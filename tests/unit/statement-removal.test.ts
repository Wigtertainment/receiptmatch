import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { StatementImportService } from '../../electron/import/service.js';
import { createWorkspace, loadWorkspace, newMetadata, type ISavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import type { BankImportInput } from '../../src/shared/bank-import.js';
import type { BankCorrection } from '../../src/shared/bank-corrections.js';
import { approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { PDF_EXTRACTION_VERSION, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import type { IWorkspaceState, IWorkspaceView } from '../../src/shared/protocol.js';
import { duplicatePairKey, type DuplicateDecision } from '../../src/shared/transaction-duplicates.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import type { IMatchSummary } from '../../src/shared/workspace-matching.js';
import { statement } from './bank-fixtures.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext): Promise<{ root: string; file: string }> {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-statement-removal-'));
    context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
    return { root, file: path.join(root, 'test.receiptmatch') };
}

function createSession(file: string, service?: StatementImportService): WorkspaceSession {
    return new WorkspaceSession({
        open: (): Promise<string> => Promise.resolve(file),
        save: (): Promise<string> => Promise.resolve(file),
        unsaved: (): Promise<'discard'> => Promise.resolve('discard')
    }, undefined, service);
}

function workspace(session: WorkspaceSession): IWorkspaceView {
    const result: IWorkspaceView | null = session.state().workspace;
    assert.ok(result);
    return result;
}

function remove(session: WorkspaceSession, importId: string, revision: number = workspace(session).matchRevision): Promise<IWorkspaceState> {
    return session.dispatch({ type: 'remove-statement', importId, revision });
}

function summary(session: WorkspaceSession, transactionId: string): IMatchSummary | undefined {
    return session.matchSummaries(workspace(session).matchRevision)?.find((row: IMatchSummary): boolean => row.transactionId === transactionId);
}

