import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type TestContext } from 'vitest';
import type { IDocumentImportService } from '../../electron/documents/service.js';
import type { BankImportAttempt, IBankImportService } from '../../electron/import/service.js';
import { prepareStatementAnalysisVersion } from '../../electron/import/statement-analyses.js';
import { reconciliationRows, type ReconciliationRow } from '../../electron/reconciliation-csv.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, type ISavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type IWorkspaceDialogs } from '../../electron/workspace-session.js';
import type { BankImportResult } from '../../src/shared/bank-import.js';
import { defaultExportFilenamePattern } from '../../src/shared/export-filename.js';
import type { StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

interface Fixture { root: string; file: string; original: StoredBankImport; versions: StatementAnalysisVersion[]; }

function saveVersions(current: ISavedWorkspace, versions: StatementAnalysisVersion[]): Promise<ISavedWorkspace> {
    return saveWorkspace(current, current.metadata, current.imports, current.documentImports, current.matchDecisions, current.bankCorrections,
        current.documentCorrections, current.reviewApprovals, current.duplicateDecisions, current.sourceRelocations, current.sourceReplacements,
        current.archivedSourceReviews, current.ignoredTransactions, current.receiptAnalysisVersions, new Set(), current.documentFieldReviews, versions);
}

function proposed(record: StoredBankImport, date: string): BankImportResult {
    const result: BankImportResult = structuredClone(record.result);
    result.adapter = null;
    result.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    result.transactions[0].bookingDate.value = date;
    return result;
}

async function fixture(context: TestContext): Promise<Fixture> {
    const parent: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(parent, 'receiptmatch-statement-versions-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), parent);
        await rm(root, { recursive: true, force: true });
    });
    const file: string = path.join(root, 'workspace.receiptmatch');
    const original: StoredBankImport = retainedBank(root);
    const first: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed(original, '2032-02-26'));
    const next: BankImportResult = proposed(first.record, '2032-02-25');
    next.transactions = next.transactions.slice(0, 1);
    const second: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, first.record, next);
    const versions: StatementAnalysisVersion[] = [first, second];
    const initial: ISavedWorkspace = await createWorkspace(file, newMetadata(), [original]);
    await saveVersions(initial, versions);
    return { root, file, original, versions };
}

function dialogs(file: string, destination: string = file): IWorkspaceDialogs {
    return { open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(destination),
        unsaved: async (): Promise<'discard'> => Promise.resolve('discard') };
}

test('session, corrections and reconciliation export use the latest statement analysis after reopen', async (context: TestContext): Promise<void> => {
    const { root, file, original, versions }: Fixture = await fixture(context);
    const latest: StoredBankImport = versions[1].record;
    const id: string = latest.transactions[0].transactionId;
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await session.dispatch({ type: 'open' });
    assert.equal(session.state().error, null);
    assert.equal(session.state().workspace!.dirty, false);
    assert.equal(session.state().workspace!.imports[0].transactions, 1);
    assert.equal(session.state().workspace!.imports[0].bankId, original.result.adapter!.bankId);
    assert.deepEqual(session.bankImports(), [latest]);
    assert.deepEqual(session.matchResults().map((row: ReturnType<WorkspaceSession['matchResults']>[number]): string => row.transactionId), [id]);
    await session.dispatch({ type: 'correct-bank-row', revision: session.state().workspace!.matchRevision,
        rowId: original.transactions[0].transactionId, changes: { bookingDate: '2032-02-24' } });
    assert.match(session.state().error!, /no longer available/);
    await session.dispatch({ type: 'correct-bank-row', revision: session.state().workspace!.matchRevision, rowId: id, changes: { bookingDate: '2032-02-24' } });
    assert.equal(session.state().error, null);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
    assert.equal(session.state().workspace!.dirty, false);
    const reopened: ISavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(reopened.imports, [original]);
    assert.deepEqual(reopened.statementAnalysisVersions, versions);
    const rows: ReconciliationRow[] = reconciliationRows(reopened);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].transaction_id, id);
    assert.equal(rows[0].booking_date, '2032-02-24');
    const destination: string = path.join(root, 'export');
    await mkdir(destination);
    const exported: Awaited<ReturnType<WorkspaceSession['exportReconciliation']>> = await session.exportReconciliation(session.state().workspace!.loadRevision, destination, defaultExportFilenamePattern);
    assert.equal(exported.csv.status, 'written');
    const csv: string = await readFile(path.join(destination, 'reconciliation.csv'), 'utf8');
    assert.ok(csv.includes(id));
    assert.ok(csv.includes('2032-02-24'));
    assert.ok(!csv.includes(original.transactions[0].transactionId));
    assert.ok(!csv.includes(original.transactions[1].transactionId));
    const restored: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await restored.dispatch({ type: 'open' });
    assert.equal(restored.state().error, null);
    assert.equal(restored.bankImports()[0].transactions[0].transactionId, id);
    assert.equal(restored.state().workspace!.bankCorrections[0].bookingDate, '2032-02-24');
});

