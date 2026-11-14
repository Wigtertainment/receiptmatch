import type { ImportPage, SourceEvidence } from "../../src/shared/bank-import.js";
import type { DocumentIssue, SupportingDocument } from "../../src/shared/supporting-document.js";
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bankImportInputSchema, importIssue, type BankImportInput, type PositionedSpan } from '../../src/shared/bank-import.js';
import { formatMoney } from '../../src/shared/display.js';
import { formatDocumentTotal } from '../../src/shared/document-display.js';
import { supportingDocumentSchema, type DocumentSection } from '../../src/shared/supporting-document.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import type { ZodSafeParseResult } from 'zod';

// Independently invented examples; no private source names, values or identifiers.
function document(...pages: string[][]): BankImportInput {
    return {
        source: { sourceId: 'synthetic-document', sha256: 'd'.repeat(64) },
        extraction: { runId: 'synthetic-extraction', version: 'test-1' },
        issues: [],
        pages: pages.map((lines: string[], index: number): { pageId: string; pageNumber: number; width: number; height: number; status: "complete"; spans: { text: string; region: { x: number; y: number; width: number; height: number; }; method: "embedded-text"; }[]; } => ({
            pageId: `page-${index + 1}`, pageNumber: index + 1, width: 900, height: 1200, status: 'complete',
            spans: lines.map((text: string, row: number): { text: string; region: { x: number; y: number; width: number; height: number; }; method: "embedded-text"; } => ({ text, region: { x: 30, y: 25 + row * 25, width: 750, height: 12 }, method: 'embedded-text' }))
        }))
    };
}

function invoice(...extra: string[]): BankImportInput {
    return document(['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-ALPHA', 'Invoice Date: March 14, 2032', 'Currency: EUR', 'Invoice Total: EUR 73.25', ...extra]);
}

function amounts(section: DocumentSection, role: DocumentSection['amounts'][number]['role']): { coefficient: string; scale: number; currency: string | null; }[] {
    return section.amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === role).flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): { coefficient: string; scale: number; currency: string | null; }[] => field.candidates);
}

function references(section: DocumentSection, role: DocumentSection['references'][number]['role']): string[] {
    return section.references.filter((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === role).flatMap((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => field.candidates);
}

function dates(section: DocumentSection, role: DocumentSection['dates'][number]['role']): string[] {
    return section.dates.filter((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === role).flatMap((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => field.candidates);
}

test('a labelled invoice retains exact values, field roles, extraction and source evidence without modifying its input', (): void => {
    const input: BankImportInput = invoice('Subtotal: EUR 60.00', 'VAT: EUR 13.25', 'Due Date: 2032-04-14');
    const original: BankImportInput = structuredClone(input);
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.status, 'complete', JSON.stringify(result.issues));
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].kind, 'invoice');
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '7325', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[0], 'subtotal'), [{ coefficient: '6000', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[0], 'tax'), [{ coefficient: '1325', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(dates(result.sections[0], 'issue'), ['2032-03-14']);
    assert.deepEqual(dates(result.sections[0], 'due'), ['2032-04-14']);
    assert.deepEqual(references(result.sections[0], 'invoice'), ['SYNTHETIC-ALPHA']);
    assert.ok(result.sections[0].merchants.some((field: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.candidates.includes('Orchard Workshop')));
    assert.deepEqual(result.input, original);
    assert.deepEqual(input, original);
    assert.equal(supportingDocumentSchema.safeParse(result).success, true);
    for (const field of [...result.sections[0].amounts, ...result.sections[0].dates, ...result.sections[0].references, ...result.sections[0].merchants]) {
        assert.ok(field.evidence.length);
        assert.ok(field.evidence.every((evidence: SourceEvidence): boolean => evidence.pageId === 'page-1' && evidence.method === 'embedded-text'));
    }
    assert.equal('direction' in result, false);
    assert.equal('confidence' in result, false);
    assert.equal('approved' in result, false);
});

test('invoice total, applied payment and zero balance due remain separate without summing or inferring a refund', (): void => {
    const input: BankImportInput = invoice('Applied Transactions:', 'PAYMENT-SYNTHETIC March 14, 2032 -EUR 73.25', 'Balance Due: EUR 0.00');
    const result: SupportingDocument = interpretSupportingDocument(input);
    const section: DocumentSection = result.sections[0];
    assert.deepEqual(amounts(section, 'billed-total'), [{ coefficient: '7325', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(section, 'payment'), [{ coefficient: '-7325', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(section, 'balance-due'), [{ coefficient: '0', scale: 2, currency: 'EUR' }]);
    assert.ok(!result.issues.some((issue: DocumentIssue): boolean => issue.code.includes('conflict')));
    assert.equal('direction' in section, false);
});

test('document headers above the title stay with the same invoice instead of becoming an unrelated section', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Merchant: Meadow Consulting', 'Invoice No: SYNTHETIC-HEADER', 'Invoice Date: 2032-05-20', 'Currency: EUR',
		'CREDIT INVOICE', 'Invoice Total: 81.00']));
	assert.equal(result.sections.length, 1);
	assert.equal(result.sections[0].kind, 'invoice');
	assert.deepEqual(references(result.sections[0], 'invoice'), ['SYNTHETIC-HEADER']);
	assert.deepEqual(dates(result.sections[0], 'issue'), ['2032-05-20']);
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '8100', scale: 2, currency: 'EUR' }]);
});

test('exact large amounts and printed decimal scale survive without floating point rounding', (): void => {
	const input: BankImportInput = document(['Invoice', 'Invoice Total: EUR 9,876,543,210,987,654.3210', 'Balance Due: EUR -0.0020']);
	const result: SupportingDocument = interpretSupportingDocument(input);
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '98765432109876543210', scale: 4, currency: 'EUR' }]);
	assert.deepEqual(amounts(result.sections[0], 'balance-due'), [{ coefficient: '-20', scale: 4, currency: 'EUR' }]);
	for (const token of ["1'234.56", '1’234.56']) {
		const grouped: SupportingDocument = interpretSupportingDocument(document(['Invoice', `Invoice Total: EUR ${token}`]));
		assert.deepEqual(amounts(grouped.sections[0], 'billed-total'), [{ coefficient: '123456', scale: 2, currency: 'EUR' }]);
	}
});

