import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { applyDocumentFieldCorrections, documentCorrectionKey, documentCorrectionSchema, documentCorrectionValueSchema, missingDocumentCorrectionFields, type DocumentCorrection, type DocumentCorrectionValue } from '../../src/shared/document-corrections.js';
import { supportingDocumentSchema, type DocumentIssue, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';
import { storedSupportingDocumentSchema, type StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { commandSchema, type IWorkspaceView } from '../../src/shared/protocol.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';
import type { TransactionCandidate } from '../../src/shared/bank-import.js';
import { createWorkspace, loadWorkspace, newMetadata, type ISavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { referenceEvidence } from '../../electron/matching.js';
import { hasFullDocumentReference } from '../../electron/documents/interpret.js';
import { receiptAnalysisVersionSchema } from '../../electron/documents/analysis-history.js';
import { prepareReceiptAnalysisVersion, type IReceiptVersionPlan } from '../../electron/documents/prepare-analysis-version.js';
import { SupportingDocumentState } from '../../electron/documents/document-state.js';
import { documentFieldConfirmationIssue, documentFieldSignature, isDocumentFieldConfirmed, type DocumentFieldReview } from '../../src/shared/document-field-reviews.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

function correction(document: StoredSupportingDocument, fieldId: string | null, change: DocumentCorrectionValue, revision: number = 2): DocumentCorrection {
    return documentCorrectionSchema.parse({ documentId: document.id, sectionId: document.result.sections[0].sectionId, fieldId, revision, change });
}

function declaredCurrency(section: DocumentSection): DocumentSection['currencies'][number] {
    const existing: DocumentSection['currencies'][number] | undefined = section.currencies.find((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement');
    if (existing) {
        return existing;
    }
    const field: DocumentSection['currencies'][number] = { id: 'settlement-currency', role: 'settlement', label: 'Currency', candidates: ['EUR'], evidence: section.evidence };
    section.currencies.push(field);
    return field;
}

test('keeps legacy correction keys and records while validating new text values and distinct missing slots', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const target: DocumentCorrection = correction(document, null, { kind: 'amount', value: { coefficient: '1234', scale: 2, currency: 'EUR' } });
    assert.equal(documentCorrectionKey(target, 'amount'), JSON.stringify([target.documentId, target.sectionId, null, 'amount']));
    assert.deepEqual(documentCorrectionSchema.parse(target), target);
    assert.deepEqual(documentCorrectionValueSchema.parse({ kind: 'merchant', value: '  Cedar Workshop  ' }), { kind: 'merchant', value: 'Cedar Workshop' });
    assert.equal(documentCorrectionValueSchema.safeParse({ kind: 'reference', role: 'invoice', value: '  ' }).success, false);
    assert.equal(documentCorrectionValueSchema.safeParse({ kind: 'merchant', value: 'x'.repeat(16385) }).success, false);
    assert.equal(documentCorrectionValueSchema.safeParse({ kind: 'currency', role: 'settlement', value: 'usd' }).success, false);
    assert.notEqual(documentCorrectionKey(target, 'reference', 'invoice'), documentCorrectionKey(target, 'reference', 'receipt'));
    assert.equal(documentCorrectionKey({ ...target, fieldId: 'field' }, 'reference', 'invoice'), JSON.stringify([target.documentId, target.sectionId, 'field', null]));
});

test('manual text corrections preserve printed evidence, establish reference trust and cannot enter source manifests or AI history', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const section: DocumentSection = document.result.sections[0];
    const currency: DocumentSection['currencies'][number] = declaredCurrency(section);
    const original: SupportingDocument = structuredClone(document.result);
    const corrected: SupportingDocument = applyDocumentFieldCorrections(document.result, [
        correction(document, section.merchants[0].id, { kind: 'merchant', value: 'Corrected Workshop' }),
        correction(document, section.references[0].id, { kind: 'reference', role: section.references[0].role, value: 'CORRECTED-2047' }, 3),
        correction(document, currency.id, { kind: 'currency', role: currency.role, value: 'USD' }, 4)
    ]);
    const current: DocumentSection = corrected.sections[0];
    assert.deepEqual(current.merchants[0].candidates, ['Corrected Workshop']);
    assert.deepEqual(current.references[0].evidence, section.references[0].evidence);
    assert.equal(current.references[0].label, section.references[0].label);
    assert.equal(current.references[0].correctedByUser, true);
    assert.equal(hasFullDocumentReference(current.references[0], 'CORRECTED-2047'), true);
    assert.equal(hasFullDocumentReference(current.references[0], 'ANOTHER-REFERENCE'), false);
    const bank: TransactionCandidate = retainedBank(path.resolve('fixtures')).result.transactions[0];
    bank.references = [{ label: 'Reference', value: 'CORRECTED-2047', evidence: [] }];
    assert.equal(referenceEvidence(bank, current).matches.length, 1);
    assert.equal(supportingDocumentSchema.safeParse(corrected).success, true);
    assert.equal(storedSupportingDocumentSchema.safeParse({ ...document, result: corrected }).success, false);
    assert.equal(receiptAnalysisVersionSchema.safeParse({ documentId: document.id, acceptedAt: '2032-06-01T12:00:00Z', analysis: corrected }).success, false);
    assert.deepEqual(document.result, original);
});

test('supplies only genuinely missing merchant, primary reference and settlement currency and fills originally unknown money', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const section: DocumentSection = document.result.sections[0];
    section.merchants = []; section.references = []; section.currencies = [];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    total.candidates[0].currency = null;
    document.result.status = 'partial';
    document.result.issues = [
        { code: 'missing-field', severity: 'warning', message: 'Missing merchant.', sectionId: section.sectionId, fieldId: null, field: 'merchant', evidence: [] },
        { code: 'missing-field', severity: 'warning', message: 'Missing reference.', sectionId: section.sectionId, fieldId: null, field: 'document-reference', evidence: [] },
        { code: 'missing-currency', severity: 'warning', message: 'Missing currency.', sectionId: section.sectionId, fieldId: total.id, field: total.role, evidence: total.evidence }
    ];
    assert.deepEqual(missingDocumentCorrectionFields(section).map((slot: ReturnType<typeof missingDocumentCorrectionFields>[number]): string => slot.kind), ['merchant', 'reference', 'currency']);
    const before: SupportingDocument = structuredClone(document.result);
    const edits: DocumentCorrection[] = [correction(document, null, { kind: 'merchant', value: 'Added Workshop' }), correction(document, null, { kind: 'reference', role: 'invoice', value: 'ADDED-2047' }, 3), correction(document, null, { kind: 'currency', role: 'settlement', value: 'USD' }, 4)];
    const current: SupportingDocument = applyDocumentFieldCorrections(document.result, edits);
    assert.deepEqual(current.sections[0].amounts[0].candidates, [{ ...total.candidates[0], currency: 'USD' }]);
    assert.deepEqual(current.sections[0].references[0].evidence, []);
    assert.deepEqual(current.issues, []);
    assert.equal(supportingDocumentSchema.safeParse(current).success, true);
    assert.deepEqual(document.result, before);
    assert.throws((): SupportingDocument => applyDocumentFieldCorrections(document.result, [correction(document, null, { kind: 'reference', role: 'payment', value: 'WRONG-SLOT' })]), /no matching missing/);
    assert.throws((): SupportingDocument => applyDocumentFieldCorrections(document.result, [correction(document, null, { kind: 'currency', role: 'informational-fx', value: 'USD' })]), /no matching missing/);
});

test('replacing an AI-adopted reference withdraws its previous provenance and permits a fresh field confirmation', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const section: DocumentSection = document.result.sections[0];
    const reference: DocumentSection['references'][number] = { ...section.references[0], candidates: ['OLD-123'], evidence: [], confirmedByUser: true };
    section.references[0] = reference;
    const current: SupportingDocument = applyDocumentFieldCorrections(document.result, [correction(document, reference.id, { kind: 'reference', role: reference.role, value: 'NEW-456' })]);
    assert.equal(current.sections[0].references[0].confirmedByUser, undefined);
    assert.equal(current.sections[0].references[0].correctedByUser, true);
    assert.equal(reference.confirmedByUser, true);
    assert.deepEqual(reference.candidates, ['OLD-123']);
    assert.equal(documentFieldConfirmationIssue(current, section.sectionId, reference.id), null);
    const review: DocumentFieldReview = { documentId: document.id, sectionId: section.sectionId, fieldId: reference.id, confirmed: true, revision: 3, signature: documentFieldSignature(current, section.sectionId, reference.id)! };
    assert.equal(isDocumentFieldConfirmed(current, review, [review]), true);
});

test('settlement changes preserve explicit original currencies, respect money edits regardless of order and retain contradictions', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const section: DocumentSection = document.result.sections[0];
    const currency: DocumentSection['currencies'][number] = declaredCurrency(section);
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    const declaration: DocumentCorrection = correction(document, currency.id, { kind: 'currency', role: currency.role, value: 'USD' });
    const conflict: SupportingDocument = applyDocumentFieldCorrections(document.result, [declaration]);
    assert.equal(conflict.sections[0].amounts[0].candidates[0].currency, 'EUR');
    assert.ok(conflict.issues.some((issue: DocumentIssue): boolean => issue.code === 'conflicting-field' && issue.fieldId === total.id));
    assert.ok(conflict.issues.some((issue: DocumentIssue): boolean => issue.code === 'conflicting-field' && issue.fieldId === currency.id));
    total.candidates[0].currency = null;
    const amount: DocumentCorrection = correction(document, total.id, { kind: 'amount', value: { ...total.candidates[0], currency: 'GBP' } }, 3);
    const first: SupportingDocument = applyDocumentFieldCorrections(document.result, [declaration, amount]);
    const second: SupportingDocument = applyDocumentFieldCorrections(document.result, [amount, declaration]);
    assert.deepEqual(first, second);
    assert.equal(first.sections[0].amounts[0].candidates[0].currency, 'GBP');
    assert.throws((): SupportingDocument => applyDocumentFieldCorrections(document.result, [correction(document, section.references[0].id, { kind: 'reference', role: 'order', value: 'WRONG-ROLE' })]), /different role/);
    assert.throws((): SupportingDocument => applyDocumentFieldCorrections(document.result, [correction(document, total.id, { kind: 'merchant', value: 'WRONG-KIND' })]), /not available/);
});

