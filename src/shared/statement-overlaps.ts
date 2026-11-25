import type { StoredBankImport } from './workspace-import.js';
import type { TransactionCandidate } from './bank-import.js';
import type { Money } from './money.js';

export interface IStatementOverlap {
	statementId: string;
	filePath: string;
	transactionId: string;
	transactionNumber: number;
	basis: 'transaction-id' | 'details';
	accountConfirmed: boolean;
}

export interface IStatementOverlaps {
	has(transactionId: string): boolean;
	get(transactionId: string): IStatementOverlap[];
}

type Key = [key: string, basis: IStatementOverlap['basis']];
interface IIndexedRow extends Omit<IStatementOverlap, 'basis' | 'accountConfirmed'> {
	account: string | null;
	reference: string | null;
	keys: Key[];
}
interface IIndexedStatementAccount { id: string | null; currency: string }
type BankReference = TransactionCandidate['references'][number];
type AccountSection = StoredBankImport['result']['accountSections'][number];
type StoredTransaction = StoredBankImport['transactions'][number];
type StatementBuckets = Map<string, Map<string | null, IIndexedRow[]>>;

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
	return new Set(references.filter((field: BankReference): boolean => /^transaction\s+id$/i.test(field.label.trim())).map((field: BankReference): string => field.value.trim())
		.filter((value: string): boolean => /[\p{L}\d]/u.test(value) && !missingReference.test(value)));
}

function indexRow(record: StoredBankImport, row: TransactionCandidate, index: number, bank: string,
	accounts: ReadonlyMap<string, IIndexedStatementAccount>, transactionIds: ReadonlyMap<string, string>): IIndexedRow | null {
	const account: IIndexedStatementAccount | undefined = accounts.get(row.accountSectionId);
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
	const { coefficient, scale, currency }: Money = row.accountAmount.value;
	if (/\p{L}/u.test(description) && !genericDescription.test(description) && currency === account.currency) {
		const exactAmount: string = (BigInt(coefficient) * 10n ** BigInt(18 - scale)).toString();
		keys.push([JSON.stringify(['details', ...scope, row.bookingDate.value, exactAmount, description]), 'details']);
	}
	if (!keys.length) {
		return null;
	}
	return { statementId: record.id, filePath: record.filePath, transactionId, transactionNumber: index + 1, account: account.id, reference, keys };
}

function* matchingRows(row: IIndexedRow, basis: IStatementOverlap['basis'], statements: StatementBuckets | undefined, seen: Set<string>): Generator<IStatementOverlap> {
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

function* collectOverlappingRows(row: IIndexedRow, account: string | null, entries: IIndexedRow[], basis: IStatementOverlap['basis'],
	seen: Set<string>): Generator<IStatementOverlap> {
	for (const other of entries) {
		if (seen.has(other.transactionId) || conflictingReferences(row, other, basis)) {
			continue;
		}

		seen.add(other.transactionId);
		yield { statementId: other.statementId, filePath: other.filePath, transactionId: other.transactionId, transactionNumber: other.transactionNumber,
			basis, accountConfirmed: row.account !== null && row.account === account };
	}
}

function conflictingReferences(row: IIndexedRow, other: IIndexedRow, basis: IStatementOverlap['basis']): boolean {
	return basis === 'details' && Boolean(row.reference && other.reference && row.reference !== other.reference);
}

// These are review hints derived from imported bookings. The index stores each row once per kind of evidence.
export function originalStatementBankIds(originals: readonly StoredBankImport[]): Map<string, string> {
	return new Map(originals.flatMap((record: StoredBankImport): [string, string][] => record.result.adapter ? [[record.id, record.result.adapter.bankId]] : []));
}

export function indexStatementOverlaps(records: readonly StoredBankImport[], originalBankIds: ReadonlyMap<string, string> = new Map()): (statementId: string) => IStatementOverlaps {
	const rows: Map<string, IIndexedRow> = new Map<string, IIndexedRow>();
	const byKey: Map<string, StatementBuckets> = new Map<string, StatementBuckets>();
	for (const record of records) {
		const bank: string | undefined = record.result.adapter?.bankId ?? originalBankIds.get(record.id);
		if (!bank) {
			continue;
		}
		const accounts: Map<string, IIndexedStatementAccount> = new Map(record.result.accountSections.map((section: AccountSection): [string, IIndexedStatementAccount] => [section.sectionId, {
			id: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
		}]));
		const transactionIds: Map<string, string> = new Map(record.transactions.map((row: StoredTransaction): [string, string] => [row.rowId, row.transactionId]));
		for (const [index, row] of record.result.transactions.entries()) {
			const entry: IIndexedRow | null = indexRow(record, row, index, bank, accounts, transactionIds);
			if (!entry) {
				continue;
			}
			rows.set(entry.transactionId, entry);
			for (const [key] of entry.keys) {
				const statements: StatementBuckets = byKey.get(key) ?? new Map<string, Map<string | null, IIndexedRow[]>>();
				const accounts: Map<string | null, IIndexedRow[]> = statements.get(record.id) ?? new Map<string | null, IIndexedRow[]>();
				const bucket: IIndexedRow[] = accounts.get(entry.account) ?? [];
				bucket.push(entry);
				accounts.set(entry.account, bucket);
				statements.set(record.id, accounts);
				byKey.set(key, statements);
			}
		}
	}
	return (statementId: string): IStatementOverlaps => {
		function* matches(transactionId: string): Generator<IStatementOverlap> {
			const row: IIndexedRow | undefined = rows.get(transactionId);
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
			get(transactionId: string): IStatementOverlap[] {
				return [...matches(transactionId)];
			},
		};
	};
}
