import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import type { LocalDocumentOcr } from '../../electron/extraction/host.js';
import { importIssue } from '../../src/shared/bank-import.js';
import { documentCorrectionKey, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import { approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import type { OriginalAdoptionResult } from '../../src/shared/original-preview.js';
import { LOCAL_OCR_VERSIONS, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import type { DocumentSnapshot, WorkspaceView } from '../../src/shared/protocol.js';
import type { ReceiptAiPreviewResult, ReceiptAiRequest } from '../../src/shared/receipt-ai.js';
import type { DocumentSection } from '../../src/shared/supporting-document.js';
import type { DocumentFileResult, DocumentFormat, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';

const model: LocalDocumentOcr = { model: 'paddleocr-vl-1.6', files: { executable: 'unused', model: 'unused', projector: 'unused', template: 'unused' } };
type Ready = Extract<ReceiptAiPreviewResult, { status: 'ready' }>;
type Total = DocumentSection['amounts'][number];

interface Fixture {
    file: string;
    document: StoredSupportingDocument;
    report: StoredDocumentImport;
    session: WorkspaceSession;
    transactionId: string;
    modelReading: { total: string };
    failed?: Extract<DocumentFileResult, { status: 'failed' }>;
    correction?: DocumentCorrection;
}

function total(sections: DocumentSection[]): Total {
    const field: Total | undefined = sections[0]?.amounts.find((amount: Total): boolean => amount.role === 'billed-total');
    assert.ok(field);
    return field;
}

async function failedReceipt(root: string): Promise<Extract<DocumentFileResult, { status: 'failed' }>> {
    const filePath: string = path.join(root, 'failed.pdf');
    const bytes: string = 'synthetic unreadable initial receipt';
    await writeFile(filePath, bytes);
    return { status: 'failed', filePath, format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), analysis: null,
        issues: [importIssue('unreadable', 'Initial OCR failed.')] };
}

async function fixture(context: TestContext, options: { corrected?: true; failed?: true } = {}): Promise<Fixture> {
    const temporary: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(temporary, 'receiptmatch-receipt-adoption-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), temporary);
        await rm(root, { recursive: true, force: true });
    });
    const file: string = path.join(root, 'review.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    await writeFile(document.filePath, 'synthetic.pdf');
    const report: StoredDocumentImport = documentRun(root, [document]);
    const failed: Fixture['failed'] = options.failed ? await failedReceipt(root) : undefined;
    if (failed) {
        report.files.push(failed);
    }
    const correction: DocumentCorrection | undefined = options.corrected ? {
        documentId: document.id, sectionId: document.result.sections[0].sectionId, fieldId: total(document.result.sections).id, revision: 2,
        change: { kind: 'amount', value: { coefficient: '5040', scale: 2, currency: 'EUR' } }
    } : undefined;
    const corrections: Map<string, DocumentCorrection> = new Map(correction ? [[documentCorrectionKey(correction, correction.change.kind), correction]] : []);
    const bank: StoredBankImport = retainedBank(root);
    const transactionId: string = bank.transactions[0].transactionId;
    const approved: ReviewApprovalState = { associationRevision: 1, approval: {
        ...approvalSelectionFor(transactionId, document.id, 1, correction?.revision), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z'
    } };
    await createWorkspace(file, newMetadata(), [bank], [report], new Map([[transactionId, document.id]]), new Map(), corrections, new Map([[transactionId, approved]]));
    const dialogs: WorkspaceDialogs = { open: (): Promise<string> => Promise.resolve(file), save: (): Promise<string> => Promise.resolve(file),
        unsaved: (): Promise<'discard'> => Promise.resolve('discard') };
    const modelReading: Fixture['modelReading'] = { total: '9007199254740993.27' };
    const session: WorkspaceSession = new WorkspaceSession(dialogs, undefined, undefined, undefined, undefined, undefined, {
        selectedModel: (): Promise<LocalDocumentOcr> => Promise.resolve(model),
        extract: (bytes: Uint8Array, sourceId: string, format: DocumentFormat): Promise<ExtractionResult> => {
            const extracted: ReturnType<typeof extractedDocument> = extractedDocument(bytes, sourceId, format);
            extracted.input.extraction.version = LOCAL_OCR_VERSIONS[model.model];
            for (const span of extracted.input.pages[0].spans) {
                span.method = 'local-ocr';
                span.region.x += 1;
                span.text = span.text.replace('9007199254740993.27', modelReading.total);
            }
            return Promise.resolve(extracted);
        }
    });
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    return { file, document, report, session, transactionId, modelReading, failed, correction };
}

function workspace(session: WorkspaceSession): WorkspaceView {
    const state: WorkspaceView | null = session.state().workspace;
    assert.ok(state);
    return state;
}

function imported(reports: StoredDocumentImport[], documentId: string): StoredSupportingDocument {
    const file: DocumentFileResult | undefined = reports.flatMap((report: StoredDocumentImport): DocumentFileResult[] => report.files)
        .find((item: DocumentFileResult): boolean => item.status === 'imported' && item.record.id === documentId);
    assert.equal(file?.status, 'imported');
    return file.record;
}

async function preview({ report, session }: Fixture, fileIndex: number = 0): Promise<Ready> {
    const request: ReceiptAiRequest = { reportId: report.id, fileIndex, loadRevision: workspace(session).loadRevision };
    const result: ReceiptAiPreviewResult = await session.reanalyzeReceipt(request);
    assert.equal(result.status, 'ready', JSON.stringify(result));
    return result;
}

function accept(session: WorkspaceSession, token: string, acknowledgeConflicts: boolean = false): Promise<OriginalAdoptionResult> {
    return session.acceptReceiptAnalysis({ token, acknowledgeConflicts, loadRevision: workspace(session).loadRevision });
}

test('requires a current preview token and rechecks the original bytes before applying an OCR analysis', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const { file, document, session }: Fixture = prepared;
    const before: WorkspaceView = workspace(session);
    const saved: NonSharedBuffer = await readFile(file);
    assert.equal((await accept(session, randomUUID())).status, 'failed');

    const first: Ready = await preview(prepared);
    const current: Ready = await preview(prepared);
    assert.notEqual(current.token, first.token);
    assert.equal((await accept(session, first.token)).status, 'failed');
    assert.equal((await session.acceptReceiptAnalysis({ token: current.token, acknowledgeConflicts: true, loadRevision: before.loadRevision + 1 })).status, 'failed');

    await writeFile(document.filePath, 'modified after the OCR preview');
    const changed: OriginalAdoptionResult = await accept(session, current.token, true);
    assert.equal(changed.status, 'failed');
    assert.match(changed.error, /original receipt changed/i);
    await writeFile(document.filePath, 'synthetic.pdf');
    assert.equal((await accept(session, current.token, true)).status, 'failed');
    assert.deepEqual(workspace(session), before);
    assert.deepEqual(await readFile(file), saved);
});

test('keeps receipt identity and assignment and renews review only for changed matching facts', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const { file, document, report, session, transactionId, modelReading }: Fixture = prepared;
    const saved: NonSharedBuffer = await readFile(file);
    assert.equal(workspace(session).approvedDocumentCount, 1);

    const equivalent: Ready = await preview(prepared);
    assert.deepEqual(equivalent.conflicts, []);
    assert.deepEqual(await accept(session, equivalent.token), { status: 'adopted' });
    const projected: StoredSupportingDocument = imported(session.documentImports(), document.id);
    assert.equal(projected.filePath, document.filePath);
    assert.deepEqual(projected.result.input?.source, document.result.input?.source);
    assert.equal(projected.result.input?.extraction.runId, equivalent.analysis.input?.extraction.runId);
    assert.equal((await accept(session, equivalent.token)).status, 'failed');
    assert.equal(workspace(session).approvedDocumentCount, 1);
    assert.equal(workspace(session).dirty, true);

    modelReading.total = '48.75';
    const changed: Ready = await preview(prepared);
    assert.ok(changed.conflicts.some((conflict: string): boolean => conflict.includes('need review again')));
    assert.equal((await accept(session, changed.token)).status, 'failed');
    assert.equal(workspace(session).approvedDocumentCount, 1);
    assert.equal(imported(session.documentImports(), document.id).result.input?.extraction.runId, equivalent.analysis.input?.extraction.runId);
    assert.deepEqual(await accept(session, changed.token, true), { status: 'adopted' });
    assert.equal(workspace(session).approvedDocumentCount, 0);
    assert.equal(total(imported(session.documentImports(), document.id).result.sections).candidates[0].coefficient, '4875');
    assert.deepEqual(await readFile(file), saved);

    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const stored: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(stored.documentImports, [report]);
    assert.deepEqual(stored.receiptAnalysisVersions.map((version: SavedWorkspace['receiptAnalysisVersions'][number]): (string | undefined)[] =>
        [version.documentId, version.analysis.input?.extraction.runId]), [
        [document.id, equivalent.analysis.input?.extraction.runId], [document.id, changed.analysis.input?.extraction.runId]
    ]);
    assert.equal(stored.matchDecisions.get(transactionId), document.id);
    assert.equal(stored.reviewApprovals.get(transactionId)?.associationRevision, 2);
    assert.ok(stored.reviewApprovals.get(transactionId)?.approval);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(workspace(session).approvedDocumentCount, 0);
    const reopened: StoredSupportingDocument = imported(session.documentImports(), document.id);
    assert.deepEqual(reopened.result.input?.source, document.result.input?.source);
    assert.equal(reopened.result.input?.extraction.runId, changed.analysis.input?.extraction.runId);
});

test('preserves an existing manual correction and approval when a new OCR amount leaves the effective facts unchanged', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context, { corrected: true });
    const { document, session, modelReading, correction, file }: Fixture = prepared;
    modelReading.total = '48.75';
    const staged: Ready = await preview(prepared);
    assert.equal(staged.blockingConflict, undefined);
    assert.deepEqual(staged.conflicts, []);
    assert.deepEqual(await accept(session, staged.token), { status: 'adopted' });
    const view: WorkspaceView = workspace(session);
    assert.equal(view.approvedDocumentCount, 1);
    assert.deepEqual(view.documentCorrections, [correction]);
    const projected: DocumentSnapshot | null = session.documentSnapshot({ loadRevision: view.loadRevision, revision: view.matchRevision });
    assert.ok(projected);
    assert.equal(total(projected.originals[document.id].sections).candidates[0].coefficient, '4875');
    assert.equal(total(imported(projected.reports, document.id).result.sections).candidates[0].coefficient, '5040');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const stored: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual([...stored.documentCorrections.values()], [correction]);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(workspace(session).approvedDocumentCount, 1);
});