test('new field edits survive save and reopen, reject stale input and make existing transaction approvals stale', async (context: TestContext): Promise<void> => {
    const temporary: string = await realpath(tmpdir());
    const root: string = await mkdtemp(path.join(temporary, 'receiptmatch-text-corrections-'));
    context.onTestFinished(async (): Promise<void> => {
        assert.equal(path.dirname(await realpath(root)), temporary);
        await rm(root, { recursive: true, force: true });
    });
    const file: string = path.join(root, 'corrections.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    const bank: StoredBankImport = retainedBank(root);
    const transactionId: string = bank.transactions[0].transactionId;
    const approval: ReviewApprovalState = { associationRevision: 1, approval: { ...approvalSelectionFor(transactionId, document.id), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z' } };
    await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [document])], new Map([[transactionId, document.id]]), new Map(), new Map(), new Map([[transactionId, approval]]));
    const session: WorkspaceSession = new WorkspaceSession({ open: (): Promise<string> => Promise.resolve(file), save: (): Promise<string> => Promise.resolve(file), unsaved: (): Promise<'discard'> => Promise.resolve('discard') });
    await session.dispatch({ type: 'open' });
    const before: IWorkspaceView = session.state().workspace!;
    const merchant: DocumentSection['merchants'][number] = document.result.sections[0].merchants[0];
    const edit: DocumentCorrection = correction(document, merchant.id, { kind: 'merchant', value: 'Edited Workshop' });
    assert.equal((await session.dispatch(commandSchema.parse({ ...edit, type: 'correct-document-field', revision: before.matchRevision }))).error, null);
    assert.equal(session.matchSummaries(session.state().workspace!.matchRevision)?.find((row: NonNullable<ReturnType<typeof session.matchSummaries>>[number]): boolean => row.transactionId === transactionId)?.approvalStatus.status, 'stale');
    assert.match((await session.dispatch({ ...edit, type: 'correct-document-field', revision: before.matchRevision })).error!, /changed/);
    assert.equal((await session.dispatch({ type: 'save' })).error, null);
    const saved: ISavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(saved.documentImports[0].files[0], { status: 'imported', record: document });
    assert.equal(saved.documentCorrections.get(documentCorrectionKey(edit, edit.change.kind))!.change.value, 'Edited Workshop');
    assert.equal((await session.dispatch({ type: 'open' })).error, null);
    assert.equal(session.state().workspace!.documentCorrections[0].change.kind, 'merchant');
});

