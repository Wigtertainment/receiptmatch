import type { SourceEvidence, TransactionCandidate } from "./bank-import.js";
import { z } from 'zod';
import { bankTransactionIds, statementAccountKey } from './statement-overlaps.js';
import type { StoredBankImport } from './workspace-import.js';

const duplicateDecisionSchema: z.ZodObject<{ firstId: z.ZodUUID; secondId: z.ZodUUID; primaryId: z.ZodNullable<z.ZodUUID>; archivedReview: z.ZodNullable<z.ZodObject<{ documentId: z.ZodNullable<z.ZodUUID>; }, z.core.$strict>>; }, z.core.$strict> = z.strictObject({
	firstId: z.uuid(),
	secondId: z.uuid(),
	primaryId: z.uuid().nullable(),
	archivedReview: z.strictObject({ documentId: z.uuid().nullable() }).nullable(),
}).refine(({ firstId, secondId, primaryId, archivedReview }: { firstId: string; secondId: string; primaryId: string | null; archivedReview: { documentId: string | null; } | null; }): boolean => firstId < secondId &&
	(primaryId === null ? archivedReview === null : primaryId === firstId || primaryId === secondId));

export type DuplicateDecision = z.infer<typeof duplicateDecisionSchema>;

export function duplicatePairKey(firstId: string, secondId: string): string {
	return firstId < secondId ? firstId + ':' + secondId : secondId + ':' + firstId;
}

export function secondaryDuplicateId({ firstId, secondId, primaryId }: DuplicateDecision): string | null {
	return primaryId === null ? null : primaryId === firstId ? secondId : firstId;
}

interface BookingOwner { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string> }

function validateGroups(primaryBySecondary: ReadonlyMap<string, string>, owners: ReadonlyMap<string, BookingOwner>): void {
	const groups: Map<string, { statements: Set<string>; accounts: Set<string>; references: Set<string>; }> = new Map<string, { statements: Set<string>; accounts: Set<string>; references: Set<string> }>();
	for (const [secondary, primary] of primaryBySecondary) {
		const kept: BookingOwner = owners.get(primary)!, excluded: BookingOwner = owners.get(secondary)!;
		const group: { statements: Set<string>; accounts: Set<string>; references: Set<string>; } = groups.get(primary) ?? { statements: new Set([kept.statementId]), accounts: new Set(kept.account ? [kept.account] : []), references: new Set(kept.references) };
		if (group.statements.has(excluded.statementId)) {
			throw new Error('A duplicate group can contain only one booking per statement.');
		}
		group.statements.add(excluded.statementId);
		if (excluded.account) {
			group.accounts.add(excluded.account);
		}
		for (const reference of excluded.references) {
			group.references.add(reference);
		}
		if (kept.scope !== excluded.scope || group.accounts.size > 1 || group.references.size > 1) {
			throw new Error('The duplicate group contains conflicting bank, account or transaction identifiers.');
		}
		groups.set(primary, group);
	}
}

export function validateDuplicateDecisions(decisions: Iterable<DuplicateDecision>, imports: readonly StoredBankImport[]): Map<string, DuplicateDecision> {
	const result: Map<string, DuplicateDecision> = new Map<string, DuplicateDecision>(), primaryBySecondary: Map<string, string> = new Map<string, string>();
	const parsed: DuplicateDecision[] = [...decisions].map((value: DuplicateDecision): DuplicateDecision => duplicateDecisionSchema.parse(value));
	if (!parsed.length) {
		return result;
	}
	const referenced: Set<string> = new Set(parsed.flatMap(({ firstId, secondId }: DuplicateDecision): string[] => [firstId, secondId]));
	const owners: Map<string, { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string>; }> = new Map(imports.flatMap((record: StoredBankImport): (readonly [string, { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string>; }])[] => {
		const selected: { rowId: string; transactionId: string; }[] = record.transactions.filter((row: { rowId: string; transactionId: string; }): boolean => referenced.has(row.transactionId));
		if (!selected.length) {
			return [];
		}
		const rows: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
		const accounts: Map<string, { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }> = new Map(record.result.accountSections.map((account: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): [string, { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }] => [account.sectionId, account]));
		return selected.flatMap(({ transactionId, rowId }: { rowId: string; transactionId: string; }): [] | [readonly [string, { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string>; }]] => {
			const row: TransactionCandidate | undefined = rows.get(rowId), account: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } | undefined = row && accounts.get(row.accountSectionId);
			return row && account ? [[transactionId, { statementId: record.id, account: statementAccountKey(account.accountReference?.value),
				scope: JSON.stringify([record.result.adapter?.bankId, account.currency.value, row.direction]), references: bankTransactionIds(row.references) }] as const] : [];
		});
	}));
	for (const decision of parsed) {
		const { firstId, secondId, primaryId }: DuplicateDecision = decision;
		const firstOwner: { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string>; } | undefined = owners.get(firstId), secondOwner: { readonly statementId: string; readonly account: string | null; readonly scope: string; readonly references: Set<string>; } | undefined = owners.get(secondId);
		const key: string = duplicatePairKey(firstId, secondId);
		if (!firstOwner || !secondOwner || firstOwner.statementId === secondOwner.statementId || result.has(key)) {
			throw new Error('Duplicate decisions must refer to two bookings from different statements.');
		}
		const secondaryId: string | null = secondaryDuplicateId(decision);
		if (primaryId && secondaryId) {
			if (primaryBySecondary.has(secondaryId)) {
				throw new Error('This booking already has a leading booking. Undo that decision first.');
			}
			primaryBySecondary.set(secondaryId, primaryId);
		}
		result.set(key, decision);
	}
	if ([...primaryBySecondary.values()].some((id: string): boolean => primaryBySecondary.has(id))) {
		throw new Error('A leading booking cannot also be excluded. Undo the conflicting duplicate decision first.');
	}
	validateGroups(primaryBySecondary, owners);
	for (const { firstId, secondId, primaryId } of result.values()) {
		if (primaryId === null && (primaryBySecondary.get(firstId) ?? firstId) === (primaryBySecondary.get(secondId) ?? secondId)) {
			throw new Error('These bookings were kept separate. Undo the conflicting duplicate decision first.');
		}
	}
	return result;
}

export function excludedDuplicateIds(decisions: Iterable<DuplicateDecision>): Set<string> {
	const excluded: Set<string> = new Set<string>();
	for (const decision of decisions) {
		const id: string | null = secondaryDuplicateId(decision);
		if (id) {
			excluded.add(id);
		}
	}
	return excluded;
}

export function excludeDuplicateTransactions(imports: StoredBankImport[], decisions: Iterable<DuplicateDecision>): StoredBankImport[] {
	return excludeTransactions(imports, excludedDuplicateIds(decisions));
}

export function excludeTransactions(imports: StoredBankImport[], excluded: ReadonlySet<string>): StoredBankImport[] {
	if (!excluded.size) {
		return imports;
	}
	return imports.map((record: StoredBankImport): StoredBankImport => {
		const transactions: { rowId: string; transactionId: string; }[] = record.transactions.filter((row: { rowId: string; transactionId: string; }): boolean => !excluded.has(row.transactionId));
		if (transactions.length === record.transactions.length) {
			return record;
		}
		const keptRows: Set<string> = new Set(transactions.map((row: { rowId: string; transactionId: string; }): string => row.rowId));
		return { ...record, transactions, result: { ...record.result, transactions: record.result.transactions.filter((row: TransactionCandidate): boolean => keptRows.has(row.rowId)) } };
	});
}
