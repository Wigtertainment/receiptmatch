import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { bankImportResultSchema, type BankImportInput, type BankImportResult, type ImportPage, type PositionedSpan } from '../../src/shared/bank-import.js';
import type { DocumentImagesResult } from '../../electron/extraction/host.js';
import type { NuExtractRequest, NuExtractRuntime, NuExtractRuntimeFiles } from '../../electron/extraction/nuextract-runtime.js';
import { proposeNuExtractStatement, type StatementProposalExtraction } from '../../electron/import/nuextract-statement.js';
import { proposeStatementTransactions } from '../../electron/import/statement-table.js';
import { span } from './bank-fixtures.js';

type Row = readonly string[];
const columns: string[] = ['Buchungstag', 'Verwendungszweck', 'Soll', 'Haben', 'Kontostand'];
const bookings: string[][] = [
    ['02.03.2026', 'Linden Handel', '64,20', '', '1.235,80'],
    ['03.03.2026', 'Tulpe Design', '', '180,00', '1.415,80'],
    ['04.03.2026', 'Klee Markt', '0,00', '12,09', '1.427,89']
];

function evidenceRow(values: Row, y: number, localOcr: boolean = false): PositionedSpan[] {
    const anchors: number[] = [40, 150, 325, 405, 485];
    return values.flatMap((value: string, index: number): PositionedSpan[] => {
        const words: string[] = localOcr ? value.split(' ') : [value];
        let x: number = anchors[index];
        return words.filter(Boolean).map((word: string): PositionedSpan => {
            const width: number = word.length * 5;
            const positioned: PositionedSpan = span(word, x, y, width, localOcr ? 'local-ocr' : 'embedded-text');
            x += width + 3;
            return positioned;
        });
    });
}

function inputOf(rows: Row[] = bookings, headings: string[] = columns, currency: string = 'Kontowährung: EUR', localOcr: boolean = false): BankImportInput {
    return {
        source: { sourceId: 'synthetic-table-source', sha256: 'd'.repeat(64) },
        extraction: { runId: 'synthetic-table-run', version: 'test-1' }, issues: [],
        pages: [{ pageId: 'page-1', pageNumber: 1, width: 600, height: 800, status: 'complete',
            spans: [...evidenceRow([currency], 65, localOcr), ...evidenceRow(headings, 140, localOcr),
                ...rows.flatMap((row: Row, index: number): PositionedSpan[] => evidenceRow(row, 185 + index * 30, localOcr))] }]
    };
}

test('uses grounded positions and monetary columns to propose exact localized bookings', (): void => {
    const input: BankImportInput = inputOf(bookings, columns, 'Kontowährung: EUR', true);
    const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, [columns, ...bookings]]]));
    assert.equal(result.status, 'complete');
    assert.equal(result.adapter, null);
    assert.deepEqual(result.localRecognition, { model: 'nuextract3', parserVersion: '1' });
    assert.deepEqual(result.transactions.map((row: BankImportResult['transactions'][number]): unknown[] => [row.bookingDate.value, row.direction, row.accountAmount.value]), [
        ['2026-03-02', 'outgoing', { coefficient: '-6420', scale: 2, currency: 'EUR' }],
        ['2026-03-03', 'incoming', { coefficient: '18000', scale: 2, currency: 'EUR' }],
        ['2026-03-04', 'incoming', { coefficient: '1209', scale: 2, currency: 'EUR' }]
    ]);
    assert.deepEqual(result.transactions[0].accountAmount.evidence.map((value: BankImportResult['transactions'][number]['evidence'][number]): string => value.rawText), ['64,20', 'Soll']);
    assert.ok(result.transactions[0].description.evidence.every((item: BankImportResult['transactions'][number]['evidence'][number]): boolean => item.method === 'local-ocr'));
    assert.equal(result.accountSections[0].currency.evidence.map((item: BankImportResult['transactions'][number]['evidence'][number]): string => item.rawText).join(' '), 'Kontowährung: EUR');
});