test('promotes a fingerprinted failed receipt only on acceptance and keeps the failed report after reopening', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context, { failed: true });
    const { failed, file, report, session }: Fixture = prepared;
    assert.ok(failed);
    const staged: Ready = await preview(prepared, 1);
    assert.equal(session.documentImports()[0].files[1].status, 'failed');
    assert.equal(session.documentImports().length, 1);
    assert.deepEqual(await accept(session, staged.token, true), { status: 'adopted' });
    assert.equal(session.documentImports().length, 2);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);

    const stored: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(stored.documentImports.find((run: StoredDocumentImport): boolean => run.id === report.id), report);
    assert.deepEqual(stored.receiptAnalysisVersions, []);
    const promoted: DocumentFileResult | undefined = stored.documentImports.find((run: StoredDocumentImport): boolean => run.id !== report.id)?.files[0];
    assert.equal(promoted?.status, 'imported');
    assert.equal(promoted.record.filePath, failed.filePath);
    assert.equal(promoted.record.result.input?.source.sha256, failed.sha256);
    assert.equal(promoted.record.result.input?.extraction.runId, staged.analysis.input?.extraction.runId);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(imported(session.documentImports(), promoted.record.id).filePath, failed.filePath);
    assert.equal((await session.reanalyzeReceipt({ reportId: report.id, fileIndex: 1, loadRevision: workspace(session).loadRevision })).status, 'failed');
});
