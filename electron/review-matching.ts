import type { TransactionCandidate } from '../src/shared/bank-import.js';
import type { Money } from '../src/shared/money.js';
import type { DocumentSection } from '../src/shared/supporting-document.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { MatchCandidate, MatchNameEvidence, ReviewMatch, ReviewMatchCandidate, TransactionMatch } from '../src/shared/workspace-matching.js';
import { hasFullDocumentReference, mergedLegacySections, recordedDocumentPayments } from './documents/interpret.js';
import { bankReferenceFields, dateEvidence, documentReferenceFields, moneyKey, normalizeReference, outgoingAmounts, referenceEvidence } from './matching.js';

type AmountEvidence = MatchCandidate['amounts'][number];
type AmountSignal = ReviewMatchCandidate['signals']['amount'];
interface NamedText { text: string; words: string[] }
interface ReviewSection {
	documentId: string;
	section: DocumentSection;
	filename: NamedText;
	merchants: NamedText[];
	references: Set<string>;
	dates: DocumentSection['dates'];
	outgoing: DocumentSection['amounts'];
	incoming: DocumentSection['amounts'];
}

const day = 86_400_000;
const exactAmountScore = 4;
const genericWords = new Set([
	'at', 'beleg', 'bild', 'card', 'copy', 'dinner', 'document', 'file', 'from', 'gmbh', 'image', 'inc', 'invoice', 'karte', 'kartenzahlung', 'limited',
	'ltd', 'lunch', 'new', 'payment', 'photo', 'pos', 'purchase', 'receipt', 'rechnung', 'restaurant', 'shop', 'store', 'terminal', 'to', 'transaction', 'transfer', 'zahlung',
]);

function namedText(text: string, matchText = text): NamedText {
	const words = matchText.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').toLowerCase().normalize('NFC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	return { text, words: words.filter(word => /\p{L}/u.test(word) && !genericWords.has(word) && !/^(?:img|dscn?|pxl|scan|screenshot)[0-9]*$/.test(word)) };
}

function nameEvidence(bank: NamedText[], documents: NamedText[]): MatchNameEvidence {
	const bankText = bank.find(item => item.words.length)?.text ?? null;
	const documentText = documents.find(item => item.words.length)?.text ?? null;
	if (!bankText || !documentText) return { state: 'missing', bankText, documentText };
	let partial: MatchNameEvidence | undefined;
	for (const left of bank) for (const right of documents) {
		const a = left.words.join(' '), b = right.words.join(' ');
		if ((a === b && a.length >= 3) || (left.words.length >= 2 && right.words.length >= 2 &&
			((' ' + a + ' ').includes(' ' + b + ' ') || (' ' + b + ' ').includes(' ' + a + ' ')))) {
			return { state: 'match', bankText: left.text, documentText: right.text };
		}
		if (!partial && left.words.some(word => word.length >= 4 && right.words.includes(word))) {
			partial = { state: 'partial', bankText: left.text, documentText: right.text };
		}
	}
	return partial ?? { state: 'different', bankText, documentText };
}

function absolute(value: bigint): bigint { return value < 0n ? -value : value; }

function amountRating(bank: Money, document: Money): { signal: AmountSignal; score: number } {
	if (bank.currency !== document.currency) return { signal: 'currency-differs', score: -2 };
	const a = absolute(BigInt(bank.coefficient)) * 10n ** BigInt(document.scale);
	const b = absolute(BigInt(document.coefficient)) * 10n ** BigInt(bank.scale);
	const delta = absolute(a - b);
	if (!delta) return { signal: 'equal', score: exactAmountScore };
	if (delta * 100n <= b * 5n) return { signal: 'close', score: 3 };
	if (delta * 100n <= b * 15n) return { signal: 'close', score: 2 };
	return { signal: 'different', score: delta * 4n >= b ? -2 : 0 };
}

function amountEvidence(row: TransactionCandidate, fields: DocumentSection['amounts']) {
	let best: { evidence: AmountEvidence; signal: AmountSignal; score: number } | undefined;
	const bases = [['account-settlement', row.accountAmount.value], ['reported-original', row.reportedOriginalAmount?.value]] as const;
	for (const [basis, amount] of bases) {
		if (!amount) continue;
		for (const field of fields) for (const value of field.candidates) {
			if (!value.currency || value.coefficient === '0' || (field.role === 'billed-total' && value.coefficient.startsWith('-'))) continue;
			const documentAmount = { ...value, currency: value.currency };
			const rating = amountRating(amount, documentAmount);
			if (!best || rating.score > best.score || (rating.signal === 'different' && best.signal === 'currency-differs')) {
				best = { ...rating, evidence: { basis, transactionAmount: amount, documentFieldId: field.id, documentAmount } };
			}
		}
	}
	return best;
}

