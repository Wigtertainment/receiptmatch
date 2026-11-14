import type { StoredSupportingDocument } from "../src/shared/workspace-documents.js";
import type { SourceEvidence } from "../src/shared/bank-import.js";
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

const day: 86400000 = 86_400_000;
const exactAmountScore: number = 4;
const filenameRank: { match: number; partial: number; different: number; missing: number; } = { match: 2, partial: 1, different: 0, missing: 0 };
const genericWords: Set<string> = new Set([
	'at', 'beleg', 'bild', 'card', 'copy', 'dinner', 'document', 'file', 'from', 'gmbh', 'image', 'inc', 'invoice', 'karte', 'kartenzahlung', 'limited',
	'ltd', 'lunch', 'new', 'payment', 'photo', 'pos', 'purchase', 'receipt', 'rechnung', 'restaurant', 'shop', 'store', 'terminal', 'to', 'transaction', 'transfer', 'zahlung',
]);

function namedText(text: string, matchText: string = text): NamedText {
	const words: [] | RegExpMatchArray = matchText.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').toLowerCase().normalize('NFC').replace(/(?<=[\p{L}\p{M}])['’](?=\p{L})/gu, '').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	return { text, words: words.filter((word: string): boolean => /\p{L}/u.test(word) && !genericWords.has(word) && !/^(?:img|dscn?|pxl|scan|screenshot)[0-9]*$/.test(word)) };
}

function nameEvidence(bank: NamedText[], documents: NamedText[]): MatchNameEvidence {
	const bankText: string | null = bank.find((item: NamedText): number => item.words.length)?.text ?? null;
	const documentText: string | null = documents.find((item: NamedText): number => item.words.length)?.text ?? null;
	if (!bankText || !documentText) {
		return { state: 'missing', bankText, documentText };
	}
	let partial: MatchNameEvidence | undefined;
	for (const left of bank) {
		for (const right of documents) {
		const a: string = left.words.join(' '), b: string = right.words.join(' ');
		if ((a === b && a.length >= 3) || (left.words.length >= 2 && right.words.length >= 2 &&
			((' ' + a + ' ').includes(' ' + b + ' ') || (' ' + b + ' ').includes(' ' + a + ' ')))) {
			return { state: 'match', bankText: left.text, documentText: right.text };
		}
		if (!partial && left.words.some((word: string): boolean => word.length >= 4 && right.words.includes(word))) {
			partial = { state: 'partial', bankText: left.text, documentText: right.text };
		}
	}
	}
	return partial ?? { state: 'different', bankText, documentText };
}

function absolute(value: bigint): bigint {
	return value < 0n ? -value : value;
}

function amountRating(bank: Money, document: Money): { signal: AmountSignal; score: number } {
	if (bank.currency !== document.currency) {
		return { signal: 'currency-differs', score: -2 };
	}
	const a: bigint = absolute(BigInt(bank.coefficient)) * 10n ** BigInt(document.scale);
	const b: bigint = absolute(BigInt(document.coefficient)) * 10n ** BigInt(bank.scale);
	const delta: bigint = absolute(a - b);
	if (!delta) {
		return { signal: 'equal', score: exactAmountScore };
	}
	if (delta * 100n <= b * 5n) {
		return { signal: 'close', score: 3 };
	}
	if (delta * 100n <= b * 15n) {
		return { signal: 'close', score: 2 };
	}
	return { signal: 'different', score: delta * 4n >= b ? -2 : 0 };
}

interface RatedAmount { evidence: AmountEvidence; signal: AmountSignal; score: number }

function bestAmountForBasis(basis: AmountEvidence['basis'], amount: Money, fields: DocumentSection['amounts'], best: RatedAmount | undefined): RatedAmount | undefined {
	for (const field of fields) {
		for (const value of field.candidates) {
		if (!value.currency || value.coefficient === '0' || (field.role === 'billed-total' && value.coefficient.startsWith('-'))) {
			continue;
		}
		const documentAmount: Money = { ...value, currency: value.currency };
		const rating: { signal: AmountSignal; score: number; } = amountRating(amount, documentAmount);
		if (!best || rating.score > best.score || (rating.signal === 'different' && best.signal === 'currency-differs')) {
			best = { ...rating, evidence: { basis, transactionAmount: amount, documentFieldId: field.id, documentAmount } };
		}
	}
	}
	return best;
}

