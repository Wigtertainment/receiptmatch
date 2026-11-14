import type { SourceEvidence } from "./bank-import.js";
import type { StoredBankImport } from './workspace-import.js';
import type { TransactionCandidate } from './bank-import.js';

export interface StatementOverlap {
	statementId: string;
	filePath: string;
	transactionId: string;
	transactionNumber: number;
	basis: 'transaction-id' | 'details';
	accountConfirmed: boolean;
}

export interface StatementOverlaps {
	has(transactionId: string): boolean;
	get(transactionId: string): StatementOverlap[];
}

type Key = [key: string, basis: StatementOverlap['basis']];
type IndexedRow = Omit<StatementOverlap, 'basis' | 'accountConfirmed'> & { account: string | null; reference: string | null; keys: Key[] };
type StatementBuckets = Map<string, Map<string | null, IndexedRow[]>>;

export function statementAccountKey(value: string | undefined): string | null {
	const compact: string | undefined = value?.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
	if (!compact || /^(?:UNKNOWN|N\/?A|NONE|NOTAVAILABLE)$/.test(compact) || /[*•…]|X{2,}(?=\d+$)|(?:END(?:S|ING)(?:IN|WITH)|LAST(?:FOUR|4)(?:DIGITS)?)[:.-]?\d+$/.test(compact)) {
		return null;
	}
	return /[\p{L}\d]/u.test(compact) ? compact : null;
}

const genericDescription: RegExp = /^(?:card(?: payment| refund)?|payout|payin|deposit|payment|transfer|conversion|refund|direct debit|fee|adjustment|transaction)$/;
const missingReference: RegExp = /^(?:unknown|n\/?a|none|not available)$/i;

export function bankTransactionIds(references: TransactionCandidate['references']): Set<string> {
	return new Set(references.filter((field: { label: string; value: string; evidence: SourceEvidence[]; }): boolean => /^transaction\s+id$/i.test(field.label.trim())).map((field: { label: string; value: string; evidence: SourceEvidence[]; }): string => field.value.trim())
		.filter((value: string): boolean => /[\p{L}\d]/u.test(value) && !missingReference.test(value)));
}

function indexRow(record: StoredBankImport, row: TransactionCandidate, index: number, bank: string,
	accounts: ReadonlyMap<string, { id: string | null; currency: string }>, transactionIds: ReadonlyMap<string, string>): IndexedRow | null {
	const account: { id: string | null; currency: string; } | undefined = accounts.get(row.accountSectionId);
	const transactionId: string | undefined = transactionIds.get(row.rowId);
	if (!account || !transactionId) {
		return null;
	}
	const ids: Set<string> = bankTransactionIds(row.references);
	if (ids.size > 1) {
		return null;
	}
	const reference: string = [...ids][0] ?? null;
	const keys: Key[] = [];
	const scope: string[] = [bank, account.currency, row.direction];
	if (reference) {
		keys.push([JSON.stringify(['id', ...scope, reference]), 'transaction-id']);
	}
	const description: string = row.description.value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
	const { coefficient, scale, currency }: { coefficient: string; currency: string; scale: number; } = row.accountAmount.value;
	if (/\p{L}/u.test(description) && !genericDescription.test(description) && currency === account.currency) {
		const exactAmount: string = (BigInt(coefficient) * 10n ** BigInt(18 - scale)).toString();
		keys.push([JSON.stringify(['details', ...scope, row.bookingDate.value, exactAmount, description]), 'details']);
	}
	if (!keys.length) {
		return null;
	}
	return { statementId: record.id, filePath: record.filePath, transactionId, transactionNumber: index + 1, account: account.id, reference, keys };
}

function* matchingRows(row: IndexedRow, basis: StatementOverlap['basis'], statements: StatementBuckets | undefined, seen: Set<string>): Generator<StatementOverlap> {
	for (const [statementId, accounts] of statements ?? []) {
		if (statementId === row.statementId) {
			continue;
		}

		for (const [account, entries] of accounts) {
			if (row.account && account && row.account !== account) {
				continue;
			}

			yield* collectOverlappingRows(row, account, entries, basis, seen);
		}
	}
}

function* collectOverlappingRows(row: IndexedRow, account: string | null, entries: IndexedRow[], basis: StatementOverlap['basis'],
	seen: Set<string>): Generator<StatementOverlap> {
	for (const other of entries) {
		if (seen.has(other.transactionId) || conflictingReferences(row, other, basis)) {
			continue;
		}

		seen.add(other.transactionId);
		yield { statementId: other.statementId, filePath: other.filePath, transactionId: other.transactionId, transactionNumber: other.transactionNumber,
			basis, accountConfirmed: row.account !== null && row.account === account };
	}
}

function conflictingReferences(row: IndexedRow, other: IndexedRow, basis: StatementOverlap['basis']): boolean {
	return basis === 'details' && Boolean(row.reference && other.reference && row.reference !== other.reference);
}

// These are review hints derived from imported bookings. The index stores each row once per kind of evidence.
export function indexStatementOverlaps(records: readonly StoredBankImport[]): (statementId: string) => StatementOverlaps {
	const rows: Map<string, IndexedRow> = new Map<string, IndexedRow>();
	const byKey: Map<string, StatementBuckets> = new Map<string, StatementBuckets>();
	for (const record of records) {
		const bank: string | undefined = record.result.adapter?.bankId;
		if (!bank) {
			continue;
		}
		const accounts: Map<string, { id: string | null; currency: string; }> = new Map(record.result.accountSections.map((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): [string, { id: string | null; currency: string; }] => [section.sectionId, {
			id: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
		}]));
		const transactionIds: Map<string, string> = new Map(record.transactions.map((row: { rowId: string; transactionId: string; }): [string, string] => [row.rowId, row.transactionId]));
		for (const [index, row] of record.result.transactions.entries()) {
			const entry: IndexedRow | null = indexRow(record, row, index, bank, accounts, transactionIds);
			if (!entry) {
				continue;
			}
			rows.set(entry.transactionId, entry);
			for (const [key] of entry.keys) {
				const statements: StatementBuckets = byKey.get(key) ?? new Map<string, Map<string | null, IndexedRow[]>>();
				const accounts: Map<string | null, IndexedRow[]> = statements.get(record.id) ?? new Map<string | null, IndexedRow[]>();
				const bucket: IndexedRow[] = accounts.get(entry.account) ?? [];
				bucket.push(entry);
				accounts.set(entry.account, bucket);
				statements.set(record.id, accounts);
				byKey.set(key, statements);
			}
		}
	}
	return (statementId: string): { has(transactionId: string): boolean; get: (transactionId: string) => StatementOverlap[]; } => {
		function* matches(transactionId: string): Generator<StatementOverlap> {
			const row: IndexedRow | undefined = rows.get(transactionId);
			if (row?.statementId !== statementId) {
				return;
			}
			const seen: Set<string> = new Set<string>();
			for (const [key, basis] of row.keys) {
				yield* matchingRows(row, basis, byKey.get(key), seen);
			}
		}
		const available: Map<string, boolean> = new Map<string, boolean>();
		return {
			has(transactionId: string): boolean {
				const found: boolean = available.get(transactionId) ?? !matches(transactionId).next().done;
				available.set(transactionId, found);
				return found;
			},
			get: (transactionId: string): StatementOverlap[] => [...matches(transactionId)],
		};
	};
}
