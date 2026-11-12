import type { TransactionCandidate } from '../src/shared/bank-import.js';
import type { Money } from '../src/shared/money.js';
import type { DocumentSection } from '../src/shared/supporting-document.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { MatchCandidate, TransactionMatch } from '../src/shared/workspace-matching.js';
import { hasFullDocumentReference, mergedLegacySections, recordedDocumentPayments } from './documents/interpret.js';

type AmountField = DocumentSection['amounts'][number];
type DateField = DocumentSection['dates'][number];
type Direction = TransactionCandidate['direction'];
type ReferenceEvidence = MatchCandidate['references'][number];
type DateEvidence = NonNullable<MatchCandidate['date']>;

interface DocumentAmounts {
	documentId: string;
	section: DocumentSection;
	direction: Direction;
	dates: DateField[];
	uncertainReferences: Set<string>;
	conflicting: boolean;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function moneyKey(amount: Money): string {
	let coefficient = BigInt(amount.coefficient);
	let scale = amount.scale;
	if (coefficient < 0n) coefficient = -coefficient;
	while (scale > 0 && coefficient % 10n === 0n) {
		coefficient /= 10n;
		scale--;
	}
	return `${amount.currency}:${coefficient}:${scale}`;
}

export function normalizeReference(value: string): string {
	return value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

export function outgoingAmounts(section: DocumentSection, recordedPayments: Set<string>, requireIdentifiedDocument = true): AmountField[] {
	if (section.kind !== 'receipt' && section.kind !== 'invoice' &&
		(requireIdentifiedDocument || (section.kind !== 'unknown' && section.kind !== 'payment-information'))) return [];
	const payments = section.amounts.filter((field) => recordedPayments.has(field.id));
	if (payments.length) return payments;
	if (requireIdentifiedDocument && section.kind === 'invoice' && !section.merchants.some((field) => field.candidates.length === 1)) return [];
	return section.amounts.filter((field) => field.role === 'billed-total');
}

function indexDocumentAmounts(documents: readonly StoredSupportingDocument[]) {
	const index = new Map<string, { document: DocumentAmounts; fieldId: string; amount: Money }[]>();
	for (const { id, result } of documents) {
		const mergedSections = mergedLegacySections(result);
		const uncertainFields = new Set(result.issues.map((issue) => issue.fieldId));
		const recordedPayments = recordedDocumentPayments(result);
		for (const section of result.sections) {
			if (mergedSections.has(section.sectionId)) continue;
			const paymentDates = section.dates.filter((field) => field.role === 'payment');
			const dates = paymentDates.some((field) => field.candidates.length > 0) ? paymentDates : section.dates.filter((field) => field.role === 'issue');
			const currencies = section.currencies.filter((field) => field.role === 'settlement');
			const declaredCurrencies = new Set(currencies.flatMap((field) => field.candidates));
			const uncertainReferences = new Set(section.references.filter((field) => uncertainFields.has(field.id)).map((field) => field.id));
			const directions = [
				['outgoing', outgoingAmounts(section, recordedPayments)],
				['incoming', section.amounts.filter((field) => field.role === 'refund-payment')],
			] as const;
			for (const [direction, fields] of directions) {
				if (!fields.length) continue;
				const amounts = fields.flatMap((field) => field.candidates.map((amount) => ({ field, amount })));
				const values = new Set(amounts.map(({ amount }) => (amount.currency === null ? null : moneyKey({ ...amount, currency: amount.currency }))));
				const conflicting = values.size > 1 || declaredCurrencies.size > 1 || new Set(dates.flatMap((field) => field.candidates)).size > 1 ||
					[...fields, ...dates, ...paymentDates, ...currencies].some((field) => uncertainFields.has(field.id)) ||
					(fields.some((field) => field.role === 'billed-total') && section.kind === 'invoice' &&
						!section.merchants.some((field) => field.candidates.length === 1 && !uncertainFields.has(field.id)));
				const document = { documentId: id, section, direction, dates, uncertainReferences, conflicting };
				for (const { field, amount } of amounts) {
					if (amount.currency === null || amount.coefficient === '0' || (field.role === 'billed-total' && amount.coefficient.startsWith('-'))) continue;
					const value = { ...amount, currency: amount.currency };
					const key = `${direction}:${moneyKey(value)}`;
					const entries = index.get(key) ?? [];
					const inconsistentCurrency = declaredCurrencies.size > 0 && !declaredCurrencies.has(value.currency);
					entries.push({ document: inconsistentCurrency ? { ...document, conflicting: true } : document, fieldId: field.id, amount: value });
					index.set(key, entries);
				}
			}
		}
	}
	return index;
}

export function suggestWorkspaceMatches(bankImports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[]): TransactionMatch[] {
	return suggestTransactionMatches(bankImports, documentImports.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [file.record] : [])));
}

export function bankReferenceFields(row: TransactionCandidate) {
	return row.references.filter((field) => /^(?:ref|reference|payment reference)$/i.test(field.label.trim()));
}

