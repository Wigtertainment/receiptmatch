import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'vitest';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceDocumentState } from '../../electron/documents/document-state.js';
import { documentFieldConfirmationIssue, documentFieldReviewKey, documentFieldSignature, isDocumentFieldConfirmed, type DocumentFieldReview, type DocumentFieldReviewTarget } from '../../src/shared/document-field-reviews.js';
import { documentRevisionIndex } from '../../src/shared/match-approvals.js';
import type { DocumentSnapshot, WorkspaceState } from '../../src/shared/protocol.js';
import type { SupportingDocument, DocumentSection } from '../../src/shared/supporting-document.js';
import type { StoredSupportingDocument, StoredDocumentImport } from '../../src/shared/workspace-documents.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

function reviewFor(document: StoredSupportingDocument, section: DocumentSection, fieldId: string): DocumentFieldReview {
    return { documentId: document.id, sectionId: section.sectionId, fieldId, confirmed: true, revision: 2, signature: documentFieldSignature(document.result, section.sectionId, fieldId)! };
}

function effective(session: WorkspaceSession): SupportingDocument {
    const workspace: NonNullable<WorkspaceState['workspace']> = session.state().workspace!;
    const snapshot: DocumentSnapshot = session.documentSnapshot({ loadRevision: workspace.loadRevision, revision: workspace.matchRevision })!;
    const file: StoredDocumentImport['files'][number] = snapshot.reports[0].files[0];
    assert.equal(file.status, 'imported');
    return file.record.result;
}

test('field confirmation resolves only explicit association warnings while retaining the original values and evidence', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const section: DocumentSection = document.result.sections[0];
    const merchant: DocumentSection['merchants'][number] = section.merchants[0];
    document.result.issues = [{ code: 'unconfirmed-merchant', severity: 'warning', message: 'Review the supplier context.', sectionId: section.sectionId, fieldId: merchant.id, field: merchant.role, evidence: merchant.evidence }];
    document.result.status = 'partial';
    const original: SupportingDocument = structuredClone(document.result);
    const review: DocumentFieldReview = reviewFor(document, section, merchant.id);
    assert.equal(documentFieldConfirmationIssue(original, section.sectionId, merchant.id), null);
    const view: WorkspaceDocumentState = new WorkspaceDocumentState([documentRun(path.resolve('.'), [document])], new Map(), [], new Map([[documentFieldReviewKey(review), review]]));
    const file: StoredDocumentImport['files'][number] = view.effective[0].files[0];
    assert.equal(file.status, 'imported');
    if (file.status !== 'imported') {
        return;
    }
    assert.deepEqual(file.record.result.issues, []);
    assert.equal(file.record.result.status, 'complete');
    assert.deepEqual(file.record.result.sections, original.sections);
    assert.deepEqual(document.result, original);
    assert.equal(isDocumentFieldConfirmed(file.record.result, review, [review]), true);
    const reanalyzed: SupportingDocument = structuredClone(file.record.result);
    reanalyzed.input!.extraction.runId = 'new-analysis-run';
    assert.equal(isDocumentFieldConfirmed(reanalyzed, review, [review]), false);
});

test('missing currency, multiple candidates, unknown meaning and scalar conflicts cannot be confirmed', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    total.candidates[0].currency = null;
    assert.match(documentFieldConfirmationIssue(document.result, section.sectionId, total.id)!, /currency/);
    total.candidates[0].currency = 'EUR';
    total.candidates.push({ coefficient: '5000', currency: 'EUR', scale: 2 });
    assert.match(documentFieldConfirmationIssue(document.result, section.sectionId, total.id)!, /single value/);
    total.candidates.pop();
    total.role = 'unknown';
    assert.match(documentFieldConfirmationIssue(document.result, section.sectionId, total.id)!, /meaning/);
    total.role = 'billed-total';
    section.amounts.push({ ...total, id: 'another-total', candidates: [{ coefficient: '5000', currency: 'EUR', scale: 2 }] });
    assert.match(documentFieldConfirmationIssue(document.result, section.sectionId, total.id)!, /conflicting/);
});