test('keeps source rows open when the model swaps columns, omits entries or invents an extra booking', (): void => {
    const swapped: Row = [bookings[0][0], bookings[0][1], '', '64,20', bookings[0][4]];
    const hallucinated: Row = ['06.03.2026', 'Fabricated', '88,99', '', '999,99'];
    const result: BankImportResult = proposeStatementTransactions(inputOf(), new Map([[1, [columns, swapped, bookings[2], hallucinated]]]));
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.transactions.map((row: BankImportResult['transactions'][number]): string => row.description.value), ['Klee Markt']);
    assert.deepEqual(result.unresolvedDrafts.map((draft: BankImportResult['unresolvedDrafts'][number]): string | undefined => draft.description?.value), ['Linden Handel', 'Tulpe Design']);
    assert.ok(result.unresolvedDrafts.every((draft: BankImportResult['unresolvedDrafts'][number]): boolean => draft.accountAmount === null && draft.direction === null));
    assert.ok(result.issues.some((issue: BankImportResult['issues'][number]): boolean => issue.code === 'unverified-table-coverage' && issue.pageId === 'page-1'));
});

test('requires corroboration of the full description when the source wraps across lines', (): void => {
    const input: BankImportInput = inputOf();
    input.pages[0].spans.push(...evidenceRow(['', 'Invoice 5017'], 198));
    const incomplete: BankImportResult = proposeStatementTransactions(input, new Map([[1, [columns, ...bookings]]]));
    assert.equal(incomplete.status, 'partial');
    assert.equal(incomplete.transactions.length, 2);
    assert.equal(incomplete.unresolvedDrafts[0].description?.value, 'Linden Handel Invoice 5017');
    assert.equal(incomplete.unresolvedDrafts[0].accountAmount, null);

    const completeRows: string[][] = bookings.map((row: string[]): string[] => [...row]);
    completeRows[0][1] += ' Invoice 5017';
    const complete: BankImportResult = proposeStatementTransactions(input, new Map([[1, [columns, ...completeRows]]]));
    assert.equal(complete.status, 'complete');
    assert.equal(complete.transactions[0].description.value, 'Linden Handel Invoice 5017');
    assert.equal(complete.transactions[0].description.evidence.length, 2);
});

test('retains independently grounded duplicate-looking rows only with matching table coverage', (): void => {
    const original: BankImportInput = inputOf([bookings[0], bookings[0]]);
    const unsatisfied: BankImportResult = proposeStatementTransactions(original, new Map([[1, [columns, bookings[0]]]]));
    assert.equal(unsatisfied.transactions.length, 0);
    assert.equal(unsatisfied.unresolvedDrafts.length, 2);
    const corroborated: BankImportResult = proposeStatementTransactions(original, new Map([[1, [columns, bookings[0], bookings[0]]]]));
    assert.equal(corroborated.status, 'complete');
    assert.equal(corroborated.transactions.length, 2);
    assert.notEqual(corroborated.transactions[0].bookingDate.evidence[0].region.y, corroborated.transactions[1].bookingDate.evidence[0].region.y);
});

test('preserves source order and reports unreadable pages, dated balance summaries, and ambiguous amounts correctly', (): void => {
    const headings: string[] = ['Booking date', 'Description', 'Amount', 'Balance'];
    const rows: Row[] = [
        ['01 Apr 2026', 'Balance brought forward', '+500.00', '500.00'],
        ['02 Apr 2026', 'Workshop', '-15.63', '484.37'],
        ['03 Apr 2026', 'Cafe', '+1,234', '485.60'],
        ['04 Apr 2026', 'Unknown direction', '2.40', '488.00'],
        ['05/04/2026', 'Ambiguous date', '-4.00', '484.00']
    ];
    const input: BankImportInput = inputOf(rows, headings, 'Account currency: USD');
    const missing: ImportPage = { pageId: 'page-2', pageNumber: 2, width: 600, height: 800, status: 'failed', spans: [] };
    input.pages.push(missing);
    const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, [headings, ...[...rows].reverse()]]]));
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.transactions.map((row: BankImportResult['transactions'][number]): string => row.bookingDate.value), ['2026-04-02']);
    assert.equal(result.unresolvedDrafts.length, 3);
    assert.equal(result.unresolvedDrafts[0].accountAmount, null);
    assert.equal(result.unresolvedDrafts[1].direction, null);
    assert.equal(result.unresolvedDrafts[2].bookingDate, null);
    assert.ok(result.issues.some((issue: BankImportResult['issues'][number]): boolean => issue.code === 'unverified-table-page' && issue.pageId === 'page-2'));
});

