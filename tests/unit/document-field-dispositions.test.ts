import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestContext } from 'vitest';
import { receiptAnalysisVersionSchema } from '../../electron/documents/analysis-history.js';
import { WorkspaceDocumentState } from '../../electron/documents/document-state.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { suggestWorkspaceMatches } from '../../electron/matching.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';
import { documentCorrectionKey, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import { activeDocumentFieldDisposition, documentFieldConfirmationIssue, documentFieldReviewKey, documentFieldReviewSchema, documentFieldSignature,
    isDocumentFieldConfirmed, type DocumentFieldDisposition, type DocumentFieldReview, type DocumentFieldReviewTarget } from '../../src/shared/document-field-reviews.js';
import { approvalSelectionFor, documentRevisionIndex, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { randomUUID } from 'node:crypto';
import type { IDocumentSnapshot } from '../../src/shared/protocol.js';
import { supportingDocumentSchema, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';
import { storedDocumentImportSchema, type StoredDocumentImport, type StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import type { TransactionMatch } from '../../src/shared/workspace-matching.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

function decision(document: StoredSupportingDocument, fieldId: string, disposition: DocumentFieldDisposition = 'rejected'): DocumentFieldReview {
    const sectionId: string = document.result.sections[0].sectionId;
    const base: SupportingDocument = imported(projected(document, []).reviewBase);
    return { documentId: document.id, sectionId, fieldId, confirmed: false, disposition, revision: 2, signature: documentFieldSignature(base, sectionId, fieldId)! };
}

function projected(document: StoredSupportingDocument, reviews: DocumentFieldReview[], corrections: DocumentCorrection[] = []): WorkspaceDocumentState {
    return new WorkspaceDocumentState([documentRun(path.resolve('.'), [document])],
        new Map(corrections.map((edit: DocumentCorrection): [string, DocumentCorrection] => [documentCorrectionKey(edit, edit.change.kind), edit])), [],
        new Map(reviews.map((review: DocumentFieldReview): [string, DocumentFieldReview] => [documentFieldReviewKey(review), review])));
}

function imported(reports: StoredDocumentImport[]): SupportingDocument {
    const file: StoredDocumentImport['files'][number] = reports[0].files[0];
    assert.equal(file.status, 'imported');
    return file.record.result;
}

function snapshot(session: WorkspaceSession): IDocumentSnapshot {
    const workspace: NonNullable<ReturnType<WorkspaceSession['state']>['workspace']> = session.state().workspace!;
    return session.documentSnapshot({ revision: workspace.matchRevision, loadRevision: workspace.loadRevision })!;
}

async function temporary(context: TestContext): Promise<string> {
    const parent: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(parent, 'receiptmatch-dispositions-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), parent);
        await rm(root, { recursive: true, force: true });
    });
    return root;
}

function dialogs(file: string): WorkspaceDialogs {
    return { open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<'discard'> => Promise.resolve('discard') };
}

async function setDisposition(session: WorkspaceSession, target: DocumentFieldReviewTarget, disposition: DocumentFieldDisposition | null): Promise<void> {
    await session.dispatch({ type: 'set-document-field-disposition', revision: session.state().workspace!.matchRevision, ...target, disposition });
    assert.equal(session.state().error, null);
}

test('exclusion retains fields and evidence, binds to the pre-review value and never enters source manifests or AI analyses', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const original: SupportingDocument = structuredClone(document.result);
    const reference: DocumentSection['references'][number] = document.result.sections[0].references[0];
    const review: DocumentFieldReview = decision(document, reference.id);
    const view: WorkspaceDocumentState = projected(document, [review]);
    const effective: SupportingDocument = imported(view.effective);
    assert.deepEqual(effective.sections[0].references[0], { ...reference, candidates: [] });
    assert.equal(activeDocumentFieldDisposition(imported(view.reviewBase), review, [review]), 'rejected');
    assert.equal(activeDocumentFieldDisposition(effective, review, [review]), null);
    assert.equal(effective.issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.code === 'rejected-field' && issue.fieldId === reference.id), true);
    assert.equal(supportingDocumentSchema.safeParse(effective).success, true);
    assert.deepEqual(document.result, original);
    assert.deepEqual(imported(view.analyzed), original);
    assert.equal(storedDocumentImportSchema.safeParse({ ...view.effective[0] }).success, false);
    assert.equal(receiptAnalysisVersionSchema.safeParse({ documentId: document.id, acceptedAt: '2032-05-20T12:00:00Z', analysis: effective }).success, false);
    const changed: SupportingDocument = structuredClone(original);
    changed.sections[0].references[0].candidates = ['DIFFERENT'];
    assert.equal(activeDocumentFieldDisposition(changed, review, [review]), null);
    const legacy: DocumentFieldReview = { ...review, disposition: undefined };
    assert.equal(documentFieldReviewSchema.safeParse(legacy).success, true);
    assert.equal(documentFieldReviewSchema.safeParse({ ...review, confirmed: true }).success, false);
});

test('excluded AI-adopted fields without source evidence remain valid effective unresolved fields', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const reference: DocumentSection['references'][number] = document.result.sections[0].references[0];
    reference.confirmedByUser = true;
    reference.evidence = [];
    const review: DocumentFieldReview = decision(document, reference.id, 'unavailable');
    const effective: SupportingDocument = imported(projected(document, [review]).effective);
    assert.equal(effective.sections[0].references[0].confirmedByUser, undefined);
    assert.deepEqual(effective.sections[0].references[0].candidates, []);
    assert.equal(supportingDocumentSchema.safeParse(effective).success, true);
    assert.equal(reference.confirmedByUser, true);
});