test('credit invoice terms, credit-card wording and a negative line item do not change the whole document to a credit note', (): void => {
    const input: BankImportInput = document(['CREDIT INVOICE', 'Merchant: Harbour Consulting', 'Invoice No: SYNTHETIC-CREDIT-TERMS', 'Date: 2032-05-20', 'Currency: EUR',
        'Invoice Total: EUR 81.00', 'Unused time credit: -EUR 4.75', 'Payment Method: Credit Card', 'The invoice is payable upon issue.']);
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.sections[0].kind, 'invoice');
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '8100', scale: 2, currency: 'EUR' }]);
    assert.ok(result.sections[0].amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role !== 'credit-note-component' && field.candidates.some((value: { coefficient: string; scale: number; currency: string | null; }): boolean => value.coefficient === '-475')));
    assert.equal('direction' in result.sections[0], false);
});

test('a billing summary, attached invoice, distinct credit notes and FX instructions retain their own sections and references', (): void => {
    const input: BankImportInput = document(
        ['Billing Summary', 'Merchant: Harbour Services Ltd', 'Billing Number: SYNTHETIC-NET', 'Document Date: 2032-05-20', 'Total Amount: EUR (12.50)', 'No payments Required'],
        ['Invoice', 'Merchant: Harbour Services Ltd', 'Tax Invoice Number: SYNTHETIC-INVOICE', 'Tax Invoice Date: 2032-05-20', 'Currency: EUR', 'Total: EUR 40.00'],
        ['Credit Note', 'Credit Note Number: SYNTHETIC-CN-1', 'Credit Note Date: 2032-05-20', 'Currency: EUR', 'Credit Note Total: EUR 22.50', 'Invoice number: SYNTHETIC-PRIOR-1'],
        ['Credit Note', 'Credit Note Number: SYNTHETIC-CN-2', 'Credit Note Date: 2032-05-20', 'Currency: EUR', 'Credit Note Total: EUR 30.00', 'Invoice number: SYNTHETIC-PRIOR-2'],
        ['Payment Instructions', 'Exchange rate', 'Pricing Currency: USD', 'Exchange rate to EUR: 0.843210']
    );
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.sections.length, 5);
    assert.deepEqual(result.sections.map((section: DocumentSection): "unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" => section.kind), ['billing-summary', 'invoice', 'credit-note', 'credit-note', 'payment-information']);
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '-1250', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[1], 'billed-total'), [{ coefficient: '4000', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[2], 'credit-note-component'), [{ coefficient: '2250', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[3], 'credit-note-component'), [{ coefficient: '3000', scale: 2, currency: 'EUR' }]);
    assert.ok(references(result.sections[2], 'related-invoice').includes('SYNTHETIC-PRIOR-1'));
    assert.ok(!references(result.sections[2], 'invoice').includes('SYNTHETIC-PRIOR-1'));
    assert.deepEqual(result.sections[4].amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role !== 'informational-fx'), []);
    assert.ok(result.sections[4].currencies.some((field: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'informational-fx' && field.candidates.includes('USD')));
    assert.ok(result.sections.slice(0, 4).flatMap((section: DocumentSection): { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] => section.amounts).flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): { coefficient: string; scale: number; currency: string | null; }[] => field.candidates).every((value: { coefficient: string; scale: number; currency: string | null; }): boolean => value.currency !== 'USD'));
});

test('different documents can start on the same physical page', (): void => {
    const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Invoice Number: SYNTHETIC-A', 'Total: EUR 21.00', 'Credit Note', 'Credit Note Number: SYNTHETIC-B', 'Credit Note Total: EUR 5.00']));
    assert.equal(result.sections.length, 2);
    assert.deepEqual(result.sections.map((section: DocumentSection): string[] => section.pageIds), [['page-1'], ['page-1']]);
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '2100', scale: 2, currency: 'EUR' }]);
    assert.deepEqual(amounts(result.sections[1], 'credit-note-component'), [{ coefficient: '500', scale: 2, currency: 'EUR' }]);
});

