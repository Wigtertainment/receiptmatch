import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestContext } from 'vitest';
import { prepareStatementAnalysisVersion, projectCorrectedStatementAnalyses } from '../../electron/import/statement-analyses.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import type { BankImportResult } from '../../src/shared/bank-import.js';
import type { BankCorrection } from '../../src/shared/bank-corrections.js';
import type { StatementAnalysisVersion } from '../../src/shared/statement-analysis.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';
import { statement } from './bank-fixtures.js';
import type { BankImportInput, PositionedSpan } from '../../src/shared/bank-import.js';
import { approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { duplicatePairKey, type DuplicateDecision } from '../../src/shared/transaction-duplicates.js';

async function directory(context: TestContext): Promise<string> {
    const parent: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(parent, 'receiptmatch-statement-history-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), parent);
        await rm(root, { recursive: true, force: true });
    });
    return root;
}

function version(original: StoredBankImport, current: StoredBankImport = original, date: string = '2032-02-26'): StatementAnalysisVersion {
    const proposed: BankImportResult = structuredClone(current.result);
    proposed.adapter = null;
    proposed.localRecognition = { model: 'nuextract3', parserVersion: '1' };
    proposed.transactions[0].bookingDate.value = date;
    return prepareStatementAnalysisVersion(original, current, proposed);
}

function saveHistory(current: SavedWorkspace, versions: StatementAnalysisVersion[]): Promise<SavedWorkspace> {
    return saveWorkspace(current, current.metadata, current.imports, current.documentImports, current.matchDecisions, current.bankCorrections,
        current.documentCorrections, current.reviewApprovals, current.duplicateDecisions, current.sourceRelocations, current.sourceReplacements,
        current.archivedSourceReviews, current.ignoredTransactions, current.receiptAnalysisVersions, new Set(), versions);
}

test('statement versions round-trip unchanged originals, retain historical SQL rows and validate the exact union', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const original: StoredBankImport = retainedBank(root);
    const file: string = path.join(root, 'workspace.receiptmatch');
    const first: StatementAnalysisVersion = version(original);
    const second: StatementAnalysisVersion = version(original, first.record, '2032-02-25');
    const saved: SavedWorkspace = await saveHistory(await createWorkspace(file, newMetadata(), [original]), [first, second]);
    const reopened: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(reopened.imports, [original]);
    assert.deepEqual(reopened.statementAnalysisVersions, [first, second]);
    const active: StoredBankImport = projectCorrectedStatementAnalyses(reopened.imports, reopened.statementAnalysisVersions, reopened.bankCorrections)[0];
    assert.deepEqual(active, second.record);
    assert.equal(reopened.matches.length, active.transactions.length);
    const db: Database.Database = new Database(file);
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, 4);
    db.prepare('INSERT INTO transactions(id,statement_id,coefficient,currency,scale) VALUES(?,?,?,?,?)').run(randomUUID(), original.accounts[0].statementId, '99', 'EUR', 2);
    db.close();
    await assert.rejects(loadWorkspace(file), /unexpected projected records/);
    assert.equal(saved.schemaVersion, SCHEMA_VERSION);
});

test('saved history is append-only and invalid UUID/source edits roll back atomically', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const original: StoredBankImport = retainedBank(root);
    const file: string = path.join(root, 'workspace.receiptmatch');
    const document: ReturnType<typeof retainedDocument> = retainedDocument(root);
    const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [original], [documentRun(root, [document])]);
    const collision: StatementAnalysisVersion = version(original);
    collision.record.transactions[0].transactionId = document.id;
    const bytes: NonSharedBuffer = await readFile(file);
    await assert.rejects(saveHistory(saved, [collision]), /workspace identity/);
    assert.deepEqual(await readFile(file), bytes);
    const first: StatementAnalysisVersion = version(original);
    const updated: SavedWorkspace = await saveHistory(saved, [first]);
    const committed: NonSharedBuffer = await readFile(file);
    await assert.rejects(saveHistory(updated, []), /cannot be removed/);
    const rewrite: StatementAnalysisVersion = structuredClone(first);
    rewrite.acceptedAt = '2033-01-01T00:00:00Z';
    await assert.rejects(saveHistory(updated, [rewrite]), /cannot be removed, reordered or rewritten/);
    const forged: StatementAnalysisVersion = version(original, first.record, '2032-02-24');
    forged.record.result.sourceProvenance!.sha256 = 'f'.repeat(64);
    await assert.rejects(saveHistory(updated, [first, forged]), /original import/);
    assert.deepEqual(await readFile(file), committed);
});

