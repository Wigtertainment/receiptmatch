import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, vi } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, loadWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import type { MatchApprovalSelection } from '../../src/shared/match-approvals.js';
import { commandSchema } from '../../src/shared/protocol.js';
import { span } from './bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';

test('approves an explicit batch atomically and preserves its revisions through migration and reopening', async context => {
    const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-approvals-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'approvals.receiptmatch');
    const bank = retainedBank(root);
    const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
    const receipt = retainedDocument(root, 'uncertain.pdf');
    const { input } = extractedDocument(Buffer.from('uncertain receipt'), randomUUID());
    input.pages[0].spans = ['Receipt', 'Merchant: Cedar Workshop', 'Total: EUR 1,234.56'].map((line, index) => span(line, 30, 30 + index * 30, 250));
    receipt.result = interpretSupportingDocument(input);
    const other = retainedDocument(root, 'second.pdf');
    await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt, other])], new Map([[first, receipt.id], [second, other.id]]));
    const db = new Database(file);
    try { db.exec('DROP TABLE match_approval_state; PRAGMA user_version=7;'); } finally { db.close(); }
    const before = await readFile(file);
    const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' });
    const workspace = () => session.state().workspace!;
    const summaries = () => session.matchSummaries(workspace().matchRevision)!;
    const row = (id: string) => summaries().find(summary => summary.transactionId === id)!;
    const approve = (selections: MatchApprovalSelection[], loadRevision = workspace().loadRevision) =>
        session.dispatch(commandSchema.parse({ type: 'approve-matches', selections, loadRevision }));
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await loadWorkspace(file)).schemaVersion, 7);
    assert.deepEqual(await readFile(file), before);
    assert.equal(row(first).status, 'uncertain');
    assert.equal(row(first).approval, null);
    const selectedFirst = row(first).approvalSelection!;
    const selectedSecond = row(second).approvalSelection!;
    const initialLoad = workspace().loadRevision;
    assert.equal(selectedSecond.associationRevision, 1);
    assert.equal(commandSchema.safeParse({ type: 'approve-matches', loadRevision: initialLoad, selections: [selectedFirst, selectedFirst] }).success, false);
    assert.equal(commandSchema.safeParse({ type: 'approve-matches', loadRevision: initialLoad, selections: [] }).success, false);

    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'completed-without-document' } });
    assert.equal(row(second).approvalSelection, null);
    const noDocument = await approve([selectedFirst, selectedSecond]);
    assert.deepEqual(noDocument.approvalIssue, { transactionId: second, reason: 'not-assigned' });
    assert.equal(row(first).approval, null);
    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'assigned', documentId: other.id } });
    const stale = await approve([selectedFirst, selectedSecond]);
    assert.deepEqual(stale.approvalIssue, { transactionId: second, reason: 'selection-changed' });
    assert.match(stale.error!, /River Studio/);
    assert.equal(row(first).approval, null);
    assert.equal(row(second).approval, null);

    const reassignedSecond = row(second).approvalSelection!;
    assert.equal(reassignedSecond.associationRevision, 3);
    assert.equal((await session.dispatch({ type: 'correct-bank-row', revision: workspace().matchRevision, rowId: first,
        changes: { bookingDate: '2032-02-26' } })).error, null);
    const oldBooking = await approve([reassignedSecond, selectedFirst]);
    assert.deepEqual(oldBooking.approvalIssue, { transactionId: first, reason: 'selection-changed' });
    assert.equal(row(second).approval, null);
    const updatedFirst = row(first).approvalSelection!;
    assert.equal(updatedFirst.transactionRevision, 2);
    const { sectionId, amounts } = other.result.sections[0];
    assert.equal((await session.dispatch({ type: 'correct-document-field', revision: workspace().matchRevision, documentId: other.id,
        sectionId, fieldId: amounts[0].id, change: { kind: 'amount', value: { currency: 'EUR', coefficient: '14000', scale: 2 } } })).error, null);
    const oldDocument = await approve([updatedFirst, reassignedSecond]);
    assert.deepEqual(oldDocument.approvalIssue, { transactionId: second, reason: 'selection-changed' });
    assert.equal(row(first).approval, null);
    const updatedSecond = row(second).approvalSelection!;
    assert.equal(updatedSecond.associationRevision, 3);
    assert.equal(updatedSecond.documentRevision, 2);
    const result = await approve([updatedFirst, updatedSecond]);
    assert.equal(result.error, null);
    assert.equal(result.approvalIssue, undefined);
    assert.equal(workspace().dirty, true);
    const approvedFirst = row(first).approval!;
    const approvedSecond = row(second).approval!;
    assert.ok(approvedFirst.batchId);
    assert.equal(approvedFirst.batchId, approvedSecond.batchId);
    assert.equal(approvedFirst.approvedAt, approvedSecond.approvedAt);
    assert.equal(approvedSecond.associationRevision, updatedSecond.associationRevision);
    const approvedRevision = workspace().matchRevision;
    await approve([updatedFirst, updatedSecond]);
    assert.equal(workspace().matchRevision, approvedRevision);
    assert.deepEqual(row(first).approval, approvedFirst);
    assert.deepEqual(await readFile(file), before);

    const originalPrepare = Database.prototype.prepare;
    const fail = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
        if (sql.startsWith('INSERT INTO match_approval_state')) throw new Error('Controlled approval write failure');
        return originalPrepare.call(this, sql);
    });
    try { assert.match((await session.dispatch({ type: 'save' })).error!, /Controlled approval write failure/); }
    finally { fail.mockRestore(); }
    assert.deepEqual(await readFile(file), before);
    assert.equal(workspace().dirty, true);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await loadWorkspace(file)).schemaVersion, SCHEMA_VERSION);
    assert.equal(workspace().dirty, false);
    assert.deepEqual(row(first).approval, approvedFirst);
    assert.deepEqual(row(second).approval, approvedSecond);
    assert.match((await approve([selectedFirst], initialLoad)).error!, /workspace has changed/);
});