test('two invoices on the same page keep independent references and totals', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Invoice Number: SYNTHETIC-FIRST', 'Total: EUR 21.00',
		'Invoice', 'Invoice Number: SYNTHETIC-SECOND', 'Total: EUR 32.00']));
	assert.equal(result.sections.length, 2);
	assert.deepEqual(references(result.sections[0], 'invoice'), ['SYNTHETIC-FIRST']);
	assert.deepEqual(references(result.sections[1], 'invoice'), ['SYNTHETIC-SECOND']);
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '2100', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(result.sections[1], 'billed-total'), [{ coefficient: '3200', scale: 2, currency: 'EUR' }]);
});

test('a repeated invoice heading with the same reference across pages remains a continuation', (): void => {
	const input: BankImportInput = document(['Invoice', 'Invoice Number: SYNTHETIC-SAME', 'Total: EUR 21.00'], ['Invoice', 'Invoice Number: SYNTHETIC-SAME', 'Total: EUR 21.00']);
	const result: SupportingDocument = interpretSupportingDocument(input);
	assert.equal(result.sections.length, 1);
	assert.deepEqual(result.sections[0].pageIds, ['page-1', 'page-2']);
	assert.ok(!result.issues.some((issue: DocumentIssue): boolean => issue.code.includes('conflict')));
});

test('damaged amount tokens are unresolved in full, never a valid numeric prefix or suffix', (): void => {
	for (const token of ['--19.95', '19.95CR', '19,95.20', '1.23.45', '19.95?', '19.95-', "1'23.45", '12’34.56']) {
		const input: BankImportInput = invoice();
		input.pages[0].spans.find((span: PositionedSpan): boolean => span.text.startsWith('Invoice Total:'))!.text = `Invoice Total: EUR ${token}`;
		const result: SupportingDocument = interpretSupportingDocument(input);
		assert.equal(result.status, 'partial', token);
		assert.deepEqual(amounts(result.sections[0], 'billed-total'), [], token);
		assert.ok(result.issues.length, token);
		assert.ok(result.sections[0].amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText.includes(token))), token);
	}
});

test('payment due is a balance awaiting payment, not an applied payment', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(invoice('Payment due: EUR 73.25'));
	assert.deepEqual(amounts(result.sections[0], 'balance-due'), [{ coefficient: '7325', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(result.sections[0], 'payment'), []);
});

test('cash payment and non-cash consideration on the same sentence do not become a combined amount', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Passenger / Itinerary Receipt', 'In addition to the cash amount of EUR 63.27, 1450 miles were used.', 'Grand Total: EUR 70.00']));
	assert.deepEqual(amounts(result.sections[0], 'payment'), [{ coefficient: '6327', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '7000', scale: 2, currency: 'EUR' }]);
	assert.ok(result.input?.pages[0].spans.some((span: PositionedSpan): boolean => span.text.includes('1450 miles')));
});

test('damaged document references are not silently shortened to a different identifier', (): void => {
	const input: BankImportInput = invoice();
	input.pages[0].spans.find((span: PositionedSpan): boolean => span.text.startsWith('Invoice Number:'))!.text = 'Invoice Number: BROKEN?REF';
	const result: SupportingDocument = interpretSupportingDocument(input);
	assert.equal(result.status, 'partial');
	assert.ok(!references(result.sections[0], 'invoice').includes('BROKEN'));
	assert.ok(result.sections[0].references.some((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText.includes('BROKEN?REF'))));
});

test('multiple labelled dates on a single line keep their own roles', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Invoice Date 2032-05-20 Due Date 2032-06-20', 'Invoice Total: EUR 8.00']));
	assert.deepEqual(dates(result.sections[0], 'issue'), ['2032-05-20']);
	assert.deepEqual(dates(result.sections[0], 'due'), ['2032-06-20']);
});

test('uses a generic Date when there is no specific issue date', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Receipt', 'Date: 16/10/2032 Original Due Date: 2032-10-18', 'Payment Date: 2032-10-17']));
	assert.deepEqual(dates(result.sections[0], 'issue'), ['2032-10-16']);
	assert.deepEqual(dates(result.sections[0], 'payment'), ['2032-10-17']);
	assert.deepEqual(dates(result.sections[0], 'due'), ['2032-10-18']);
});

test('prefers an explicit issue date and leaves ambiguous generic dates unresolved', (): void => {
	const section: (...lines: string[]) => DocumentSection = (...lines: string[]): DocumentSection => interpretSupportingDocument(document(['Receipt', ...lines])).sections[0];
	for (const label of ['Invoice Date', 'Issue Date', 'Belegdatum']) {
		assert.deepEqual(dates(section('Date: 16/10/2032', `${label}: 2032-10-17`), 'issue'), ['2032-10-17']);
	}
	assert.deepEqual(dates(section('Date: 04/05/2032'), 'issue'), []);
	assert.deepEqual(dates(section('Date: 16/10/2032', 'Date: 17/10/2032'), 'issue'), []);
	assert.deepEqual(dates(section('Date: 16/10/2032 17/10/2032'), 'issue'), []);
	assert.deepEqual(dates(section('16/10/2032 Original'), 'issue'), []);
});

