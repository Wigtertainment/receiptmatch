import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import type { TransactionCandidate } from '../../src/shared/bank-import.js';
import { indexStatementOverlaps } from '../../src/shared/statement-overlaps.js';
import { retainedBank } from './document-fixtures.js';

function imported(accountReference: string | null = 'SYNTHETIC-ACCOUNT-A') {
	const record = retainedBank(process.cwd());
	record.result.transactions = record.result.transactions.slice(0, 1);
	record.transactions = record.transactions.slice(0, 1);
	const account = record.result.accountSections[0];
	account.accountReference = accountReference ? { label: 'Account identifier', value: accountReference, evidence: account.evidence } : null;
	const [row] = record.result.transactions;
	return { record, row, id: record.transactions[0].transactionId };
}

function reference(row: TransactionCandidate, value: string, label = 'Transaction ID') {
	row.references = [{ label, value, evidence: row.evidence }];
}

test('matches equivalent booking details only across compatible accounts and separate statements', () => {
	const original = imported();
	const repeated = imported('synthetic- account-a');
	repeated.row.description.value = '  ' + original.row.description.value.toUpperCase().replaceAll(' ', '  ');
	repeated.row.accountAmount.value.coefficient += '0';
	repeated.row.accountAmount.value.scale++;

	const sameAmount = imported();
	sameAmount.row.description.value = 'Independent purchase';
	const otherAccount = imported('SYNTHETIC-ACCOUNT-B');
	const otherBank = imported();
	otherBank.record.result.adapter!.bankId = 'airwallex';
	const otherCurrency = imported();
	otherCurrency.record.result.accountSections[0].currency.value = 'USD';
	otherCurrency.row.accountAmount.value.currency = 'USD';
	const opposite = imported();
	opposite.row.direction = 'incoming';
	opposite.row.accountAmount.value.coefficient = original.row.accountAmount.value.coefficient.slice(1);
	const otherDay = imported();
	otherDay.row.bookingDate.value = '2032-02-27';

	const all = indexStatementOverlaps([original, repeated, sameAmount, otherAccount, otherBank, otherCurrency, opposite, otherDay].map(item => item.record));
	assert.deepEqual(all(original.record.id).get(original.id), [{
		statementId: repeated.record.id, transactionId: repeated.id, filePath: repeated.record.filePath, transactionNumber: 1, basis: 'details', accountConfirmed: true,
	}]);
	assert.equal(all(repeated.record.id).get(repeated.id)?.[0].transactionId, original.id);
	assert.equal(indexStatementOverlaps([original.record])(original.record.id).has(original.id), false);
});

test('uses a bank transaction ID without treating ordinary payment references as unique', () => {
	const original = imported(null), repeated = imported(null), samePaymentReference = imported(null), distinctId = imported(null);
	reference(original.row, 'SYNTHETIC-TRANSACTION-ID');
	reference(repeated.row, 'SYNTHETIC-TRANSACTION-ID');
	repeated.row.description.value = 'Booking details changed on later statement';
	repeated.row.bookingDate.value = '2032-03-02';
	repeated.row.accountAmount.value.coefficient = '-500';
	samePaymentReference.row.description.value = 'Independent purchase';
	reference(samePaymentReference.row, 'SYNTHETIC-TRANSACTION-ID', 'Payment reference');
	reference(distinctId.row, 'SYNTHETIC-DIFFERENT-ID');
	const otherAccount = imported('SYNTHETIC-ACCOUNT-B');
	reference(otherAccount.row, 'SYNTHETIC-TRANSACTION-ID');
	const knownAccount = imported();
	reference(knownAccount.row, 'SYNTHETIC-TRANSACTION-ID');

	const all = indexStatementOverlaps([original, repeated, samePaymentReference, distinctId, knownAccount, otherAccount].map(item => item.record));
	assert.deepEqual(all(original.record.id).get(original.id)?.map(candidate => [candidate.transactionId, candidate.basis, candidate.accountConfirmed]), [
		[repeated.id, 'transaction-id', false], [knownAccount.id, 'transaction-id', false], [otherAccount.id, 'transaction-id', false],
	]);
	assert.ok(!all(knownAccount.record.id).get(knownAccount.id)?.some(candidate => candidate.transactionId === otherAccount.id));
});

test('marks unverified accounts and excludes generic descriptions from booking-detail matches', () => {
	const original = imported(), unknown = imported(null);
	const candidates = () => indexStatementOverlaps([original.record, unknown.record])(original.record.id).get(original.id);
	assert.equal(candidates()?.[0].accountConfirmed, false);
	original.row.description.value = unknown.row.description.value = 'Card';
	assert.deepEqual(candidates(), []);
	original.row.description.value = unknown.row.description.value = '1,234.56';
	assert.deepEqual(candidates(), []);
});

test('treats masked account references as unverified even when they agree', () => {
	for (const masked of ['ending in 1234', '****1234', 'xxxx1234', 'last 4 digits: 1234']) {
		const first = imported(masked), second = imported(masked);
		const [candidate] = indexStatementOverlaps([first.record, second.record])(first.record.id).get(first.id);
		assert.equal(candidate.accountConfirmed, false);
	}
});

test('uses each row’s account section and only returns matches from another statement', () => {
	const first = imported(), otherStatement = imported();
	const [accountA] = first.record.result.accountSections;
	const accountB = { ...accountA, sectionId: 'another-account', accountReference: { ...accountA.accountReference!, value: 'SYNTHETIC-ACCOUNT-B' } };
	first.record.result.accountSections.push(accountB);
	const sameStatementRow = { ...first.row, rowId: 'same-statement-row' };
	const otherAccountRow = { ...first.row, rowId: 'another-account-row', accountSectionId: accountB.sectionId };
	first.record.result.transactions.push(sameStatementRow, otherAccountRow);
	const sameStatementId = randomUUID(), otherAccountId = randomUUID();
	first.record.transactions.push({ rowId: sameStatementRow.rowId, transactionId: sameStatementId }, { rowId: otherAccountRow.rowId, transactionId: otherAccountId });

	const overlaps = indexStatementOverlaps([first.record, otherStatement.record]);
	assert.equal(overlaps(first.record.id).get(first.id)?.[0].transactionId, otherStatement.id);
	assert.equal(overlaps(first.record.id).get(sameStatementId)?.[0].transactionId, otherStatement.id);
	assert.equal(overlaps(first.record.id).has(otherAccountId), false);
	assert.deepEqual(overlaps(otherStatement.record.id).get(otherStatement.id)?.map(candidate => candidate.transactionNumber), [1, 2]);
});
