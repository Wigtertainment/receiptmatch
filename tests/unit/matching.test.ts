import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, ImportPage, SourceEvidence, TransactionCandidate } from "../../src/shared/bank-import.js";
import type { MatchCandidate, TransactionMatch } from "../../src/shared/workspace-matching.js";
import type { MatchNameEvidence } from "../../src/shared/workspace-matching.js";
import type { ReviewMatchCandidate } from "../../src/shared/workspace-matching.js";
import type { ReviewMatch } from "../../src/shared/workspace-matching.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { suggestTransactionMatches } from '../../electron/matching.js';
import { evaluateReviewMatches } from '../../electron/review-matching.js';
import { storedSupportingDocumentSchema } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, extractedDocument, retainedBank } from './document-fixtures.js';

function document(...lines: string[]): StoredSupportingDocument {
	const { input }: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(Buffer.from(lines.join('\n')), randomUUID());
	const page: ImportPage = input.pages[0];
	page.spans = lines.map((text: string, index: number): { text: string; region: { x: number; y: number; width: number; height: number; }; method: "embedded-text"; } => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text' }));
	return storedSupportingDocumentSchema.parse({ id: randomUUID(), importedAt: '2032-05-20T12:00:00Z', filePath: `${process.cwd()}/synthetic.pdf`, format: 'pdf', result: interpretSupportingDocument(input) });
}

function invoice(...lines: string[]): StoredSupportingDocument {
	return document('Invoice', 'Merchant: Cedar Workshop', ...lines);
}

function matchFor(bank: StoredBankImport, index: number, ...documents: ReturnType<typeof document>[]): TransactionMatch {
	const { transactionId }: { rowId: string; transactionId: string; } = bank.transactions[index];
	return suggestTransactionMatches([bank], documents).find((match: TransactionMatch): boolean => match.transactionId === transactionId)!;
}

test('rechecks the amounts of a historically reliable candidate before displaying it', (): void => {
	const root: string = process.cwd();
	const bank: StoredBankImport = retainedBank(root);
	const original: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const replacement: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.57');
	const historical: ReturnType<typeof matchFor> = matchFor(bank, 0, original);
	const [candidate]: MatchCandidate[] = historical.candidates;
	candidate.documentId = replacement.id;
	candidate.sectionId = replacement.result.sections[0].sectionId;
	candidate.amounts[0].documentAmount.coefficient = '123457';
	const [reviewed]: ReviewMatch[] = evaluateReviewMatches([historical], [bank], [documentRun(root, [replacement])]);
	assert.equal(historical.status, 'reliable');
	assert.equal(reviewed.status, 'uncertain');
	assert.equal(reviewed.candidates[0].signals.amount, 'close');
	assert.deepEqual(reviewed.candidates[0].issues, ['amount-needs-review']);
});

test('normalizes only reference case and surrounding whitespace and applies inclusive calendar-day evidence', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const row: TransactionCandidate = bank.result.transactions[0];
	row.references[0].value = '  synthetic-a  ';
	const source: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-03-06', 'Invoice Total: EUR 1,234.5600');
	const result: ReturnType<typeof matchFor> = matchFor(bank, 0, source);
	const [candidate]: MatchCandidate[] = result.candidates;
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

test('uses payment date before issue date and keeps distant or missing dates from excluding a referenced match', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const invoiceFields: string[] = ['Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56'];
	const distant: ReturnType<typeof matchFor> = matchFor(bank, 0, invoice(...invoiceFields, 'Invoice Date: 2032-02-27', 'Payment Date: 2032-03-07'));
	assert.equal(distant.status, 'reliable');
	assert.deepEqual(distant.candidates[0].date, {
		documentFieldId: distant.candidates[0].date?.documentFieldId, bookingDate: '2032-02-28', documentDate: '2032-03-07', role: 'payment', daysApart: 8, withinWindow: false,
	});
	const missing: ReturnType<typeof matchFor> = matchFor(bank, 0, invoice(...invoiceFields, 'Due Date: 2032-02-28'));
	assert.equal(missing.status, 'reliable');
	assert.equal(missing.candidates[0].date, null);
});

test('requires the full spaced reference even for previously imported truncated candidates', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const source: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A 0042', 'Invoice Total: EUR 1,234.56');
	assert.equal(matchFor(bank, 0, source).status, 'uncertain');
	bank.result.transactions[0].references[0].value = 'synthetic-a 0042';
	assert.equal(matchFor(bank, 0, source).status, 'reliable');
	bank.result.transactions[0].references[0].value = 'SYNTHETIC-A';
	source.result.sections[0].references[0].candidates = ['SYNTHETIC-A'];
	assert.equal(matchFor(bank, 0, source).status, 'uncertain');
});