test('associates a Date label with an OCR date on the same visual row', (): void => {
	const input: BankImportInput = document([]);
	input.pages[0].spans = [
		{ text: 'Date', region: { x: 22, y: 397, width: 30, height: 10.5 }, method: 'local-ocr' },
		{ text: '16/10/2032', region: { x: 78, y: 392.5, width: 75, height: 13 }, method: 'local-ocr' },
		{ text: 'Original', region: { x: 289.5, y: 392.5, width: 51.5, height: 15 }, method: 'local-ocr' },
	];
	const result: SupportingDocument = interpretSupportingDocument(input);
	const date: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | undefined = result.sections[0].dates.find((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'issue');
	assert.ok(date);
	assert.deepEqual(date.candidates, ['2032-10-16']);
	assert.deepEqual(date.evidence.map((item: SourceEvidence): string => item.rawText), ['Date', '16/10/2032 Original']);

	input.pages[0].spans.push({ text: 'Due', region: { x: 1, y: 397, width: 18, height: 10.5 }, method: 'local-ocr' });
	assert.deepEqual(dates(interpretSupportingDocument(input).sections[0], 'issue'), []);
	input.pages[0].spans.pop();
	input.pages[0].spans[0].region.y = 370;
	assert.deepEqual(dates(interpretSupportingDocument(input).sections[0], 'issue'), []);
});

test('multiple labelled amounts on one line keep billed total and balance due distinct', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Invoice Total EUR 88.00 Balance Due EUR 0.00']));
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '8800', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(result.sections[0], 'balance-due'), [{ coefficient: '0', scale: 2, currency: 'EUR' }]);
});

test('tax totals cannot supply a missing billed total', (): void => {
	for (const [label, role] of [['VAT Total', 'tax'], ['Tax Total', 'tax'], ['Total VAT', 'tax'], ['Total Tax', 'tax'], ['Subtotal including VAT', 'subtotal']] as const) {
		const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Merchant: Fern Workshop', 'Invoice Number: SYNTHETIC-TAX', 'Invoice Date: 2032-05-20', 'Currency: EUR', `${label}: EUR 19.95`]));
		assert.equal(result.status, 'partial', label);
		assert.deepEqual(amounts(result.sections[0], 'billed-total'), [], label);
		assert.deepEqual(amounts(result.sections[0], role), [{ coefficient: '1995', scale: 2, currency: 'EUR' }], label);
	}
	const including: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Total (including Tax): EUR 88.00']));
	assert.deepEqual(amounts(including.sections[0], 'billed-total'), [{ coefficient: '8800', scale: 2, currency: 'EUR' }]);
});

test('a column value above its total label retains both evidence regions and needs association review', (): void => {
	const input: BankImportInput = invoice();
	input.pages[0].spans = input.pages[0].spans.filter((span: PositionedSpan): boolean => !span.text.startsWith('Invoice Total:'));
	input.pages[0].spans.push(
		{ text: 'EUR 47.12', region: { x: 500, y: 300, width: 90, height: 12 }, method: 'embedded-text' },
		{ text: 'Grand Total', region: { x: 500, y: 318, width: 90, height: 12 }, method: 'embedded-text' }
	);
	const result: SupportingDocument = interpretSupportingDocument(input);
	assert.equal(result.status, 'partial');
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '4712', scale: 2, currency: 'EUR' }]);
	const total: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total')!;
	assert.ok(total.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText === 'EUR 47.12'));
	assert.ok(total.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText === 'Grand Total'));
	assert.ok(result.issues.some((issue: DocumentIssue): boolean => issue.fieldId === total.id && /association|unconfirmed/.test(issue.code)));
	assert.equal(formatDocumentTotal(result), null);
	const telephone: BankImportInput = invoice();
	telephone.pages[0].spans = telephone.pages[0].spans.filter((span: PositionedSpan): boolean => !span.text.startsWith('Invoice Total:'));
	telephone.pages[0].spans.push(
		{ text: 'Phone:', region: { x: 500, y: 282, width: 90, height: 12 }, method: 'embedded-text' },
		{ text: '5551234567', region: { x: 500, y: 300, width: 90, height: 12 }, method: 'embedded-text' },
		{ text: 'Total', region: { x: 500, y: 318, width: 90, height: 12 }, method: 'embedded-text' }
	);
	const rejected: SupportingDocument = interpretSupportingDocument(telephone);
	assert.equal(rejected.status, 'partial');
	assert.deepEqual(amounts(rejected.sections[0], 'billed-total'), []);
});

test('equivalent exact totals with different printed scales are not conflicting financial values', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(invoice('Invoice Total: EUR 73.2500'));
	assert.ok(!result.issues.some((issue: DocumentIssue): boolean => issue.code.includes('conflict')));
	assert.deepEqual(amounts(result.sections[0], 'billed-total'), [
		{ coefficient: '7325', scale: 2, currency: 'EUR' }, { coefficient: '732500', scale: 4, currency: 'EUR' }
	]);
	assert.equal(formatDocumentTotal(result), formatMoney({ coefficient: '7325', scale: 2, currency: 'EUR' }));
});

