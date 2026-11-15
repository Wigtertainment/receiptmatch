import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { PositionedSpan } from '../../src/shared/bank-import.js';
import { importIssue } from '../../src/shared/bank-import.js';
import { LOCAL_OCR_VERSIONS, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import { receiptAiRequestSchema, type ReceiptAiRequest, type ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import type { DocumentFormat, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { ReceiptAiDependencies } from '../../electron/documents/reanalysis.js';
import type { LocalDocumentOcr } from '../../electron/extraction/host.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { documentRun, extractedDocument, retainedDocument } from './document-fixtures.js';

const model: LocalDocumentOcr = { model: 'paddleocr-vl-1.6', files: { executable: 'unused', model: 'unused', projector: 'unused', template: 'unused' } };

function modelExtraction(bytes: Uint8Array, id: string, format: DocumentFormat): Promise<ExtractionResult> {
    const extracted: ReturnType<typeof extractedDocument> = extractedDocument(bytes, id, format);
    extracted.input.extraction.version = LOCAL_OCR_VERSIONS[model.model];
    for (const span of extracted.input.pages[0].spans) {
        span.method = 'local-ocr';
        span.text = span.text.replace('9007199254740993.27', '48.75');
    }
    return Promise.resolve(extracted);
}

async function sessionFor(run: StoredDocumentImport, dependencies: ReceiptAiDependencies, relocated?: string): Promise<WorkspaceSession> {
    const dialogs: WorkspaceDialogs = { open: (): Promise<null> => Promise.resolve(null), save: (): Promise<null> => Promise.resolve(null),
        unsaved: (): Promise<'discard'> => Promise.resolve('discard'), relinkOriginal: (): Promise<string | null> => Promise.resolve(relocated ?? null) };
    const session: WorkspaceSession = new WorkspaceSession(dialogs, undefined, undefined, { run: (): Promise<StoredDocumentImport> => Promise.resolve(run) }, undefined, undefined, dependencies);
    await session.dispatch({ type: 'new' });
    await session.dispatch({ type: 'import-documents' });
    return session;
}

test('validates receipt locators and compares the relinked original without changing the existing workspace', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    try {
        const document: StoredSupportingDocument = retainedDocument(root);
        const relocated: string = path.join(root, 'identical.pdf');
        await writeFile(document.filePath, 'synthetic.pdf');
        await rename(document.filePath, relocated);
        const run: StoredDocumentImport = documentRun(root, [document]);
        const extract: typeof modelExtraction = vi.fn(modelExtraction);
        const session: WorkspaceSession = await sessionFor(run, { selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model), extract }, relocated);
        const revision: number = session.state().workspace!.loadRevision;
        const request: ReceiptAiRequest = { reportId: run.id, fileIndex: 0, loadRevision: revision };
        assert.equal(receiptAiRequestSchema.safeParse({ ...request, filePath: relocated }).success, false);
        assert.equal((await session.reanalyzeReceipt({ ...request, loadRevision: revision + 1 })).status, 'failed');
        assert.equal((await session.reanalyzeReceipt({ ...request, fileIndex: 1 })).status, 'failed');
        assert.equal((await session.relinkOriginal({ kind: 'document', id: document.id, loadRevision: revision })).status, 'linked');
        const before: ReturnType<WorkspaceSession['state']> = session.state();
        const records: StoredDocumentImport[] = session.documentImports();
        const result: ReceiptAiResult = await session.reanalyzeReceipt(request);
        assert.equal(result.status, 'ready');
        assert.deepEqual(result.analysis.input?.source, document.result.input?.source);
        assert.ok(result.analysis.input?.pages[0].spans.every((span: PositionedSpan): boolean => span.method === 'local-ocr'));
        assert.ok(result.changes.some((item: typeof result.changes[number]): boolean => item.after?.includes('48.75') === true));
        assert.equal(vi.mocked(extract).mock.calls.length, 1);
        assert.deepEqual(session.state(), before);
        assert.deepEqual(session.documentImports(), records);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('allows a failed receipt with a verified fingerprint and rejects its duplicate and an unreadable entry', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    try {
        const document: StoredSupportingDocument = retainedDocument(root);
        const run: StoredDocumentImport = documentRun(root, [document]);
        const failedPath: string = path.join(root, 'unreadable.pdf');
        const bytes: string = 'synthetic failed document';
        await writeFile(failedPath, bytes);
        const failed: Extract<StoredDocumentImport['files'][number], { status: 'failed' }> = {
            status: 'failed', filePath: failedPath, format: 'pdf', analysis: null, sha256: createHash('sha256').update(bytes).digest('hex'),
            issues: [importIssue('unreadable', 'Initial OCR failed.')]
        };
        run.files.push(failed, { ...failed, filePath: path.join(root, 'duplicate.pdf'), sha256: document.result.input!.source.sha256 },
            { ...failed, filePath: path.join(root, 'no-fingerprint.pdf'), sha256: null });
        const extract: typeof modelExtraction = vi.fn(modelExtraction);
        const session: WorkspaceSession = await sessionFor(run, { selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model), extract });
        const request: ReceiptAiRequest = { reportId: run.id, fileIndex: 1, loadRevision: session.state().workspace!.loadRevision };
        const result: ReceiptAiResult = await session.reanalyzeReceipt(request);
        assert.equal(result.status, 'ready');
        assert.equal(result.analysis.input?.source.sha256, failed.sha256);
        assert.ok(result.changes.length);
        assert.equal((await session.reanalyzeReceipt({ ...request, fileIndex: 2 })).status, 'failed');
        assert.equal((await session.reanalyzeReceipt({ ...request, fileIndex: 3 })).status, 'failed');
        assert.equal(vi.mocked(extract).mock.calls.length, 1);
        assert.equal(session.documentImports()[0].files[1].status, 'failed');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cancels in-flight receipt recognition through the workspace import control', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    try {
        const document: StoredSupportingDocument = retainedDocument(root);
        await writeFile(document.filePath, 'synthetic.pdf');
        const run: StoredDocumentImport = documentRun(root, [document]);
        let markStarted: (() => void) | undefined;
        const started: Promise<void> = new Promise<void>((resolve: () => void): void => {
            markStarted = resolve;
        });
        const extract: ReceiptAiDependencies['extract'] = (_bytes: Uint8Array, _id: string, _format: DocumentFormat, _model: LocalDocumentOcr,
            options?: Parameters<ReceiptAiDependencies['extract']>[4]): Promise<ExtractionResult> => {
            assert.ok(options?.signal);
            const signal: AbortSignal = options.signal;
            return new Promise((resolve: (result: ExtractionResult) => void): void => {
                signal.addEventListener('abort', (): void => resolve({ status: 'cancelled', issues: [importIssue('cancelled', 'Cancelled.')] }), { once: true });
                options.onProgress?.({ phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 });
                markStarted?.();
            });
        };
        const session: WorkspaceSession = await sessionFor(run, { selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model), extract });
        const before: ReturnType<WorkspaceSession['state']> = session.state();
        const pending: Promise<ReceiptAiResult> = session.reanalyzeReceipt({ reportId: run.id, fileIndex: 0, loadRevision: before.workspace!.loadRevision });
        await started;
        assert.equal(session.state().documentImport?.progress?.extraction?.phase, 'ocr');
        await session.dispatch({ type: 'cancel-import' });
        assert.deepEqual(await pending, { status: 'cancelled' });
        assert.deepEqual(session.state(), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
