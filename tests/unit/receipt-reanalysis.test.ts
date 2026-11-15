import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { BankImportInput } from '../../src/shared/bank-import.js';
import { LOCAL_OCR_VERSIONS, PDF_EXTRACTION_VERSION, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import type { ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { reanalyzeReceipt, type ReceiptAiDependencies, type ReceiptAiSource } from '../../electron/documents/reanalysis.js';
import type { ExtractionOptions, LocalDocumentOcr } from '../../electron/extraction/host.js';
import { extractedDocument } from './document-fixtures.js';

const model: LocalDocumentOcr = { model: 'paddleocr-vl-1.6', files: { executable: 'fixture', model: 'fixture', projector: 'fixture', template: 'fixture' } };
const original: Uint8Array = Buffer.from('synthetic receipt content for local analysis');

function modelResult(bytes: Uint8Array, sourceId: string): ReturnType<typeof extractedDocument> {
    const result: ReturnType<typeof extractedDocument> = extractedDocument(bytes, sourceId);
    result.input.extraction.version = LOCAL_OCR_VERSIONS[model.model];
    for (const span of result.input.pages[0].spans) {
        span.method = 'local-ocr';
    }
    result.input.pages[0].spans.at(-1)!.text = 'Invoice Total: EUR 43.50';
    return result;
}

async function withReceipt(run: (source: ReceiptAiSource) => Promise<void>): Promise<void> {
    const directory: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    const filePath: string = path.join(directory, 'synthetic.pdf');
    try {
        await writeFile(filePath, original);
        const sourceId: string = randomUUID();
        await run({ filePath, format: 'pdf', sha256: createHash('sha256').update(original).digest('hex'), sourceId,
            previous: interpretSupportingDocument(extractedDocument(original, sourceId).input) });
    } finally {
        await rm(filePath, { force: true });
        await rmdir(directory);
    }
}

test('previews the configured model against the same receipt without modifying its original analysis or file', async (): Promise<void> => {
    await withReceipt(async (source: ReceiptAiSource): Promise<void> => {
        const before: ReceiptAiSource['previous'] = structuredClone(source.previous);
        const controller: AbortController = new AbortController();
        const dependencies: ReceiptAiDependencies = {
            selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model),
            extract: (bytes: Uint8Array, sourceId: string, format: ReceiptAiSource['format'], selected: LocalDocumentOcr, options?: ExtractionOptions): Promise<ExtractionResult> => {
                assert.deepEqual(bytes, original);
                assert.equal(sourceId, source.sourceId);
                assert.equal(format, 'pdf');
                assert.equal(selected, model);
                assert.equal(options?.signal, controller.signal);
                return Promise.resolve(modelResult(bytes, sourceId));
            },
        };
        const result: ReceiptAiResult = await reanalyzeReceipt(source, dependencies, { signal: controller.signal });
        assert.equal(result.status, 'ready');
        assert.equal(result.model, model.model);
        assert.deepEqual(result.analysis.input?.source, { sourceId: source.sourceId, sha256: source.sha256 });
        assert.ok(result.changes.some((change: (typeof result.changes)[number]): boolean => change.label === 'Billed total' && change.after === '43.50 EUR' && change.before !== null));
        assert.deepEqual(result.conflicts, []);
        assert.deepEqual(source.previous, before);
        assert.deepEqual(await readFile(source.filePath), original);
    });
});

test('previews a formerly failed receipt using only its verified fingerprint', async (): Promise<void> => {
    await withReceipt(async (source: ReceiptAiSource): Promise<void> => {
        const result: ReceiptAiResult = await reanalyzeReceipt({ ...source, sourceId: undefined, previous: null }, {
            selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model),
            extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => Promise.resolve(modelResult(bytes, sourceId)),
        });
        assert.equal(result.status, 'ready');
        assert.notEqual(result.analysis.input?.source.sourceId, source.sourceId);
        assert.equal(result.analysis.input?.source.sha256, source.sha256);
        assert.ok(result.changes.some((change: (typeof result.changes)[number]): boolean => change.label === 'Added document section' && change.before === null));
    });
});

test('a changed receipt and unavailable model both stop before recognition', async (): Promise<void> => {
    await withReceipt(async (source: ReceiptAiSource): Promise<void> => {
        const extract: ReceiptAiDependencies['extract'] = (): Promise<never> => assert.fail('Recognition must not start.');
        const unavailable: ReceiptAiResult = await reanalyzeReceipt(source, { selectedModel: (): Promise<undefined> => Promise.resolve(undefined), extract });
        assert.equal(unavailable.status, 'failed');
        assert.match(unavailable.error, /installed model/u);
        await writeFile(source.filePath, 'different bytes');
        const changed: ReceiptAiResult = await reanalyzeReceipt(source, { selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model), extract });
        assert.equal(changed.status, 'failed');
        assert.match(changed.error, /original receipt changed/u);
    });
});

test('rejects changed recognition provenance and ignores a success that arrives after cancellation', async (): Promise<void> => {
    await withReceipt(async (source: ReceiptAiSource): Promise<void> => {
        const defects: ((input: BankImportInput) => void)[] = [
            (input: BankImportInput): void => {
                input.extraction.version = PDF_EXTRACTION_VERSION;
            },
            (input: BankImportInput): void => {
                input.source.sourceId = randomUUID();
            },
            (input: BankImportInput): void => {
                input.source.sha256 = '0'.repeat(64);
            },
            (input: BankImportInput): void => {
                input.pages[0].spans[0].method = 'embedded-text';
            },
            (input: BankImportInput): void => {
                input.extraction.runId = source.previous!.input!.extraction.runId;
            },
        ];
        for (const mutate of defects) {
            const result: ReceiptAiResult = await reanalyzeReceipt(source, {
                selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model),
                extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => {
                    const attempted: ReturnType<typeof modelResult> = modelResult(bytes, sourceId);
                    mutate(attempted.input);
                    return Promise.resolve(attempted);
                },
            });
            assert.deepEqual(result, { status: 'failed', error: 'Local AI results could not be verified against the original receipt.' });
        }
        const controller: AbortController = new AbortController();
        const cancelled: ReceiptAiResult = await reanalyzeReceipt(source, {
            selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model),
            extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => {
                controller.abort();
                return Promise.resolve(modelResult(bytes, sourceId));
            },
        }, { signal: controller.signal });
        assert.deepEqual(cancelled, { status: 'cancelled' });
    });
});