function approved(transactionId: string, documentId: string, transactionRevision: number = 1): ReviewApprovalState {
    return {
        associationRevision: 1,
        approval: { ...approvalSelectionFor(transactionId, documentId, transactionRevision), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z' }
    };
}

function excluded(leaderId: string, survivorId: string, documentId: string): Map<string, DuplicateDecision> {
    const [firstId, secondId]: string[] = [leaderId, survivorId].sort();
    return new Map([[duplicatePairKey(firstId, secondId), { firstId, secondId, primaryId: leaderId, archivedReview: { documentId } }]]);
}

function statementService(source: string): StatementImportService {
    return new StatementImportService({
        choose: (): Promise<string> => Promise.resolve(source),
        extract: (bytes: Uint8Array, sourceId: string): Promise<ExtractionResult> => {
            const input: BankImportInput = statement();
            input.source = { sourceId, sha256: createHash('sha256').update(bytes).digest('hex') };
            input.extraction = { runId: randomUUID(), version: PDF_EXTRACTION_VERSION };
            return Promise.resolve({ status: 'complete', input });
        }
    });
}

test('removes only the current statement selection and permits reimport before saving', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const removed: StoredBankImport = retainedBank(root);
    const kept: StoredBankImport = { ...retainedBank(root), filePath: path.join(root, 'keep.pdf') };
    const original: Buffer = Buffer.from('Synthetic PDF transport source');
    await writeFile(removed.filePath, original);
    const provenance: NonNullable<StoredBankImport['result']['sourceProvenance']> = removed.result.sourceProvenance!;
    provenance.sha256 = createHash('sha256').update(original).digest('hex');
    const [removedId, ignoredId]: string[] = removed.transactions.map((row: StoredBankImport['transactions'][number]): string => row.transactionId);
    const receipt: StoredSupportingDocument = retainedDocument(root);
    const report: StoredDocumentImport = documentRun(root, [receipt]);
    report.files.push({ status: 'skipped', filePath: removed.filePath, sha256: provenance.sha256, existingSourceId: provenance.sourceId });
    const correction: BankCorrection = { rowId: removedId, revision: 2, bookingDate: '2032-02-29' };
    await createWorkspace(file, newMetadata(), [removed, kept], [report], new Map([[removedId, receipt.id]]), new Map([[removedId, correction]]), undefined,
        new Map([[removedId, approved(removedId, receipt.id, 2)]]), undefined, undefined, undefined, undefined, new Set([ignoredId]));
    const session: WorkspaceSession = createSession(file, statementService(removed.filePath));
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    const before: IWorkspaceView = workspace(session);
    const savedBytes: Buffer = await readFile(file);
    assert.ok((await remove(session, removed.id, before.matchRevision - 1)).error);
    assert.ok((await remove(session, randomUUID())).error);
    assert.deepEqual(workspace(session), before);

    assert.equal((await remove(session, removed.id)).error, null);
    const changed: IWorkspaceView = workspace(session);
    assert.equal(changed.dirty, true);
    assert.ok(changed.loadRevision > before.loadRevision);
    assert.ok(changed.matchRevision > before.matchRevision);
    assert.deepEqual(session.bankImports(), [kept]);
    assert.deepEqual(changed.bankCorrections, []);
    assert.equal(changed.approvedDocumentCount, 0);
    assert.equal(changed.documentImports[0].imported, 1);
    assert.equal(changed.documentImports[0].skipped, 0);
    assert.equal(summary(session, removedId), undefined);
    assert.deepEqual(await readFile(file), savedBytes);

    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.deepEqual(session.bankImports(), [removed, kept]);
    assert.equal(workspace(session).dirty, false);
    assert.equal((await remove(session, removed.id)).error, null);
    assert.equal((await session.dispatch({ type: 'import-statement' })).importOutcome?.status, 'imported');
    const [restoredKept, reimported]: StoredBankImport[] = session.bankImports();
    assert.deepEqual(restoredKept, kept);
    assert.notEqual(reimported.id, removed.id);
    assert.equal(reimported.result.sourceProvenance?.sha256, provenance.sha256);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: ISavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(saved.imports, [kept, reimported]);
    assert.deepEqual(saved.documentImports[0].files, [{ status: 'imported', record: receipt }]);
    assert.equal(saved.matchDecisions.size, 0);
    assert.equal(saved.reviewApprovals.size, 0);
    assert.equal(saved.ignoredTransactions.size, 0);
    assert.equal(workspace(session).dirty, false);
    assert.deepEqual(await readFile(removed.filePath), original);
});

test('removing an unsaved statement releases its source without scheduling a saved import removal', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const source: string = path.join(root, 'unsaved.pdf');
    await writeFile(source, 'Synthetic PDF transport source');
    const session: WorkspaceSession = createSession(file, statementService(source));
    assert.equal((await session.dispatch({ type: 'new' })).error, null);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'import-statement' })).importOutcome?.status, 'imported');
    const [record]: StoredBankImport[] = session.bankImports();
    assert.equal((await remove(session, record.id)).error, null);
    assert.deepEqual(session.bankImports(), []);
    assert.equal(workspace(session).dirty, false);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.deepEqual((await loadWorkspace(file)).imports, []);
});