export function documentReferenceFields(section: DocumentSection) {
	return section.references.filter(field => field.role === 'payment' || field.role === 'invoice' || field.role === 'receipt');
}

export function referenceEvidence(row: TransactionCandidate, section: DocumentSection): { matches: ReferenceEvidence[]; conflicting: boolean } {
	const bankReferences = bankReferenceFields(row);
	const matches = new Map<string, ReferenceEvidence>();
	let conflicting = false;
	for (const field of documentReferenceFields(section)) {
		const values = new Set(field.candidates.map(normalizeReference));
		for (const bank of bankReferences) {
			const normalized = normalizeReference(bank.value);
			for (const documentValue of field.candidates) {
				if (!normalized || normalized !== normalizeReference(documentValue) || !hasFullDocumentReference(field, documentValue)) continue;
				const key = JSON.stringify([normalized, field.id, bank.label, bank.value, documentValue]);
				matches.set(key, { normalized, bankLabel: bank.label, bankValue: bank.value, documentFieldId: field.id, documentValue });
				conflicting ||= values.size > 1;
			}
		}
	}
	return { matches: [...matches.keys()].sort(compare).map((key) => matches.get(key)!), conflicting };
}

export function dateEvidence(row: TransactionCandidate, dates: DateField[]): DateEvidence | null {
	const values = new Set(dates.flatMap((field) => field.candidates));
	if (values.size !== 1) return null;
	const field = dates.filter((field) => field.candidates.length > 0).sort((left, right) => compare(left.id, right.id))[0];
	const bookingDate = row.bookingDate.value;
	const documentDate = field.candidates[0];
	const daysApart = Math.abs(Date.parse(`${bookingDate}T00:00:00Z`) - Date.parse(`${documentDate}T00:00:00Z`)) / 86_400_000;
	return { documentFieldId: field.id, bookingDate, documentDate, role: field.role === 'payment' ? 'payment' : 'issue', daysApart, withinWindow: daysApart <= 7 };
}

export function suggestTransactionMatches(bankImports: readonly StoredBankImport[], documents: readonly StoredSupportingDocument[]): TransactionMatch[] {
	const index = indexDocumentAmounts(documents);
	const matches: TransactionMatch[] = [];
	const referenceCounts = new Map<string, number>();
	for (const record of bankImports) {
		const rows = new Map(record.result.transactions.map((row) => [row.rowId, row]));
		for (const { rowId, transactionId } of record.transactions) {
			const row = rows.get(rowId)!;
			const candidates = new Map<string, MatchCandidate>();
			const bases = [
				['account-settlement', row.accountAmount.value],
				['reported-original', row.reportedOriginalAmount?.value],
			] as const;
			for (const [basis, amount] of bases) {
				if (!amount) continue;
				for (const { document, fieldId, amount: documentAmount } of index.get(`${row.direction}:${moneyKey(amount)}`) ?? []) {
					const { documentId, section, direction, conflicting } = document;
					const key = JSON.stringify([documentId, section.sectionId]);
					let candidate = candidates.get(key);
					if (!candidate) {
						const references = referenceEvidence(row, section);
						candidate = { documentId, sectionId: section.sectionId, direction, amounts: [], references: references.matches, date: dateEvidence(row, document.dates), issues: [] };
						if (!references.matches.length) candidate.issues.push('missing-reference');
						if (references.conflicting || references.matches.some((reference) => document.uncertainReferences.has(reference.documentFieldId))) {
							candidate.issues.push('conflicting-evidence');
						}
						for (const ref of new Set(candidate.references.map((reference) => reference.normalized))) referenceCounts.set(ref, (referenceCounts.get(ref) ?? 0) + 1);
						candidates.set(key, candidate);
					}
					if (conflicting && !candidate.issues.includes('conflicting-evidence')) candidate.issues.push('conflicting-evidence');
					candidate.amounts.push({ basis, transactionAmount: amount, documentFieldId: fieldId, documentAmount });
				}
			}
			matches.push({ transactionId, status: candidates.size ? 'uncertain' : 'unmatched', candidates: [...candidates.values()] });
		}
	}
	for (const match of matches) {
		const referencedCount = match.candidates.filter((candidate) => candidate.references.length).length;
		for (const candidate of match.candidates) {
			if (candidate.references.length && (referencedCount > 1 || candidate.references.every((ref) => (referenceCounts.get(ref.normalized) ?? 0) > 1))) {
				candidate.issues.push('competing-reference');
			}
			if (!candidate.issues.length) match.status = 'reliable';
			candidate.amounts.sort((left, right) => compare(left.basis, right.basis) || compare(left.documentFieldId, right.documentFieldId) || left.documentAmount.scale - right.documentAmount.scale);
		}
		match.candidates.sort((left, right) => Number(Boolean(left.issues.length)) - Number(Boolean(right.issues.length)) ||
			Number(Boolean(right.date?.withinWindow)) - Number(Boolean(left.date?.withinWindow)) || compare(left.documentId, right.documentId) || compare(left.sectionId, right.sectionId));
	}
	return matches.sort((left, right) => compare(left.transactionId, right.transactionId));
}