test('new analysis cannot discard corrected, assigned, approved, ignored or duplicate-reviewed bank rows', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    for (const protection of ['correction', 'decision', 'approval', 'ignore', 'duplicate'] as const) {
        const original: StoredBankImport = retainedBank(root);
        const id: string = original.transactions[0].transactionId;
        const correction: BankCorrection = { rowId: id, revision: 2, bookingDate: '2032-02-24' };
        const document: ReturnType<typeof retainedDocument> = retainedDocument(root);
        const approved: ReviewApprovalState = { associationRevision: 1, approval: { ...approvalSelectionFor(id, document.id), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00Z' } };
        const other: StoredBankImport = retainedBank(root);
        const pair: string[] = [id, other.transactions[0].transactionId].sort();
        const duplicate: DuplicateDecision = { firstId: pair[0], secondId: pair[1], primaryId: null, archivedReview: null };
        const saved: SavedWorkspace = await createWorkspace(path.join(root, protection + '.receiptmatch'), newMetadata(), protection === 'duplicate' ? [original, other] : [original], [documentRun(root, [document])],
            protection === 'decision' || protection === 'approval' ? new Map([[id, document.id]]) : new Map(), protection === 'correction' ? new Map([[id, correction]]) : new Map(), undefined,
            protection === 'approval' ? new Map([[id, approved]]) : new Map(), protection === 'duplicate' ? new Map([[duplicatePairKey(pair[0], pair[1]), duplicate]]) : new Map(), undefined, undefined, undefined,
            protection === 'ignore' ? new Set([id]) : new Set());
        const bytes: NonSharedBuffer = await readFile(saved.filePath);
        await assert.rejects(saveHistory(saved, [version(original)]), /protected bank row/, protection);
        assert.deepEqual(await readFile(saved.filePath), bytes);
    }
});

test('archived corrections validate and project their historical SQL row without affecting latest bookings', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const original: StoredBankImport = retainedBank(root);
    const initial: SavedWorkspace = await createWorkspace(path.join(root, 'workspace.receiptmatch'), newMetadata(), [original]);
    const saved: SavedWorkspace = await saveHistory(initial, [version(original)]);
    const id: string = original.transactions[0].transactionId;
    const corrections: Map<string, BankCorrection> = new Map([[id, { rowId: id, revision: 2, bookingDate: '2032-02-20' }]]);
    const edited: SavedWorkspace = await saveWorkspace(saved, saved.metadata, undefined, undefined, undefined, corrections);
    const reopened: SavedWorkspace = await loadWorkspace(edited.filePath);
    assert.equal(reopened.bankCorrections.get(id)!.bookingDate, '2032-02-20');
    assert.equal(projectCorrectedStatementAnalyses(reopened.imports, reopened.statementAnalysisVersions, reopened.bankCorrections)[0].result.transactions[0].bookingDate.value, '2032-02-26');
});

test('old workspaces stay byte-identical on open and gain the history table only on explicit save', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const file: string = path.join(root, 'old.receiptmatch');
    await createWorkspace(file, newMetadata(), [retainedBank(root)]);
    const db: Database.Database = new Database(file);
    db.exec('DROP TABLE statement_analysis_versions; PRAGMA user_version=13;');
    db.close();
    const bytes: NonSharedBuffer = await readFile(file);
    const previous: SavedWorkspace = await loadWorkspace(file);
    assert.equal(previous.schemaVersion, 13);
    assert.deepEqual(previous.statementAnalysisVersions, []);
    assert.deepEqual(await readFile(file), bytes);
    const saved: SavedWorkspace = await saveHistory(previous, [version(previous.imports[0])]);
    assert.equal(saved.schemaVersion, SCHEMA_VERSION);
    assert.equal((await loadWorkspace(file)).statementAnalysisVersions.length, 1);
});