test.for([false, true])('restores the surviving duplicate without taking an assigned receipt (conflict: %s)', async (conflict: boolean, context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const [leader, survivor, other]: StoredBankImport[] = ['leader.pdf', 'survivor.pdf', 'other.pdf'].map((name: string): StoredBankImport => ({
        ...retainedBank(root), filePath: path.join(root, name)
    }));
    const leaderId: string = leader.transactions[0].transactionId, survivorId: string = survivor.transactions[0].transactionId;
    const otherId: string = other.transactions[0].transactionId;
    const receipt: StoredSupportingDocument = retainedDocument(root);
    await createWorkspace(file, newMetadata(), [leader, survivor, other], [documentRun(root, [receipt])], new Map([[survivorId, receipt.id]]), undefined, undefined,
        new Map([[survivorId, approved(survivorId, receipt.id)]]));
    const session: WorkspaceSession = createSession(file);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await session.dispatch({ type: 'set-duplicate-decision', revision: workspace(session).matchRevision,
        transactionId: leaderId, otherTransactionId: survivorId, decision: 'keep-first' })).error, null);
    assert.equal(summary(session, survivorId), undefined);
    if (conflict) {
        assert.equal((await session.dispatch({ type: 'review-match', revision: workspace(session).matchRevision, transactionId: otherId,
            review: { status: 'assigned', documentId: receipt.id } })).error, null);
    }
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await remove(session, leader.id)).error, null);
    assert.deepEqual(workspace(session).duplicateDecisions, []);
    assert.deepEqual(summary(session, survivorId)?.review, conflict ? { status: 'open' } : { status: 'assigned', documentId: receipt.id });
    assert.deepEqual(summary(session, otherId)?.review, conflict ? { status: 'assigned', documentId: receipt.id } : { status: 'open' });
    assert.equal(summary(session, survivorId)?.approvalStatus.status, 'revoked');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.deepEqual(summary(session, survivorId)?.review, conflict ? { status: 'open' } : { status: 'assigned', documentId: receipt.id });
});

test('leaves both bookings open when their archived reviews claim the same receipt', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const [leader, first, second]: StoredBankImport[] = ['leader.pdf', 'first.pdf', 'second.pdf'].map((name: string): StoredBankImport => ({
        ...retainedBank(root), filePath: path.join(root, name)
    }));
    const leaderId: string = leader.transactions[0].transactionId;
    const firstId: string = first.transactions[0].transactionId, secondId: string = second.transactions[0].transactionId;
    const receipt: StoredSupportingDocument = retainedDocument(root);
    const duplicates: Map<string, DuplicateDecision> = new Map([...excluded(leaderId, firstId, receipt.id), ...excluded(leaderId, secondId, receipt.id)]);
    await createWorkspace(file, newMetadata(), [leader, first, second], [documentRun(root, [receipt])], undefined, undefined, undefined, undefined, duplicates);
    const session: WorkspaceSession = createSession(file);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await remove(session, leader.id)).error, null);
    assert.deepEqual(summary(session, firstId)?.review, { status: 'open' });
    assert.deepEqual(summary(session, secondId)?.review, { status: 'open' });
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await loadWorkspace(file)).matchDecisions.size, 0);
});

test('reconnects remaining replacement versions and reactivates the predecessor when removing the latest version', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const [original, middle, latest]: StoredBankImport[] = ['original.pdf', 'middle.pdf', 'latest.pdf'].map((name: string): StoredBankImport => ({
        ...retainedBank(root), filePath: path.join(root, name)
    }));
    const [originalSource, middleSource, latestSource]: string[] = [original, middle, latest].map((record: StoredBankImport): string =>
        record.result.sourceProvenance!.sourceId);
    const originalId: string = original.transactions[0].transactionId, latestId: string = latest.transactions[0].transactionId;
    const receipt: StoredSupportingDocument = retainedDocument(root);
    const replacements: Map<string, string> = new Map([[originalSource, middleSource], [middleSource, latestSource]]);
    const archives: ISavedWorkspace['archivedSourceReviews'] = new Map([[originalSource, new Map([[originalId, receipt.id]])]]);
    await createWorkspace(file, newMetadata(), [original, middle, latest], [documentRun(root, [receipt])], new Map([[latestId, receipt.id]]), undefined, undefined,
        new Map([[latestId, approved(latestId, receipt.id)]]), undefined, undefined, replacements, archives);
    const session: WorkspaceSession = createSession(file);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(workspace(session).imports[2].replacesStatementId, middle.id);
    assert.equal((await remove(session, middle.id)).error, null);
    assert.deepEqual(session.bankImports(), [original, latest]);
    assert.deepEqual(workspace(session).supersededStatements, [original.id]);
    assert.equal(workspace(session).imports[1].replacesStatementId, original.id);
    assert.equal(summary(session, latestId)?.approvalStatus.status, 'approved');
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.deepEqual((await loadWorkspace(file)).sourceReplacements, new Map([[originalSource, latestSource]]));

    assert.equal((await remove(session, latest.id)).error, null);
    assert.deepEqual(session.bankImports(), [original]);
    assert.deepEqual(workspace(session).supersededStatements, []);
    assert.deepEqual(summary(session, originalId)?.review, { status: 'assigned', documentId: receipt.id });
    assert.equal(workspace(session).approvedDocumentCount, 0);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.deepEqual(summary(session, originalId)?.review, { status: 'assigned', documentId: receipt.id });
    assert.deepEqual((await loadWorkspace(file)).archivedSourceReviews, new Map());
});

