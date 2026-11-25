import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { importIssue, type BankImportInput, type BankImportResult, type PositionedSpan } from '../../src/shared/bank-import.js';
import { PDF_EXTRACTION_VERSION, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import { StatementImportService, type BankImportAttempt, type IBankImportOptions, type StatementFallbackResult } from '../../electron/import/service.js';
import { proposeStatementTransactions } from '../../electron/import/statement-table.js';
import type { StatementProposalExtraction } from '../../electron/import/nuextract-statement.js';
import { span, statement } from './bank-fixtures.js';

const original: string = 'Synthetic PDF snapshot';
const table: string[][] = [['Booking date', 'Description', 'Amount', 'Balance'], ['2026-02-02', 'Juniper Supply', '-118.05', '1,681.95']];

function extract(bytes: Uint8Array, sourceId: string, knownBank: boolean = false): ExtractionResult {
    const input: BankImportInput = statement();
    input.source = { sourceId, sha256: createHash('sha256').update(bytes).digest('hex') };
    input.extraction = { runId: randomUUID(), version: PDF_EXTRACTION_VERSION };
    if (!knownBank) {
        const x: number[] = [36, 160, 332, 430];
        input.pages[0].spans = [span('Currency: USD', 36, 50, 95), ...table.flatMap((cells: string[], row: number): PositionedSpan[] =>
            cells.map((cell: string, column: number): PositionedSpan => span(cell, x[column], 100 + 30 * row, cell.length * 5)))];
    }
    return { status: 'complete', input };
}

test('offers recognition only on request and retries the same original bytes after model setup', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-ai-service-'));
    try {
        const file: string = path.join(root, 'synthetic.pdf');
        const expectedHash: string = createHash('sha256').update(original).digest('hex');
        await writeFile(file, original);
        let selectionCount: number = 0;
        let recognitionCount: number = 0;
        let ready: boolean = false;
        const statementImportService: StatementImportService = new StatementImportService({
            choose: (): Promise<string> => {
                selectionCount++;
                return Promise.resolve(file);
            },
            extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => Promise.resolve(extract(bytes, sourceId)),
            propose: (bytes: Uint8Array, input: BankImportInput): Promise<StatementProposalExtraction> => {
                recognitionCount++;
                assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
                assert.equal(input.source.sha256, expectedHash);
                return Promise.resolve(ready ? { status: 'proposed', result: proposeStatementTransactions(input, new Map([[1, table]])) } :
                    { status: 'unavailable', issues: [importIssue('local-model-unavailable', 'Make the model available in Settings.')] });
            }
        });
        const offered: BankImportAttempt = await statementImportService.run({ existing: [] });
        assert.equal(offered.status, 'unsupported');
        assert.ok('fallback' in offered);
        assert.equal(offered.fallback.filePath, file);
        assert.equal(recognitionCount, 0);

        await writeFile(file, 'Other bytes at the original path');
        assert.equal((await offered.fallback.run({})).status, 'unavailable');
        ready = true;
        const proposed: StatementFallbackResult = await offered.fallback.run({});
        assert.equal(proposed.status, 'proposed');
        assert.equal(proposed.record.result.localRecognition?.model, 'nuextract3');
        assert.equal(proposed.record.result.transactions[0].accountAmount.value.coefficient, '-11805');
        assert.equal(proposed.record.result.sourceProvenance?.sha256, expectedHash);
        assert.equal(selectionCount, 1);
        assert.equal(recognitionCount, 2);

        await writeFile(file, original);
        assert.deepEqual(await statementImportService.run({ existing: [proposed.record] }), { status: 'skipped', importId: proposed.record.id });
        assert.equal(recognitionCount, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('validates recognized provenance and honors cancellation before the proposal can be used', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-ai-service-'));
    try {
        const file: string = path.join(root, 'synthetic.pdf');
        await writeFile(file, original);
        const aborted: AbortController = new AbortController();
        const statementImportService: StatementImportService = new StatementImportService({
            choose: (): Promise<string> => Promise.resolve(file),
            extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => Promise.resolve(extract(bytes, sourceId)),
            propose: (_bytes: Uint8Array, input: BankImportInput, options: Pick<IBankImportOptions, 'signal' | 'onProgress'>): Promise<StatementProposalExtraction> => {
                const result: BankImportResult = proposeStatementTransactions(input, new Map([[1, table]]));
                if (options.signal) {
                    aborted.abort();
                } else {
                    result.sourceProvenance!.sha256 = 'f'.repeat(64);
                }
                return Promise.resolve({ status: 'proposed', result });
            }
        });
        const offered: BankImportAttempt = await statementImportService.run({ existing: [] });
        assert.ok('fallback' in offered);
        const mismatch: StatementFallbackResult = await offered.fallback.run({});
        assert.equal(mismatch.status, 'failed');
        assert.equal(mismatch.issues[0].code, 'invalid-provenance');
        assert.deepEqual(await offered.fallback.run({ signal: aborted.signal }), { status: 'cancelled' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps recognized-bank imports and failed extraction on their normal paths', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-ai-service-'));
    try {
        const file: string = path.join(root, 'synthetic.pdf');
        await writeFile(file, original);
        let fail: boolean = false;
        let currency: string = 'EUR';
        const statementImportService: StatementImportService = new StatementImportService({
            choose: (): Promise<string> => Promise.resolve(file),
            extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => {
                if (fail) {
                    return Promise.resolve({ status: 'failed', issues: [importIssue('unsupported-bank', 'No readable source evidence could be extracted.')] });
                }
                const result: ExtractionResult = extract(bytes, sourceId, true);
                assert.ok('input' in result);
                result.input.pages[0].spans.find((item: PositionedSpan): boolean => item.text === 'Currency EUR')!.text = 'Currency ' + currency;
                return Promise.resolve(result);
            },
            propose: (): Promise<never> => assert.fail('An existing adapter or extraction failure reached local recognition.')
        });
        const imported: BankImportAttempt = await statementImportService.run({ existing: [] });
        assert.equal(imported.status, 'imported');
        assert.equal(imported.record.result.adapter?.bankId, 'revolut');
        currency = 'GBP';
        const unsupported: BankImportAttempt = await statementImportService.run({ existing: [] });
        assert.equal(unsupported.status, 'unsupported');
        assert.equal(unsupported.issues[0].code, 'unsupported-currency');
        assert.equal('fallback' in unsupported, false);
        fail = true;
        const failed: BankImportAttempt = await statementImportService.run({ existing: [] });
        assert.equal(failed.status, 'failed');
        assert.equal('fallback' in failed, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