test('removing a statement deletes every retained analysis and historical transaction identity', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const original: StoredBankImport = retainedBank(root);
    const initial: SavedWorkspace = await createWorkspace(path.join(root, 'workspace.receiptmatch'), newMetadata(), [original]);
    const saved: SavedWorkspace = await saveHistory(initial, [version(original)]);
    const removed: SavedWorkspace = await saveWorkspace(saved, saved.metadata, [], [], new Map(), new Map(), undefined, new Map(), new Map(), undefined,
        undefined, undefined, new Set(), undefined, new Set([original.id]), []);
    assert.deepEqual(removed.imports, []);
    assert.deepEqual((await loadWorkspace(removed.filePath)).statementAnalysisVersions, []);
    const db: Database.Database = new Database(removed.filePath);
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT count(*) AS count FROM statements').get() as { count: number }).count, 0);
    db.close();
});

test('the historical SQL union includes correction-promoted drafts without transferring their identities to AI promotions', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const input: BankImportInput = statement();
    input.pages[0].spans.find((span: PositionedSpan): boolean => span.text === '28 Feb 2032')!.text = '?? Feb 2032';
    const original: StoredBankImport = retainedBank(root, input);
    const id: string = original.drafts[0].draftId;
    const corrections: Map<string, BankCorrection> = new Map([[id, { rowId: id, revision: 2, bookingDate: '2032-02-28' }]]);
    const initial: SavedWorkspace = await createWorkspace(path.join(root, 'workspace.receiptmatch'), newMetadata(), [original], [], undefined, corrections);
    const next: StatementAnalysisVersion = version(original);
    const saved: SavedWorkspace = await saveHistory(initial, [next]);
    const reopened: SavedWorkspace = await loadWorkspace(saved.filePath);
    const active: StoredBankImport = projectCorrectedStatementAnalyses(reopened.imports, reopened.statementAnalysisVersions, reopened.bankCorrections)[0];
    assert.equal(active.transactions.some((row: StoredBankImport['transactions'][number]): boolean => row.transactionId === id), true);
    const db: Database.Database = new Database(saved.filePath);
    assert.equal((db.prepare('SELECT revision FROM transactions WHERE id=?').get(id) as { revision: number }).revision, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, 3);
    db.close();
});

test('unchanged duplicate-reviewed rows retain their decisions across a local analysis version and reopen', async (context: TestContext): Promise<void> => {
    const root: string = await directory(context);
    const original: StoredBankImport = retainedBank(root);
    const other: StoredBankImport = retainedBank(root);
    const pair: string[] = [original.transactions[0].transactionId, other.transactions[0].transactionId].sort();
    const duplicate: DuplicateDecision = { firstId: pair[0], secondId: pair[1], primaryId: null, archivedReview: null };
    const decisions: Map<string, DuplicateDecision> = new Map([[duplicatePairKey(pair[0], pair[1]), duplicate]]);
    const saved: SavedWorkspace = await createWorkspace(path.join(root, 'workspace.receiptmatch'), newMetadata(), [original, other], [], undefined, undefined, undefined, undefined, decisions);
    const proposed: BankImportResult = { ...structuredClone(original.result), adapter: null, localRecognition: { model: 'nuextract3', parserVersion: '1' } };
    await saveHistory(saved, [prepareStatementAnalysisVersion(original, original, proposed)]);
    const reopened: SavedWorkspace = await loadWorkspace(saved.filePath);
    assert.deepEqual(reopened.duplicateDecisions, decisions);
    assert.equal(reopened.statementAnalysisVersions[0].record.result.adapter, null);
});
