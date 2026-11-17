import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { applySelectedReceiptAi, reviewNuExtractResult, type ReceiptAiSource } from '../../electron/documents/nuextract-receipt.js';
import { compareDocuments } from '../../electron/source-comparison.js';
import type { PositionedSpan } from '../../src/shared/bank-import.js';
import { documentCorrectionKey, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import { approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import type { OriginalAdoptionResult } from '../../src/shared/original-preview.js';
import type { DocumentSnapshot, WorkspaceView } from '../../src/shared/protocol.js';
import { NUEXTRACT_RECEIPT_VERSION, type ReceiptAiPreviewResult, type ReceiptAiProposal, type ReceiptAiRequest, type ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import type { DocumentSection, SupportingDocument } from '../../src/shared/supporting-document.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';

type Ready = Extract<ReceiptAiPreviewResult, { status: 'ready' }>;
type Total = DocumentSection['amounts'][number];

interface Fixture {
    file: string;
    document: StoredSupportingDocument;
    report: StoredDocumentImport;
    session: WorkspaceSession;
    transactionId: string;
    modelReading: { total: string; tax?: string };
    correction?: DocumentCorrection;
}

function total(sections: DocumentSection[]): Total {
    const field: Total | undefined = sections[0]?.amounts.find((amount: Total): boolean => amount.role === 'billed-total');
    assert.ok(field);
    return field;
}

async function fixture(context: TestContext, options: { corrected?: true; selectable?: true } = {}): Promise<Fixture> {
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
        async analyze(source: ReceiptAiSource): Promise<ReceiptAiResult> {
            if (options.selectable) {
                assert.ok(source.previous);
                return reviewNuExtractResult(source.previous, {
                    invoice_or_receipt_number: 'A2026/33612', issue_date: '2026-10-16', gross_total: 97.3
                });
            }
            const bytes: NonSharedBuffer = await readFile(source.filePath);
            const extracted: ReturnType<typeof extractedDocument> = extractedDocument(bytes, source.sourceId ?? randomUUID(), source.format);
            extracted.input.extraction.version = NUEXTRACT_RECEIPT_VERSION;
            for (const span of extracted.input.pages[0].spans) {
                span.region.x += 1;
                span.text = span.text.replace('9007199254740993.27', modelReading.total);
            }
            if (modelReading.tax) {
                const last: PositionedSpan = extracted.input.pages[0].spans.at(-1)!;
                extracted.input.pages[0].spans.push({ ...last, text: 'Tax: EUR ' + modelReading.tax, region: { ...last.region, y: last.region.y + 25 } });
            }
            const analysis: SupportingDocument = interpretSupportingDocument(extracted.input);
            const { changes, conflicts }: ReturnType<typeof compareDocuments> = compareDocuments(source.previous ? { result: source.previous } : null, { result: analysis });
            return { status: 'ready', model: 'nuextract3', analysis, changes, conflicts };
        }
    });
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    return { file, document, report, session, transactionId, modelReading, correction };
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
    prepared.modelReading.total = '48.75';

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

test('applies only selected unverified fields and retains their user confirmation after reopening', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context, { selectable: true });
    const { file, session, document, report }: Fixture = prepared;
    const staged: Ready = await preview(prepared);
    assert.equal(staged.blockingConflict, undefined);
    assert.deepEqual(staged.proposals?.map((item: ReceiptAiProposal): [ReceiptAiProposal['field'], boolean] => [item.field, item.verified]), [
        ['reference', false], ['issue-date', false], ['billed-total', false]
    ]);
    const request: { token: string; loadRevision: number; acknowledgeConflicts: boolean } =
        { token: staged.token, loadRevision: workspace(session).loadRevision, acknowledgeConflicts: true };
    assert.equal((await session.acceptReceiptAnalysis(request)).status, 'failed');
    assert.deepEqual(await session.acceptReceiptAnalysis({ ...request, selectedFields: ['reference', 'issue-date'] }), { status: 'adopted' });
    assert.equal(workspace(session).approvedDocumentCount, 0);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.deepEqual((await loadWorkspace(file)).documentImports, [report]);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    const result: SupportingDocument = imported(session.documentImports(), document.id).result;
    assert.deepEqual(total(result.sections), total(document.result.sections));
    const reference: DocumentSection['references'][number] | undefined = result.sections[0].references.find((item: DocumentSection['references'][number]): boolean => item.role === 'invoice');
    const date: DocumentSection['dates'][number] | undefined = result.sections[0].dates.find((item: DocumentSection['dates'][number]): boolean => item.role === 'issue');
    assert.deepEqual(reference?.candidates, ['A2026/33612']);
    assert.equal(reference?.confirmedByUser, true);
    assert.deepEqual(reference?.evidence, []);
    assert.deepEqual(date?.candidates, ['2026-10-16']);
    assert.equal(date?.confirmedByUser, true);
    assert.deepEqual(date?.evidence, []);
});

