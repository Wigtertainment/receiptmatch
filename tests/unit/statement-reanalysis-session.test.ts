import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import type { StatementAiService, StatementAiSource } from '../../electron/import/reanalyze-statement.js';
import { reconciliationRows } from '../../electron/reconciliation-csv.js';
import { createWorkspace, loadWorkspace, newMetadata, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { importIssue, type BankImportResult } from '../../src/shared/bank-import.js';
import type { StatementAiPreviewResult, StatementAiRequest, StatementAiResult } from '../../src/shared/statement-ai.js';
import type { MatchSummary } from '../../src/shared/workspace-matching.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

interface Fixture { session: WorkspaceSession; original: StoredBankImport; file: string; request: StatementAiRequest; root: string; receiptId: string }

function proposal(source: StatementAiSource, date: string = '2032-02-26'): StatementAiResult {
    const result: BankImportResult = structuredClone(source.original.result);
    result.adapter = null;
    result.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    result.transactions[0].bookingDate.value = date;
    return { status: 'ready', model: 'nuextract3', result };
}

function missingDate(record: StoredBankImport): void {
    const row: BankImportResult['transactions'][number] = record.result.transactions.pop()!;
    const id: StoredBankImport['transactions'][number] = record.transactions.pop()!;
    const issue: ReturnType<typeof importIssue> = importIssue('missing-date', 'Booking date is unreadable.', row.evidence, row.rowId, 'bookingDate');
    record.result.unresolvedDrafts = [{ ...row, bookingDate: null, issues: [issue] }];
    record.drafts = [{ rowId: row.rowId, draftId: id.transactionId }];
    record.result.status = 'partial';
    record.result.issues = [issue];
}

async function fixture(context: TestContext, analyze: StatementAiService['analyze'] = (source: StatementAiSource): Promise<StatementAiResult> => Promise.resolve(proposal(source)),
    prepare?: (record: StoredBankImport) => void): Promise<Fixture> {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-statement-reanalysis-'));
    context.onTestFinished(async (): Promise<void> => rm(root, { recursive: true, force: true }));
    const original: StoredBankImport = retainedBank(root);
    const bytes: string = 'Synthetic statement for reanalysis lifecycle tests';
    original.result.sourceProvenance!.sha256 = createHash('sha256').update(bytes).digest('hex');
    prepare?.(original);
    await writeFile(original.filePath, bytes);
    const receipt: ReturnType<typeof retainedDocument> = retainedDocument(root);
    const file: string = path.join(root, 'workspace.receiptmatch');
    await createWorkspace(file, newMetadata(), [original], [documentRun(root, [receipt])]);
    const dialogs: WorkspaceDialogs = { open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file),
        unsaved: async (): Promise<'discard'> => Promise.resolve('discard'), relinkOriginal: async (): Promise<string> => Promise.resolve(path.join(root, 'relocated.pdf')) };
    const session: WorkspaceSession = new WorkspaceSession(dialogs, undefined, undefined, undefined, undefined, undefined, undefined, { analyze });
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    return { session, original, file, root, receiptId: receipt.id, request: { importId: original.id, loadRevision: session.state().workspace!.loadRevision } };
}

function ready(result: StatementAiPreviewResult): Extract<StatementAiPreviewResult, { status: 'ready' }> {
    assert.equal(result.status, 'ready');
    return result;
}

function summary(session: WorkspaceSession, id: string): MatchSummary {
    return session.matchSummaries(session.state().workspace!.matchRevision)!.find((row: MatchSummary): boolean => row.transactionId === id)!;
}

test('complete adapter statements produce an isolated preview and append one analysis only after acceptance', async (context: TestContext): Promise<void> => {
    const { session, original, file, request }: Fixture = await fixture(context);
    assert.equal(original.result.status, 'complete');
    const before: ReturnType<WorkspaceSession['state']> = session.state();
    const fingerprint: Buffer = await readFile(file);
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(preview.summary.beforeTransactions, 2);
    assert.equal(preview.summary.afterTransactions, 2);
    assert.equal(preview.summary.unchanged, 1);
    assert.deepEqual(session.state(), before);
    assert.deepEqual(session.bankImports(), [original]);
    assert.deepEqual(await readFile(file), fingerprint);
    preview.result.transactions[0].bookingDate.value = '2032-01-01';
    await session.dispatch({ type: 'save' });
    assert.deepEqual((await loadWorkspace(file)).statementAnalysisVersions, []);
    const acceptance: { token: string; loadRevision: number; acknowledgeConflicts: boolean } = { token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true };
    assert.deepEqual(await session.acceptStatementAnalysis(acceptance), { status: 'adopted' });
    const active: StoredBankImport = session.bankImports()[0];
    assert.equal(active.id, original.id);
    assert.equal(active.result.transactions[0].bookingDate.value, '2032-02-26');
    assert.notEqual(active.transactions[0].transactionId, original.transactions[0].transactionId);
    assert.equal(active.transactions[1].transactionId, original.transactions[1].transactionId);
    assert.equal(session.state().workspace!.dirty, true);
    assert.equal(session.state().workspace!.matchRevision, before.workspace!.matchRevision + 1);
    assert.equal((await session.acceptStatementAnalysis(acceptance)).status, 'failed');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(saved.imports, [original]);
    assert.equal(saved.statementAnalysisVersions.length, 1);
    assert.equal(saved.sources.length, 2);
    assert.deepEqual(reconciliationRows(saved).map((row: ReturnType<typeof reconciliationRows>[number]): string => row.transaction_id), active.transactions.map((row: StoredBankImport['transactions'][number]): string => row.transactionId));
    await session.dispatch({ type: 'open' });
    assert.deepEqual(session.bankImports(), [active]);
    const next: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement({ ...request, loadRevision: session.state().workspace!.loadRevision }));
    assert.ok(next.blockingConflict);
});

