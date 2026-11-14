import type { ImportIssue, SourceEvidence } from "../src/shared/bank-import.js";
import type { DocumentIssue, SupportingDocument } from "../src/shared/supporting-document.js";
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
	let coefficient: bigint = BigInt(amount.coefficient);
	let scale: number = amount.scale;
	if (coefficient < 0n) {
		coefficient = -coefficient;
	}
	while (scale > 0 && coefficient % 10n === 0n) {
		coefficient /= 10n;
		scale--;
	}
	return `${amount.currency}:${coefficient}:${scale}`;
}

export function normalizeReference(value: string): string {
	return value.trim().replace(/[a-z]/g, (letter: string): string => letter.toUpperCase());
}

export function outgoingAmounts(section: DocumentSection, recordedPayments: Set<string>, requireIdentifiedDocument: boolean = true): AmountField[] {
	if (section.kind !== 'receipt' && section.kind !== 'invoice' &&
		(requireIdentifiedDocument || (section.kind !== 'unknown' && section.kind !== 'payment-information'))) {
			return [];
		}
	const payments: AmountField[] = section.amounts.filter((field: AmountField): boolean => recordedPayments.has(field.id));
	if (payments.length) {
		return payments;
	}
	if (requireIdentifiedDocument && section.kind === 'invoice' && !section.merchants.some((field: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.candidates.length === 1)) {
		return [];
	}
	return section.amounts.filter((field: AmountField): boolean => field.role === 'billed-total');
}

interface IndexedAmount { document: DocumentAmounts; fieldId: string; amount: Money }
interface SectionAmountFacts {
	documentId: string;
	section: DocumentSection;
	paymentDates: DateField[];
	dates: DateField[];
	currencies: DocumentSection['currencies'];
	declaredCurrencies: Set<string>;
	uncertainFields: Set<string | null>;
	uncertainReferences: Set<string>;
}

function addIndexedAmounts(index: Map<string, IndexedAmount[]>, facts: SectionAmountFacts, direction: Direction, fields: AmountField[]): void {
	const { documentId, section, paymentDates, dates, currencies, declaredCurrencies, uncertainFields, uncertainReferences }: SectionAmountFacts = facts;
	if (!fields.length) {
		return;
	}
	const amounts: { field: AmountField; amount: AmountField['candidates'][number]; }[] = fields.flatMap((field: AmountField): { field: AmountField; amount: AmountField['candidates'][number]; }[] => field.candidates.map((amount: AmountField['candidates'][number]): { field: AmountField; amount: AmountField['candidates'][number]; } => ({ field, amount })));
	const values: Set<string | null> = new Set(amounts.map(({ amount }: { field: AmountField; amount: AmountField['candidates'][number]; }): string | null => (amount.currency === null ? null : moneyKey({ ...amount, currency: amount.currency }))));
	const conflicting: boolean = values.size > 1 || declaredCurrencies.size > 1 || new Set(dates.flatMap((field: DateField): string[] => field.candidates)).size > 1 ||
		[...fields, ...dates, ...paymentDates, ...currencies].some((field: AmountField | DateField | DocumentSection['currencies'][number]): boolean => uncertainFields.has(field.id)) ||
		(fields.some((field: AmountField): boolean => field.role === 'billed-total') && section.kind === 'invoice' &&
			!section.merchants.some((field: DocumentSection['merchants'][number]): boolean => field.candidates.length === 1 && !uncertainFields.has(field.id)));
	const document: DocumentAmounts = { documentId, section, direction, dates, uncertainReferences, conflicting };
	for (const { field, amount } of amounts) {
		if (amount.currency === null || amount.coefficient === '0' || (field.role === 'billed-total' && amount.coefficient.startsWith('-'))) {
			continue;
		}
		const value: Money = { ...amount, currency: amount.currency };
		const key: string = `${direction}:${moneyKey(value)}`;
		const entries: IndexedAmount[] = index.get(key) ?? [];
		const inconsistentCurrency: boolean = declaredCurrencies.size > 0 && !declaredCurrencies.has(value.currency);
		entries.push({ document: inconsistentCurrency ? { ...document, conflicting: true } : document, fieldId: field.id, amount: value });
		index.set(key, entries);
	}
}

function indexSectionAmounts(index: Map<string, IndexedAmount[]>, id: string, section: DocumentSection, uncertainFields: Set<string | null>, recordedPayments: Set<string>): void {
	const paymentDates: DateField[] = section.dates.filter((field: DateField): boolean => field.role === 'payment');
	const dates: DateField[] = paymentDates.some((field: DateField): boolean => field.candidates.length > 0) ? paymentDates : section.dates.filter((field: DateField): boolean => field.role === 'issue');
	const currencies: DocumentSection['currencies'][number][] = section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement');
	const declaredCurrencies: Set<string> = new Set(currencies.flatMap((field: DocumentSection['currencies'][number]): string[] => field.candidates));
	const uncertainReferences: Set<string> = new Set(section.references.filter((field: DocumentSection['references'][number]): boolean => uncertainFields.has(field.id)).map((field: DocumentSection['references'][number]): string => field.id));
	const directions: readonly [readonly ["outgoing", AmountField[]], readonly ["incoming", AmountField[]]] = [
		['outgoing', outgoingAmounts(section, recordedPayments)],
		['incoming', section.amounts.filter((field: AmountField): boolean => field.role === 'refund-payment')],
	] as const;
	for (const [direction, fields] of directions) {
		addIndexedAmounts(index, { documentId: id, section, paymentDates, dates, currencies, declaredCurrencies, uncertainFields, uncertainReferences }, direction, fields);
	}
}

function indexDocumentAmounts(documents: readonly StoredSupportingDocument[]): Map<string, IndexedAmount[]> {
	const index: Map<string, IndexedAmount[]> = new Map();
	for (const { id, result } of documents) {
		const mergedSections: Set<string> = mergedLegacySections(result);
		const uncertainFields: Set<string | null> = new Set(result.issues.map((issue: DocumentIssue): string | null => issue.fieldId));
		const recordedPayments: Set<string> = recordedDocumentPayments(result);
		for (const section of result.sections) {
			if (!mergedSections.has(section.sectionId)) {
				indexSectionAmounts(index, id, section, uncertainFields, recordedPayments);
			}
		}
	}
	return index;
}

export function suggestWorkspaceMatches(bankImports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[]): TransactionMatch[] {
	return suggestTransactionMatches(bankImports, documentImports.flatMap((record: StoredDocumentImport): StoredSupportingDocument[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): StoredSupportingDocument[] => file.status === 'imported' ? [file.record] : [])));
}

