import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredDocumentImport, StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, PositionedSpan } from "../../src/shared/bank-import.js";
import type { DocumentSection } from "../../src/shared/supporting-document.js";
import type { MatchApproval } from "../../src/shared/match-approvals.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type { MatchSummary } from "../../src/shared/workspace-matching.js";
import type { WorkspaceView } from "../../src/shared/protocol.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, vi, type TestContext } from 'vitest';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, loadWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import type { MatchApprovalSelection } from '../../src/shared/match-approvals.js';
import { commandSchema } from '../../src/shared/protocol.js';
import { span } from './bank-fixtures.js';
import { documentRun, extractedDocument, retainedBank, retainedDocument } from './document-fixtures.js';

test('approves an explicit batch atomically and preserves its revisions through migration and reopening', async (context: TestContext & object): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-approvals-'));
    context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
    const file: string = path.join(root, 'approvals.receiptmatch');
    const bank: StoredBankImport = retainedBank(root);
    const [{ transactionId: first }, { transactionId: second }]: { rowId: string; transactionId: string; }[] = bank.transactions;
    const receipt: StoredSupportingDocument = retainedDocument(root, 'uncertain.pdf');
    const { input }: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(Buffer.from('uncertain receipt'), randomUUID());
    input.pages[0].spans = ['Receipt', 'Merchant: Cedar Workshop', 'Total: EUR 1,234.56'].map((line: string, index: number): PositionedSpan => span(line, 30, 30 + index * 30, 250));
    receipt.result = interpretSupportingDocument(input);
    const other: StoredSupportingDocument = retainedDocument(root, 'second.pdf');
    await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt, other])], new Map([[first, receipt.id], [second, other.id]]));
    const db: Database.Database = new Database(file);
    try {
        db.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; PRAGMA user_version=7;');
    } finally {
        db.close();
    }
    const before: NonSharedBuffer = await readFile(file);
    const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
    const workspace: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;

    const summaries: () => MatchSummary[] = (): MatchSummary[] => session.matchSummaries(workspace().matchRevision)!;

    const row: (id: string) => MatchSummary = (id: string): MatchSummary => summaries().find((summary: MatchSummary): boolean => summary.transactionId === id)!;

    const approve: (selections: MatchApprovalSelection[], loadRevision?: number) => Promise<WorkspaceState> = (selections: MatchApprovalSelection[], loadRevision: number = workspace().loadRevision): Promise<WorkspaceState> =>
        session.dispatch(commandSchema.parse({ type: 'approve-matches', selections, loadRevision }));
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal((await loadWorkspace(file)).schemaVersion, 7);
    assert.deepEqual(await readFile(file), before);
    assert.equal(row(first).status, 'uncertain');
    assert.equal(row(first).approval, null);
    const selectedFirst: MatchApprovalSelection = row(first).approvalSelection!;
    const selectedSecond: MatchApprovalSelection = row(second).approvalSelection!;
    const initialLoad: number = workspace().loadRevision;
    assert.equal(selectedSecond.associationRevision, 1);
    assert.equal(commandSchema.safeParse({ type: 'approve-matches', loadRevision: initialLoad, selections: [selectedFirst, selectedFirst] }).success, false);
    assert.equal(commandSchema.safeParse({ type: 'approve-matches', loadRevision: initialLoad, selections: [] }).success, false);

    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'completed-without-document' } });
    assert.equal(row(second).approvalSelection, null);
    const noDocument: WorkspaceState = await approve([selectedFirst, selectedSecond]);
    assert.deepEqual(noDocument.approvalIssue, { transactionId: second, reason: 'not-assigned' });
    assert.equal(row(first).approval, null);
    await session.dispatch({ type: 'review-match', revision: workspace().matchRevision, transactionId: second, review: { status: 'assigned', documentId: other.id } });
    const stale: WorkspaceState = await approve([selectedFirst, selectedSecond]);
    assert.deepEqual(stale.approvalIssue, { transactionId: second, reason: 'selection-changed' });
    assert.match(stale.error!, /River Studio/);
    assert.equal(row(first).approval, null);
    assert.equal(row(second).approval, null);

    const reassignedSecond: MatchApprovalSelection = row(second).approvalSelection!;
    assert.equal(reassignedSecond.associationRevision, 3);
    assert.equal((await session.dispatch({ type: 'correct-bank-row', revision: workspace().matchRevision, rowId: first,
        changes: { bookingDate: '2032-02-26' } })).error, null);
    const oldBooking: WorkspaceState = await approve([reassignedSecond, selectedFirst]);
    assert.deepEqual(oldBooking.approvalIssue, { transactionId: first, reason: 'selection-changed' });
    assert.equal(row(second).approval, null);
    const updatedFirst: MatchApprovalSelection = row(first).approvalSelection!;
    assert.equal(updatedFirst.transactionRevision, 2);
    const { sectionId, amounts }: DocumentSection = other.result.sections[0];
    assert.equal((await session.dispatch({ type: 'correct-document-field', revision: workspace().matchRevision, documentId: other.id,
        sectionId, fieldId: amounts[0].id, change: { kind: 'amount', value: { currency: 'EUR', coefficient: '14000', scale: 2 } } })).error, null);
    const oldDocument: WorkspaceState = await approve([updatedFirst, reassignedSecond]);
    assert.deepEqual(oldDocument.approvalIssue, { transactionId: second, reason: 'selection-changed' });
    assert.equal(row(first).approval, null);
    const updatedSecond: MatchApprovalSelection = row(second).approvalSelection!;
    assert.equal(updatedSecond.associationRevision, 3);
    assert.equal(updatedSecond.documentRevision, 2);
    const result: WorkspaceState = await approve([updatedFirst, updatedSecond]);
    assert.equal(result.error, null);
    assert.equal(result.approvalIssue, undefined);
    assert.equal(workspace().dirty, true);
    const approvedFirst: MatchApproval = row(first).approval!;
    const approvedSecond: MatchApproval = row(second).approval!;
    assert.ok(approvedFirst.batchId);
    assert.equal(approvedFirst.batchId, approvedSecond.batchId);
    assert.equal(approvedFirst.approvedAt, approvedSecond.approvedAt);
    assert.equal(approvedSecond.associationRevision, updatedSecond.associationRevision);
    const approvedRevision: number = workspace().matchRevision;
    await approve([updatedFirst, updatedSecond]);
    assert.equal(workspace().matchRevision, approvedRevision);
    assert.deepEqual(row(first).approval, approvedFirst);
    assert.deepEqual(await readFile(file), before);

    const originalPrepare: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
    const fail: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
        if (sql.startsWith('INSERT INTO match_approval_state')) {
            throw new Error('Controlled approval write failure');
        }
        return originalPrepare(this, sql);
    });
    try {
        assert.match((await session.dispatch({ type: 'save' })).error!, /Controlled approval write failure/);
    } finally {
        fail.mockRestore();
    }
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