test('partial statements can promote an unresolved booking without importing another statement', async (context: TestContext): Promise<void> => {
    const { session, original, request }: Fixture = await fixture(context, (source: StatementAiSource): Promise<StatementAiResult> => {
        const result: BankImportResult = structuredClone(source.original.result);
        const row: BankImportResult['unresolvedDrafts'][number] = result.unresolvedDrafts[0];
        result.transactions.push({ rowId: row.rowId, accountSectionId: row.accountSectionId, valueDate: row.valueDate, reportedOriginalAmount: row.reportedOriginalAmount,
            counterpartyCandidate: row.counterpartyCandidate, references: row.references, evidence: row.evidence,
            bookingDate: { value: '2032-02-28', basisLabel: 'Date', evidence: row.evidence }, description: row.description!, accountAmount: row.accountAmount!, direction: row.direction! });
        result.unresolvedDrafts = [];
        result.issues = [];
        result.status = 'complete';
        result.adapter = null;
        result.localRecognition = { model: 'nuextract3', parserVersion: '1' };
        return Promise.resolve({ status: 'ready', model: 'nuextract3', result });
    }, missingDate);
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(preview.summary.afterDrafts, 0);
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'adopted');
    assert.equal(session.bankImports().length, 1);
    assert.equal(session.bankImports()[0].transactions.length, 2);
    assert.ok(!session.bankImports()[0].transactions.some((row: StoredBankImport['transactions'][number]): boolean => row.transactionId === original.drafts[0].draftId));
});