test('new AI analyses retain matching manual text fields while blocking replacement of a supplied missing slot', (): void => {
    const document: StoredSupportingDocument = retainedDocument(path.resolve('fixtures'));
    const section: DocumentSection = document.result.sections[0];
    const currency: DocumentSection['currencies'][number] = declaredCurrency(section);
    const edits: DocumentCorrection[] = [correction(document, section.merchants[0].id, { kind: 'merchant', value: 'Edited Workshop' }), correction(document, section.references[0].id, { kind: 'reference', role: section.references[0].role, value: 'EDITED-REF' }, 3), correction(document, currency.id, { kind: 'currency', role: currency.role, value: 'USD' }, 4)];
    const proposed: SupportingDocument = structuredClone(document.result);
    proposed.input!.extraction.runId = randomUUID();
    proposed.sections[0].currencies.find((field: DocumentSection['currencies'][number]): boolean => field.id === currency.id)!.candidates = ['JPY'];
    const plan: IReceiptVersionPlan = prepareReceiptAnalysisVersion(document, proposed, edits);
    assert.equal(plan.blockingConflict, undefined);
    const effective: SupportingDocument = new SupportingDocumentState(plan.analysis, edits).effective;
    assert.deepEqual(effective.sections[0].merchants[0].candidates, ['Edited Workshop']);
    assert.deepEqual(effective.sections[0].references[0].candidates, ['EDITED-REF']);
    assert.deepEqual(effective.sections[0].currencies.find((field: DocumentSection['currencies'][number]): boolean => field.id === currency.id)!.candidates, ['USD']);
    section.references = [];
    document.result.status = 'partial';
    document.result.issues.push({ code: 'missing-field', severity: 'warning', message: 'Missing reference.', sectionId: section.sectionId, fieldId: null, field: 'document-reference', evidence: [] });
    const supplied: DocumentCorrection = correction(document, null, { kind: 'reference', role: 'invoice', value: 'MANUAL-REF' });
    assert.ok(prepareReceiptAnalysisVersion(document, proposed, [supplied]).blockingConflict);
});
