import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { StatementReanalysisService, type StatementAiSource, type StatementReanalysisDependencies } from '../../electron/import/reanalyze-statement.js';
import type { ExtractionOptions } from '../../electron/extraction/host.js';
import { sourceProvenance, type BankImportInput, type BankImportResult } from '../../src/shared/bank-import.js';
import { PDF_EXTRACTION_VERSION, type ExtractionProgress } from '../../src/shared/pdf-extraction.js';
import type { StatementAiResult } from '../../src/shared/statement-ai.js';
import { statement } from './bank-fixtures.js';
import { retainedBank } from './document-fixtures.js';

interface Fixture { source: StatementAiSource; input: BankImportInput; dependencies: StatementReanalysisDependencies; calls: { extract: number; propose: number } }
const progress: ExtractionProgress = { phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 };

function proposal(fixture: Fixture, input: BankImportInput): BankImportResult {
    return { ...structuredClone(fixture.source.original.result), sourceProvenance: sourceProvenance(input), adapter: null, localRecognition: { model: 'nuextract3', parserVersion: '1' } };
}

async function fixture(context: TestContext): Promise<Fixture> {
    const parent: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(parent, 'receiptmatch-statement-reanalysis-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), parent);
        await rm(root, { recursive: true, force: true });
    });
    const source: StatementAiSource = { filePath: path.join(root, 'relinked.pdf'), original: retainedBank(root) };
    const bytes: NonSharedBuffer = Buffer.from('Independently invented PDF fixture bytes');
    await writeFile(source.filePath, bytes);
    source.original.result.sourceProvenance!.sha256 = createHash('sha256').update(bytes).digest('hex');
    const input: BankImportInput = statement();
    input.source = { sourceId: source.original.result.sourceProvenance!.sourceId, sha256: source.original.result.sourceProvenance!.sha256 };
    input.extraction = { runId: randomUUID(), version: PDF_EXTRACTION_VERSION };
    const calls: Fixture['calls'] = { extract: 0, propose: 0 };
    const prepared: Fixture = { source, input, calls, dependencies: {
        async extract(actual: Uint8Array, sourceId: string, options: ExtractionOptions): Promise<{ status: 'complete'; input: BankImportInput }> {
            calls.extract++;
            assert.deepEqual(actual, bytes);
            assert.equal(sourceId, input.source.sourceId);
            options.onProgress?.(progress);
            return Promise.resolve({ status: 'complete', input: structuredClone(input) });
        },
        async propose(actual: Uint8Array, extracted: BankImportInput, options: ExtractionOptions): Promise<{ status: 'proposed'; result: BankImportResult }> {
            calls.propose++;
            assert.deepEqual(actual, bytes);
            options.onProgress?.({ ...progress, phase: 'page-complete', completedPages: 1 });
            return Promise.resolve({ status: 'proposed', result: proposal(prepared, extracted) });
        }
    } };
    return prepared;
}

test('reanalyzes the existing PDF at its resolved path regardless of its adapter without changing import identities', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const original: StatementAiSource['original'] = structuredClone(prepared.source.original);
    const events: ExtractionProgress[] = [];
    const result: StatementAiResult = await new StatementReanalysisService(prepared.dependencies).analyze(prepared.source, { onProgress: (event: ExtractionProgress): void => {
        events.push(event);
    } });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') {
        return;
    }
    assert.equal(result.result.adapter, null);
    assert.equal(result.result.sourceProvenance!.sourceId, original.result.sourceProvenance!.sourceId);
    assert.equal(result.result.sourceProvenance!.extractionRunId, prepared.input.extraction.runId);
    assert.deepEqual(prepared.source.original, original);
    assert.deepEqual(prepared.calls, { extract: 1, propose: 1 });
    assert.equal(events.length, 2);
});

test('rejects changed source bytes before extraction and mutations during recognition', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const bytes: NonSharedBuffer = await readFile(prepared.source.filePath);
    await writeFile(prepared.source.filePath, 'Different original bytes');
    let result: StatementAiResult = await new StatementReanalysisService(prepared.dependencies).analyze(prepared.source);
    assert.equal(result.status, 'failed');
    assert.deepEqual(prepared.calls, { extract: 0, propose: 0 });
    await writeFile(prepared.source.filePath, bytes);
    const propose: StatementReanalysisDependencies['propose'] = prepared.dependencies.propose.bind(prepared.dependencies);
    prepared.dependencies.propose = async (...args: Parameters<typeof propose>): ReturnType<typeof propose> => {
        const proposed: Awaited<ReturnType<typeof propose>> = await propose(...args);
        await writeFile(prepared.source.filePath, 'Modified during recognition');
        return proposed;
    };
    result = await new StatementReanalysisService(prepared.dependencies).analyze(prepared.source);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
        assert.match(result.error, /original statement changed/);
    }
});