function indexSections(imports: readonly StoredDocumentImport[]) {
	const sections = new Map<string, ReviewSection>();
	const index = new Map<string, Set<ReviewSection>>();
	const add = (key: string, section: ReviewSection) => {
		const entries = index.get(key) ?? new Set<ReviewSection>();
		entries.add(section);
		index.set(key, entries);
	};
	for (const run of imports) for (const file of run.files) {
		if (file.status !== 'imported') continue;
		const { id: documentId, filePath, result } = file.record;
		const filename = filePath.split(/[\\/]/).at(-1)!;
		const filenameText = namedText(filename, filename.replace(/\.[^.]+$/, ''));
		const recordedPayments = recordedDocumentPayments(result);
		const merged = mergedLegacySections(result);
		for (const section of result.sections) {
			const paymentDates = section.dates.filter(field => field.role === 'payment');
			const dates = paymentDates.some(field => field.candidates.length) ? paymentDates : section.dates.filter(field => field.role === 'issue');
			const merchants = section.merchants.flatMap(field => field.candidates.map(value => namedText(value)));
			const references = new Set(documentReferenceFields(section).flatMap(field => field.candidates
				.filter(value => hasFullDocumentReference(field, value)).map(normalizeReference)).filter(Boolean));
			const entry = { documentId, section, filename: filenameText, merchants, references, dates, outgoing: outgoingAmounts(section, recordedPayments, false),
				incoming: section.amounts.filter(field => field.role === 'refund-payment') };
			sections.set(JSON.stringify([documentId, section.sectionId]), entry);
			if (merged.has(section.sectionId)) continue;
			for (const value of references) add('ref:' + value, entry);
			for (const name of [filenameText, ...merchants]) for (const word of name.words) if (word.length >= 3) add('name:' + word, entry);
			for (const direction of ['outgoing', 'incoming'] as const) {
				for (const field of entry[direction]) for (const amount of field.candidates) {
					if (amount.currency && amount.coefficient !== '0') add(direction + ':' + moneyKey({ ...amount, currency: amount.currency }), entry);
				}
			}
			const values = new Set(dates.flatMap(field => field.candidates));
			if (values.size === 1) add('date:' + [...values][0], entry);
		}
	}
	return { sections, index };
}

function evaluate(row: TransactionCandidate, names: NamedText[], entry: ReviewSection, exact?: MatchCandidate) {
	const { documentId, section } = entry;
	const fields = row.direction === 'outgoing' ? entry.outgoing : entry.incoming;
	const historicalAmount = exact?.amounts[0];
	const bestAmount = amountEvidence(row, fields) ?? (historicalAmount ? {
		evidence: historicalAmount, ...amountRating(historicalAmount.transactionAmount, historicalAmount.documentAmount)
	} : undefined);
	const equalAmounts = exact?.amounts.filter(({ transactionAmount, documentAmount }) => amountRating(transactionAmount, documentAmount).signal === 'equal') ?? [];
	const hasEqualAmount = equalAmounts.length > 0;
	const amounts = hasEqualAmount ? equalAmounts : bestAmount ? [bestAmount.evidence] : [];
	const date = dateEvidence(row, entry.dates);
	const referenceResult = referenceEvidence(row, section);
	const references = referenceResult.matches;
	const merchant = nameEvidence(names, entry.merchants);
	const filename = nameEvidence(names, [entry.filename]);
	const reference = references.length ? 'match' : entry.references.size && bankReferenceFields(row).some(field => field.value.trim()) ? 'different' : 'missing';
	const nameStates = [merchant.state, filename.state];
	const nameScore = nameStates.includes('match') ? 2 : nameStates.includes('partial') ? 1 : merchant.state === 'different' ? -1 : 0;
	const dateScore = !date ? 0 : date.daysApart <= 2 ? 2 : date.withinWindow ? 1 : -1;
	const amountScore = hasEqualAmount ? exactAmountScore : bestAmount?.score ?? 0;
	const score = amountScore + nameScore + dateScore + (references.length ? 5 : 0);
	const supportingSignals = Number(nameScore > 0) + Number(dateScore > 0) + Number(amountScore > 0);
	if (amountScore !== exactAmountScore && !references.length && (score < 3 || supportingSignals < 2)) return null;
	const issues: ReviewMatchCandidate['issues'] = exact && hasEqualAmount ? [...exact.issues] :
		references.length ? [amountScore === exactAmountScore ? 'conflicting-evidence' : 'amount-needs-review'] : ['missing-reference'];
	if (!references.length && !issues.includes('missing-reference')) issues.push('missing-reference');
	if (referenceResult.conflicting && !issues.includes('conflicting-evidence')) issues.push('conflicting-evidence');
	const candidate: ReviewMatchCandidate = { documentId, sectionId: section.sectionId, direction: row.direction, amounts, date, references, issues,
		signals: { amount: hasEqualAmount ? 'equal' : bestAmount?.signal ?? 'missing', merchant, filename, reference } };
	return { candidate, score, reliable: hasEqualAmount && issues.length === 0 };
}