test('the document contract rejects a complete result with contradictory scalar fields and no conflict issue', (): void => {
	const result: SupportingDocument = interpretSupportingDocument(invoice());
	const other: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = structuredClone(result.sections[0].amounts[0]);
	other.id = 'synthetic-contradictory-total'; other.candidates[0].coefficient = '9999';
	result.sections[0].amounts.push(other);
	assert.equal(result.status, 'complete');
	assert.equal(supportingDocumentSchema.safeParse(result).success, false);
});

test('malformed amount candidates are validation failures without throwing during scalar comparisons', (): void => {
	for (const bad of [{ coefficient: 'garbled', scale: 2, currency: 'EUR' }, { coefficient: '0', scale: 19, currency: 'EUR' }]) {
		const result: SupportingDocument = interpretSupportingDocument(invoice());
		result.sections[0].amounts[0].candidates = [bad];
		assert.doesNotThrow((): ZodSafeParseResult<SupportingDocument> => supportingDocumentSchema.safeParse(result));
		assert.equal(supportingDocumentSchema.safeParse(result).success, false);
	}
});

test('page continuation and repeated totals preserve evidence without double-counting or declaring a conflict', (): void => {
    const input: BankImportInput = invoice();
    input.pages.push(document(['Continuation', 'Invoice Number: SYNTHETIC-ALPHA', 'Invoice Total: EUR 73.25']).pages[0]);
    input.pages[1].pageId = 'page-2'; input.pages[1].pageNumber = 2;
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.sections.length, 1);
    assert.deepEqual(result.sections[0].pageIds, ['page-1', 'page-2']);
    assert.ok(amounts(result.sections[0], 'billed-total').every((value: { coefficient: string; scale: number; currency: string | null; }): boolean => value.coefficient === '7325'));
    assert.ok(!result.issues.some((issue: DocumentIssue): boolean => issue.code.includes('conflict')));
    assert.ok(result.sections[0].amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total').flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence).some((evidence: SourceEvidence): boolean => evidence.pageId === 'page-2'));
    assert.equal(formatDocumentTotal(result), formatMoney({ coefficient: '7325', scale: 2, currency: 'EUR' }));
});

test('ambiguous slash dates retain both calendar readings and do not replace the invoice date with due or service dates', (): void => {
    const input: BankImportInput = document(['Invoice', 'Invoice Date: 04/05/2032', 'Due Date: 2032-06-20', 'Service Period: 2032-03-01 - 2032-03-31', 'Invoice Total: EUR 9.00']);
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.status, 'partial');
    assert.deepEqual([...new Set(dates(result.sections[0], 'issue'))].sort(), ['2032-04-05', '2032-05-04']);
    assert.deepEqual(dates(result.sections[0], 'due'), ['2032-06-20']);
	assert.ok([...dates(result.sections[0], 'service-period'), ...dates(result.sections[0], 'service-start')].includes('2032-03-01'));
	assert.ok([...dates(result.sections[0], 'service-period'), ...dates(result.sections[0], 'service-end')].includes('2032-03-31'));
    assert.ok(result.issues.some((issue: DocumentIssue): number | false => issue.code.includes('ambig') && issue.evidence.length));
});

test('two-digit years and invalid dates stay unresolved without inventing a century or rolling the calendar', (): void => {
	for (const raw of ['04/05/32', '2032-02-30', 'February 30, 2032', 'Mayhem 14, 2032']) {
        const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', `Invoice Date: ${raw}`, 'Total: EUR 1.00']));
        assert.equal(result.status, 'partial');
        assert.deepEqual(dates(result.sections[0], 'issue'), []);
        assert.ok(result.sections[0].dates.some((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.evidence.some((evidence: SourceEvidence): boolean => evidence.rawText.includes(raw))));
    }
});

test('a dollar symbol or source country does not establish USD, and missing currency does not discard the amount', (): void => {
    const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Merchant: Bay Workshop, USA', 'Invoice Number: SYNTHETIC-DOLLAR', 'Invoice Date: 2032-05-20', 'Total: $19.95']));
    assert.equal(result.status, 'partial');
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '1995', scale: 2, currency: null }]);
    assert.ok(!result.sections[0].currencies.flatMap((field: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => field.candidates).includes('USD'));
    assert.ok(result.issues.some((issue: DocumentIssue): boolean => /currency/i.test(`${issue.code} ${issue.field}`)));
});