test('confirmation and withdrawal persist, reject stale commands and do not assign a transaction', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-field-reviews-'));
    try {
        const file: string = path.join(root, 'reviews.receiptmatch');
        const document: StoredSupportingDocument = retainedDocument(root);
        const section: DocumentSection = document.result.sections[0];
        const merchant: DocumentSection['merchants'][number] = section.merchants[0];
        document.result.issues.push({ code: 'unconfirmed-merchant', severity: 'warning', message: 'Check the merchant.', sectionId: section.sectionId, fieldId: merchant.id, field: merchant.role, evidence: merchant.evidence });
        document.result.status = 'partial';
        const original: SupportingDocument = structuredClone(document.result);
        await createWorkspace(file, newMetadata(), [retainedBank(root)], [documentRun(root, [document])]);
        const dialogs: WorkspaceDialogs = { open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<'discard'> => Promise.resolve('discard') };
        const session: WorkspaceSession = new WorkspaceSession(dialogs);
        await session.dispatch({ type: 'open' });
        const target: DocumentFieldReviewTarget = { documentId: document.id, sectionId: section.sectionId, fieldId: merchant.id };
        const revision: number = session.state().workspace!.matchRevision;
        await session.dispatch({ type: 'set-document-field-confirmed', revision, ...target, confirmed: true });
        assert.equal(session.state().error, null);
        assert.equal(session.state().workspace!.dirty, true);
        assert.equal(session.state().workspace!.matchReviewCounts.assigned, 0);
        assert.equal(session.state().workspace!.approvedDocumentCount, 0);
        assert.equal(isDocumentFieldConfirmed(effective(session), target, session.state().workspace!.documentFieldReviews!), true);
        assert.equal(effective(session).issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.code === 'unconfirmed-merchant'), false);
        await session.dispatch({ type: 'set-document-field-confirmed', revision, ...target, confirmed: false });
        assert.match(session.state().error!, /changed/);
        await session.dispatch({ type: 'save' });
        const restored: WorkspaceSession = new WorkspaceSession(dialogs);
        await restored.dispatch({ type: 'open' });
        assert.equal(isDocumentFieldConfirmed(effective(restored), target, restored.state().workspace!.documentFieldReviews!), true);
        assert.deepEqual((await loadWorkspace(file)).documentImports[0].files[0], { status: 'imported', record: { ...document, result: original } });
        await restored.dispatch({ type: 'set-document-field-confirmed', revision: restored.state().workspace!.matchRevision, ...target, confirmed: false });
        assert.equal(restored.state().error, null);
        assert.equal(effective(restored).issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.code === 'unconfirmed-merchant'), true);
        assert.equal(restored.state().workspace!.documentFieldReviews![0].revision, 3);
        await restored.dispatch({ type: 'save' });
        const withdrawn: SavedWorkspace = await loadWorkspace(file);
        assert.equal(withdrawn.documentFieldReviews.get(documentFieldReviewKey(target))!.confirmed, false);
        assert.equal(documentRevisionIndex(withdrawn.documentCorrections.values(), withdrawn.documentFieldReviews.values()).get(document.id), 3);
        await restored.dispatch({ type: 'new' });
        assert.deepEqual(restored.state().workspace!.documentFieldReviews, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('correcting a field away and back never reactivates a previous confirmation', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-field-corrections-'));
    try {
        const file: string = path.join(root, 'reviews.receiptmatch');
        const document: StoredSupportingDocument = retainedDocument(root);
        const section: DocumentSection = document.result.sections[0];
        const total: DocumentSection['amounts'][number] = section.amounts[0];
        await createWorkspace(file, newMetadata(), [], [documentRun(root, [document])]);
        const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<'discard'> => Promise.resolve('discard') });
        await session.dispatch({ type: 'open' });
        const target: DocumentFieldReviewTarget = { documentId: document.id, sectionId: section.sectionId, fieldId: total.id };
        await session.dispatch({ type: 'set-document-field-confirmed', revision: session.state().workspace!.matchRevision, ...target, confirmed: true });
        for (const coefficient of ['12000', total.candidates[0].coefficient]) {
            await session.dispatch({ type: 'correct-document-field', revision: session.state().workspace!.matchRevision, ...target, change: { kind: 'amount', value: { coefficient, currency: 'EUR', scale: 2 } } });
            assert.equal(session.state().error, null);
        }
        assert.equal(isDocumentFieldConfirmed(effective(session), target, session.state().workspace!.documentFieldReviews!), false);
        await session.dispatch({ type: 'save' });
        assert.equal(session.state().error, null);
        assert.equal((await loadWorkspace(file)).documentFieldReviews.get(documentFieldReviewKey(target))!.confirmed, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('version 13 opens unchanged and gains field reviews only on explicit save', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-field-migration-'));
    try {
        const file: string = path.join(root, 'old.receiptmatch');
        await createWorkspace(file, newMetadata());
        const db: Database.Database = new Database(file);
        db.exec('DROP TABLE document_field_reviews; PRAGMA user_version=13;');
        db.close();
        const previous: SavedWorkspace = await loadWorkspace(file);
        assert.equal(previous.schemaVersion, 13);
        assert.equal(previous.documentFieldReviews.size, 0);
        const saved: SavedWorkspace = await saveWorkspace(previous, previous.metadata);
        assert.equal(saved.schemaVersion, 14);
        assert.equal((await loadWorkspace(file)).documentFieldReviews.size, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