function amountEvidence(row: TransactionCandidate, fields: DocumentSection['amounts']): RatedAmount | undefined {
	let best: RatedAmount | undefined;
	const bases: readonly [readonly ["account-settlement", Money], readonly ["reported-original", Money | undefined]] = [['account-settlement', row.accountAmount.value], ['reported-original', row.reportedOriginalAmount?.value]] as const;
	for (const [basis, amount] of bases) {
		if (!amount) {
			continue;
		}
		best = bestAmountForBasis(basis, amount, fields, best);
	}
	return best;
}

function reviewSection(documentId: string, section: DocumentSection, filename: NamedText, recordedPayments: Set<string>): ReviewSection {
	const paymentDates: DocumentSection['dates'][number][] = section.dates.filter((field: DocumentSection['dates'][number]): boolean => field.role === 'payment');
	const dates: DocumentSection['dates'][number][] = paymentDates.some((field: DocumentSection['dates'][number]): number => field.candidates.length) ? paymentDates :
		section.dates.filter((field: DocumentSection['dates'][number]): boolean => field.role === 'issue');
	const merchants: NamedText[] = section.merchants.flatMap((field: DocumentSection['merchants'][number]): NamedText[] => field.candidates.map((value: string): NamedText => namedText(value)));
	const references: Set<string> = new Set(documentReferenceFields(section).flatMap((field: DocumentSection['references'][number]): string[] => field.candidates
		.filter((value: string): boolean => hasFullDocumentReference(field, value)).map(normalizeReference)).filter(Boolean));
	return { documentId, section, filename, merchants, references, dates, outgoing: outgoingAmounts(section, recordedPayments, false),
		incoming: section.amounts.filter((field: DocumentSection['amounts'][number]): boolean => field.role === 'refund-payment') };
}

function indexReviewAmounts(entry: ReviewSection, add: (key: string, section: ReviewSection) => void): void {
	for (const direction of ['outgoing', 'incoming'] as const) {
		for (const field of entry[direction]) {
			for (const amount of field.candidates) {
			if (amount.currency && amount.coefficient !== '0') {
				add(direction + ':' + moneyKey({ ...amount, currency: amount.currency }), entry);
			}
		}
		}
	}
}

function indexSectionEvidence(entry: ReviewSection, add: (key: string, section: ReviewSection) => void): void {
	for (const value of entry.references) {
		add('ref:' + value, entry);
	}
	for (const name of [entry.filename, ...entry.merchants]) {
		for (const word of name.words) {
			if (word.length >= 3) {
				add('name:' + word, entry);
			}
		}
	}
	indexReviewAmounts(entry, add);
	const values: Set<string> = new Set(entry.dates.flatMap((field: DocumentSection['dates'][number]): string[] => field.candidates));
	if (values.size === 1) {
		add('date:' + [...values][0], entry);
	}
}

function indexSections(imports: readonly StoredDocumentImport[]): { sections: Map<string, ReviewSection>; index: Map<string, Set<ReviewSection>>; } {
	const sections: Map<string, ReviewSection> = new Map<string, ReviewSection>();
	const index: Map<string, Set<ReviewSection>> = new Map<string, Set<ReviewSection>>();
	const add: (key: string, section: ReviewSection) => void = (key: string, section: ReviewSection): void => {
		const entries: Set<ReviewSection> = index.get(key) ?? new Set<ReviewSection>();
		entries.add(section);
		index.set(key, entries);
	};
	for (const run of imports) {
		for (const file of run.files) {
		if (file.status !== 'imported') {
			continue;
		}
		const { id: documentId, filePath, result }: StoredSupportingDocument = file.record;
		const filename: string = filePath.split(/[\\/]/).at(-1)!;
		const filenameText: NamedText = namedText(filename, filename.replace(/\.[^.]+$/, ''));
		const recordedPayments: Set<string> = recordedDocumentPayments(result);
		const merged: Set<string> = mergedLegacySections(result);
		for (const section of result.sections) {
			const entry: ReviewSection = reviewSection(documentId, section, filenameText, recordedPayments);
			sections.set(JSON.stringify([documentId, section.sectionId]), entry);
			if (merged.has(section.sectionId)) {
				continue;
			}
			indexSectionEvidence(entry, add);
		}
	}
	}
	return { sections, index };
}

interface EvaluatedAmounts { amounts: AmountEvidence[]; score: number; signal: AmountSignal; equal: boolean }