test('uses EUR for amounts without currency evidence and preserves explicit foreign currencies', (): void => {
	const receipt: (...lines: string[]) => DocumentSection = (...lines: string[]): DocumentSection => interpretSupportingDocument(document(['Receipt', ...lines])).sections[0];
	assert.deepEqual(amounts(receipt('Total: 27.50'), 'billed-total'), [{ coefficient: '2750', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(receipt('Currency: USD', 'Total: 27.50'), 'billed-total'), [{ coefficient: '2750', scale: 2, currency: 'USD' }]);
	assert.deepEqual(amounts(receipt('Currency: XOF', 'Total: 27.50'), 'billed-total'), [{ coefficient: '2750', scale: 2, currency: null }]);
});

test('reads an unlabeled printed total from an arithmetically consistent invoice summary', (): void => {
	const input: BankImportInput = document(['Invoice', 'Currency: GBP']);
	const page: ImportPage = input.pages[0];
	const add: (text: string, x: number, y: number, width: number) => void = (text: string, x: number, y: number, width: number): void => {
		page.spans.push({ text, region: { x, y, width, height: 9 }, method: 'embedded-text' });
	};
	add('VAT ANALYSIS', 70, 225, 80);
	add('I N V O I C E S U M M A R Y', 400, 226, 130);
	add('Discount Value', 440, 242, 65);
	add('Net Amount', 520, 242, 45);
	add('0.00', 465, 257, 15);
	add('70.00', 552, 257, 18);
	add('Vat Amount:', 450, 272, 50);
	add('14.00', 552, 272, 18);
	add('84.00', 552, 287, 18);

	const result: SupportingDocument = interpretSupportingDocument(input);
	const [field]: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] = result.sections[0].amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total');
	assert.ok(field);
	assert.deepEqual(field.candidates, [{ coefficient: '8400', scale: 2, currency: 'GBP' }]);
	assert.ok(field.evidence.some((item: SourceEvidence): boolean => item.rawText === '84.00'));
	assert.ok(!result.issues.some((issue: DocumentIssue): boolean => issue.code === 'missing-field' && issue.field === 'billed-total'));
	page.spans[1].text = 'Invoice Number: SYNTHETIC-A';
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), [{ coefficient: '8400', scale: 2, currency: 'EUR' }]);
	add('Invoice Total: EUR 84.00', 550, 315, 95);
	assert.equal(amounts(interpretSupportingDocument(input).sections[0], 'billed-total').length, 1);
	page.spans.pop();

	const printed: PositionedSpan = page.spans.at(-1)!;
	printed.text = '85.00';
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), []);
	printed.text = '84.00';
	printed.region.x = 350;
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), []);
	printed.region.x = 552;
	add('84.00', 600, 287, 18);
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), []);
});

test('recognizes an unlabeled receipt date and recovers a clipped total from the printed VAT breakdown', (): void => {
	const input: BankImportInput = document([]);
	const page: ImportPage = input.pages[0];
	const add: (text: string, x: number, y: number, width: number, height?: number) => PositionedSpan = (text: string, x: number, y: number, width: number, height: number = 16): PositionedSpan => {
		const span: PositionedSpan = { text, region: { x, y, width, height }, method: 'local-ocr' };
		page.spans.push(span);
		return span;
	};
	add('SUBTOTAL', 12, 237, 77, 19);
	const original: PositionedSpan = add('ORIGINAL', 33, 264, 76, 19);
	add('14 May 2032', 15, 290, 105, 17);
	add('20:26', 131, 293, 47, 17);
	const printed: PositionedSpan = add('0.00', 411, 738, 44, 31);
	add('{', 466, 744, 8, 26);
	add('TOTAL', 280, 753, 46);
	add('Tax included', 108, 795, 114);
	add('Base', 308, 797, 37);
	add('Tax', 449, 799, 26);
	add('VAT 9%', 166, 846, 55);
	add('64.22', 280, 846, 45);
	const vat: PositionedSpan = add('5.78', 421, 848, 36);
	add('€', 468, 851, 8, 13);

	const result: SupportingDocument = interpretSupportingDocument(input);
	const section: DocumentSection = result.sections[0];
	assert.deepEqual(dates(section, 'issue'), ['2032-05-14']);
	assert.deepEqual(amounts(section, 'subtotal'), [{ coefficient: '6422', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(section, 'tax'), [{ coefficient: '578', scale: 2, currency: 'EUR' }]);
	assert.deepEqual(amounts(section, 'billed-total'), [{ coefficient: '7000', scale: 2, currency: 'EUR' }]);
	assert.equal(formatDocumentTotal(result), formatMoney({ coefficient: '7000', scale: 2, currency: 'EUR' }));
	assert.ok(result.issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total'));

	vat.text = '5.88';
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), []);
	vat.text = '5.78';
	printed.text = '80.00';
	assert.deepEqual(amounts(interpretSupportingDocument(input).sections[0], 'billed-total'), []);
	printed.text = '70.00';
	assert.ok(!interpretSupportingDocument(input).issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total'));
	original.text = 'UNRELATED';
	assert.deepEqual(dates(interpretSupportingDocument(input).sections[0], 'issue'), []);
});

test('currency declarations stay inside their own section', (): void => {
    const result: SupportingDocument = interpretSupportingDocument(document(['Invoice', 'Currency: USD', 'Invoice Number: SYNTHETIC-A', 'Total: 11.00'],
        ['Invoice', 'Invoice Number: SYNTHETIC-B', 'Total: $12.00']));
    assert.equal(result.sections.length, 2);
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '1100', scale: 2, currency: 'USD' }]);
    assert.deepEqual(amounts(result.sections[1], 'billed-total'), [{ coefficient: '1200', scale: 2, currency: null }]);
});

