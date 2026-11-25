import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { BankImportInput, ImportPage, PositionedSpan } from '../../src/shared/bank-import.js';
import { PDF_EXTRACTION_VERSION } from '../../src/shared/pdf-extraction.js';
import { NUEXTRACT_RECEIPT_VERSION, type ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import type { DocumentSection, SupportingDocument } from '../../src/shared/supporting-document.js';
import { hasFullDocumentReference, interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { reanalyzeNuExtractReceipt, reviewNuExtractResult, type INuExtractReceiptDependencies } from '../../electron/documents/nuextract-receipt.js';
import type { DocumentImagesResult } from '../../electron/extraction/host.js';
import type { INuExtractRequest, INuExtractRuntimeFiles } from '../../electron/extraction/nuextract-runtime.js';

const receiptBytes: Buffer = Buffer.from('%PDF-synthetic-receipt');
const sha256: string = createHash('sha256').update(receiptBytes).digest('hex');

function document(...pages: string[][]): SupportingDocument {
    const input: BankImportInput = {
        source: { sourceId: randomUUID(), sha256 },
        extraction: { runId: randomUUID(), version: PDF_EXTRACTION_VERSION },
        pages: pages.map((spans: string[], index: number): ImportPage => ({
            pageId: 'page-' + (index + 1), pageNumber: index + 1, width: 600, height: 800, status: 'complete',
            spans: spans.map((text: string, row: number): PositionedSpan => ({
                text, method: 'embedded-text', region: { x: 30, y: 30 + row * 20, width: 540, height: 12 }
            }))
        })),
        issues: []
    };
    return interpretSupportingDocument(input);
}

test('does not replace an invoice total with a value from the billing summary or credit note', (): void => {
    const before: SupportingDocument = document(
        ['Billing Summary', 'Billing Number: SYNTHETIC-NET', 'Document Date: 2032-05-20', 'Total Amount: EUR (24.17)'],
        ['Invoice', 'Invoice Number: SYNTHETIC-INVOICE', 'Invoice Date: 2032-05-20', 'Invoice Total: EUR 25.80'],
        ['Credit Note', 'Credit Note Number: SYNTHETIC-CN', 'Credit Note Date: 2032-05-20', 'Credit Note Total: EUR 24.17']
    );
    assert.deepEqual(before.sections.map((section: DocumentSection): string => section.kind), ['billing-summary', 'invoice', 'credit-note']);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, {
        invoice_or_receipt_number: 'SYNTHETIC-INVOICE', issue_date: '2032-05-20', gross_total: 24.17
    });
    assert.equal(result.model, 'nuextract3');
    assert.deepEqual(result.analysis.sections, before.sections);
    assert.deepEqual(result.changes, [{ label: 'Billed total', before: null, after: '24.17', unrecognized: true }]);
    assert.equal(result.analysis.input?.extraction.version, NUEXTRACT_RECEIPT_VERSION);
});

test('shows an account number as unverified when the invoice reference is absent', (): void => {
    const before: SupportingDocument = document(['Invoice', 'Account Number: SYNTHETIC-ACCOUNT', 'Invoice Date: 2032-05-20', 'Invoice Total: EUR 25.80']);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, {
        invoice_or_receipt_number: 'SYNTHETIC-ACCOUNT', issue_date: '2032-05-20', gross_total: 25.8
    });
    assert.deepEqual(result.analysis.sections, before.sections);
    assert.deepEqual(result.changes, [{ label: 'Invoice or receipt number', before: null, after: 'SYNTHETIC-ACCOUNT', unrecognized: true }]);
});

test('uses an explicit German issue date with day-month-year notation and retains source positions', (): void => {
    const before: SupportingDocument = document(['Rechnung', 'Rechnungsnummer: SYNTHETIC-INVOICE', 'Rechnungsdatum: 06.10.2026', 'Rechnungsbetrag: EUR 25.80']);
    const fields: DocumentSection['dates'] = before.sections[0].dates;
    assert.equal(fields[0].candidates.length, 2);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, { issue_date: '2026-10-06' });
    assert.deepEqual(result.analysis.sections[0].dates[0], { ...fields[0], candidates: ['2026-10-06'] });
    assert.ok(result.changes.some((change: typeof result.changes[number]): boolean => change.after === '2026-10-06' && !change.unrecognized));
    assert.notEqual(result.analysis.input?.extraction.runId, before.input?.extraction.runId);
    assert.deepEqual(result.analysis.input?.pages, before.input?.pages);
    const swapped: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, { issue_date: '2026-06-10' });
    assert.deepEqual(swapped.analysis.sections, before.sections);
    assert.equal(swapped.changes[0].unrecognized, true);
});