test('removing a statement also removes its analysis history and latest booking decisions', async (context: TestContext): Promise<void> => {
    const { file, original, versions }: Fixture = await fixture(context);
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await session.dispatch({ type: 'open' });
    await session.dispatch({ type: 'set-transaction-ignored', revision: session.state().workspace!.matchRevision,
        transactionId: versions[1].record.transactions[0].transactionId, ignored: true });
    assert.equal(session.state().error, null);
    await session.dispatch({ type: 'remove-statement', importId: original.id, revision: session.state().workspace!.matchRevision });
    assert.equal(session.state().error, null);
    assert.deepEqual(session.bankImports(), []);
    assert.deepEqual(session.matchResults(), []);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
    const reopened: ISavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(reopened.imports, []);
    assert.deepEqual(reopened.statementAnalysisVersions, []);
    assert.equal(reopened.ignoredTransactions.size, 0);
});

test('a new workspace clears statement analysis versions without altering the previously saved workspace', async (context: TestContext): Promise<void> => {
    const { root, file, versions }: Fixture = await fixture(context);
    const destination: string = path.join(root, 'new.receiptmatch');
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file, destination));
    await session.dispatch({ type: 'open' });
    await session.dispatch({ type: 'new' });
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
    assert.deepEqual((await loadWorkspace(destination)).statementAnalysisVersions, []);
    assert.deepEqual((await loadWorkspace(file)).statementAnalysisVersions, versions);
});

test('new statement and document imports cannot reuse retired analysis row identities', async (context: TestContext): Promise<void> => {
    const { root, file, versions }: Fixture = await fixture(context);
    const retired: string = versions[0].record.transactions[0].transactionId;
    const bank: StoredBankImport = retainedBank(root);
    bank.transactions[0].transactionId = retired;
    const document: StoredSupportingDocument = retainedDocument(root);
    document.id = retired;
    const documents: StoredDocumentImport = documentRun(root, [document]);
    const bankService: IBankImportService = { run: async (): Promise<BankImportAttempt> => Promise.resolve({ status: 'imported', record: bank }) };
    const documentService: IDocumentImportService = { run: async (): Promise<StoredDocumentImport> => Promise.resolve(documents) };
    for (const type of ['import-statement', 'import-documents'] as const) {
        const session: WorkspaceSession = new WorkspaceSession(dialogs(file), undefined, bankService, documentService);
        await session.dispatch({ type: 'open' });
        await session.dispatch({ type });
        await vi.waitFor((): void => assert.equal(session.state().busy, false));
        const outcome: ReturnType<WorkspaceSession['state']>['importOutcome'] | ReturnType<WorkspaceSession['state']>['documentOutcome'] =
            type === 'import-statement' ? session.state().importOutcome : session.state().documentOutcome;
        assert.equal(outcome?.status, 'failed');
        assert.match(outcome.issues[0].message, /reus/i);
        assert.equal(session.state().workspace!.dirty, false);
        assert.deepEqual(session.bankImports(), [versions[1].record]);
    }
});

test('known original bank scope preserves duplicate decisions and permits reviewing overlaps after reanalysis', async (context: TestContext): Promise<void> => {
    const { root, original }: Fixture = await fixture(context);
    const other: StoredBankImport = retainedBank(root);
    const file: string = path.join(root, 'duplicates.receiptmatch');
    await createWorkspace(file, newMetadata(), [original, other]);
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await session.dispatch({ type: 'open' });
    const transactionId: string = original.transactions[0].transactionId;
    const otherTransactionId: string = other.transactions[0].transactionId;
    await session.dispatch({ type: 'set-duplicate-decision', revision: session.state().workspace!.matchRevision,
        transactionId, otherTransactionId, decision: 'keep-first' });
    assert.equal(session.state().error, null);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
    const version: StatementAnalysisVersion = prepareStatementAnalysisVersion(original, original, proposed(original, original.result.transactions[0].bookingDate.value));
    await saveVersions(await loadWorkspace(file), [version]);
    const restored: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await restored.dispatch({ type: 'open' });
    assert.equal(restored.state().error, null);
    assert.equal(restored.state().workspace!.duplicateDecisions.length, 1);
    assert.equal(restored.state().workspace!.imports[0].bankId, original.result.adapter!.bankId);
    assert.equal(restored.bankImports()[0].result.adapter, null);
    assert.equal(restored.matchResults().length, 3);
    for (const decision of ['clear', 'keep-first'] as const) {
        await restored.dispatch({ type: 'set-duplicate-decision', revision: restored.state().workspace!.matchRevision, transactionId, otherTransactionId, decision });
        assert.equal(restored.state().error, null);
    }
    await restored.dispatch({ type: 'save' });
    assert.equal(restored.state().error, null);
    assert.equal((await loadWorkspace(file)).duplicateDecisions.size, 1);
});
