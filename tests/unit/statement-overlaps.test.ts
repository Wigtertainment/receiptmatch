import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { SourceEvidence } from "../../src/shared/bank-import.js";
import type { StatementOverlap } from "../../src/shared/statement-overlaps.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import type { TransactionCandidate } from '../../src/shared/bank-import.js';
import { indexStatementOverlaps, type StatementOverlaps } from '../../src/shared/statement-overlaps.js';
import { retainedBank } from './document-fixtures.js';

function imported(accountReference: string | null = 'SYNTHETIC-ACCOUNT-A'): { record: StoredBankImport; row: TransactionCandidate; id: string; } {
	const record: StoredBankImport = retainedBank(process.cwd());
	record.result.transactions = record.result.transactions.slice(0, 1);
	record.transactions = record.transactions.slice(0, 1);
	const account: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } = record.result.accountSections[0];
	account.accountReference = accountReference ? { label: 'Account identifier', value: accountReference, evidence: account.evidence } : null;
	const [row]: TransactionCandidate[] = record.result.transactions;
	return { record, row, id: record.transactions[0].transactionId };
}

function reference(row: TransactionCandidate, value: string, label: string = 'Transaction ID'): void {
	row.references = [{ label, value, evidence: row.evidence }];
}

test('matches equivalent booking details only across compatible accounts and separate statements', (): void => {
	const original: ReturnType<typeof imported> = imported();
	const repeated: ReturnType<typeof imported> = imported('synthetic- account-a');
	repeated.row.description.value = '  ' + original.row.description.value.toUpperCase().replaceAll(' ', '  ');
	repeated.row.accountAmount.value.coefficient += '0';
	repeated.row.accountAmount.value.scale++;

	const sameAmount: ReturnType<typeof imported> = imported();
	sameAmount.row.description.value = 'Independent purchase';
	const otherAccount: ReturnType<typeof imported> = imported('SYNTHETIC-ACCOUNT-B');
	const otherBank: ReturnType<typeof imported> = imported();
	otherBank.record.result.adapter!.bankId = 'airwallex';
	const otherCurrency: ReturnType<typeof imported> = imported();
	otherCurrency.record.result.accountSections[0].currency.value = 'USD';
	otherCurrency.row.accountAmount.value.currency = 'USD';
	const opposite: ReturnType<typeof imported> = imported();
	opposite.row.direction = 'incoming';
	opposite.row.accountAmount.value.coefficient = original.row.accountAmount.value.coefficient.slice(1);
	const otherDay: ReturnType<typeof imported> = imported();
	otherDay.row.bookingDate.value = '2032-02-27';

	const all: (statementId: string) => StatementOverlaps = indexStatementOverlaps([original, repeated, sameAmount, otherAccount, otherBank, otherCurrency, opposite, otherDay].map((item: { record: StoredBankImport; row: TransactionCandidate; id: string; }): StoredBankImport => item.record));
	assert.deepEqual(all(original.record.id).get(original.id), [{
		statementId: repeated.record.id, transactionId: repeated.id, filePath: repeated.record.filePath, transactionNumber: 1, basis: 'details', accountConfirmed: true,
	}]);
	assert.equal(all(repeated.record.id).get(repeated.id)?.[0].transactionId, original.id);
	assert.equal(indexStatementOverlaps([original.record])(original.record.id).has(original.id), false);
});