test('requires the account currency and column labels to be corroborated outside transaction descriptions', (): void => {
    const alternate: Row = [bookings[0][0], 'Currency: USD', ...bookings[0].slice(2)];
    const input: BankImportInput = inputOf([alternate], columns, 'Kontoauszug');
    const missing: BankImportResult = proposeStatementTransactions(input, new Map([[1, [columns, alternate]]]));
    assert.equal(missing.status, 'failed');
    assert.equal(missing.issues[0].code, 'unverified-account-currency');
    const reversed: Row = ['Buchungstag', 'Verwendungszweck', 'Haben', 'Soll', 'Kontostand'];
    const disagree: BankImportResult = proposeStatementTransactions(inputOf(), new Map([[1, [reversed, ...bookings]]]));
    assert.equal(disagree.status, 'failed');
    assert.equal(disagree.issues[0].code, 'no-verified-table-pages');

    const conflict: BankImportInput = inputOf();
    conflict.pages[0].spans.push(span('Account currency: USD', 40, 100, 110));
    assert.equal(proposeStatementTransactions(conflict, new Map([[1, [columns, ...bookings]]])).issues[0].code, 'unverified-account-currency');
    const foreign: BankImportInput = inputOf(bookings, columns, 'Foreign currency: USD');
    assert.equal(proposeStatementTransactions(foreign, new Map([[1, [columns, ...bookings]]])).issues[0].code, 'unverified-account-currency');
});

test('holds conflicting row currencies and rows with damaged financial text for review', (): void => {
    const headings: string[] = ['Booking date', 'Description', 'Amount', 'Balance', 'Transaction currency'];
    const rows: Row[] = [
        ['2026-03-01', 'Workshop', '-15.63', '484.37', 'USD'],
        ['2026-03-02', 'Cafe', '-20.00', '464.37', 'EUR'],
        ['??.03.2026', 'Card payment', '(12.00)', 'USD 452.37', 'USD']
    ];
    const result: BankImportResult = proposeStatementTransactions(inputOf(rows, headings, 'Currency: USD'), new Map([[1, [headings, ...rows]]]));
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.transactions.map((row: BankImportResult['transactions'][number]): string => row.description.value), ['Workshop']);
    assert.deepEqual(result.unresolvedDrafts.map((row: BankImportResult['unresolvedDrafts'][number]): string | undefined => row.description?.value), ['Cafe', 'Card payment']);
    assert.ok(result.unresolvedDrafts.every((row: BankImportResult['unresolvedDrafts'][number]): boolean => row.accountAmount === null));
});

test('does not combine pages that explicitly identify different accounts in the same currency', (): void => {
    const input: BankImportInput = inputOf();
    const second: ImportPage = { ...input.pages[0], pageId: 'page-2', pageNumber: 2, spans: [...input.pages[0].spans, span('Account number: 222', 40, 100, 110)] };
    input.pages[0].spans.push(span('Account number: 111', 40, 100, 110));
    input.pages.push(second);
    const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, [columns, ...bookings]], [2, [columns, ...bookings]]]));
    assert.equal(result.status, 'failed');
    assert.equal(result.issues[0].code, 'multiple-statement-accounts');
    assert.deepEqual(result.transactions, []);
});

test('rejects conflicting account metadata on a cover page without a recognized table', (): void => {
    const input: BankImportInput = inputOf(bookings, columns, 'Account currency: EUR');
    const original: ImportPage = input.pages[0];
    const continued: ImportPage = { ...original, pageId: 'page-3', pageNumber: 3, spans: original.spans.filter((source: PositionedSpan): boolean => !source.text.startsWith('Account currency:')) };
    const cover: ImportPage = { ...original, pageId: 'page-2', pageNumber: 2, spans: [span('Account currency: USD', 40, 40, 120)] };
    input.pages.push(cover, continued);
    const tables: Map<number, Row[]> = new Map([[1, [columns, ...bookings]], [3, [columns, ...bookings]]]);
    const currencies: BankImportResult = proposeStatementTransactions(input, tables);
    assert.equal(currencies.issues[0].code, 'unverified-account-currency');
    assert.deepEqual(currencies.transactions, []);

    original.spans.push(span('Account number: 111', 40, 100, 110));
    cover.spans = [span('Account number: 222', 40, 40, 110)];
    const accounts: BankImportResult = proposeStatementTransactions(input, tables);
    assert.equal(accounts.issues[0].code, 'multiple-statement-accounts');
    assert.deepEqual(accounts.transactions, []);
});