test('excluding settlement currency clears derived money currencies while retaining explicit and manually corrected amounts', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const input: NonNullable<SupportingDocument['input']> = structuredClone(document.result.input!);
    input.pages[0].spans[4].text = 'Invoice Total: 1234.56';
    input.pages[0].spans.push({ ...input.pages[0].spans[4], text: 'Currency: EUR', region: { ...input.pages[0].spans[4].region, y: 190 } });
    document.result = interpretSupportingDocument(input);
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts.find((field: DocumentSection['amounts'][number]): boolean => field.role === 'billed-total')!;
    assert.equal(total.candidates[0].currency, 'EUR');
    const review: DocumentFieldReview = decision(document, section.currencies[0].id, 'unavailable');
    const effective: SupportingDocument = imported(projected(document, [review]).effective);
    assert.equal(effective.sections[0].amounts[0].candidates[0].currency, null);
    assert.equal(effective.issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.code === 'missing-currency' && issue.fieldId === total.id), true);
    assert.equal(supportingDocumentSchema.safeParse(effective).success, true);
    const correction: DocumentCorrection = { documentId: document.id, sectionId: section.sectionId, fieldId: total.id, revision: 3,
        change: { kind: 'amount', value: { coefficient: '123456', scale: 2, currency: 'EUR' } } };
    assert.equal(imported(projected(document, [review], [correction]).effective).sections[0].amounts[0].candidates[0].currency, 'EUR');
    total.evidence[0].rawText = 'Invoice Total: EUR 1234.56';
    // Retained source evidence must match the immutable page text.
    document.result.input!.pages[0].spans[4].text = total.evidence[0].rawText;
    const explicitReview: DocumentFieldReview = decision(document, section.currencies[0].id);
    assert.equal(imported(projected(document, [explicitReview]).effective).sections[0].amounts[0].candidates[0].currency, 'EUR');
});

test('excluding a false scalar duplicate recomputes warning conflicts while retaining errors and unrelated interpretation warnings', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    const duplicate: DocumentSection['amounts'][number] = { ...total, id: 'false-total', candidates: [{ coefficient: '5000', scale: 2, currency: 'EUR' }] };
    section.amounts.push(duplicate);
    for (const field of [total, duplicate]) {
        document.result.issues.push({ code: 'conflicting-field', severity: 'warning', message: 'Conflicting totals.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
    }
    document.result.status = 'partial';
    const review: DocumentFieldReview = decision(document, duplicate.id);
    let effective: SupportingDocument = imported(projected(document, [review]).effective);
    assert.equal(effective.issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.code === 'conflicting-field'), false);
    assert.equal(documentFieldConfirmationIssue(effective, section.sectionId, total.id), null);
    const confirmation: DocumentFieldReview = { ...decision(document, total.id), disposition: undefined, confirmed: true, revision: 3 };
    effective = imported(projected(document, [review, confirmation]).effective);
    assert.equal(isDocumentFieldConfirmed(document.result, confirmation, [confirmation], effective), true);
    document.result.issues[0].severity = 'error';
    effective = imported(projected(document, [review]).effective);
    assert.equal(effective.issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.severity === 'error'), true);
});

