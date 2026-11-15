import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BankImportInput, BankImportResult, ImportPage, PositionedSpan } from '../../src/shared/bank-import.js';
import { proposeStatementTransactions } from '../../electron/import/statement-table.js';
import { parsePaddleVlTable } from '../../electron/extraction/paddle-vl.js';
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
    const observed: string = '<fcel>Fikitive Bank<lcel><lcel><lcel><lcel><nl>' +
        [columns, ...bookings].map((row: string[]): string => `${row.map((cell: string): string => cell ? `<fcel>${cell}` : '<ecel>').join('')}<nl>`).join('');
    const input: BankImportInput = inputOf(bookings, columns, 'Kontowährung: EUR', true);
    const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, parsePaddleVlTable(observed)]]));
    assert.equal(result.status, 'complete');
    assert.equal(result.adapter, null);
    assert.deepEqual(result.localRecognition, { model: 'paddleocr-vl-1.6', parserVersion: '1' });
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