test('keeps an unselected manual correction when confirming a different receipt reference', async (context: TestContext): Promise<void> => {
    const prepared: Fixture = await fixture(context, { selectable: true, corrected: true });
    const { document, session, correction }: Fixture = prepared;
    const staged: Ready = await preview(prepared);
    const amount: ReceiptAiProposal | undefined = staged.proposals?.find((item: ReceiptAiProposal): boolean => item.field === 'billed-total');
    assert.match(amount?.unavailable ?? '', /manual correction/i);
    assert.deepEqual(await session.acceptReceiptAnalysis({ token: staged.token, loadRevision: workspace(session).loadRevision,
        acknowledgeConflicts: true, selectedFields: ['reference'] }), { status: 'adopted' });
    assert.deepEqual(workspace(session).documentCorrections, [correction]);
    const view: WorkspaceView = workspace(session);
    const snapshot: DocumentSnapshot | null = session.documentSnapshot({ loadRevision: view.loadRevision, revision: view.matchRevision });
    assert.ok(snapshot);
    assert.equal(total(imported(snapshot.reports, document.id).result.sections).candidates[0].coefficient, '5040');
});

test('offers a matching total for confirmation when its currency is still missing', async (context: TestContext): Promise<void> => {
    const { document }: Fixture = await fixture(context);
    const source: SupportingDocument = structuredClone(document.result);
    source.status = 'partial';
    const field: Total = total(source.sections);
    field.candidates[0].currency = null;
    source.sections[0].currencies = [];
    source.issues.push({ code: 'missing-currency', severity: 'warning', message: 'Currency could not be established.',
        sectionId: source.sections[0].sectionId, fieldId: field.id, field: 'billed-total', evidence: field.evidence });
    const staged: Extract<ReceiptAiResult, { status: 'ready' }> = reviewNuExtractResult(source, { gross_total: '9007199254740993.27' });
    const proposals: ReceiptAiProposal[] = staged.proposals ?? [];
    assert.equal(proposals[0]?.needsCurrency, true);
    assert.equal(proposals[0]?.verified, false);
    assert.throws((): SupportingDocument => applySelectedReceiptAi(source, proposals, ['billed-total']), /three-letter currency/i);
    const confirmed: Total = total(applySelectedReceiptAi(source, proposals, ['billed-total'], 'EUR').sections);
    assert.equal(confirmed.confirmedByUser, true);
    assert.deepEqual(confirmed.candidates, [{ coefficient: '900719925474099327', scale: 2, currency: 'EUR' }]);
});

test('keeps receipt identity and assignment and renews review only for changed matching facts', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context);
    const { file, document, report, session, transactionId, modelReading }: Fixture = prepared;
    const saved: NonSharedBuffer = await readFile(file);
    assert.equal(workspace(session).approvedDocumentCount, 1);

    const equivalent: Ready = await preview(prepared);
    assert.deepEqual(equivalent.conflicts, []);
    assert.equal(equivalent.blockingConflict, 'NuExtract3 did not propose a verified change.');
    assert.equal((await accept(session, equivalent.token)).status, 'failed');
    const projected: StoredSupportingDocument = imported(session.documentImports(), document.id);
    assert.equal(projected.filePath, document.filePath);
    assert.deepEqual(projected.result.input?.source, document.result.input?.source);
    assert.equal(projected.result.input?.extraction.runId, document.result.input?.extraction.runId);
    assert.equal((await accept(session, equivalent.token)).status, 'failed');
    assert.equal(workspace(session).approvedDocumentCount, 1);
    assert.equal(workspace(session).dirty, false);

    modelReading.total = '48.75';
    const changed: Ready = await preview(prepared);
    assert.ok(changed.conflicts.some((conflict: string): boolean => conflict.includes('need review again')));
    assert.equal((await accept(session, changed.token)).status, 'failed');
    assert.equal(workspace(session).approvedDocumentCount, 1);
    assert.equal(imported(session.documentImports(), document.id).result.input?.extraction.runId, document.result.input?.extraction.runId);
    assert.deepEqual(await accept(session, changed.token, true), { status: 'adopted' });
    assert.equal(workspace(session).approvedDocumentCount, 0);
    assert.equal(total(imported(session.documentImports(), document.id).result.sections).candidates[0].coefficient, '4875');
    assert.deepEqual(await readFile(file), saved);

    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const stored: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(stored.documentImports, [report]);
    assert.deepEqual(stored.receiptAnalysisVersions.map((version: SavedWorkspace['receiptAnalysisVersions'][number]): (string | undefined)[] =>
        [version.documentId, version.analysis.input?.extraction.runId]), [
        [document.id, changed.analysis.input?.extraction.runId]
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

test('preserves an existing manual correction and approval while applying a verified non-matching field', async (context: TestContext & object): Promise<void> => {
    const prepared: Fixture = await fixture(context, { corrected: true });
    const { document, session, modelReading, correction, file }: Fixture = prepared;
    modelReading.total = '48.75';
    modelReading.tax = '8.50';
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