test('rejects forged extraction source, page and execution provenance before calling the model', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    for (const change of [
        (input: BankImportInput): void => {
            input.source.sourceId = randomUUID();
        },
        (input: BankImportInput): void => {
            input.source.sha256 = 'f'.repeat(64);
        },
        (input: BankImportInput): void => {
            input.pages[0].width++;
        },
        (input: BankImportInput): void => {
            input.extraction.runId = 'not-a-host-run';
        },
        (input: BankImportInput): void => {
            input.extraction.version = 'unknown-engine';
        }
    ]) {
        const input: BankImportInput = structuredClone(prepared.input);
        change(input);
        const result: StatementAiResult = await new StatementReanalysisService({ ...prepared.dependencies, extract: async (): Promise<{ status: 'complete'; input: BankImportInput }> => Promise.resolve({ status: 'complete', input }) }).analyze(prepared.source);
        assert.equal(result.status, 'failed');
    }
    assert.equal(prepared.calls.propose, 0);
});

test('rejects model responses that change provenance or claim an adapter or another model', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    for (const change of [
        (result: BankImportResult): void => {
            result.sourceProvenance!.sourceId = randomUUID();
        },
        (result: BankImportResult): void => {
            result.sourceProvenance!.extractionRunId = randomUUID();
        },
        (result: BankImportResult): void => {
            result.sourceProvenance!.pages[0].height++;
        },
        (result: BankImportResult): void => {
            result.adapter = prepared.source.original.result.adapter;
        },
        (result: BankImportResult): void => {
            result.localRecognition = { model: 'paddleocr-vl-1.6', parserVersion: '1' };
        }
    ]) {
        const result: BankImportResult = proposal(prepared, prepared.input);
        change(result);
        const response: StatementAiResult = await new StatementReanalysisService({ ...prepared.dependencies, propose: async (): Promise<{ status: 'proposed'; result: BankImportResult }> => Promise.resolve({ status: 'proposed', result }) }).analyze(prepared.source);
        assert.equal(response.status, 'failed');
    }
});

test('cancellation propagates through extraction and recognition and ignores late progress', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const controller: AbortController = new AbortController();
    controller.abort();
    assert.equal((await new StatementReanalysisService(prepared.dependencies).analyze(prepared.source, { signal: controller.signal })).status, 'cancelled');
    assert.equal(prepared.calls.extract, 0);
    const extracting: AbortController = new AbortController();
    const interrupted: StatementAiResult = await new StatementReanalysisService({ ...prepared.dependencies, extract: async (): Promise<{ status: 'complete'; input: BankImportInput }> => {
        extracting.abort();
        return Promise.resolve({ status: 'complete', input: prepared.input });
    } }).analyze(prepared.source, { signal: extracting.signal });
    assert.equal(interrupted.status, 'cancelled');
    assert.equal(prepared.calls.propose, 0);
    const active: AbortController = new AbortController();
    let late: ExtractionOptions['onProgress'];
    const dependencies: StatementReanalysisDependencies = { ...prepared.dependencies, propose: async (_bytes: Uint8Array, _input: BankImportInput, options: ExtractionOptions): Promise<{ status: 'cancelled'; issues: [] }> => {
        late = options.onProgress;
        active.abort();
        return Promise.resolve({ status: 'cancelled', issues: [] });
    } };
    let events: number = 0;
    assert.equal((await new StatementReanalysisService(dependencies).analyze(prepared.source, { signal: active.signal, onProgress: (): void => {
        events++;
    } })).status, 'cancelled');
    late?.(progress);
    assert.equal(events, 1);
});

test('unavailable models and invalid runtime progress never produce an adoptable result', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const unavailable: StatementAiResult = await new StatementReanalysisService({ ...prepared.dependencies, propose: async (): Promise<{ status: 'unavailable'; issues: BankImportResult['issues'] }> =>
        Promise.resolve({ status: 'unavailable', issues: [{ code: 'local-model-unavailable', severity: 'warning', message: 'NuExtract is unavailable.', pageId: null, rowId: null, field: null, evidence: [] }] }) }).analyze(prepared.source);
    assert.deepEqual(unavailable, { status: 'unavailable', error: 'NuExtract is unavailable.' });
    const invalid: StatementAiResult = await new StatementReanalysisService({ ...prepared.dependencies, extract: async (_bytes: Uint8Array, _sourceId: string, options: ExtractionOptions): Promise<{ status: 'complete'; input: BankImportInput }> => {
        options.onProgress?.({ ...progress, pageNumber: 0 });
        return Promise.resolve({ status: 'complete', input: prepared.input });
    } }).analyze(prepared.source);
    assert.equal(invalid.status, 'failed');
});