test('keeps approvals through reanalysis and distinguishes corrected data from a changed assignment', async (context: TestContext & object): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-approval-status-'));
    context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
    const file: string = path.join(root, 'approval-status.receiptmatch');
    const bank: StoredBankImport = retainedBank(root);
    const [{ transactionId: first }, { transactionId: second }]: { rowId: string; transactionId: string; }[] = bank.transactions;
    const invoice: (name: string) => StoredSupportingDocument = (name: string): StoredSupportingDocument => {
        const document: StoredSupportingDocument = retainedDocument(root, name);
        const { input }: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(Buffer.from(name), randomUUID());
        const lines: string[] = ['Invoice', 'Merchant: Cedar Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28', 'Invoice Total: EUR 1,234.56'];
        input.pages[0].spans = lines.map((line: string, index: number): PositionedSpan => span(line, 30, 30 + index * 30, 250));
        return { ...document, result: interpretSupportingDocument(input) };
    };
    const approvedInvoice: ReturnType<typeof invoice> = invoice('invoice.pdf');
    const other: StoredSupportingDocument = retainedDocument(root, 'other.pdf');
    const competing: ReturnType<typeof invoice> = invoice('competing.pdf');
    const documents: StoredDocumentImport = documentRun(root, [approvedInvoice, other]);
    await createWorkspace(file, newMetadata(), [bank], [documents], new Map([[first, approvedInvoice.id], [second, other.id]]));
    const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') }, undefined, undefined,
        { run: async (): Promise<StoredDocumentImport> => Promise.resolve(documentRun(root, [competing])) });
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    const workspace: () => WorkspaceView = (): WorkspaceView => session.state().workspace!;

    const row: (id: string) => MatchSummary = (id: string): MatchSummary => session.matchSummaries(workspace().matchRevision)!.find((summary: MatchSummary): boolean => summary.transactionId === id)!;

    const approve: (...ids: string[]) => Promise<WorkspaceState> = (...ids: string[]): Promise<WorkspaceState> => session.dispatch({ type: 'approve-matches', loadRevision: workspace().loadRevision,
        selections: ids.map((id: string): MatchApprovalSelection => row(id).approvalSelection!) });
    assert.equal(row(first).status, 'reliable');
    assert.equal((await approve(first, second)).error, null);
    const firstApproval: MatchApproval = row(first).approval!;
    const secondApproval: MatchApproval = row(second).approval!;
    assert.equal(row(first).approvalStatus.status, 'approved');

    await session.dispatch({ type: 'import-documents' });
    assert.equal(row(first).status, 'uncertain');
    assert.deepEqual(row(first).approval, firstApproval);
    assert.deepEqual(row(second).approval, secondApproval);
    const correctDate: (document: StoredSupportingDocument, value: string) => Promise<WorkspaceState> = (document: typeof approvedInvoice, value: string): Promise<WorkspaceState> => {
        const { sectionId, dates }: DocumentSection = document.result.sections[0];
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