test('discarded, superseded and workspace-stale tokens cannot apply a statement preview', async (context: TestContext): Promise<void> => {
    const { session, request, original }: Fixture = await fixture(context);
    const first: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    session.discardStatementAnalysis({ token: first.token, loadRevision: request.loadRevision });
    assert.equal((await session.acceptStatementAnalysis({ token: first.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    const second: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    const third: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal((await session.acceptStatementAnalysis({ token: second.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    await session.dispatch({ type: 'correct-bank-row', revision: session.state().workspace!.matchRevision, rowId: original.transactions[1].transactionId, changes: { bookingDate: '2032-02-24' } });
    assert.equal((await session.acceptStatementAnalysis({ token: third.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    const fourth: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    await session.dispatch({ type: 'new' });
    assert.equal((await session.acceptStatementAnalysis({ token: fourth.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    assert.equal((await session.reanalyzeStatement({ ...request, importId: randomUUID() })).status, 'failed');
});

test('acceptance rechecks original bytes and resolved relink path', async (context: TestContext): Promise<void> => {
    const observed: string[] = [];
    const { session, request, original, root }: Fixture = await fixture(context, (source: StatementAiSource): Promise<StatementAiResult> => {
        observed.push(source.filePath);
        return Promise.resolve(proposal(source));
    });
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    await writeFile(original.filePath, 'Changed PDF');
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    await writeFile(original.filePath, 'Synthetic statement for reanalysis lifecycle tests');
    const beforeRelink: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    await rename(original.filePath, path.join(root, 'relocated.pdf'));
    assert.equal((await session.relinkOriginal({ kind: 'statement', id: original.id, loadRevision: request.loadRevision })).status, 'linked');
    assert.equal((await session.acceptStatementAnalysis({ token: beforeRelink.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    const relinked: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(observed.at(-1), path.join(root, 'relocated.pdf'));
    assert.equal((await session.acceptStatementAnalysis({ token: relinked.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'adopted');
});

test('manual corrections and decisions block changed rows while unchanged corrections survive the preview', async (context: TestContext): Promise<void> => {
    const { session, request, original }: Fixture = await fixture(context);
    await session.dispatch({ type: 'correct-bank-row', revision: session.state().workspace!.matchRevision, rowId: original.transactions[1].transactionId, changes: { bookingDate: '2032-02-24' } });
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(preview.result.transactions[1].bookingDate.value, '2032-02-24');
    assert.equal(preview.changes.find((change: typeof preview.changes[number]): boolean => change.before?.id === original.transactions[1].transactionId)?.after?.row.bookingDate?.value, '2032-02-24');
    await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision, transactionId: original.transactions[0].transactionId, review: { status: 'completed-without-document' } });
    const blocked: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.ok(blocked.blockingConflict);
    assert.equal((await session.acceptStatementAnalysis({ token: blocked.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    assert.deepEqual(session.bankImports(), [original]);
});

test('surviving assignments remain but approvals require explicit acknowledgement and renewed review', async (context: TestContext): Promise<void> => {
    const { session, request, original, receiptId, file }: Fixture = await fixture(context);
    const id: string = original.transactions[1].transactionId;
    await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision, transactionId: id, review: { status: 'assigned', documentId: receiptId } });
    await session.dispatch({ type: 'approve-matches', loadRevision: request.loadRevision, selections: [summary(session, id).approvalSelection!] });
    assert.equal(summary(session, id).approvalStatus.status, 'approved');
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.match(preview.conflicts.join(' '), /approved matches/i);
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: false })).status, 'failed');
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'adopted');
    assert.equal(summary(session, id).review.status, 'assigned');
    assert.equal(summary(session, id).approvalStatus.status, 'revoked');
    await session.dispatch({ type: 'save' });
    const saved: SavedWorkspace = await loadWorkspace(file);
    assert.equal(saved.matchDecisions.get(id), receiptId);
    assert.equal(saved.statementAnalysisVersions.length, 1);
});

test('model failures and in-flight cancellation leave the active analysis and saved workspace untouched', async (context: TestContext): Promise<void> => {
    let attempt: number = 0;
    const { session, request, file, original }: Fixture = await fixture(context, async (_source: StatementAiSource, options: Parameters<StatementAiService['analyze']>[1]): Promise<StatementAiResult> => {
        if (++attempt === 1) {
            return { status: 'unavailable', error: 'Install NuExtract3.' };
        }
        return new Promise((resolve: (value: StatementAiResult) => void): void => {
            options!.onProgress?.({ phase: 'ocr', pageNumber: 1, pageCount: 1, completedPages: 0 });
            options!.signal!.addEventListener('abort', (): void => resolve({ status: 'cancelled' }), { once: true });
        });
    });
    const before: ReturnType<WorkspaceSession['state']> = session.state();
    const bytes: Buffer = await readFile(file);
    assert.deepEqual(await session.reanalyzeStatement(request), { status: 'unavailable', error: 'Install NuExtract3.' });
    const running: Promise<StatementAiPreviewResult> = session.reanalyzeStatement(request);
    assert.equal(session.state().statementImport?.localAi, true);
    assert.equal(session.state().statementImport?.progress?.phase, 'ocr');
    assert.equal((await session.reanalyzeStatement(request)).status, 'failed');
    await session.dispatch({ type: 'cancel-import' });
    assert.deepEqual(await running, { status: 'cancelled' });
    assert.deepEqual(session.state(), before);
    assert.deepEqual(session.bankImports(), [original]);
    assert.deepEqual(await readFile(file), bytes);
});

test('corrected draft approvals are revoked when another statement row changes and remain revoked after reopen', async (context: TestContext): Promise<void> => {
    const { session, request, original, receiptId }: Fixture = await fixture(context,
        (source: StatementAiSource): Promise<StatementAiResult> => Promise.resolve(proposal(source)), missingDate);
    const id: string = original.drafts[0].draftId;
    await session.dispatch({ type: 'correct-bank-row', revision: session.state().workspace!.matchRevision, rowId: id, changes: { bookingDate: '2032-02-28' } });
    await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision, transactionId: id, review: { status: 'assigned', documentId: receiptId } });
    await session.dispatch({ type: 'approve-matches', loadRevision: request.loadRevision, selections: [summary(session, id).approvalSelection!] });
    assert.equal(summary(session, id).approvalStatus.status, 'approved');
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(preview.summary.beforeDrafts, 0);
    assert.equal(preview.summary.afterDrafts, 0);
    assert.equal(preview.summary.afterTransactions, 2);
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'adopted');
    assert.equal(summary(session, id).approvalStatus.status, 'revoked');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(summary(session, id).approvalStatus.status, 'revoked');
});

test('saved protections remain in force until their removal is saved', async (context: TestContext): Promise<void> => {
    const { session, request, original }: Fixture = await fixture(context);
    const id: string = original.transactions[0].transactionId;
    await session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision, transactionId: id, ignored: true });
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    await session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision, transactionId: id, ignored: false });
    const blocked: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.ok(blocked.blockingConflict);
    assert.equal((await session.acceptStatementAnalysis({ token: blocked.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'failed');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const preview: Extract<StatementAiPreviewResult, { status: 'ready' }> = ready(await session.reanalyzeStatement(request));
    assert.equal(preview.blockingConflict, undefined);
    assert.equal((await session.acceptStatementAnalysis({ token: preview.token, loadRevision: request.loadRevision, acknowledgeConflicts: true })).status, 'adopted');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
});