test('conflicting totals remain candidates with an issue while distinct payments remain separate events', (): void => {
    const result: SupportingDocument = interpretSupportingDocument(invoice('Invoice Total: EUR 73.35', 'Payment: EUR -20.00', 'Payment: EUR -53.25'));
    assert.equal(result.status, 'partial');
    assert.deepEqual(amounts(result.sections[0], 'billed-total').map((value: { coefficient: string; scale: number; currency: string | null; }): string => value.coefficient).sort(), ['7325', '7335']);
    const conflicts: DocumentIssue[] = result.issues.filter((issue: DocumentIssue): boolean => issue.code.includes('conflict'));
    assert.ok(conflicts.length);
    assert.ok(!conflicts.some((issue: DocumentIssue): boolean => (issue.field ?? '').includes('payment')));
    assert.deepEqual(amounts(result.sections[0], 'payment').map((value: { coefficient: string; scale: number; currency: string | null; }): string => value.coefficient).sort(), ['-2000', '-5325']);
    assert.equal(formatDocumentTotal(result), null);
});

test('unlabelled values and customer, table, order or account identifiers never supply a missing invoice reference', (): void => {
    const input: BankImportInput = document(['Receipt', 'Table No: 12', 'Customer Number: SYNTHETIC-CUSTOMER', 'Account Number: SYNTHETIC-ACCOUNT', 'Order Number: SYNTHETIC-ORDER', 'Total: 43.21', 'Unclassified source value 987.65']);
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.status, 'partial');
    assert.deepEqual(references(result.sections[0], 'invoice'), []);
    assert.deepEqual(references(result.sections[0], 'receipt'), []);
    assert.ok(references(result.sections[0], 'table').includes('12'));
    assert.ok(references(result.sections[0], 'customer').includes('SYNTHETIC-CUSTOMER'));
    assert.ok(references(result.sections[0], 'account').includes('SYNTHETIC-ACCOUNT'));
    assert.ok(references(result.sections[0], 'order').includes('SYNTHETIC-ORDER'));
    assert.deepEqual(result.input, input);
    assert.ok(result.issues.some((issue: DocumentIssue): boolean => /reference/i.test(`${issue.code} ${issue.field}`)));
});

test('unrecognised languages and damaged glyphs retain raw evidence rather than manufacturing a corrected reference or sign', (): void => {
    const input: BankImportInput = document(['ΑΠΟΔΕΙΞΗ', 'Invoice Number: SYNTHETIC\0BROKEN', 'Invoice Total: \0$3.11', '(cid:129)43,99', '<img src=x onerror=alert(1)>']);
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.input, input);
    assert.ok(result.issues.length);
    assert.ok(!result.sections.flatMap((section: DocumentSection): { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] => section.references).flatMap((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => field.candidates).includes('SYNTHETIC-BROKEN'));
    assert.ok(!result.sections.flatMap((section: DocumentSection): { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] => section.amounts).flatMap((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): { coefficient: string; scale: number; currency: string | null; }[] => field.candidates).some((value: { coefficient: string; scale: number; currency: string | null; }): boolean => value.coefficient === '-311'));
});

test('OCR words, split labels and mixed extraction methods retain positioned evidence and deterministic interpretation', (): void => {
    const input: BankImportInput = invoice();
    input.pages[0].spans = input.pages[0].spans.flatMap((line: PositionedSpan): PositionedSpan[] => {
        let x: number = 30;
        return line.text.split(' ').map((text: string): PositionedSpan => {
            const width: number = text.length * 7;
            const span: PositionedSpan = { text, region: { x, y: line.region.y, width, height: 12 }, method: 'local-ocr' };
            x += width + 7;
            return span;
        });
    });
    input.pages[0].spans[0].method = 'embedded-text';
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '7325', scale: 2, currency: 'EUR' }]);
    assert.ok(result.sections[0].amounts[0].evidence.some((evidence: SourceEvidence): boolean => evidence.method === 'local-ocr'));
    const reordered: BankImportInput = structuredClone(input);
    reordered.pages[0].spans.reverse();
    const again: SupportingDocument = interpretSupportingDocument(reordered);
    assert.deepEqual(again.sections, result.sections);
    assert.deepEqual(again.issues, result.issues);
});

test('failed or blank pages and extractor warnings stay visible; a readable invoice can still be retained', (): void => {
    const input: BankImportInput = invoice();
    input.pages.push({ pageId: 'page-2', pageNumber: 2, width: 900, height: 1200, status: 'failed', spans: [] });
    input.issues.push({ ...importIssue('page-failed', 'Synthetic page failure.'), pageId: 'page-2' });
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.input, input);
    assert.ok(result.issues.some((issue: DocumentIssue): boolean => issue.code === 'page-failed'));
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '7325', scale: 2, currency: 'EUR' }]);
    const blank: SupportingDocument = interpretSupportingDocument(document([]));
    assert.equal(blank.status, 'failed');
    assert.ok(blank.issues.length);
    assert.equal(supportingDocumentSchema.safeParse(blank).success, true);
});

test('invalid extraction is rejected at the interpretation boundary', (): void => {
    for (const input of [null, {}, { ...invoice(), pages: [] }]) {
        const result: SupportingDocument = interpretSupportingDocument(input);
        assert.equal(result.status, 'failed');
        assert.ok(result.issues.length);
        assert.equal(supportingDocumentSchema.safeParse(result).success, true);
    }
});