function evaluateAmounts(row: TransactionCandidate, entry: ReviewSection, exact?: MatchCandidate): EvaluatedAmounts {
	const fields: DocumentSection['amounts'][number][] = row.direction === 'outgoing' ? entry.outgoing : entry.incoming;
	const historicalAmount: AmountEvidence | undefined = exact?.amounts[0];
	const bestAmount: RatedAmount | undefined = amountEvidence(row, fields) ?? (historicalAmount ? {
		evidence: historicalAmount, ...amountRating(historicalAmount.transactionAmount, historicalAmount.documentAmount)
	} : undefined);
	const equalAmounts: AmountEvidence[] = exact?.amounts.filter(({ transactionAmount, documentAmount }: AmountEvidence): boolean => amountRating(transactionAmount, documentAmount).signal === 'equal') ?? [];
	const hasEqualAmount: boolean = equalAmounts.length > 0;
	const amounts: AmountEvidence[] = hasEqualAmount ? equalAmounts : bestAmount ? [bestAmount.evidence] : [];
	return { amounts, score: hasEqualAmount ? exactAmountScore : bestAmount?.score ?? 0, signal: hasEqualAmount ? 'equal' : bestAmount?.signal ?? 'missing', equal: hasEqualAmount };
}

function referenceSignal(row: TransactionCandidate, entry: ReviewSection, hasReferences: boolean): ReviewMatchCandidate['signals']['reference'] {
	return hasReferences ? 'match' : entry.references.size && bankReferenceFields(row).some((field: { label: string; value: string; evidence: SourceEvidence[]; }): string => field.value.trim()) ? 'different' : 'missing';
}

function scoreCandidate(merchant: MatchNameEvidence, filename: MatchNameEvidence, date: ReturnType<typeof dateEvidence>, amountScore: number, hasReferences: boolean): { score: number; supportingSignals: number } {
	const nameStates: ("match" | "partial" | "different" | "missing")[] = [merchant.state, filename.state];
	const nameScore: 0 | 1 | 2 | -1 = nameStates.includes('match') ? 2 : nameStates.includes('partial') ? 1 : merchant.state === 'different' ? -1 : 0;
	const dateScore: 0 | 1 | 2 | -1 = !date ? 0 : date.daysApart <= 2 ? 2 : date.withinWindow ? 1 : -1;
	const score: number = amountScore + nameScore + dateScore + (hasReferences ? 5 : 0);
	return { score, supportingSignals: Number(nameScore > 0) + Number(dateScore > 0) + Number(amountScore > 0) };
}

function candidateIssues(hasReferences: boolean, referenceConflict: boolean, amountScore: number, hasEqualAmount: boolean, exact?: MatchCandidate): ReviewMatchCandidate['issues'] {
	const issues: ReviewMatchCandidate['issues'] = exact && hasEqualAmount ? [...exact.issues] :
		hasReferences ? [amountScore === exactAmountScore ? 'conflicting-evidence' : 'amount-needs-review'] : ['missing-reference'];
	if (!hasReferences && !issues.includes('missing-reference')) {
		issues.push('missing-reference');
	}
	if (referenceConflict && !issues.includes('conflicting-evidence')) {
		issues.push('conflicting-evidence');
	}
	return issues;
}

function evaluate(row: TransactionCandidate, names: NamedText[], entry: ReviewSection, exact?: MatchCandidate): { candidate: ReviewMatchCandidate; score: number; reliable: boolean; } | null {
	const { documentId, section }: ReviewSection = entry;
	const { amounts, score: amountScore, signal: amountSignal, equal: hasEqualAmount }: EvaluatedAmounts = evaluateAmounts(row, entry, exact);
	const date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null = dateEvidence(row, entry.dates);
	const referenceResult: { matches: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[]; conflicting: boolean; } = referenceEvidence(row, section);
	const references: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }[] = referenceResult.matches;
	const merchant: MatchNameEvidence = nameEvidence(names, entry.merchants);
	const filename: MatchNameEvidence = nameEvidence(names, [entry.filename]);
	const hasReferences: boolean = references.length > 0;
	const reference: ReviewMatchCandidate['signals']['reference'] = referenceSignal(row, entry, hasReferences);
	const { score, supportingSignals }: { score: number; supportingSignals: number } = scoreCandidate(merchant, filename, date, amountScore, hasReferences);
	if (amountScore !== exactAmountScore && !references.length && (score < 3 || supportingSignals < 2)) {
		return null;
	}
	const issues: ReviewMatchCandidate['issues'] = candidateIssues(hasReferences, referenceResult.conflicting, amountScore, hasEqualAmount, exact);
	const candidate: ReviewMatchCandidate = { documentId, sectionId: section.sectionId, direction: row.direction, amounts, date, references, issues,
		signals: { amount: amountSignal, merchant, filename, reference } };
	return { candidate, score, reliable: hasEqualAmount && issues.length === 0 };
}

