import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { PositionedSpan } from '../../src/shared/bank-import.js';
import { importIssue } from '../../src/shared/bank-import.js';
import { NUEXTRACT_RECEIPT_VERSION, receiptAiRequestSchema, type ReceiptAiRequest, type ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import type { IReceiptAiSource } from '../../electron/documents/nuextract-receipt.js';
import { compareDocuments } from '../../electron/source-comparison.js';
import type { SupportingDocument } from '../../src/shared/supporting-document.js';
import { WorkspaceSession, type IReceiptAiDependencies, type IWorkspaceDialogs } from '../../electron/workspace-session.js';
import { documentRun, extractedDocument, retainedDocument } from './document-fixtures.js';
import type { OriginalAdoptionRequest } from '../../src/shared/original-preview.js';

async function modelAnalysis(source: IReceiptAiSource): Promise<ReceiptAiResult> {
    const bytes: NonSharedBuffer = await readFile(source.filePath);
    const extracted: ReturnType<typeof extractedDocument> = extractedDocument(bytes, source.sourceId ?? randomUUID(), source.format);
    extracted.input.extraction.version = NUEXTRACT_RECEIPT_VERSION;
    for (const span of extracted.input.pages[0].spans) {
        span.text = span.text.replace('9007199254740993.27', '48.75');
    }
    const analysis: SupportingDocument = interpretSupportingDocument(extracted.input);
    const { changes, conflicts }: ReturnType<typeof compareDocuments> = compareDocuments(source.previous ? { result: source.previous } : null, { result: analysis });
    return { status: 'ready', model: 'nuextract3', analysis, changes, conflicts };
}

async function sessionFor(run: StoredDocumentImport, dependencies: IReceiptAiDependencies, relocated?: string): Promise<WorkspaceSession> {
    const dialogs: IWorkspaceDialogs = { open: (): Promise<null> => Promise.resolve(null), save: (): Promise<null> => Promise.resolve(null),
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
        const analyze: typeof modelAnalysis = vi.fn(modelAnalysis);
        const session: WorkspaceSession = await sessionFor(run, { analyze }, relocated);
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
        assert.ok(result.analysis.input?.pages[0].spans.every((span: PositionedSpan): boolean => span.method === 'embedded-text'));
        assert.ok(result.changes.some((item: typeof result.changes[number]): boolean => item.after?.includes('48.75') === true));
        assert.equal(vi.mocked(analyze).mock.calls.length, 1);
        assert.deepEqual(session.state(), before);
        assert.deepEqual(session.documentImports(), records);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects failed receipts even if they have a verified fingerprint', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    try {
        const document: StoredSupportingDocument = retainedDocument(root);
        const run: StoredDocumentImport = documentRun(root, [document]);
        const failedPath: string = path.join(root, 'unreadable.pdf');
        const bytes: string = 'synthetic failed document';
        await writeFile(failedPath, bytes);
        const failed: Extract<StoredDocumentImport['files'][number], Record<'status', 'failed'>> = {
            status: 'failed', filePath: failedPath, format: 'pdf', analysis: null, sha256: createHash('sha256').update(bytes).digest('hex'),
            issues: [importIssue('unreadable', 'Initial OCR failed.')]
        };
        run.files.push(failed, { ...failed, filePath: path.join(root, 'duplicate.pdf'), sha256: document.result.input!.source.sha256 },
            { ...failed, filePath: path.join(root, 'no-fingerprint.pdf'), sha256: null });
        const analyze: typeof modelAnalysis = vi.fn(modelAnalysis);
        const session: WorkspaceSession = await sessionFor(run, { analyze });
        const request: ReceiptAiRequest = { reportId: run.id, fileIndex: 1, loadRevision: session.state().workspace!.loadRevision };
        assert.equal((await session.reanalyzeReceipt(request)).status, 'failed');
        assert.equal((await session.reanalyzeReceipt({ ...request, fileIndex: 2 })).status, 'failed');
        assert.equal((await session.reanalyzeReceipt({ ...request, fileIndex: 3 })).status, 'failed');
        assert.equal(vi.mocked(analyze).mock.calls.length, 0);
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
        const analyze: IReceiptAiDependencies['analyze'] = (_source: IReceiptAiSource,
            options?: Parameters<IReceiptAiDependencies['analyze']>[1]): Promise<ReceiptAiResult> => {
            assert.ok(options?.signal);
            const signal: AbortSignal = options.signal;
            return new Promise((resolve: (result: ReceiptAiResult) => void): void => {
                signal.addEventListener('abort', (): void => resolve({ status: 'cancelled' }), { once: true });
                options.onProgress?.({ phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 });
                markStarted?.();
            });
        };
        const session: WorkspaceSession = await sessionFor(run, { analyze });
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

test('isolates unverified AI values and invalidates the preview when it is discarded', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-receipt-ai-'));
    try {
        const document: StoredSupportingDocument = retainedDocument(root);
        await writeFile(document.filePath, 'synthetic.pdf');
        const run: StoredDocumentImport = documentRun(root, [document]);
        const analyze: IReceiptAiDependencies['analyze'] = (source: IReceiptAiSource): Promise<ReceiptAiResult> => Promise.resolve({
            status: 'ready', model: 'nuextract3', analysis: structuredClone(source.previous!),
            changes: [{ label: 'Reference number', before: null, after: 'UNVERIFIED-ACCOUNT', unrecognized: true }],
            conflicts: []
        });
        const session: WorkspaceSession = await sessionFor(run, { analyze });
        const request: ReceiptAiRequest = { reportId: run.id, fileIndex: 0, loadRevision: session.state().workspace!.loadRevision };
        const result: Awaited<ReturnType<WorkspaceSession['reanalyzeReceipt']>> = await session.reanalyzeReceipt(request);
        assert.equal(result.status, 'ready');
        assert.deepEqual(result.changes, [{ label: 'Reference number', before: null, after: 'UNVERIFIED-ACCOUNT', unrecognized: true }]);
        assert.match(result.blockingConflict ?? '', /no proposed changes could be verified/i);
        const adoption: OriginalAdoptionRequest & Record<'acknowledgeConflicts', true> = { token: result.token, loadRevision: request.loadRevision, acknowledgeConflicts: true };
        assert.equal((await session.acceptReceiptAnalysis(adoption)).status, 'failed');
        session.discardReceiptAnalysis({ token: result.token, loadRevision: request.loadRevision });
        const stale: Awaited<ReturnType<WorkspaceSession['acceptReceiptAnalysis']>> = await session.acceptReceiptAnalysis(adoption);
        assert.equal(stale.status, 'failed');
        assert.match(stale.error, /no longer current/i);
        assert.deepEqual(session.documentImports(), [run]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