test('compares original and settlement currency separately and retains both bases on one candidate when equal', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const original: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 1,500.01');
	const wrongCurrency: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: USD 1,234.56');
	const wrongAmount: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,500.01');
	assert.equal(matchFor(bank, 0, wrongCurrency, wrongAmount).status, 'unmatched');
	const match: ReturnType<typeof matchFor> = matchFor(bank, 0, original, wrongCurrency, wrongAmount);
	assert.equal(match.status, 'reliable');
	assert.deepEqual(match.candidates.map((candidate: MatchCandidate): (string | ("account-settlement" | "reported-original")[])[] => [candidate.documentId, candidate.amounts.map((amount: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }): "account-settlement" | "reported-original" => amount.basis)]), [[original.id, ['reported-original']]]);
	const row: TransactionCandidate = bank.result.transactions[0];
	row.reportedOriginalAmount = row.accountAmount;
	const same: ReturnType<typeof matchFor> = matchFor(bank, 0, invoice('Invoice Total: EUR 1,234.56'));
	assert.deepEqual(same.candidates.map((candidate: MatchCandidate): ("account-settlement" | "reported-original")[] => candidate.amounts.map((amount: { basis: "account-settlement" | "reported-original"; transactionAmount: { coefficient: string; currency: string; scale: number; }; documentFieldId: string; documentAmount: { coefficient: string; currency: string; scale: number; }; }): "account-settlement" | "reported-original" => amount.basis)), [['account-settlement', 'reported-original']]);
});

test('prefers explicit payments and ignores balance due, line items and FX as payment bases', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const misleading: ReturnType<typeof invoice> = invoice('Invoice Total: EUR 1,234.56', 'Amount Paid: EUR 20.00', 'Balance Due: EUR 1,234.56', 'Informational amount: USD 1,500.01');
	assert.equal(matchFor(bank, 0, misleading).status, 'unmatched');
	const actual: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,254.56', 'Amount Paid: EUR 1,234.56', 'Balance Due: EUR 20.00');
	const match: ReturnType<typeof matchFor> = matchFor(bank, 0, actual);
	assert.equal(match.status, 'reliable');
	assert.equal(actual.result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === match.candidates[0].amounts[0].documentFieldId)?.role, 'payment');
	const scheduled: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 20.00', 'Payment scheduled: EUR 1,234.56');
	assert.equal(matchFor(bank, 0, scheduled).status, 'unmatched');
	const applied: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,254.56', 'Applied Transactions:', 'PAYMENT-SYNTHETIC March 14, 2032 -EUR 1,234.56');
	assert.equal(matchFor(bank, 0, applied).status, 'reliable');
	const payment: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = applied.result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'payment')!;
	payment.evidence = payment.evidence.filter((item: SourceEvidence): boolean => item.rawText !== 'Applied Transactions:');
	assert.equal(matchFor(bank, 0, applied).status, 'reliable');
});

test('requires explicit executed refund evidence for incoming transactions', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const note: ReturnType<typeof document> = document('Credit Note', 'Credit Note Number: SYNTHETIC-CREDIT', 'Credit Note Total: EUR 25.07', 'Refund issued: EUR 25.07 if approved');
	assert.equal(matchFor(bank, 1, note, invoice('Invoice Total: EUR 25.07')).status, 'unmatched');
	const refund: ReturnType<typeof document> = document('Credit Note', 'Credit Note Number: SYNTHETIC-CREDIT', 'Credit Note Total: EUR 25.07', 'Amount Refunded: EUR 25.07');
	const match: ReturnType<typeof matchFor> = matchFor(bank, 1, note, refund);
	assert.equal(match.status, 'uncertain');
	assert.deepEqual(match.candidates.map(({ documentId, direction }: MatchCandidate): string[] => [documentId, direction]), [[refund.id, 'incoming']]);
	assert.equal(refund.result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === match.candidates[0].amounts[0].documentFieldId)?.role, 'refund-payment');
});

