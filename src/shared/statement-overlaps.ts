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

interface StatementOverlaps {
	has(transactionId: string): boolean;
	get(transactionId: string): StatementOverlap[];
}

type Key = [key: string, basis: StatementOverlap['basis']];
type IndexedRow = Omit<StatementOverlap, 'basis' | 'accountConfirmed'> & { account: string | null; reference: string | null; keys: Key[] };
type StatementBuckets = Map<string, Map<string | null, IndexedRow[]>>;

export function statementAccountKey(value: string | undefined) {
	const compact = value?.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
	if (!compact || /^(?:UNKNOWN|N\/?A|NONE|NOTAVAILABLE)$/.test(compact) || /[*•…]|X{2,}(?=\d+$)|(?:END(?:S|ING)(?:IN|WITH)|LAST(?:FOUR|4)(?:DIGITS)?)[:.-]?\d+$/.test(compact)) return null;
	return /[\p{L}\d]/u.test(compact) ? compact : null;
}

const genericDescription = /^(?:card(?: payment| refund)?|payout|payin|deposit|payment|transfer|conversion|refund|direct debit|fee|adjustment|transaction)$/;
const missingReference = /^(?:unknown|n\/?a|none|not available)$/i;

export function bankTransactionIds(references: TransactionCandidate['references']) {
	return new Set(references.filter(field => /^transaction\s+id$/i.test(field.label.trim())).map(field => field.value.trim())
		.filter(value => /[\p{L}\d]/u.test(value) && !missingReference.test(value)));
}

// These are review hints derived from imported bookings. The index stores each row once per kind of evidence.
export function indexStatementOverlaps(records: readonly StoredBankImport[]): (statementId: string) => StatementOverlaps {
	const rows = new Map<string, IndexedRow>();
	const byKey = new Map<string, StatementBuckets>();
	for (const record of records) {
		const bank = record.result.adapter?.bankId;
		if (!bank) continue;
		const accounts = new Map(record.result.accountSections.map(section => [section.sectionId, {
			id: statementAccountKey(section.accountReference?.value), currency: section.currency.value,
		}]));
		const transactionIds = new Map(record.transactions.map(row => [row.rowId, row.transactionId]));
		for (const [index, row] of record.result.transactions.entries()) {
			const account = accounts.get(row.accountSectionId);
			const transactionId = transactionIds.get(row.rowId);
			if (!account || !transactionId) continue;
			const ids = bankTransactionIds(row.references);
			if (ids.size > 1) continue;
			const reference = [...ids][0] ?? null;
			const keys: Key[] = [];
			const scope = [bank, account.currency, row.direction];
			if (reference) keys.push([JSON.stringify(['id', ...scope, reference]), 'transaction-id']);
			const description = row.description.value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
			const { coefficient, scale, currency } = row.accountAmount.value;
			if (/\p{L}/u.test(description) && !genericDescription.test(description) && currency === account.currency) {
				const exactAmount = (BigInt(coefficient) * 10n ** BigInt(18 - scale)).toString();
				keys.push([JSON.stringify(['details', ...scope, row.bookingDate.value, exactAmount, description]), 'details']);
			}
			if (!keys.length) continue;
			const entry = { statementId: record.id, filePath: record.filePath, transactionId, transactionNumber: index + 1, account: account.id, reference, keys };
			rows.set(transactionId, entry);
			for (const [key] of keys) {
				const statements = byKey.get(key) ?? new Map();
				const accounts = statements.get(record.id) ?? new Map();
				const bucket = accounts.get(account.id) ?? [];
				bucket.push(entry);
				accounts.set(account.id, bucket);
				statements.set(record.id, accounts);
				byKey.set(key, statements);
			}
		}
	}
	return statementId => {
		function* matches(transactionId: string): Generator<StatementOverlap> {
			const row = rows.get(transactionId);
			if (!row || row.statementId !== statementId) return;
			const seen = new Set<string>();
			for (const [key, basis] of row.keys) for (const [otherStatement, accounts] of byKey.get(key) ?? []) {
				if (otherStatement === statementId) continue;
				for (const [otherAccount, entries] of accounts) {
					if (row.account && otherAccount && row.account !== otherAccount) continue;
					for (const other of entries) {
						if (seen.has(other.transactionId) || (basis === 'details' && row.reference && other.reference && row.reference !== other.reference)) continue;
						seen.add(other.transactionId);
						yield { statementId: otherStatement, filePath: other.filePath, transactionId: other.transactionId, transactionNumber: other.transactionNumber,
							basis, accountConfirmed: row.account !== null && row.account === otherAccount };
					}
				}
			}
		}
		const available = new Map<string, boolean>();
		return {
			has(transactionId) {
				const found = available.get(transactionId) ?? !matches(transactionId).next().done;
				available.set(transactionId, found);
				return found;
			},
			get: transactionId => [...matches(transactionId)],
		};
	};
}