test('keeps an apparent amount unresolved when its source span crosses into the balance column', (): void => {
    const headings: string[] = ['Booking date', 'Description', 'Amount', 'Balance'];
    const input: BankImportInput = inputOf([['2026-03-02', 'Source payment', '', '']], headings, 'Currency: USD');
    input.pages[0].spans.push(span('-123,456,789.00', 330, 185, 99));
    const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, [headings, ['2026-03-02', 'Source payment', '-123,456,789.00', '']]]]));
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.transactions, []);
    assert.equal(result.unresolvedDrafts[0].accountAmount, null);
    assert.equal(result.unresolvedDrafts[0].evidence.find((item: BankImportResult['unresolvedDrafts'][number]['evidence'][number]): boolean => item.rawText === '-123,456,789.00')?.region.x, 330);
});

test('checks NuExtract3 tables against the original statement and preserves the original provenance', async (): Promise<void> => {
    const bytes: Uint8Array = Buffer.from('Synthetic original');
    const input: BankImportInput = inputOf();
    input.source.sha256 = createHash('sha256').update(bytes).digest('hex');
    const image: Uint8Array = new Uint8Array([1, 2, 3]);
    let calls: number = 0;
    let closed: boolean = false;
    const outcome: StatementProposalExtraction = await proposeNuExtractStatement(bytes, input, {
        runtimeFiles: (): Promise<NuExtractRuntimeFiles> => Promise.resolve({ executable: 'local', model: 'local', projector: 'local' }),
        render: (source: Uint8Array, sourceId: string, format: string): Promise<DocumentImagesResult> => {
            assert.deepEqual(source, bytes);
            assert.equal(sourceId, input.source.sourceId);
            assert.equal(format, 'pdf');
            return Promise.resolve({ status: 'complete', images: [image] });
        },
        start: (): Promise<Pick<NuExtractRuntime, 'extract' | 'close'>> => Promise.resolve({
            extract: ({ images, jsonObject }: NuExtractRequest): Promise<Record<string, unknown>> => {
                calls++;
                assert.deepEqual(images, [image]);
                assert.equal(jsonObject, true);
                return Promise.resolve({ headings: columns, rows: [
                    { cells: [bookings[0][0], bookings[0][1], bookings[0][2], null, bookings[0][4]] },
                    { cells: [bookings[1][0], bookings[1][1], null, '999,99', bookings[1][4]] }
                ] });
            },
            close: (): Promise<void> => {
                closed = true;
                return Promise.resolve();
            }
        })
    });
    assert.equal(outcome.status, 'proposed');
    assert.equal(outcome.result.status, 'partial');
    assert.equal(outcome.result.sourceProvenance?.sha256, input.source.sha256);
    assert.equal(outcome.result.localRecognition?.model, 'nuextract3');
    assert.equal(outcome.result.transactions.length, 1);
    assert.equal(outcome.result.transactions[0].accountAmount.value.coefficient, '-6420');
    assert.equal(outcome.result.unresolvedDrafts.length, 2);
    assert.equal(calls, 1);
    assert.equal(closed, true);
});

test('rejects a changed statement snapshot before starting image extraction or inference', async (): Promise<void> => {
    const outcome: StatementProposalExtraction = await proposeNuExtractStatement(Buffer.from('Unrelated bytes'), inputOf(), {
        runtimeFiles: (): Promise<NuExtractRuntimeFiles> => assert.fail('The model should not be queried for a different source'),
        render: (): Promise<DocumentImagesResult> => assert.fail('The different source should not be rendered')
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.issues[0].code, 'invalid-provenance');
});

test('preserves the provenance of already imported PaddleOCR statements', (): void => {
    const result: BankImportResult = proposeStatementTransactions(inputOf(), new Map([[1, [columns, ...bookings]]]));
    result.localRecognition = { model: 'paddleocr-vl-1.6', parserVersion: '1' };
    assert.deepEqual(bankImportResultSchema.parse(result).localRecognition, result.localRecognition);
});