export function bankReferenceFields(row: TransactionCandidate): { label: string; value: string; evidence: SourceEvidence[]; }[] {
	return row.references.filter((field: { label: string; value: string; evidence: SourceEvidence[]; }): boolean => /^(?:ref|reference|payment reference)$/i.test(field.label.trim()));
}

export function documentReferenceFields(section: DocumentSection): { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] {
	return section.references.filter((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'payment' || field.role === 'invoice' || field.role === 'receipt');
}

export function referenceEvidence(row: TransactionCandidate, section: DocumentSection): { matches: ReferenceEvidence[]; conflicting: boolean } {
	const bankReferences: { label: string; value: string; evidence: SourceEvidence[]; }[] = bankReferenceFields(row);
	const matches: Map<string, ReferenceEvidence> = new Map<string, ReferenceEvidence>();
	let conflicting: boolean = false;
	for (const field of documentReferenceFields(section)) {
		const values: Set<string> = new Set(field.candidates.map(normalizeReference));
		for (const bank of bankReferences) {
			const normalized: string = normalizeReference(bank.value);
			for (const documentValue of field.candidates) {
				if (!normalized || normalized !== normalizeReference(documentValue) || !hasFullDocumentReference(field, documentValue)) {
					continue;
				}
				const key: string = JSON.stringify([normalized, field.id, bank.label, bank.value, documentValue]);
				matches.set(key, { normalized, bankLabel: bank.label, bankValue: bank.value, documentFieldId: field.id, documentValue });
				conflicting ||= values.size > 1;
			}
		}
	}
	return { matches: [...matches.keys()].sort(compare).map((key: string): ReferenceEvidence => matches.get(key)!), conflicting };
}

export function dateEvidence(row: TransactionCandidate, dates: DateField[]): DateEvidence | null {
	const values: Set<string> = new Set(dates.flatMap((field: DateField): string[] => field.candidates));
	if (values.size !== 1) {
		return null;
	}
	const field: DateField = dates.filter((field: DateField): boolean => field.candidates.length > 0).sort((left: DateField, right: DateField): number => compare(left.id, right.id))[0];
	const bookingDate: string = row.bookingDate.value;
	const documentDate: string = field.candidates[0];
	const daysApart: number = Math.abs(Date.parse(`${bookingDate}T00:00:00Z`) - Date.parse(`${documentDate}T00:00:00Z`)) / 86_400_000;
	return { documentFieldId: field.id, bookingDate, documentDate, role: field.role === 'payment' ? 'payment' : 'issue', daysApart, withinWindow: daysApart <= 7 };
}

function matchCandidate(row: TransactionCandidate, document: DocumentAmounts, referenceCounts: Map<string, number>): MatchCandidate {
	const { documentId, section, direction }: DocumentAmounts = document;
	const references: ReturnType<typeof referenceEvidence> = referenceEvidence(row, section);
	const candidate: MatchCandidate = { documentId, sectionId: section.sectionId, direction, amounts: [], references: references.matches, date: dateEvidence(row, document.dates), issues: [] };
	if (!references.matches.length) {
		candidate.issues.push('missing-reference');
	}
	if (references.conflicting || references.matches.some((reference: ReferenceEvidence): boolean => document.uncertainReferences.has(reference.documentFieldId))) {
		candidate.issues.push('conflicting-evidence');
	}
	for (const ref of new Set(candidate.references.map((reference: ReferenceEvidence): string => reference.normalized))) {
		referenceCounts.set(ref, (referenceCounts.get(ref) ?? 0) + 1);
	}
	return candidate;
}

function matchTransaction(row: TransactionCandidate, transactionId: string, index: Map<string, IndexedAmount[]>, referenceCounts: Map<string, number>): TransactionMatch {
	const candidates: Map<string, MatchCandidate> = new Map<string, MatchCandidate>();
	const bases: readonly [readonly ["account-settlement", Money], readonly ["reported-original", Money | undefined]] = [
		['account-settlement', row.accountAmount.value],
		['reported-original', row.reportedOriginalAmount?.value],
	] as const;
	for (const [basis, amount] of bases) {
		if (!amount) {
			continue;
		}
		for (const { document, fieldId, amount: documentAmount } of index.get(`${row.direction}:${moneyKey(amount)}`) ?? []) {
			const { documentId, section, conflicting }: DocumentAmounts = document;
			const key: string = JSON.stringify([documentId, section.sectionId]);
			let candidate: MatchCandidate | undefined = candidates.get(key);
			if (!candidate) {
				candidate = matchCandidate(row, document, referenceCounts);
				candidates.set(key, candidate);
			}
			if (conflicting && !candidate.issues.includes('conflicting-evidence')) {
				candidate.issues.push('conflicting-evidence');
			}
			candidate.amounts.push({ basis, transactionAmount: amount, documentFieldId: fieldId, documentAmount });
		}
	}
	return { transactionId, status: candidates.size ? 'uncertain' : 'unmatched', candidates: [...candidates.values()] };
}

function finalizeMatch(match: TransactionMatch, referenceCounts: Map<string, number>): void {
	const referencedCount: number = match.candidates.filter((candidate: MatchCandidate): number => candidate.references.length).length;
	for (const candidate of match.candidates) {
		if (candidate.references.length && (referencedCount > 1 || candidate.references.every((ref: ReferenceEvidence): boolean => (referenceCounts.get(ref.normalized) ?? 0) > 1))) {
			candidate.issues.push('competing-reference');
		}
		if (!candidate.issues.length) {
			match.status = 'reliable';
		}
		candidate.amounts.sort((left: MatchCandidate['amounts'][number], right: MatchCandidate['amounts'][number]): number => compare(left.basis, right.basis) || compare(left.documentFieldId, right.documentFieldId) || left.documentAmount.scale - right.documentAmount.scale);
	}
	match.candidates.sort((left: MatchCandidate, right: MatchCandidate): number => Number(Boolean(left.issues.length)) - Number(Boolean(right.issues.length)) ||
		Number(Boolean(right.date?.withinWindow)) - Number(Boolean(left.date?.withinWindow)) || compare(left.documentId, right.documentId) || compare(left.sectionId, right.sectionId));
}

export function suggestTransactionMatches(bankImports: readonly StoredBankImport[], documents: readonly StoredSupportingDocument[]): TransactionMatch[] {
	const index: Map<string, IndexedAmount[]> = indexDocumentAmounts(documents);
	const matches: TransactionMatch[] = [];
	const referenceCounts: Map<string, number> = new Map<string, number>();
	for (const record of bankImports) {
		const rows: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
		for (const { rowId, transactionId } of record.transactions) {
			const row: TransactionCandidate = rows.get(rowId)!;
			matches.push(matchTransaction(row, transactionId, index, referenceCounts));
		}
	}
	for (const match of matches) {
		finalizeMatch(match, referenceCounts);
	}
	return matches.sort((left: TransactionMatch, right: TransactionMatch): number => compare(left.transactionId, right.transactionId));
}