test('retains an excluded review in the archived statement until its booking is reactivated', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const [leader, survivor, replacement]: StoredBankImport[] = ['leader.pdf', 'survivor.pdf', 'replacement.pdf'].map((name: string): StoredBankImport => ({
        ...retainedBank(root), filePath: path.join(root, name)
    }));
    const survivorId: string = survivor.transactions[0].transactionId;
    const survivorSource: string = survivor.result.sourceProvenance!.sourceId;
    const receipt: StoredSupportingDocument = retainedDocument(root);
    const duplicate: Map<string, DuplicateDecision> = excluded(leader.transactions[0].transactionId, survivorId, receipt.id);
    const replacements: Map<string, string> = new Map([[survivorSource, replacement.result.sourceProvenance!.sourceId]]);
    await createWorkspace(file, newMetadata(), [leader, survivor, replacement], [documentRun(root, [receipt])], undefined, undefined, undefined, undefined,
        duplicate, undefined, replacements);
    const session: WorkspaceSession = createSession(file);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await remove(session, leader.id)).error, null);
    assert.equal(summary(session, survivorId), undefined);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await loadWorkspace(file)).archivedSourceReviews.get(survivorSource)?.get(survivorId), receipt.id);

    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await remove(session, replacement.id)).error, null);
    assert.deepEqual(summary(session, survivorId)?.review, { status: 'assigned', documentId: receipt.id });
    assert.equal(workspace(session).approvedDocumentCount, 0);
});

test('retains a surviving booking’s excluded review when its receipt is superseded', async (context: TestContext): Promise<void> => {
    const { root, file }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
    const leader: StoredBankImport = retainedBank(root);
    const survivor: StoredBankImport = { ...retainedBank(root), filePath: path.join(root, 'survivor.pdf') };
    const survivorId: string = survivor.transactions[0].transactionId;
    const receipt: StoredSupportingDocument = retainedDocument(root);
    const replacement: StoredSupportingDocument = retainedDocument(root, 'replacement-receipt.pdf');
    const receiptSource: string = receipt.result.input!.source.sourceId;
    const duplicate: Map<string, DuplicateDecision> = excluded(leader.transactions[0].transactionId, survivorId, receipt.id);
    const replacements: Map<string, string> = new Map([[receiptSource, replacement.result.input!.source.sourceId]]);
    await createWorkspace(file, newMetadata(), [leader, survivor], [documentRun(root, [receipt, replacement])], undefined, undefined, undefined, undefined,
        duplicate, undefined, replacements);
    const session: WorkspaceSession = createSession(file);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await remove(session, leader.id)).error, null);
    assert.deepEqual(summary(session, survivorId)?.review, { status: 'open' });
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await loadWorkspace(file)).archivedSourceReviews.get(receiptSource)?.get(survivorId), receipt.id);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.deepEqual(summary(session, survivorId)?.review, { status: 'open' });
});