test('requires independent evidence before narrowing ambiguous dates or amounts', (): void => {
    const before: SupportingDocument = document(['Invoice', 'Invoice Number: SYNTHETIC-INVOICE', 'Invoice Date: 03/04/2026', 'Invoice Total: EUR 1.250']);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, { issue_date: '2026-03-04', gross_total: 1250 });
    assert.deepEqual(result.analysis.sections, before.sections);
    assert.deepEqual(result.changes.map((change: typeof result.changes[number]): string | undefined => change.unrecognized ? change.label : undefined), ['Issue date', 'Billed total']);
});

test('recovers a clearly labelled printed check number as usable receipt evidence', (): void => {
    const before: SupportingDocument = document(['Receipt', 'Check No: TEST-2047', 'Grand Total: EUR 25.80']);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, { invoice_or_receipt_number: 'TEST-2047' });
    const field: DocumentSection['references'][number] | undefined = result.analysis.sections[0].references.find((candidate: DocumentSection['references'][number]): boolean =>
        candidate.role === 'receipt');
    assert.ok(field);
    assert.deepEqual(field.candidates, ['TEST-2047']);
    assert.equal(hasFullDocumentReference(field, 'TEST-2047'), true);
});

test('recovers a missing issue date only when the printed label has a nearby continuation', (): void => {
    const before: SupportingDocument = document(['Invoice', 'Invoice Number: SYNTHETIC-INVOICE', 'Issued on', '2032-05-20', 'Invoice Total: EUR 25.80']);
    assert.equal(before.sections[0].dates.some((field: DocumentSection['dates'][number]): boolean => field.role === 'issue'), false);
    const result: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(before, { issue_date: '2032-05-20' });
    const field: DocumentSection['dates'][number] | undefined = result.analysis.sections[0].dates.find((candidate: DocumentSection['dates'][number]): boolean => candidate.role === 'issue');
    assert.ok(field);
    assert.deepEqual(field.candidates, ['2032-05-20']);
    assert.deepEqual(field.evidence.map((evidence: typeof field.evidence[number]): string => evidence.rawText), ['Issued on', '2032-05-20']);

    const differentPage: SupportingDocument = document(['Invoice', 'Invoice Number: SYNTHETIC-INVOICE', 'Invoice Total: EUR 25.80', 'Issued on'], ['2032-05-20']);
    const unsafe: ReturnType<typeof reviewNuExtractResult> = reviewNuExtractResult(differentPage, { issue_date: '2032-05-20' });
    assert.ok(unsafe.changes.some((change: typeof unsafe.changes[number]): boolean => change.unrecognized === true));
});

test('verifies original bytes before rendering and closes the runtime after extracting a receipt', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-nuextract-'));
    try {
        const filePath: string = path.join(root, 'receipt.pdf');
        await writeFile(filePath, receiptBytes);
        const previous: SupportingDocument = document(['Invoice', 'Invoice Number: SYNTHETIC-INVOICE', 'Invoice Date: 2032-05-20', 'Invoice Total: EUR 25.80']);
        const calls: string[] = [];
        const dependencies: INuExtractReceiptDependencies = {
            runtimeFiles(): Promise<INuExtractRuntimeFiles> {
                return Promise.resolve({ executable: 'synthetic-server', model: 'synthetic-model', projector: 'synthetic-projector' });
            },
            render(bytes: Uint8Array): Promise<DocumentImagesResult> {
                assert.deepEqual(bytes, receiptBytes);
                calls.push('render');
                return Promise.resolve({ status: 'complete', images: [Uint8Array.of(137)] });
            },
            start(): ReturnType<NonNullable<INuExtractReceiptDependencies['start']>> {
                calls.push('start');
                return Promise.resolve({
                    extract(input: INuExtractRequest): Promise<Record<string, unknown>> {
                        assert.deepEqual(input.images, [Uint8Array.of(137)]);
                        assert.deepEqual(Object.keys(input.template), ['invoice_or_receipt_number', 'issue_date', 'gross_total']);
                        calls.push('extract');
                        return Promise.resolve({ invoice_or_receipt_number: 'SYNTHETIC-INVOICE', issue_date: '2032-05-20', gross_total: 25.8 });
                    },
                    close(): Promise<void> {
                        calls.push('close');
                        return Promise.resolve();
                    }
                });
            }
        };
        const result: ReceiptAiResult = await reanalyzeNuExtractReceipt({ filePath, format: 'pdf', previous, sha256 }, dependencies);
        assert.equal(result.status, 'ready');
        assert.deepEqual(calls, ['render', 'start', 'extract', 'close']);
        await writeFile(filePath, Buffer.from('changed'));
        const rejected: ReceiptAiResult = await reanalyzeNuExtractReceipt({ filePath, format: 'pdf', previous, sha256 }, dependencies);
        assert.equal(rejected.status, 'failed');
        assert.deepEqual(calls, ['render', 'start', 'extract', 'close']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