test('required-field decisions persist and reset, invalidate approvals, reject stale commands and expose original and review bases', async (context: TestContext): Promise<void> => {
    const root: string = await temporary(context);
    const file: string = path.join(root, 'workspace.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    const bank: StoredBankImport = retainedBank(root);
    const transactionId: string = bank.transactions[0].transactionId;
    const approval: ReviewApprovalState = { associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, document.id), batchId: randomUUID(), approvedAt: '2032-05-20T12:00:00Z' } };
    await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [document])], new Map([[transactionId, document.id]]), new Map(), new Map(), new Map([[transactionId, approval]]));
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await session.dispatch({ type: 'open' });
    assert.equal(session.state().workspace!.approvedDocumentCount, 1);
    const target: DocumentFieldReviewTarget = { documentId: document.id, sectionId: section.sectionId, fieldId: total.id };
    const previousRevision: number = session.state().workspace!.matchRevision;
    await setDisposition(session, target, 'unavailable');
    const current: IDocumentSnapshot = snapshot(session);
    assert.deepEqual(imported(current.reports).sections[0].amounts[0].candidates, []);
    assert.deepEqual(current.originals[document.id].sections, document.result.sections);
    assert.deepEqual(current.reviewBases![document.id].sections, document.result.sections);
    assert.equal(session.state().workspace!.approvedDocumentCount, 0);
    await session.dispatch({ type: 'set-document-field-disposition', revision: previousRevision, ...target, disposition: null });
    assert.match(session.state().error!, /changed/);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
    const reopened: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await reopened.dispatch({ type: 'open' });
    assert.equal(activeDocumentFieldDisposition(document.result, target, reopened.state().workspace!.documentFieldReviews!), 'unavailable');
    await setDisposition(reopened, target, null);
    assert.deepEqual(imported(snapshot(reopened).reports).sections, document.result.sections);
    await reopened.dispatch({ type: 'save' });
    const saved: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(imported(saved.documentImports), document.result, 'original analysis remains unchanged');
    assert.equal(saved.documentFieldReviews.get(documentFieldReviewKey(target))!.disposition, undefined);
    assert.equal(documentRevisionIndex(saved.documentCorrections.values(), saved.documentFieldReviews.values()).get(document.id), 3);
});