test('keeps separate sections, preserves competing referenced candidates and returns deterministic results', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const split: ReturnType<typeof invoice> = invoice('Invoice Total: EUR 1,234.56', 'Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 2.00');
	assert.equal(matchFor(bank, 0, split).status, 'uncertain');
	const left: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const right: ReturnType<typeof invoice> = invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56');
	const match: ReturnType<typeof matchFor> = matchFor(bank, 0, left, right, split);
	assert.equal(match.status, 'uncertain');
	assert.equal(match.candidates.filter((candidate: MatchCandidate): boolean => candidate.issues.includes('competing-reference')).length, 2);
	assert.deepEqual(matchFor(bank, 0, right, split, left), match);
	const duplicateBank: StoredBankImport = retainedBank(process.cwd());
	const crossBank: TransactionMatch[] = suggestTransactionMatches([bank, duplicateBank], [left]);
	assert.equal(crossBank.filter((result: TransactionMatch): boolean => result.candidates[0]?.issues.includes('competing-reference')).length, 2);
	assert.deepEqual(suggestTransactionMatches([duplicateBank, bank], [left]), crossBank);
});

test('keeps conflicting financial fields uncertain and rejects unknown currency and imprecise amount differences', (): void => {
	const bank: StoredBankImport = retainedBank(process.cwd());
	const match: ReturnType<typeof matchFor> = matchFor(bank, 0, invoice('Invoice Number: SYNTHETIC-A', 'Invoice Total: EUR 1,234.56', 'Invoice Total: EUR 12.00'));
	assert.equal(match.status, 'uncertain');
	assert.deepEqual(match.candidates[0].issues, ['conflicting-evidence']);
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: 1,234.56')).status, 'uncertain');
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: $1,234.56')).status, 'unmatched');
	const row: TransactionCandidate = bank.result.transactions[0];
	row.accountAmount.value = { currency: 'EUR', coefficient: '-900719925474099301', scale: 2 };
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: EUR 9,007,199,254,740,993.02')).status, 'unmatched');
	assert.equal(matchFor(bank, 0, invoice('Invoice Total: EUR 9,007,199,254,740,993.01')).status, 'uncertain');
});

test.for(["'", '’'])('suggests a receipt when the bank name contains an internal %s apostrophe', (apostrophe: string): void => {
	const root: string = process.cwd();
	const bank: StoredBankImport = retainedBank(root);
	const booking: TransactionCandidate = bank.result.transactions[0];
	const description: string = `Bloom${apostrophe}s Bar & Grill Lca`;
	booking.description.value = description;
	booking.counterpartyCandidate = null;
	booking.reportedOriginalAmount = null;
	booking.accountAmount.value = { coefficient: '-14663', scale: 2, currency: 'EUR' };
	const receipt: ReturnType<typeof document> = document('Receipt', 'Total: EUR 133.30');
	receipt.filePath = `${root}/Blooms.pdf`;

	const historical: ReturnType<typeof matchFor> = matchFor(bank, 0, receipt);
	assert.equal(historical.status, 'unmatched');
	const [reviewed]: ReviewMatch[] = evaluateReviewMatches([historical], [bank], [documentRun(root, [receipt])]);
	assert.equal(reviewed.status, 'uncertain');
	assert.deepEqual(reviewed.candidates.map(({ documentId, signals }: ReviewMatchCandidate): (string | MatchNameEvidence)[] => [documentId, signals.amount, signals.filename]), [
		[receipt.id, 'close', { state: 'partial', bankText: description, documentText: 'Blooms.pdf' }],
	]);

	booking.description.value = 'Bloom S Bar & Grill Lca';
	const [unrelated]: ReviewMatch[] = evaluateReviewMatches([historical], [bank], [documentRun(root, [receipt])]);
	assert.equal(unrelated.status, 'unmatched');
});
