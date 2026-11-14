import { z } from 'zod';
import { bankTransactionIds, statementAccountKey } from './statement-overlaps.js';
import type { StoredBankImport } from './workspace-import.js';

const duplicateDecisionSchema = z.strictObject({
	firstId: z.uuid(),
	secondId: z.uuid(),
	primaryId: z.uuid().nullable(),
	archivedReview: z.strictObject({ documentId: z.uuid().nullable() }).nullable(),
}).refine(({ firstId, secondId, primaryId, archivedReview }) => firstId < secondId &&
	(primaryId === null ? archivedReview === null : primaryId === firstId || primaryId === secondId));

export type DuplicateDecision = z.infer<typeof duplicateDecisionSchema>;

export function duplicatePairKey(firstId: string, secondId: string): string {
	return firstId < secondId ? firstId + ':' + secondId : secondId + ':' + firstId;
}

export function secondaryDuplicateId({ firstId, secondId, primaryId }: DuplicateDecision): string | null {
	return primaryId === null ? null : primaryId === firstId ? secondId : firstId;
}

export function validateDuplicateDecisions(decisions: Iterable<DuplicateDecision>, imports: readonly StoredBankImport[]): Map<string, DuplicateDecision> {
	const result = new Map<string, DuplicateDecision>(), primaryBySecondary = new Map<string, string>();
	const parsed = [...decisions].map(value => duplicateDecisionSchema.parse(value));
	if (!parsed.length) return result;
	const referenced = new Set(parsed.flatMap(({ firstId, secondId }) => [firstId, secondId]));
	const owners = new Map(imports.flatMap(record => {
		const selected = record.transactions.filter(row => referenced.has(row.transactionId));
		if (!selected.length) return [];
		const rows = new Map(record.result.transactions.map(row => [row.rowId, row]));
		const accounts = new Map(record.result.accountSections.map(account => [account.sectionId, account]));
		return selected.flatMap(({ transactionId, rowId }) => {
			const row = rows.get(rowId), account = row && accounts.get(row.accountSectionId);
			return row && account ? [[transactionId, { statementId: record.id, account: statementAccountKey(account.accountReference?.value),
				scope: JSON.stringify([record.result.adapter?.bankId, account.currency.value, row.direction]), references: bankTransactionIds(row.references) }] as const] : [];
		});
	}));
	for (const decision of parsed) {
		const { firstId, secondId, primaryId } = decision;
		const firstOwner = owners.get(firstId), secondOwner = owners.get(secondId);
		const key = duplicatePairKey(firstId, secondId);
		if (!firstOwner || !secondOwner || firstOwner.statementId === secondOwner.statementId || result.has(key)) {
			throw new Error('Duplicate decisions must refer to two bookings from different statements.');
		}
		const secondaryId = secondaryDuplicateId(decision);
		if (primaryId && secondaryId) {
			if (primaryBySecondary.has(secondaryId)) throw new Error('This booking already has a leading booking. Undo that decision first.');
			primaryBySecondary.set(secondaryId, primaryId);
		}
		result.set(key, decision);
	}
	if ([...primaryBySecondary.values()].some(id => primaryBySecondary.has(id))) {
		throw new Error('A leading booking cannot also be excluded. Undo the conflicting duplicate decision first.');
	}
	const groups = new Map<string, { statements: Set<string>; accounts: Set<string>; references: Set<string> }>();
	for (const [secondary, primary] of primaryBySecondary) {
		const kept = owners.get(primary)!, excluded = owners.get(secondary)!;
		const group = groups.get(primary) ?? { statements: new Set([kept.statementId]), accounts: new Set(kept.account ? [kept.account] : []), references: new Set(kept.references) };
		if (group.statements.has(excluded.statementId)) {
			throw new Error('A duplicate group can contain only one booking per statement.');
		}
		group.statements.add(excluded.statementId);
		if (excluded.account) group.accounts.add(excluded.account);
		for (const reference of excluded.references) group.references.add(reference);
		if (kept.scope !== excluded.scope || group.accounts.size > 1 || group.references.size > 1) {
			throw new Error('The duplicate group contains conflicting bank, account or transaction identifiers.');
		}
		groups.set(primary, group);
	}
	for (const { firstId, secondId, primaryId } of result.values()) {
		if (primaryId === null && (primaryBySecondary.get(firstId) ?? firstId) === (primaryBySecondary.get(secondId) ?? secondId)) {
			throw new Error('These bookings were kept separate. Undo the conflicting duplicate decision first.');
		}
	}
	return result;
}

export function excludedDuplicateIds(decisions: Iterable<DuplicateDecision>): Set<string> {
	const excluded = new Set<string>();
	for (const decision of decisions) {
		const id = secondaryDuplicateId(decision);
		if (id) excluded.add(id);
	}
	return excluded;
}

export function excludeDuplicateTransactions(imports: StoredBankImport[], decisions: Iterable<DuplicateDecision>): StoredBankImport[] {
	return excludeTransactions(imports, excludedDuplicateIds(decisions));
}

export function excludeTransactions(imports: StoredBankImport[], excluded: ReadonlySet<string>): StoredBankImport[] {
	if (!excluded.size) return imports;
	return imports.map(record => {
		const transactions = record.transactions.filter(row => !excluded.has(row.transactionId));
		if (transactions.length === record.transactions.length) return record;
		const keptRows = new Set(transactions.map(row => row.rowId));
		return { ...record, transactions, result: { ...record.result, transactions: record.result.transactions.filter(row => keptRows.has(row.rowId)) } };
	});
}
