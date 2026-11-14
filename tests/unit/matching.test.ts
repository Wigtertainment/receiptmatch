import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { suggestTransactionMatches } from '../../electron/matching.js';
import { evaluateReviewMatches } from '../../electron/review-matching.js';
import { storedSupportingDocumentSchema } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, extractedDocument, retainedBank } from './document-fixtures.js';

function document(...lines: string[]) {
	const { input } = extractedDocument(Buffer.from(lines.join('\n')), randomUUID());
	const page = input.pages[0];
	page.spans = lines.map((text, index) => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text' }));
	return storedSupportingDocumentSchema.parse({ id: randomUUID(), importedAt: '2032-05-20T12:00:00Z', filePath: `${process.cwd()}/synthetic.pdf`, format: 'pdf', result: interpretSupportingDocument(input) });
}

function invoice(...lines: string[]) {
	return document('Invoice', 'Merchant: Cedar Workshop', ...lines);
}

function matchFor(bank: StoredBankImport, index: number, ...documents: ReturnType<typeof document>[]) {
	const { transactionId } = bank.transactions[index];
	return suggestTransactionMatches([bank], documents).find((match) => match.transactionId === transactionId)!;
}

test('rechecks the amounts of a historically reliable candidate before displaying it', () => {
	const root = process.cwd();
	const bank = retainedBank(root);
	const original = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const replacement = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.57');
	const historical = matchFor(bank, 0, original);
	const [candidate] = historical.candidates;
	candidate.documentId = replacement.id;
	candidate.sectionId = replacement.result.sections[0].sectionId;
	candidate.amounts[0].documentAmount.coefficient = '123457';
	const [reviewed] = evaluateReviewMatches([historical], [bank], [documentRun(root, [replacement])]);
	assert.equal(historical.status, 'reliable');
	assert.equal(reviewed.status, 'uncertain');
	assert.equal(reviewed.candidates[0].signals.amount, 'close');
	assert.deepEqual(reviewed.candidates[0].issues, ['amount-needs-review']);
});

test('normalizes only reference case and surrounding whitespace and applies inclusive calendar-day evidence', () => {
	const bank = retainedBank(process.cwd());
	const row = bank.result.transactions[0];
	row.references[0].value = '  synthetic-a  ';
	const source = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-03-06', 'Invoice Total: EUR 1,234.5600');
	const result = matchFor(bank, 0, source);
	const [candidate] = result.candidates;
	assert.equal(result.status, 'reliable');
	assert.equal(candidate.references[0].normalized, 'SYNTHETIC-A');
	assert.equal(candidate.date?.daysApart, 7);
	assert.equal(candidate.date.withinWindow, true);
	assert.equal(candidate.amounts[0].documentAmount.scale, 4);
	assert.equal(candidate.amounts[0].basis, 'account-settlement');
	assert.equal(matchFor(bank, 0, invoice('Invoice Number: SYNTHETICA', 'Invoice Total: EUR 1,234.56')).status, 'uncertain');
	row.references[0].label = 'Transaction ID';
	assert.deepEqual(matchFor(bank, 0, source).candidates[0].issues, ['missing-reference']);
});

test('uses payment date before issue date and keeps distant or missing dates from excluding a referenced match', () => {
	const bank = retainedBank(process.cwd());
	const invoiceFields = ['Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56'];
	const distant = matchFor(bank, 0, invoice(...invoiceFields, 'Invoice Date: 2032-02-27', 'Payment Date: 2032-03-07'));
	assert.equal(distant.status, 'reliable');
	assert.deepEqual(distant.candidates[0].date, {
		documentFieldId: distant.candidates[0].date?.documentFieldId, bookingDate: '2032-02-28', documentDate: '2032-03-07', role: 'payment', daysApart: 8, withinWindow: false,
	});
	const missing = matchFor(bank, 0, invoice(...invoiceFields, 'Due Date: 2032-02-28'));
	assert.equal(missing.status, 'reliable');
	assert.equal(missing.candidates[0].date, null);
});

test('requires the full spaced reference even for previously imported truncated candidates', () => {
	const bank = retainedBank(process.cwd());
	const source = invoice('Invoice Number: SYNTHETIC-A 0042', 'Invoice Total: EUR 1,234.56');
	assert.equal(matchFor(bank, 0, source).status, 'uncertain');
	bank.result.transactions[0].references[0].value = 'synthetic-a 0042';
	assert.equal(matchFor(bank, 0, source).status, 'reliable');
	bank.result.transactions[0].references[0].value = 'SYNTHETIC-A';
	source.result.sections[0].references[0].candidates = ['SYNTHETIC-A'];
	assert.equal(matchFor(bank, 0, source).status, 'uncertain');
});

test('compares original and settlement currency separately and retains both bases on one candidate when equal', () => {
	const bank = retainedBank(process.cwd());
	const original = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 1,500.01');
	const wrongCurrency = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 1,234.56');
	const wrongAmount = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,500.01');
	assert.equal(matchFor(bank, 0, wrongCurrency, wrongAmount).status, 'unmatched');
	const match = matchFor(bank, 0, original, wrongCurrency, wrongAmount);
	assert.equal(match.status, 'reliable');
	assert.deepEqual(match.candidates.map((candidate) => [candidate.documentId, candidate.amounts.map((amount) => amount.basis)]), [[original.id, ['reported-original']]]);
	const row = bank.result.transactions[0];
	row.reportedOriginalAmount = row.accountAmount;
	const same = matchFor(bank, 0, invoice('Invoice Total: EUR 1,234.56'));
	assert.deepEqual(same.candidates.map((candidate) => candidate.amounts.map((amount) => amount.basis)), [['account-settlement', 'reported-original']]);
});

test('prefers explicit payments and ignores balance due, line items and FX as payment bases', () => {
	const bank = retainedBank(process.cwd());
	const misleading = invoice('Invoice Total: EUR 1,234.56', 'Amount Paid: EUR 20.00', 'Balance Due: EUR 1,234.56', 'Informational amount: USD 1,500.01');
	assert.equal(matchFor(bank, 0, misleading).status, 'unmatched');
	const actual = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,254.56', 'Amount Paid: EUR 1,234.56', 'Balance Due: EUR 20.00');
	const match = matchFor(bank, 0, actual);
	assert.equal(match.status, 'reliable');
	assert.equal(actual.result.sections[0].amounts.find((field) => field.id === match.candidates[0].amounts[0].documentFieldId)?.role, 'payment');
	const scheduled = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 20.00', 'Payment scheduled: EUR 1,234.56');
	assert.equal(matchFor(bank, 0, scheduled).status, 'unmatched');
	const applied = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,254.56', 'Applied Transactions:', 'PAYMENT-SYNTHETIC March 14, 2032 -EUR 1,234.56');
	assert.equal(matchFor(bank, 0, applied).status, 'reliable');
	const payment = applied.result.sections[0].amounts.find((field) => field.role === 'payment')!;
	payment.evidence = payment.evidence.filter((item) => item.rawText !== 'Applied Transactions:');
	assert.equal(matchFor(bank, 0, applied).status, 'reliable');
});

test('requires explicit executed refund evidence for incoming transactions', () => {
	const bank = retainedBank(process.cwd());
	const note = document('Credit Note', 'Credit Note Number: SYNTHETIC-CREDIT', 'Credit Note Total: EUR 25.07', 'Refund issued: EUR 25.07 if approved');
	assert.equal(matchFor(bank, 1, note, invoice('Invoice Total: EUR 25.07')).status, 'unmatched');
	const refund = document('Credit Note', 'Credit Note Number: SYNTHETIC-CREDIT', 'Credit Note Total: EUR 25.07', 'Amount Refunded: EUR 25.07');
	const match = matchFor(bank, 1, note, refund);
	assert.equal(match.status, 'uncertain');
	assert.deepEqual(match.candidates.map(({ documentId, direction }) => [documentId, direction]), [[refund.id, 'incoming']]);
	assert.equal(refund.result.sections[0].amounts.find((field) => field.id === match.candidates[0].amounts[0].documentFieldId)?.role, 'refund-payment');
});

test('keeps separate sections, preserves competing referenced candidates and returns deterministic results', () => {
	const bank = retainedBank(process.cwd());
	const split = invoice('Invoice Total: EUR 1,234.56', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 2.00');
	assert.equal(matchFor(bank, 0, split).status, 'uncertain');
	const left = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const right = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const match = matchFor(bank, 0, left, right, split);
	assert.equal(match.status, 'uncertain');
	assert.equal(match.candidates.filter((candidate) => candidate.issues.includes('competing-reference')).length, 2);
	assert.deepEqual(matchFor(bank, 0, right, split, left), match);
	const duplicateBank = retainedBank(process.cwd());
	const crossBank = suggestTransactionMatches([bank, duplicateBank], [left]);
	assert.equal(crossBank.filter((result) => result.candidates[0]?.issues.includes('competing-reference')).length, 2);
	assert.deepEqual(suggestTransactionMatches([duplicateBank, bank], [left]), crossBank);
});

test('keeps conflicting financial fields uncertain and rejects unknown currency and imprecise amount differences', () => {
	const bank = retainedBank(process.cwd());
	const match = matchFor(bank, 0, invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56', 'Invoice Total: EUR 12.00'));
	assert.equal(match.status, 'uncertain');
	assert.deepEqual(match.candidates[0].issues, ['conflicting-evidence']);
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: 1,234.56')).status, 'uncertain');
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: $1,234.56')).status, 'unmatched');
	const row = bank.result.transactions[0];
	row.accountAmount.value = { currency: 'EUR', coefficient: '-900719925474099301', scale: 2 };
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: EUR 9,007,199,254,740,993.02')).status, 'unmatched');
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: EUR 9,007,199,254,740,993.01')).status, 'uncertain');
});

test.for(["'", '’'])('suggests a receipt when the bank name contains an internal %s apostrophe', (apostrophe) => {
	const root = process.cwd();
	const bank = retainedBank(root);
	const booking = bank.result.transactions[0];
	const description = `Bloom${apostrophe}s Bar & Grill Lca`;
	booking.description.value = description;
	booking.counterpartyCandidate = null;
	booking.reportedOriginalAmount = null;
	booking.accountAmount.value = { coefficient: '-14663', scale: 2, currency: 'EUR' };
	const receipt = document('Receipt', 'Total: EUR 133.30');
	receipt.filePath = `${root}/Blooms.pdf`;

	const historical = matchFor(bank, 0, receipt);
	assert.equal(historical.status, 'unmatched');
	const [reviewed] = evaluateReviewMatches([historical], [bank], [documentRun(root, [receipt])]);
	assert.equal(reviewed.status, 'uncertain');
	assert.deepEqual(reviewed.candidates.map(({ documentId, signals }) => [documentId, signals.amount, signals.filename]), [
		[receipt.id, 'close', { state: 'partial', bankText: description, documentText: 'Blooms.pdf' }],
	]);

	booking.description.value = 'Bloom S Bar & Grill Lca';
	const [unrelated] = evaluateReviewMatches([historical], [bank], [documentRun(root, [receipt])]);
	assert.equal(unrelated.status, 'unmatched');
});
