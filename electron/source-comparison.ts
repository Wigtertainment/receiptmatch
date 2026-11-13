import { formatAmountEntry } from '../src/shared/amount-entry.js';
import type { TransactionCandidate, UnresolvedDraft } from '../src/shared/bank-import.js';
import type { OriginalAnalysisComparison } from '../src/shared/original-preview.js';
import { bankTransactionIds, statementAccountKey } from '../src/shared/statement-overlaps.js';
import type { DocumentSection } from '../src/shared/supporting-document.js';
import type { StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';

type Change = OriginalAnalysisComparison['changes'][number];
type BankRow = TransactionCandidate | UnresolvedDraft;
interface Amount { coefficient: string; scale: number; currency: string | null }
type SectionField = DocumentSection['amounts'][number] | DocumentSection['dates'][number] | DocumentSection['merchants'][number] |
	DocumentSection['references'][number] | DocumentSection['currencies'][number];

function compact(value: string) { return value.normalize('NFC').trim().replace(/\s+/g, ' '); }
function shorten(value: string) { return value.length > 600 ? value.slice(0, 597) + '…' : value; }
function moneyKey(value: Amount | undefined) {
	return value ? [value.currency, (BigInt(value.coefficient) * 10n ** BigInt(18 - value.scale)).toString()] : null;
}
function showMoney(value: Amount | undefined) {
	return value ? [formatAmountEntry(value, '.'), value.currency ?? 'currency unknown'].join(' ') : 'Unknown amount';
}
function byKey<T>(values: readonly T[], key: (item: T) => string | null) {
	const groups = new Map<string, T[]>();
	for (const value of values) {
		const id = key(value);
		if (id === null) continue;
		const bucket = groups.get(id) ?? [];
		bucket.push(value);
		groups.set(id, bucket);
	}
	return groups;
}
function differences() {
	const changes: Change[] = [];
	let omitted = 0;
	return {
		add(label: string, before: string | null, after: string | null) {
			if (changes.length >= 79) { omitted++; return; }
			changes.push({ label: shorten(label), before: before === null ? null : shorten(before), after: after === null ? null : shorten(after) });
		},
		result() {
			if (omitted) changes.push({ label: 'Additional differences', before: null, after: String(omitted) });
			return changes;
		},
	};
}

function bankRows(record: StoredBankImport) {
	const accounts = new Map(record.result.accountSections.map(section => [section.sectionId, {
		identity: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
	}]));
	const transactions = new Map(record.result.transactions.map(row => [row.rowId, row]));
	const drafts = new Map(record.result.unresolvedDrafts.map(row => [row.rowId, row]));
	const makeRow = (id: string, row: BankRow, draft: boolean) => {
		const account = accounts.get(row.accountSectionId)!;
		const scope = [record.result.adapter?.bankId, account.identity, account.currency];
		const ids = bankTransactionIds(row.references);
		const [identifier] = ids;
		const reference = ids.size === 1 && !draft && statementAccountKey(identifier) ? JSON.stringify([...scope, identifier]) : null;
		const date = (field: BankRow['bookingDate']) => field && [field.value, compact(field.basisLabel)];
		const references = row.references.map(field => JSON.stringify([compact(field.label).toLowerCase(), compact(field.value)])).sort();
		const description = compact(row.description?.value ?? '');
		const draftEvidence = 'issues' in row ? row.evidence.map(evidence => compact(evidence.rawText)).sort() : [];
		const identifiable = ids.size <= 1 && (account.identity || reference) && (!draft || (description && (row.bookingDate || row.accountAmount)));
		const signature = identifiable ? JSON.stringify([
			...scope, row.direction, draft, date(row.bookingDate), date(row.valueDate), moneyKey(row.accountAmount?.value), moneyKey(row.reportedOriginalAmount?.value),
			description, compact(row.counterpartyCandidate?.value ?? ''), references, draftEvidence,
			'issues' in row ? row.issues.map(issue => JSON.stringify([issue.code, issue.field])).sort() : [],
		]) : null;
		return { id, row, draft, account: account.identity, reference, signature };
	};
	return [
		...record.transactions.map(({ transactionId, rowId }) => makeRow(transactionId, transactions.get(rowId)!, false)),
		...record.drafts.map(({ draftId, rowId }) => makeRow(draftId, drafts.get(rowId)!, true)),
	];
}

function bookingDescription(row: BankRow) {
	return [
		row.bookingDate?.value ?? 'Unknown date', showMoney(row.accountAmount?.value), shorten(compact(row.description?.value ?? '')),
		...(row.valueDate ? ['Value date: ' + row.valueDate.value] : []),
		...(row.reportedOriginalAmount ? ['Original: ' + showMoney(row.reportedOriginalAmount.value)] : []),
		...(row.counterpartyCandidate ? ['Counterparty: ' + compact(row.counterpartyCandidate.value)] : []),
		...row.references.map(field => compact(field.label) + ': ' + compact(field.value)),
	].filter(Boolean).join(' · ');
}

export function compareStatements(old: StoredBankImport, next: StoredBankImport) {
	const oldRows = bankRows(old), newRows = bankRows(next);
	const oldKeys = byKey(oldRows, row => row.signature), newKeys = byKey(newRows, row => row.signature);
	const oldRefs = byKey(oldRows, row => row.reference), newRefs = byKey(newRows, row => row.reference);
	const pairs = new Map<string, string>(), draftPairs = new Map<string, string>(), changedPairs = new Map<string, string>();
	const used = new Set<string>(), conflicts: string[] = [], diff = differences();
	const accounts = (record: StoredBankImport) => record.result.accountSections.map(section => ({
		identity: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
	}));
	const oldAccounts = accounts(old), newAccounts = accounts(next);
	const sameBank = old.result.adapter?.bankId === next.result.adapter?.bankId;
	const accountKeys = (values: ReturnType<typeof accounts>) => values.map(value => JSON.stringify([value.currency, value.identity])).sort();
	const knownAccounts = oldAccounts.every(value => value.identity) && newAccounts.every(value => value.identity);
	const sameAccounts = JSON.stringify(accountKeys(oldAccounts)) === JSON.stringify(accountKeys(newAccounts));
	const sameCurrencies = oldAccounts.map(value => value.currency).sort().join(',') === newAccounts.map(value => value.currency).sort().join(',');
	const compatible = sameBank && (knownAccounts || oldAccounts.length > 1 || newAccounts.length > 1 ? sameAccounts : sameCurrencies &&
		(!oldAccounts[0]?.identity || !newAccounts[0]?.identity));
	if (!sameBank) conflicts.push('The selected statement is from a different bank.');
	else if (!compatible) conflicts.push('The selected statement belongs to a different known account.');
	else if (!knownAccounts) conflicts.push('The account identity could not be confirmed for both statements. Verify that the replacement is for the same account.');
	const describeAccounts = (values: ReturnType<typeof accounts>) => values.map(value =>
		(value.identity ?? 'Account not identified') + ' · ' + value.currency).sort().join(', ');
	const beforeAccounts = describeAccounts(oldAccounts), afterAccounts = describeAccounts(newAccounts);
	if (beforeAccounts !== afterAccounts) diff.add('Statement accounts', beforeAccounts, afterAccounts);
	const bookIssues = (record: StoredBankImport) => record.result.issues.map(issue => issue.code).sort().join(', ');
	const beforeIssues = bookIssues(old), afterIssues = bookIssues(next);
	if (beforeIssues !== afterIssues) diff.add('Statement analysis warnings', beforeIssues || null, afterIssues || null);
	let ambiguous = 0;
	for (const previous of oldRows) {
		const { signature, reference } = previous;
		const previousRefs = reference ? oldRefs.get(reference) ?? [] : [];
		const nextRefs = reference ? newRefs.get(reference) ?? [] : [];
		const possible = signature ? newKeys.get(signature) ?? [] : [];
		if (compatible && (previousRefs.length > 1 || nextRefs.length > 1 || possible.length > 1 || (possible.length && oldKeys.get(signature!)!.length > 1))) {
			ambiguous++;
		} else if (compatible && possible.length === 1) {
			(previous.draft ? draftPairs : pairs).set(previous.id, possible[0].id);
			used.add(possible[0].id);
			continue;
		} else if (compatible && previous.account && previousRefs.length === 1 && nextRefs.length === 1 && previous.row.direction === nextRefs[0].row.direction) {
			changedPairs.set(previous.id, nextRefs[0].id);
			used.add(nextRefs[0].id);
			diff.add('Changed booking', bookingDescription(previous.row), bookingDescription(nextRefs[0].row));
			continue;
		}
		diff.add(previous.draft ? 'Removed unresolved booking' : 'Removed booking', bookingDescription(previous.row), null);
	}
	for (const row of newRows) if (!used.has(row.id)) diff.add(row.draft ? 'Added unresolved booking' : 'Added booking', null, bookingDescription(row.row));
	if (ambiguous) conflicts.push(ambiguous + ' earlier booking(s) have non-unique matches in the statements.');
	return { compatible, pairs, changedPairs, draftPairs, changes: diff.result(), conflicts };
}

function fields(section: DocumentSection) {
	return [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies];
}
function fieldKey(field: SectionField) {
	return JSON.stringify([field.role, compact(field.label), field.candidates.map(value =>
		JSON.stringify(typeof value === 'string' ? compact(value) : moneyKey(value))).sort(),
		field.candidates.length !== 1 ? field.evidence.map(evidence => compact(evidence.rawText)).sort() : []]);
}
function sectionKey(section: DocumentSection) {
	return JSON.stringify([section.kind, fields(section).map(fieldKey).sort()]);
}
const sectionReferenceRoles = new Set(['invoice', 'receipt', 'order']);
function references(section: DocumentSection) {
	return [...new Set(section.references.filter(field => sectionReferenceRoles.has(field.role) && field.candidates.length === 1)
		.map(field => compact(field.candidates[0])).filter(Boolean))].sort();
}
function sectionReferenceKey(section: DocumentSection) {
	const ids = references(section);
	return ids.length === 1 ? JSON.stringify([section.kind, ids[0]]) : null;
}
function merchants(section: DocumentSection) {
	return section.merchants.filter(field => field.candidates.length === 1).map(field => compact(field.candidates[0]).toLowerCase()).filter(Boolean);
}
function sharesMerchant(before: DocumentSection, after: DocumentSection) {
	const beforeMerchants = merchants(before), afterMerchants = merchants(after);
	return { beforeMerchants, afterMerchants, shared: beforeMerchants.some(merchant => afterMerchants.includes(merchant)) };
}
function singletonCorresponds(before: DocumentSection, after: DocumentSection) {
	if (before.kind !== after.kind || !['invoice', 'receipt', 'credit-note'].includes(before.kind)) return false;
	const oldIds = references(before), newIds = references(after);
	if (oldIds.length && newIds.length && !oldIds.some(id => newIds.includes(id))) return false;
	return sharesMerchant(before, after).shared;
}
function displayRole(field: SectionField) { return field.role.replaceAll('-', ' ').replace(/^./, char => char.toUpperCase()); }
function displayField(field: SectionField) {
	return field.candidates.length ? field.candidates.map(value => typeof value === 'string' ? compact(value) : showMoney(value)).join(' / ') : 'No value recognized';
}

export function compareDocuments(old: StoredSupportingDocument, next: StoredSupportingDocument) {
	const before = old.result.sections, after = next.result.sections;
	const oldSignatures = byKey(before, sectionKey), newSignatures = byKey(after, sectionKey);
	const oldRefs = byKey(before, sectionReferenceKey), newRefs = byKey(after, sectionReferenceKey);
	const sections = new Map<string, string>(), matchedFields = new Map<string, string>();
	const used = new Set<string>(), conflicts: string[] = [], diff = differences();
	const documentIssues = (record: StoredSupportingDocument) => record.result.issues.map(issue => issue.code).sort().join(', ');
	const beforeIssues = documentIssues(old), afterIssues = documentIssues(next);
	if (beforeIssues !== afterIssues) diff.add('Document analysis warnings', beforeIssues || null, afterIssues || null);
	const pair = (previous: DocumentSection, candidate: DocumentSection) => {
		sections.set(previous.sectionId, candidate.sectionId);
		used.add(candidate.sectionId);
	};
	for (const previous of before) {
		const key = sectionKey(previous), matches = newSignatures.get(key);
		if (oldSignatures.get(key)?.length === 1 && matches?.length === 1) pair(previous, matches[0]);
	}
	for (const previous of before) {
		if (sections.has(previous.sectionId)) continue;
		const key = sectionReferenceKey(previous);
		const matches = key ? newRefs.get(key) : undefined;
		if (!key || oldRefs.get(key)?.length !== 1 || matches?.length !== 1 || used.has(matches[0].sectionId)) continue;
		const { beforeMerchants, afterMerchants, shared } = sharesMerchant(previous, matches[0]);
		if (!beforeMerchants.length || !afterMerchants.length || shared) pair(previous, matches[0]);
	}
	if (!sections.size && before.length === 1 && after.length === 1 && singletonCorresponds(before[0], after[0])) pair(before[0], after[0]);
	const afterById = new Map(after.map(section => [section.sectionId, section]));
	let ambiguousFields = 0;
	for (const [index, previous] of before.entries()) {
		const candidate = afterById.get(sections.get(previous.sectionId) ?? '');
		if (!candidate) {
			diff.add('Removed document section', 'Section ' + (index + 1) + ' · ' + previous.kind, null);
			for (const field of fields(previous)) diff.add(displayRole(field), displayField(field), null);
			continue;
		}
		const previousFields = fields(previous), candidateFields = fields(candidate);
		const oldFields = byKey(previousFields, fieldKey), newFields = byKey(candidateFields, fieldKey);
		const removed: SectionField[] = [], added: SectionField[] = [];
		for (const [key, entries] of oldFields) {
			const replacements = newFields.get(key) ?? [];
			if (entries.length === 1 && replacements.length === 1) matchedFields.set(entries[0].id, replacements[0].id);
			else if (replacements.length) ambiguousFields += entries.length;
			removed.push(...entries.slice(replacements.length));
		}
		for (const [key, entries] of newFields) added.push(...entries.slice(oldFields.get(key)?.length ?? 0));
		const oldRoles = byKey(removed, field => field.role), newRoles = byKey(added, field => field.role);
		for (const [role, entries] of oldRoles) {
			const replacements = newRoles.get(role);
			if (entries.length === 1 && replacements?.length === 1) {
				const left = entries[0], right = replacements[0];
				const leftValue = displayField(left), rightValue = displayField(right);
				diff.add(displayRole(left), leftValue === rightValue ? compact(left.label) + ' · ' + leftValue : leftValue,
					leftValue === rightValue ? compact(right.label) + ' · ' + rightValue : rightValue);
				newRoles.delete(role);
			} else for (const entry of entries) diff.add(displayRole(entry), displayField(entry), null);
		}
		for (const entries of newRoles.values()) for (const entry of entries) diff.add(displayRole(entry), null, displayField(entry));
	}
	for (const [index, section] of after.entries()) if (!used.has(section.sectionId)) {
		diff.add('Added document section', null, 'Section ' + (index + 1) + ' · ' + section.kind);
		for (const field of fields(section)) diff.add(displayRole(field), null, displayField(field));
	}
	if (before.length > sections.size) conflicts.push((before.length - sections.size) + ' earlier document section(s) could not be matched unambiguously.');
	if (ambiguousFields) conflicts.push(ambiguousFields + ' earlier document field(s) have non-unique matches in the analyses.');
	return { sections, fields: matchedFields, changes: diff.result(), conflicts };
}