test('uses a bank transaction ID without treating ordinary payment references as unique', (): void => {
	const original: ReturnType<typeof imported> = imported(null), repeated: ReturnType<typeof imported> = imported(null), samePaymentReference: ReturnType<typeof imported> = imported(null), distinctId: ReturnType<typeof imported> = imported(null);
	reference(original.row, 'SYNTHETIC-TRANSACTION-ID');
	reference(repeated.row, 'SYNTHETIC-TRANSACTION-ID');
	repeated.row.description.value = 'Booking details changed on later statement';
	repeated.row.bookingDate.value = '2032-03-02';
	repeated.row.accountAmount.value.coefficient = '-500';
	samePaymentReference.row.description.value = 'Independent purchase';
	reference(samePaymentReference.row, 'SYNTHETIC-TRANSACTION-ID', 'Payment reference');
	reference(distinctId.row, 'SYNTHETIC-DIFFERENT-ID');
	const otherAccount: ReturnType<typeof imported> = imported('SYNTHETIC-ACCOUNT-B');
	reference(otherAccount.row, 'SYNTHETIC-TRANSACTION-ID');
	const knownAccount: ReturnType<typeof imported> = imported();
	reference(knownAccount.row, 'SYNTHETIC-TRANSACTION-ID');

	const all: (statementId: string) => StatementOverlaps = indexStatementOverlaps([original, repeated, samePaymentReference, distinctId, knownAccount, otherAccount].map((item: { record: StoredBankImport; row: TransactionCandidate; id: string; }): StoredBankImport => item.record));
	assert.deepEqual(all(original.record.id).get(original.id)?.map((candidate: StatementOverlap): (string | boolean)[] => [candidate.transactionId, candidate.basis, candidate.accountConfirmed]), [
		[repeated.id, 'transaction-id', false], [knownAccount.id, 'transaction-id', false], [otherAccount.id, 'transaction-id', false],
	]);
	assert.ok(!all(knownAccount.record.id).get(knownAccount.id)?.some((candidate: StatementOverlap): boolean => candidate.transactionId === otherAccount.id));
});

test('marks unverified accounts and excludes generic descriptions from booking-detail matches', (): void => {
	const original: ReturnType<typeof imported> = imported(), unknown: ReturnType<typeof imported> = imported(null);
	const candidates: () => StatementOverlap[] = (): StatementOverlap[] => indexStatementOverlaps([original.record, unknown.record])(original.record.id).get(original.id);
	assert.equal(candidates()?.[0].accountConfirmed, false);
	original.row.description.value = unknown.row.description.value = 'Card';
	assert.deepEqual(candidates(), []);
	original.row.description.value = unknown.row.description.value = '1,234.56';
	assert.deepEqual(candidates(), []);
});

test('treats masked account references as unverified even when they agree', (): void => {
	for (const masked of ['ending in 1234', '****1234', 'xxxx1234', 'last 4 digits: 1234']) {
		const first: ReturnType<typeof imported> = imported(masked), second: ReturnType<typeof imported> = imported(masked);
		const [candidate]: StatementOverlap[] = indexStatementOverlaps([first.record, second.record])(first.record.id).get(first.id);
		assert.equal(candidate.accountConfirmed, false);
	}
});

test('uses each row’s account section and only returns matches from another statement', (): void => {
	const first: ReturnType<typeof imported> = imported(), otherStatement: ReturnType<typeof imported> = imported();
	const [accountA]: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }[] = first.record.result.accountSections;
	const accountB: { sectionId: string; accountReference: { value: string; label: string; evidence: SourceEvidence[]; }; currency: { value: string; evidence: SourceEvidence[]; }; evidence: SourceEvidence[]; } = { ...accountA, sectionId: 'another-account', accountReference: { ...accountA.accountReference!, value: 'SYNTHETIC-ACCOUNT-B' } };
	first.record.result.accountSections.push(accountB);
	const sameStatementRow: TransactionCandidate = { ...first.row, rowId: 'same-statement-row' };
	const otherAccountRow: TransactionCandidate = { ...first.row, rowId: 'another-account-row', accountSectionId: accountB.sectionId };
	first.record.result.transactions.push(sameStatementRow, otherAccountRow);
	const sameStatementId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(), otherAccountId: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
	first.record.transactions.push({ rowId: sameStatementRow.rowId, transactionId: sameStatementId }, { rowId: otherAccountRow.rowId, transactionId: otherAccountId });

	const overlaps: (statementId: string) => StatementOverlaps = indexStatementOverlaps([first.record, otherStatement.record]);
	assert.equal(overlaps(first.record.id).get(first.id)?.[0].transactionId, otherStatement.id);
	assert.equal(overlaps(first.record.id).get(sameStatementId)?.[0].transactionId, otherStatement.id);
	assert.equal(overlaps(first.record.id).has(otherAccountId), false);
	assert.deepEqual(overlaps(otherStatement.record.id).get(otherStatement.id)?.map((candidate: StatementOverlap): number => candidate.transactionNumber), [1, 2]);
});