// Supplemental suggestions are derived from effective imports, including corrections, when a workspace is reviewed.
export function evaluateReviewMatches(
	matches: readonly TransactionMatch[], bankImports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[],
): ReviewMatch[] {
	const { sections, index }: { sections: Map<string, ReviewSection>; index: Map<string, Set<ReviewSection>>; } = indexSections(documentImports);
	const bankRows: Map<string, TransactionCandidate> = new Map<string, TransactionCandidate>();
	for (const record of bankImports) {
		const rows: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
		for (const { transactionId, rowId } of record.transactions) {
			bankRows.set(transactionId, rows.get(rowId)!);
		}
	}
	const evaluated: { transactionId: string; candidates: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }[]; }[] = matches.map((match: TransactionMatch): { transactionId: string; candidates: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }[]; } => {
		const row: TransactionCandidate = bankRows.get(match.transactionId)!;
		const exact: Map<string, MatchCandidate> = new Map(match.candidates.map((candidate: MatchCandidate): [string, MatchCandidate] => [JSON.stringify([candidate.documentId, candidate.sectionId]), candidate]));
		const names: NamedText[] = [namedText(row.counterpartyCandidate?.value ?? ''), namedText(row.description.value)];
		const pool: Set<ReviewSection> = new Set<ReviewSection>();
		const include: (key: string) => void = (key: string): void => {
			for (const entry of index.get(key) ?? []) {
				pool.add(entry);
			}
		};
		for (const key of exact.keys()) {
			pool.add(sections.get(key)!);
		}
		for (const name of names) {
			for (const word of name.words) {
				if (word.length >= 3) {
					include('name:' + word);
				}
			}
		}
		for (const field of bankReferenceFields(row)) {
			include('ref:' + normalizeReference(field.value));
		}
		include(row.direction + ':' + moneyKey(row.accountAmount.value));
		if (row.reportedOriginalAmount) {
			include(row.direction + ':' + moneyKey(row.reportedOriginalAmount.value));
		}
		const booking: number = Date.parse(row.bookingDate.value);
		for (let offset: number = -7; offset <= 7; offset++) {
			include('date:' + new Date(booking + offset * day).toISOString().slice(0, 10));
		}
		const candidates: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }[] = [...pool].flatMap((entry: ReviewSection): { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }[] => {
			const base: MatchCandidate | undefined = exact.get(JSON.stringify([entry.documentId, entry.section.sectionId]));
			const credit: boolean = entry.incoming.length > 0 || entry.section.kind === 'credit-note';
			if (!base && (row.direction === 'incoming' ? !credit : credit && !entry.outgoing.length)) {
				return [];
			}
			const result: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; } | null = evaluate(row, names, entry, base);
			return result ? [result] : [];
		});
		return { transactionId: match.transactionId, candidates };
	});
	const counts: Map<string, number> = new Map<string, number>();
	for (const { candidates } of evaluated) {
		for (const { candidate } of candidates) {
		for (const ref of new Set(candidate.references.map((reference: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }): string => reference.normalized))) {
			counts.set(ref, (counts.get(ref) ?? 0) + 1);
		}
	}
	}
	return evaluated.map(({ transactionId, candidates }: { transactionId: string; candidates: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }[]; }): ReviewMatch => {
		const referenced: number = candidates.filter(({ candidate }: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }): number => candidate.references.length).length;
		for (const result of candidates) {
			const { candidate }: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; } = result;
			if (candidate.references.length && (referenced > 1 || candidate.references.every((ref: { normalized: string; bankLabel: string; bankValue: string; documentFieldId: string; documentValue: string; }): boolean => (counts.get(ref.normalized) ?? 0) > 1))) {
				if (!candidate.issues.includes('competing-reference')) {
					candidate.issues.push('competing-reference');
				}
				result.reliable = false;
			}
		}
		candidates.sort((left: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }, right: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }): number => Number(right.reliable) - Number(left.reliable) || right.score - left.score ||
			Number(right.candidate.signals.amount === 'equal') - Number(left.candidate.signals.amount === 'equal') ||
			filenameRank[right.candidate.signals.filename.state] - filenameRank[left.candidate.signals.filename.state] ||
			left.candidate.documentId.localeCompare(right.candidate.documentId) || left.candidate.sectionId.localeCompare(right.candidate.sectionId));
		return { transactionId, status: candidates.some((candidate: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }): boolean => candidate.reliable) ? 'reliable' : candidates.length ? 'uncertain' : 'unmatched',
			candidates: candidates.map(({ candidate }: { candidate: ReviewMatchCandidate; score: number; reliable: boolean; }): ReviewMatchCandidate => candidate) };
	});
}