// Supplemental suggestions are derived from effective imports, including corrections, when a workspace is reviewed.
export function evaluateReviewMatches(
	matches: readonly TransactionMatch[], bankImports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[],
): ReviewMatch[] {
	const { sections, index } = indexSections(documentImports);
	const bankRows = new Map<string, TransactionCandidate>();
	for (const record of bankImports) {
		const rows = new Map(record.result.transactions.map(row => [row.rowId, row]));
		for (const { transactionId, rowId } of record.transactions) bankRows.set(transactionId, rows.get(rowId)!);
	}
	const evaluated = matches.map(match => {
		const row = bankRows.get(match.transactionId)!;
		const exact = new Map(match.candidates.map(candidate => [JSON.stringify([candidate.documentId, candidate.sectionId]), candidate]));
		const names = [namedText(row.counterpartyCandidate?.value ?? ''), namedText(row.description.value)];
		const pool = new Set<ReviewSection>();
		const include = (key: string) => { for (const entry of index.get(key) ?? []) pool.add(entry); };
		for (const key of exact.keys()) pool.add(sections.get(key)!);
		for (const name of names) for (const word of name.words) if (word.length >= 3) include('name:' + word);
		for (const field of bankReferenceFields(row)) include('ref:' + normalizeReference(field.value));
		include(row.direction + ':' + moneyKey(row.accountAmount.value));
		if (row.reportedOriginalAmount) include(row.direction + ':' + moneyKey(row.reportedOriginalAmount.value));
		const booking = Date.parse(row.bookingDate.value);
		for (let offset = -7; offset <= 7; offset++) include('date:' + new Date(booking + offset * day).toISOString().slice(0, 10));
		const candidates = [...pool].flatMap(entry => {
			const base = exact.get(JSON.stringify([entry.documentId, entry.section.sectionId]));
			const credit = entry.incoming.length > 0 || entry.section.kind === 'credit-note';
			if (!base && (row.direction === 'incoming' ? !credit : credit && !entry.outgoing.length)) return [];
			const result = evaluate(row, names, entry, base);
			return result ? [result] : [];
		});
		return { transactionId: match.transactionId, candidates };
	});
	const counts = new Map<string, number>();
	for (const { candidates } of evaluated) for (const { candidate } of candidates) {
		for (const ref of new Set(candidate.references.map(reference => reference.normalized))) counts.set(ref, (counts.get(ref) ?? 0) + 1);
	}
	return evaluated.map(({ transactionId, candidates }) => {
		const referenced = candidates.filter(({ candidate }) => candidate.references.length).length;
		for (const result of candidates) {
			const { candidate } = result;
			if (candidate.references.length && (referenced > 1 || candidate.references.every(ref => (counts.get(ref.normalized) ?? 0) > 1))) {
				if (!candidate.issues.includes('competing-reference')) candidate.issues.push('competing-reference');
				result.reliable = false;
			}
		}
		candidates.sort((left, right) => Number(right.reliable) - Number(left.reliable) || right.score - left.score ||
			Number(right.candidate.signals.amount === 'equal') - Number(left.candidate.signals.amount === 'equal') ||
			left.candidate.documentId.localeCompare(right.candidate.documentId) || left.candidate.sectionId.localeCompare(right.candidate.sectionId));
		return { transactionId, status: candidates.some(candidate => candidate.reliable) ? 'reliable' : candidates.length ? 'uncertain' : 'unmatched',
			candidates: candidates.map(({ candidate }) => candidate) };
	});
}