test('keeps approvals through reanalysis and distinguishes corrected data from a changed assignment', async context => {
    const root = await mkdtemp(path.join(tmpdir(), 'receiptmatch-approval-status-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'approval-status.receiptmatch');
    const bank = retainedBank(root);
    const [{ transactionId: first }, { transactionId: second }] = bank.transactions;
    const invoice = (name: string) => {
        const document = retainedDocument(root, name);
        const { input } = extractedDocument(Buffer.from(name), randomUUID());
        const lines = ['Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56'];
        input.pages[0].spans = lines.map((line, index) => span(line, 30, 30 + index * 30, 250));
        return { ...document, result: interpretSupportingDocument(input) };
    };
    const approvedInvoice = invoice('invoice.pdf');
    const other = retainedDocument(root, 'other.pdf');
    const competing = invoice('competing.pdf');
    const documents = documentRun(root, [approvedInvoice, other]);
    await createWorkspace(file, newMetadata(), [bank], [documents], new Map([[first, approvedInvoice.id], [second, other.id]]));
    const session = new WorkspaceSession({ open: async () => file, save: async () => file, unsaved: async () => 'discard' }, undefined, undefined,
        { run: async () => documentRun(root, [competing]) });
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    const workspace = () => session.state().workspace!;
    const row = (id: string) => session.matchSummaries(workspace().matchRevision)!.find(summary => summary.transactionId === id)!;
    const approve = (...ids: string[]) => session.dispatch({ type: 'approve-matches', loadRevision: workspace().loadRevision,
        selections: ids.map(id => row(id).approvalSelection!) });
    assert.equal(row(first).status, 'reliable');
    assert.equal((await approve(first, second)).error, null);
    const firstApproval = row(first).approval!;
    const secondApproval = row(second).approval!;
    assert.equal(row(first).approvalStatus.status, 'approved');

    await session.dispatch({ type: 'import-documents' });
    assert.equal(row(first).status, 'uncertain');
    assert.deepEqual(row(first).approval, firstApproval);
    assert.deepEqual(row(second).approval, secondApproval);
    const correctDate = (document: typeof approvedInvoice, value: string) => {
        const { sectionId, dates } = document.result.sections[0];
        return session.dispatch({ type: 'correct-document-field', revision: workspace().matchRevision, documentId: document.id, sectionId, fieldId: dates[0].id,
            change: { kind: 'date', value } });
    };
    assert.equal((await correctDate(competing, '2032-02-26')).error, null);
    assert.deepEqual(row(first).approval, firstApproval);
    assert.deepEqual(row(second).approval, secondApproval);
    assert.equal((await correctDate(approvedInvoice, '2032-02-26')).error, null);
    assert.deepEqual(row(first).approvalStatus, { status: 'stale', change: 'document' });
    assert.equal((await session.dispatch({ type: 'correct-bank-row', revision: workspace().matchRevision, rowId: first,
        changes: { bookingDate: '2032-02-25' } })).error, null);
    assert.deepEqual(row(first).approvalStatus, { status: 'stale', change: 'booking-and-document' });
    assert.equal(row(first).approval, null);
    assert.deepEqual(row(second).approval, secondApproval);

    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'open' } });
    assert.equal(row(second).approvalStatus.status, 'revoked');
    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'assigned', documentId: other.id } });
    assert.equal(row(second).approvalStatus.status, 'revoked');
    assert.equal(row(second).approval, null);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.deepEqual(row(first).approvalStatus, { status: 'stale', change: 'booking-and-document' });
    assert.equal(row(second).approvalStatus.status, 'revoked');
    assert.deepEqual(row(first).review, { status: 'assigned', documentId: approvedInvoice.id });
    assert.deepEqual(row(second).review, { status: 'assigned', documentId: other.id });
    assert.equal((await approve(first)).error, null);
    assert.equal(row(first).approvalStatus.status, 'approved');
    assert.notEqual(row(first).approval?.batchId, firstApproval.batchId);
    assert.equal(row(second).approvalStatus.status, 'revoked');
});
