import type { ImportIssue, SourceEvidence } from "../src/shared/bank-import.js";
import type { DocumentIssue } from "../src/shared/supporting-document.js";
import { formatAmountEntry } from '../src/shared/amount-entry.js';
import type { TransactionCandidate, UnresolvedDraft } from '../src/shared/bank-import.js';
import type { IReceiptAiChange } from '../src/shared/receipt-ai.js';
import { bankTransactionIds, statementAccountKey } from '../src/shared/statement-overlaps.js';
import type { DocumentSection } from '../src/shared/supporting-document.js';
import type { StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';

type Change = IReceiptAiChange;
type BankRow = TransactionCandidate | UnresolvedDraft;
type AccountSection = StoredBankImport['result']['accountSections'][number];
type BankRowReference = BankRow['references'][number];
interface IAmount { coefficient: string; scale: number; currency: string | null }
type SectionField = DocumentSection['amounts'][number] | DocumentSection['dates'][number] | DocumentSection['merchants'][number] |
	DocumentSection['references'][number] | DocumentSection['currencies'][number];

function compact(value: string): string {
	return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function shorten(value: string): string {
	return value.length > 600 ? value.slice(0, 597) + '…' : value;
}

function moneyKey(value: IAmount | undefined): (string | null)[] | null {
	return value ? [value.currency, (BigInt(value.coefficient) * 10n ** BigInt(18 - value.scale)).toString()] : null;
}

function showMoney(value: IAmount | undefined): string {
	return value ? [formatAmountEntry(value, '.'), value.currency ?? 'currency unknown'].join(' ') : 'Unknown amount';
}

function byKey<T>(values: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
	const groups: Map<string, T[]> = new Map<string, T[]>();
	for (const value of values) {
		const id: string | null = key(value);
		if (id === null) {
			continue;
		}
		const bucket: T[] = groups.get(id) ?? [];
		bucket.push(value);
		groups.set(id, bucket);
	}
	return groups;
}

interface IDifferences {
	add(label: string, before: string | null, after: string | null, details?: Pick<Change, 'kind' | 'section' | 'unrecognized'>): void;
	result(): Change[];
}

function differences(): IDifferences {
	const changes: Change[] = [];
	let omitted: number = 0;
	return {
		add(label: string, before: string | null, after: string | null, details?: Pick<Change, 'kind' | 'section' | 'unrecognized'>): void {
			if (changes.length >= 79) {
				omitted++; return;
			}
			changes.push({ label: shorten(label), before: before === null ? null : shorten(before), after: after === null ? null : shorten(after), ...details });
		},
		result(): Change[] {
			if (omitted) {
				changes.push({ label: 'Additional differences', before: null, after: String(omitted), kind: 'omitted' });
			}
			return changes;
		},
	};
}

function bankRows(record: StoredBankImport): IIndexedBankRow[] {
	const accounts: Map<string, IStatementAccount> = new Map(record.result.accountSections.map((section: AccountSection): [string, IStatementAccount] => [section.sectionId, {
		identity: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
	}]));
	const transactions: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
	const drafts: Map<string, UnresolvedDraft> = new Map(record.result.unresolvedDrafts.map((row: UnresolvedDraft): [string, UnresolvedDraft] => [row.rowId, row]));
	const makeRow: (id: string, row: BankRow, draft: boolean) => IIndexedBankRow = (id: string, row: BankRow, draft: boolean): IIndexedBankRow => {
		const account: IStatementAccount = accounts.get(row.accountSectionId)!;
		const scope: (string | null | undefined)[] = [record.result.adapter?.bankId, account.identity, account.currency];
		const ids: Set<string> = bankTransactionIds(row.references);
		const [identifier]: Set<string> = ids;
		const reference: string | null = ids.size === 1 && !draft && statementAccountKey(identifier) ? JSON.stringify([...scope, identifier]) : null;
		const date: (field: BankRow["bookingDate"]) => string[] | null = (field: BankRow['bookingDate']): string[] | null => field && [field.value, compact(field.basisLabel)];
		const references: string[] = row.references.map((field: BankRowReference): string => JSON.stringify([compact(field.label).toLowerCase(), compact(field.value)])).sort();
		const description: string = compact(row.description?.value ?? '');
		const draftEvidence: string[] = 'issues' in row ? row.evidence.map((evidence: SourceEvidence): string => compact(evidence.rawText)).sort() : [];
		const identifiable: boolean | "" | NonNullable<BankRow['bookingDate']> | NonNullable<BankRow['accountAmount']> | null =
			ids.size <= 1 && (account.identity ?? reference) && (!draft || (description && (row.bookingDate ?? row.accountAmount)));
		const signature: string | null = identifiable ? JSON.stringify([
			...scope, row.direction, draft, date(row.bookingDate), date(row.valueDate), moneyKey(row.accountAmount?.value), moneyKey(row.reportedOriginalAmount?.value),
			description, compact(row.counterpartyCandidate?.value ?? ''), references, draftEvidence,
			'issues' in row ? row.issues.map((issue: ImportIssue): string => JSON.stringify([issue.code, issue.field])).sort() : [],
		]) : null;
		return { id, row, draft, account: account.identity, reference, signature };
	};
	return [
		...record.transactions.map(({ transactionId, rowId }: StoredBankImport['transactions'][number]): IIndexedBankRow => makeRow(transactionId, transactions.get(rowId)!, false)),
		...record.drafts.map(({ draftId, rowId }: StoredBankImport['drafts'][number]): IIndexedBankRow => makeRow(draftId, drafts.get(rowId)!, true)),
	];
}

function bookingDescription(row: BankRow): string {
	return [
		row.bookingDate?.value ?? 'Unknown date', showMoney(row.accountAmount?.value), shorten(compact(row.description?.value ?? '')),
		...(row.valueDate ? ['Value date: ' + row.valueDate.value] : []),
		...(row.reportedOriginalAmount ? ['Original: ' + showMoney(row.reportedOriginalAmount.value)] : []),
		...(row.counterpartyCandidate ? ['Counterparty: ' + compact(row.counterpartyCandidate.value)] : []),
		...row.references.map((field: BankRowReference): string => compact(field.label) + ': ' + compact(field.value)),
	].filter(Boolean).join(' · ');
}

interface IStatementAccount { identity: string | null; currency: string }
interface IIndexedBankRow { id: string; row: BankRow; draft: boolean; account: string | null; reference: string | null; signature: string | null }
interface IStatementComparisonIndex {
	oldKeys: Map<string, IIndexedBankRow[]>;
	newKeys: Map<string, IIndexedBankRow[]>;
	oldRefs: Map<string, IIndexedBankRow[]>;
	newRefs: Map<string, IIndexedBankRow[]>;
}
interface IPairedBankRow { kind: 'unchanged' | 'changed'; row: IIndexedBankRow }
type RowPairing = Record<'kind', 'missing' | 'ambiguous'> | IPairedBankRow;

function pairBankRow(previous: IIndexedBankRow, index: IStatementComparisonIndex): RowPairing {
	const { signature, reference }: IIndexedBankRow = previous;
	const previousRefs: IIndexedBankRow[] = reference ? index.oldRefs.get(reference) ?? [] : [];
	const nextRefs: IIndexedBankRow[] = reference ? index.newRefs.get(reference) ?? [] : [];
	const possible: IIndexedBankRow[] = signature ? index.newKeys.get(signature) ?? [] : [];
	if (previousRefs.length > 1 || nextRefs.length > 1 || possible.length > 1 || (possible.length > 0 && index.oldKeys.get(signature!)!.length > 1)) {
		return { kind: 'ambiguous' };
	}
	if (possible.length === 1) {
		return { kind: 'unchanged', row: possible[0] };
	}
	if (previous.account && previousRefs.length === 1 && nextRefs.length === 1 && previous.row.direction === nextRefs[0].row.direction) {
		return { kind: 'changed', row: nextRefs[0] };
	}
	return { kind: 'missing' };
}

function compareStatementAccounts(old: StoredBankImport, next: StoredBankImport, diff: IDifferences, conflicts: string[]): boolean {
	const accounts: (record: StoredBankImport) => IStatementAccount[] = (record: StoredBankImport): IStatementAccount[] =>
		record.result.accountSections.map((section: AccountSection): IStatementAccount => ({
			identity: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
		}));
	const oldAccounts: IStatementAccount[] = accounts(old), newAccounts: IStatementAccount[] = accounts(next);
	const oldBank: string | undefined = old.result.adapter?.bankId, newBank: string | undefined = next.result.adapter?.bankId;
	const sameBank: boolean = Boolean(oldBank && oldBank === newBank);
	const accountKeys: (values: IStatementAccount[]) => string[] = (values: IStatementAccount[]): string[] => values.map((value: IStatementAccount): string => JSON.stringify([value.currency, value.identity])).sort();
	const knownAccounts: boolean = oldAccounts.every((value: IStatementAccount): string | null => value.identity) && newAccounts.every((value: IStatementAccount): string | null => value.identity);
	const sameAccounts: boolean = JSON.stringify(accountKeys(oldAccounts)) === JSON.stringify(accountKeys(newAccounts));
	const sameCurrencies: boolean = oldAccounts.map((value: IStatementAccount): string => value.currency).sort().join(',') === newAccounts.map((value: IStatementAccount): string => value.currency).sort().join(',');
	const compatible: boolean = sameBank && (knownAccounts || oldAccounts.length > 1 || newAccounts.length > 1 ? sameAccounts : sameCurrencies &&
		(!oldAccounts[0]?.identity || !newAccounts[0]?.identity));
	if (!oldBank || !newBank) {
		conflicts.push('The bank identity could not be confirmed for both statements.');
	} else if (!sameBank) {
		conflicts.push('The selected statement is from a different bank.');
	} else if (!compatible) {
		conflicts.push('The selected statement belongs to a different known account.');
	} else if (!knownAccounts) {
		conflicts.push('The account identity could not be confirmed for both statements. Verify that the replacement is for the same account.');
	}
	const describeAccounts: (values: IStatementAccount[]) => string = (values: IStatementAccount[]): string => values.map((value: IStatementAccount): string =>
		(value.identity ?? 'Account not identified') + ' · ' + value.currency).sort().join(', ');
	const beforeAccounts: string = describeAccounts(oldAccounts), afterAccounts: string = describeAccounts(newAccounts);
	if (beforeAccounts !== afterAccounts) {
		diff.add('Statement accounts', beforeAccounts, afterAccounts);
	}
	return compatible;
}

interface IPairedBankRows {
	pairs: Map<string, string>;
	draftPairs: Map<string, string>;
	changedPairs: Map<string, string>;
}

function compareBankRows(oldRows: IIndexedBankRow[], newRows: IIndexedBankRow[], index: IStatementComparisonIndex, compatible: boolean, diff: IDifferences, conflicts: string[]): IPairedBankRows {
	const result: IPairedBankRows = { pairs: new Map(), changedPairs: new Map(), draftPairs: new Map() };
	const used: Set<string> = new Set<string>();
	let ambiguous: number = 0;
	for (const previous of oldRows) {
		const pairing: RowPairing = compatible ? pairBankRow(previous, index) : { kind: 'missing' };
		if ('row' in pairing) {
			recordBankPair(previous, pairing.kind, pairing.row, result, diff);
			used.add(pairing.row.id);
			continue;
		}
		if (pairing.kind === 'ambiguous') {
			ambiguous++;
		}
		diff.add(previous.draft ? 'Removed unresolved booking' : 'Removed booking', bookingDescription(previous.row), null);
	}
	newRows.forEach((row: IIndexedBankRow): void => {
		if (!used.has(row.id)) {
			diff.add(row.draft ? 'Added unresolved booking' : 'Added booking', null, bookingDescription(row.row));
		}
	});
	if (ambiguous) {
		conflicts.push(ambiguous + ' earlier booking(s) have non-unique matches in the statements.');
	}
	return result;
}

function recordBankPair(previous: IIndexedBankRow, kind: 'unchanged' | 'changed', replacement: IIndexedBankRow, result: IPairedBankRows, diff: IDifferences): void {
	if (kind === 'changed') {
		result.changedPairs.set(previous.id, replacement.id);
		diff.add('Changed booking', bookingDescription(previous.row), bookingDescription(replacement.row));
	} else {
		(previous.draft ? result.draftPairs : result.pairs).set(previous.id, replacement.id);
	}
}

interface IStatementComparisonDetails { compatible: boolean; changes: Change[]; conflicts: string[] }

export function compareStatements(old: StoredBankImport, next: StoredBankImport): IPairedBankRows & IStatementComparisonDetails {
	const oldRows: IIndexedBankRow[] = bankRows(old), newRows: IIndexedBankRow[] = bankRows(next);
	const signature: (row: IIndexedBankRow) => string | null = (row: IIndexedBankRow): string | null => row.signature;

	const reference: (row: IIndexedBankRow) => string | null = (row: IIndexedBankRow): string | null => row.reference;
	const index: IStatementComparisonIndex = {
		oldKeys: byKey(oldRows, signature), newKeys: byKey(newRows, signature),
		oldRefs: byKey(oldRows, reference), newRefs: byKey(newRows, reference),
	};
	const conflicts: string[] = [], diff: IDifferences = differences();
	const compatible: boolean = compareStatementAccounts(old, next, diff, conflicts);
	const bookIssues: (record: StoredBankImport) => string = (record: StoredBankImport): string => record.result.issues.map((issue: ImportIssue): string => issue.code).sort().join(', ');
	const beforeIssues: string = bookIssues(old), afterIssues: string = bookIssues(next);
	if (beforeIssues !== afterIssues) {
		diff.add('Statement analysis warnings', beforeIssues || null, afterIssues || null);
	}
	const paired: IPairedBankRows = compareBankRows(oldRows, newRows, index, compatible, diff, conflicts);
	return { compatible, ...paired, changes: diff.result(), conflicts };
}

function fields(section: DocumentSection): SectionField[] {
	return [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies];
}

function fieldKey(field: SectionField): string {
	return JSON.stringify([field.role, compact(field.label), field.candidates.map((value: string | IAmount): string =>
		JSON.stringify(typeof value === 'string' ? compact(value) : moneyKey(value))).sort(),
		field.candidates.length !== 1 ? field.evidence.map((evidence: SourceEvidence): string => compact(evidence.rawText)).sort() : []]);
}

function sectionKey(section: DocumentSection): string {
	return JSON.stringify([section.kind, fields(section).map(fieldKey).sort()]);
}
const sectionReferenceRoles: Set<string> = new Set(['invoice', 'receipt', 'order']);
function references(section: DocumentSection): string[] {
	return [...new Set(section.references.filter((field: DocumentSection['references'][number]): boolean => sectionReferenceRoles.has(field.role) && field.candidates.length === 1)
		.map((field: DocumentSection['references'][number]): string => compact(field.candidates[0])).filter(Boolean))].sort();
}

function sectionReferenceKey(section: DocumentSection): string | null {
	const ids: string[] = references(section);
	return ids.length === 1 ? JSON.stringify([section.kind, ids[0]]) : null;
}

function merchants(section: DocumentSection): string[] {
	return section.merchants.filter((field: DocumentSection['merchants'][number]): boolean => field.candidates.length === 1)
		.map((field: DocumentSection['merchants'][number]): string => compact(field.candidates[0]).toLowerCase()).filter(Boolean);
}

interface IMerchantComparison { beforeMerchants: string[]; afterMerchants: string[]; shared: boolean }

function sharesMerchant(before: DocumentSection, after: DocumentSection): IMerchantComparison {
	const beforeMerchants: string[] = merchants(before), afterMerchants: string[] = merchants(after);
	return { beforeMerchants, afterMerchants, shared: beforeMerchants.some((merchant: string): boolean => afterMerchants.includes(merchant)) };
}

function singletonCorresponds(before: DocumentSection, after: DocumentSection): boolean {
	if (before.kind !== after.kind || !['invoice', 'receipt', 'credit-note'].includes(before.kind)) {
		return false;
	}
	const oldIds: string[] = references(before), newIds: string[] = references(after);
	if (oldIds.length && newIds.length && !oldIds.some((id: string): boolean => newIds.includes(id))) {
		return false;
	}
	return sharesMerchant(before, after).shared;
}

const comparisonRoleNames: Partial<Record<SectionField['role'], string>> = {
	invoice: 'Invoice reference', receipt: 'Receipt reference', order: 'Order reference', settlement: 'Billing currency',
	issue: 'Issue date', due: 'Due date', merchant: 'Merchant', unknown: 'Unclassified field'
};

function displayRole(field: SectionField): string {
	return comparisonRoleNames[field.role] ?? field.role.replaceAll('-', ' ').replace(/^./, (char: string): string => char.toUpperCase());
}

function displayField(field: SectionField): string {
	return field.candidates.length ? field.candidates.map((value: string | IAmount): string => typeof value === 'string' ? compact(value) : showMoney(value)).join(' / ')
		: 'No value recognized';
}

function addOneSidedField(diff: IDifferences, field: SectionField, removed: boolean, section?: string): void {
	const value: string = displayField(field);
	diff.add(displayRole(field), removed ? value : null, removed ? null : value, { section, unrecognized: field.candidates.length ? undefined : true });
}

function pairDocumentSections(before: DocumentSection[], after: DocumentSection[], sections: Map<string, string>, used: Set<string>): void {
	const oldSignatures: Map<string, DocumentSection[]> = byKey(before, sectionKey), newSignatures: Map<string, DocumentSection[]> = byKey(after, sectionKey);
	const oldRefs: Map<string, DocumentSection[]> = byKey(before, sectionReferenceKey), newRefs: Map<string, DocumentSection[]> = byKey(after, sectionReferenceKey);
	const pair: (previous: DocumentSection, candidate: DocumentSection) => void = (previous: DocumentSection, candidate: DocumentSection): void => {
		sections.set(previous.sectionId, candidate.sectionId);
		used.add(candidate.sectionId);
	};
	for (const previous of before) {
		const key: string = sectionKey(previous), matches: DocumentSection[] | undefined = newSignatures.get(key);
		if (oldSignatures.get(key)?.length === 1 && matches?.length === 1) {
			pair(previous, matches[0]);
		}
	}
	for (const previous of before) {
		if (sections.has(previous.sectionId)) {
			continue;
		}
		const key: string | null = sectionReferenceKey(previous);
		const matches: DocumentSection[] | undefined = key ? newRefs.get(key) : undefined;
		if (!key || oldRefs.get(key)?.length !== 1 || matches?.length !== 1 || used.has(matches[0].sectionId)) {
			continue;
		}
		const { beforeMerchants, afterMerchants, shared }: IMerchantComparison = sharesMerchant(previous, matches[0]);
		if (!beforeMerchants.length || !afterMerchants.length || shared) {
			pair(previous, matches[0]);
		}
	}
	if (!sections.size && before.length === 1 && after.length === 1 && singletonCorresponds(before[0], after[0])) {
		pair(before[0], after[0]);
	}
}

function compareFieldRoles(removed: SectionField[], added: SectionField[], diff: IDifferences): void {
	const oldRoles: Map<string, SectionField[]> = byKey(removed, (field: SectionField): SectionField['role'] => field.role), newRoles: Map<string, SectionField[]> = byKey(added, (field: SectionField): SectionField['role'] => field.role);
	for (const [role, entries] of oldRoles) {
		const replacements: SectionField[] | undefined = newRoles.get(role);
		if (entries.length === 1 && replacements?.length === 1) {
			addFieldDifference(entries[0], replacements[0], diff);
			newRoles.delete(role);
		} else {
			for (const entry of entries) {
				addOneSidedField(diff, entry, true);
			}
		}
	}
	for (const entries of newRoles.values()) {
		for (const entry of entries) {
			addOneSidedField(diff, entry, false);
		}
	}
}

function addFieldDifference(left: SectionField, right: SectionField, diff: IDifferences): void {
	const leftValue: string = displayField(left), rightValue: string = displayField(right);
	const sameValue: boolean = leftValue === rightValue;
	diff.add(displayRole(left), sameValue ? compact(left.label) + ' · ' + leftValue : leftValue,
		sameValue ? compact(right.label) + ' · ' + rightValue : rightValue);
}

function compareSectionFields(previous: DocumentSection, candidate: DocumentSection, matchedFields: Map<string, string>, diff: IDifferences): number {
	let ambiguousFields: number = 0;
	const previousFields: ReturnType<typeof fields> = fields(previous), candidateFields: ReturnType<typeof fields> = fields(candidate);
	const oldFields: Map<string, SectionField[]> = byKey(previousFields, fieldKey), newFields: Map<string, SectionField[]> = byKey(candidateFields, fieldKey);
	const removed: SectionField[] = [], added: SectionField[] = [];
	for (const [key, entries] of oldFields) {
		const replacements: SectionField[] = newFields.get(key) ?? [];
		if (entries.length === 1 && replacements.length === 1) {
			matchedFields.set(entries[0].id, replacements[0].id);
		} else if (replacements.length) {
			ambiguousFields += entries.length;
		}
		removed.push(...entries.slice(replacements.length));
	}
	for (const [key, entries] of newFields) {
		added.push(...entries.slice(oldFields.get(key)?.length ?? 0));
	}
	compareFieldRoles(removed, added, diff);
	return ambiguousFields;
}

type DocumentAnalysis = Pick<StoredSupportingDocument, 'result'>;
interface IDocumentComparison { sections: Map<string, string>; fields: Map<string, string>; changes: Change[]; conflicts: string[] }

export function compareDocuments(old: DocumentAnalysis | null, next: DocumentAnalysis): IDocumentComparison {
	const before: DocumentSection[] = old?.result.sections ?? [], after: DocumentSection[] = next.result.sections;
	const sections: Map<string, string> = new Map<string, string>(), matchedFields: Map<string, string> = new Map<string, string>();
	const used: Set<string> = new Set<string>(), conflicts: string[] = [], diff: IDifferences = differences();
	const documentIssues: (record: DocumentAnalysis | null) => string = (record: DocumentAnalysis | null): string =>
		(record?.result.issues ?? []).map((issue: DocumentIssue): string => issue.code).sort().join(', ');
	const beforeIssues: string = documentIssues(old), afterIssues: string = documentIssues(next);
	if (beforeIssues !== afterIssues) {
		diff.add('Document analysis warnings', beforeIssues || null, afterIssues || null, { kind: 'warnings' });
	}
	pairDocumentSections(before, after, sections, used);
	const afterById: Map<string, DocumentSection> = new Map(after.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
	let ambiguousFields: number = 0;
	for (const [index, previous] of before.entries()) {
		const candidate: DocumentSection | undefined = afterById.get(sections.get(previous.sectionId) ?? '');
		if (!candidate) {
			const section: string = 'Section ' + (index + 1) + ' · ' + previous.kind.replaceAll('-', ' ');
			diff.add('Removed document section', section, null, { kind: 'section' });
			for (const field of fields(previous)) {
				addOneSidedField(diff, field, true, section);
			}
			continue;
		}
		ambiguousFields += compareSectionFields(previous, candidate, matchedFields, diff);
	}
	for (const [index, section] of after.entries()) {
		if (!used.has(section.sectionId)) {
			const heading: string = 'Section ' + (index + 1) + ' · ' + section.kind.replaceAll('-', ' ');
			diff.add('Added document section', null, heading, { kind: 'section' });
		for (const field of fields(section)) {
			addOneSidedField(diff, field, false, heading);
		}
	}
	}
	if (before.length > sections.size) {
		conflicts.push((before.length - sections.size) + ' earlier document section(s) could not be matched unambiguously.');
	}
	if (ambiguousFields) {
		conflicts.push(ambiguousFields + ' earlier document field(s) have non-unique matches in the analyses.');
	}
	return { sections, fields: matchedFields, changes: diff.result(), conflicts };
}