test('corrections and dependent field decisions tombstone reviews without reactivation', async (context: TestContext): Promise<void> => {
    const root: string = await temporary(context);
    const document: StoredSupportingDocument = retainedDocument(root);
    const file: string = path.join(root, 'workspace.receiptmatch');
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    section.amounts.push({ ...total, id: 'false-total', candidates: [{ coefficient: '5000', scale: 2, currency: 'EUR' }] });
    document.result.status = 'partial';
    for (const field of section.amounts) {
        document.result.issues.push({ code: 'conflicting-field', severity: 'warning', message: 'Conflicting totals.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
    }
    await createWorkspace(file, newMetadata(), [], [documentRun(root, [document])]);
    const session: WorkspaceSession = new WorkspaceSession(dialogs(file));
    await session.dispatch({ type: 'open' });
    const target: DocumentFieldReviewTarget = { documentId: document.id, sectionId: section.sectionId, fieldId: 'false-total' };
    const confirmedTarget: DocumentFieldReviewTarget = { ...target, fieldId: total.id };
    await setDisposition(session, target, 'rejected');
    await session.dispatch({ type: 'set-document-field-confirmed', revision: session.state().workspace!.matchRevision, ...confirmedTarget, confirmed: true });
    assert.equal(session.state().error, null);
    assert.equal(isDocumentFieldConfirmed(document.result, confirmedTarget, session.state().workspace!.documentFieldReviews!, imported(snapshot(session).reports)), true);
    await setDisposition(session, target, null);
    await setDisposition(session, target, 'rejected');
    assert.equal(session.state().workspace!.documentFieldReviews!.find((review: DocumentFieldReview): boolean => review.fieldId === total.id)!.confirmed, false);
    await session.dispatch({ type: 'correct-document-field', revision: session.state().workspace!.matchRevision, ...confirmedTarget,
        change: { kind: 'amount', value: { coefficient: '123456', currency: 'EUR', scale: 2 } } });
    assert.equal(session.state().error, null);
    assert.equal(session.state().workspace!.documentFieldReviews!.find((review: DocumentFieldReview): boolean => review.fieldId === 'false-total')!.disposition, undefined);
    await session.dispatch({ type: 'save' });
    assert.equal(session.state().error, null);
});

test('excluded required totals and declarations cannot create reliable matches', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const input: NonNullable<SupportingDocument['input']> = structuredClone(document.result.input!);
    input.pages[0].spans.push({ ...input.pages[0].spans[4], text: 'Currency: EUR', region: { ...input.pages[0].spans[4].region, y: 190 } });
    document.result = interpretSupportingDocument(input);
    const section: DocumentSection = document.result.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    total.candidates = [{ coefficient: '123456', scale: 2, currency: 'EUR' }];
    section.references[0].candidates = ['SYNTHETIC-A'];
    section.references[0].evidence[0].rawText = 'Invoice Number: SYNTHETIC-A';
    document.result.input!.pages[0].spans[2].text = 'Invoice Number: SYNTHETIC-A';
    section.dates[0].candidates = ['2032-02-28'];
    const bank: StoredBankImport = retainedBank(path.resolve('.'));
    const match: (reports: StoredDocumentImport[]) => TransactionMatch = (reports: StoredDocumentImport[]): TransactionMatch => suggestWorkspaceMatches([bank], reports)
        .find((item: TransactionMatch): boolean => item.transactionId === bank.transactions[0].transactionId)!;
    assert.equal(match([documentRun(path.resolve('.'), [document])]).status, 'reliable');
    for (const field of [total, section.currencies[0]]) {
        const review: DocumentFieldReview = decision(document, field.id);
        const view: WorkspaceDocumentState = projected(document, [review]);
        assert.notEqual(match(view.effective).status, 'reliable');
    }
    const duplicate: DocumentSection['amounts'][number] = { ...total, id: 'false-total', candidates: [{ coefficient: '5000', scale: 2, currency: 'EUR' }] };
    section.amounts.push(duplicate);
    for (const field of [total, duplicate]) {
        document.result.issues.push({ code: 'conflicting-field', severity: 'warning', message: 'Conflicting totals.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
    }
    document.result.status = 'partial';
    assert.equal(match(projected(document, [decision(document, duplicate.id)]).effective).status, 'reliable');
    assert.equal(match(projected(document, [decision(document, duplicate.id, 'unavailable')]).effective).status, 'uncertain');
});

test('version 15 opens without mutation and upgrades on explicit save', async (context: TestContext): Promise<void> => {
    const root: string = await temporary(context);
    const file: string = path.join(root, 'old.receiptmatch');
    await createWorkspace(file, newMetadata());
    const db: Database.Database = new Database(file);
    db.exec('DROP TABLE statement_analysis_versions;');
    db.pragma('user_version=15');
    db.close();
    const bytes: NonSharedBuffer = await readFile(file);
    const old: SavedWorkspace = await loadWorkspace(file);
    assert.equal(old.schemaVersion, 15);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await saveWorkspace(old, old.metadata)).schemaVersion, SCHEMA_VERSION);
});

test('unavailable duplicate merchants and primary references remain uncertain while rejected duplicates have usable replacements', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const section: DocumentSection = document.result.sections[0];
    section.amounts[0].candidates = [{ coefficient: '123456', scale: 2, currency: 'EUR' }];
    const reference: DocumentSection['references'][number] = section.references[0];
    reference.candidates = ['SYNTHETIC-A'];
    reference.evidence[0].rawText = 'Invoice Number: SYNTHETIC-A';
    document.result.input!.pages[0].spans[2].text = reference.evidence[0].rawText;
    const merchant: DocumentSection['merchants'][number] = { ...section.merchants[0], id: 'duplicate-merchant' };
    const duplicateReference: DocumentSection['references'][number] = { ...reference, id: 'duplicate-reference' };
    section.merchants.push(merchant);
    section.references.push(duplicateReference);
    const bank: StoredBankImport = retainedBank(path.resolve('.'));
    const match: (reports: StoredDocumentImport[]) => TransactionMatch = (reports: StoredDocumentImport[]): TransactionMatch => suggestWorkspaceMatches([bank], reports)
        .find((item: TransactionMatch): boolean => item.transactionId === bank.transactions[0].transactionId)!;
    assert.equal(match([documentRun(path.resolve('.'), [document])]).status, 'reliable');
    for (const field of [merchant, duplicateReference]) {
        assert.equal(match(projected(document, [decision(document, field.id, 'unavailable')]).effective).status, 'uncertain');
        assert.equal(match(projected(document, [decision(document, field.id, 'rejected')]).effective).status, 'reliable');
    }
    document.result.issues.push({ code: 'source-problem', severity: 'error', message: 'Original field error remains.', sectionId: section.sectionId,
        fieldId: merchant.id, field: merchant.role, evidence: merchant.evidence });
    document.result.status = 'partial';
    assert.equal(match(projected(document, [decision(document, merchant.id, 'rejected')]).effective).status, 'uncertain');
});

test('rejecting the last invoice reference remains uncertain even when another reference role matches', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('.'));
    const section: DocumentSection = document.result.sections[0];
    section.amounts[0].candidates = [{ coefficient: '123456', scale: 2, currency: 'EUR' }];
    const reference: DocumentSection['references'][number] = section.references[0];
    section.references.push({ ...reference, id: 'payment-reference', role: 'payment', label: 'Payment reference', candidates: ['SYNTHETIC-A'],
        confirmedByUser: true, evidence: [] });
    const bank: StoredBankImport = retainedBank(path.resolve('.'));
    const match: TransactionMatch = suggestWorkspaceMatches([bank], projected(document, [decision(document, reference.id, 'rejected')]).effective)
        .find((item: TransactionMatch): boolean => item.transactionId === bank.transactions[0].transactionId)!;
    assert.equal(match.status, 'uncertain');
    assert.equal(match.candidates[0].references[0].documentFieldId, 'payment-reference');
});