test('the document contract rejects forged evidence and orphaned or reused identities', (): void => {
    const result: SupportingDocument = interpretSupportingDocument(invoice());
    assert.equal(supportingDocumentSchema.safeParse(result).success, true);
    for (const mutate of [
        (value: typeof result): void => {
            value.sections[0].amounts[0].evidence[0].pageId = 'missing-page';
        },
        (value: typeof result): void => {
            value.sections[0].amounts[0].evidence[0].region.x = 100000;
        },
        (value: typeof result): void => {
            value.sections[0].pageIds = ['missing-page'];
        },
        (value: typeof result): void => {
            value.sections.push(structuredClone(value.sections[0]));
        },
        (value: typeof result): void => {
            value.sections[0].dates[0].id = value.sections[0].amounts[0].id;
        },
        (value: typeof result): void => {
            value.status = 'complete'; value.issues.push({ code: 'synthetic', severity: 'warning', message: 'Needs review.', sectionId: 'missing-section', fieldId: null, field: null, evidence: [] });
        }
    ]) {
        const changed: SupportingDocument = structuredClone(result); mutate(changed);
        assert.equal(supportingDocumentSchema.safeParse(changed).success, false);
    }
    assert.equal(bankImportInputSchema.safeParse(invoice()).success, true);
});

test('reads receipt tax categories below the total and excludes tax registration identifiers', (): void => {
    const input: BankImportInput = document(['Harbour Cafe', 'VAT: 103000000', 'TIC: 12300000C', 'VAT No. CY10500000Z', 'Tax ID: 8888888',
        'Total: EUR 70.00', 'Food 9% 4.95', 'BevNonAlc9% 0.83', 'All Taxes are Included']);
    const page: ImportPage = input.pages[0];
    const food: PositionedSpan = page.spans.find((span: PositionedSpan): boolean => span.text.startsWith('Food'))!;
    food.text = 'Food 9%';
    page.spans.push({ ...food, text: '4.95', region: { ...food.region, x: 620, y: food.region.y + 3, width: 55 } });
    food.region.width = 100;
    const result: SupportingDocument = interpretSupportingDocument(input);
    assert.deepEqual(amounts(result.sections[0], 'tax'), [
        { coefficient: '495', scale: 2, currency: 'EUR' },
        { coefficient: '83', scale: 2, currency: 'EUR' }
    ]);
    assert.ok(result.sections[0].amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'tax').every((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): number => field.evidence.length));
    assert.ok(result.input?.pages[0].spans.some((span: PositionedSpan): boolean => span.text === 'VAT: 103000000'));
    assert.deepEqual(amounts(result.sections[0], 'billed-total'), [{ coefficient: '7000', scale: 2, currency: 'EUR' }]);

    const unrelated: SupportingDocument = interpretSupportingDocument(document(['Receipt', 'Food 9% 4.95', 'Total: EUR 70.00', 'Food 9% 4.95']));
    assert.deepEqual(amounts(unrelated.sections[0], 'tax'), []);
});

test('recovers one missing leading digit from aligned receipt items and retains the OCR evidence', (): void => {
    const input: BankImportInput = document([]);
    const page: ImportPage = input.pages[0];
    const add: (text: string, x: number, y: number, width?: number, method?: PositionedSpan["method"]) => number = (text: string, x: number, y: number, width: number = 30, method: PositionedSpan['method'] = 'local-ocr'): number =>
        page.spans.push({ text, region: { x, y, width, height: 16 }, method });
    add('Receipt', 40, 40);
    add('2', 35, 104); add('Lunch', 75, 103, 75); add('29.50', 400, 105, 46);
    add('1', 35, 127); add('Drinks', 75, 126, 75); add('~', 335, 124); add('19.20', 402, 129, 44);
    add(']', 510, 144);
    add('1', 35, 150); add('Dessert', 75, 150, 75); add('59.50', 402, 151, 44);
    add('19:51', 35, 188, 42); add('Total', 90, 187, 50); add('08.20', 371, 189, 75);

    const result: SupportingDocument = interpretSupportingDocument(input);
    const recovered: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = result.sections[0].amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total')!;
    assert.deepEqual(recovered.candidates, [{ coefficient: '10820', scale: 2, currency: 'EUR' }]);
    assert.ok(recovered.evidence.some((item: SourceEvidence): boolean => item.rawText.includes('08.20')));
    assert.ok(recovered.evidence.some((item: SourceEvidence): boolean => item.rawText.includes('29.50')));
    assert.ok(result.issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total' && issue.fieldId === recovered.id));
    assert.equal(formatDocumentTotal(result), formatMoney({ coefficient: '10820', scale: 2, currency: 'EUR' }));

    const print: PositionedSpan = page.spans.find((span: PositionedSpan): boolean => span.text === '08.20')!;
    print.text = '08.21';
    assert.ok(!interpretSupportingDocument(input).issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total'));
    print.text = '08.20';
    add('4.00', 330, 150, 44);
    assert.ok(!interpretSupportingDocument(input).issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total'));
    page.spans.pop();
    print.method = 'embedded-text';
    assert.ok(!interpretSupportingDocument(input).issues.some((issue: DocumentIssue): boolean => issue.code === 'reconstructed-total'));
});
