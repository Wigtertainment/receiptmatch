import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DocumentCorrection } from '../../src/shared/document-corrections.js';
import { LOCAL_OCR_VERSIONS } from '../../src/shared/pdf-extraction.js';
import { supportingDocumentSchema, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { SupportingDocumentState } from '../../electron/documents/document-state.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { prepareReceiptAnalysisVersion, type ReceiptVersionPlan } from '../../electron/documents/prepare-analysis-version.js';
import { extractedDocument, retainedDocument } from './document-fixtures.js';

function modelProposal(previous: StoredSupportingDocument, total: string = 'EUR 9007199254740993.27', omitDate: boolean = false): SupportingDocument {
    const extracted: ReturnType<typeof extractedDocument> = extractedDocument(Buffer.from('synthetic.pdf'), previous.result.input!.source.sourceId);
    extracted.input.extraction.version = LOCAL_OCR_VERSIONS['paddleocr-vl-1.6'];
    const page: typeof extracted.input.pages[number] = extracted.input.pages[0];
    if (omitDate) {
        page.spans = page.spans.filter((span: typeof page.spans[number]): boolean => !span.text.startsWith('Invoice Date'));
    }
    for (const span of page.spans) {
        span.method = 'local-ocr';
        span.region.x += 1;
        span.text = span.text.replace('EUR 9007199254740993.27', total);
    }
    return interpretSupportingDocument(extracted.input);
}

function billedTotal(result: SupportingDocument): DocumentSection['amounts'][number] {
    const field: DocumentSection['amounts'][number] | undefined = result.sections[0].amounts.find((item: DocumentSection['amounts'][number]): boolean => item.role === 'billed-total');
    assert.ok(field);
    return field;
}

function amountCorrection(document: StoredSupportingDocument): DocumentCorrection {
    return { documentId: document.id, sectionId: document.result.sections[0].sectionId, fieldId: billedTotal(document.result).id, revision: 2,
        change: { kind: 'amount', value: { coefficient: '900719925474099312', scale: 2, currency: 'EUR' } } };
}

test('preserves a manual total at a newly keyed, uniquely paired field and keeps proposed source values', (): void => {
    const previous: StoredSupportingDocument = retainedDocument('fixtures');
    const correction: DocumentCorrection = amountCorrection(previous);
    const proposed: SupportingDocument = modelProposal(previous, 'EUR 48.75');
    const currentSectionId: string = proposed.sections[0].sectionId;
    const currentFieldId: string = billedTotal(proposed).id;
    proposed.sections[0].sectionId = 'model-section';
    billedTotal(proposed).id = 'model-amount';
    for (const issue of proposed.issues) {
        if (issue.sectionId === currentSectionId) {
            issue.sectionId = 'model-section';
        }
        if (issue.fieldId === currentFieldId) {
            issue.fieldId = 'model-amount';
        }
    }
    const tax: DocumentSection['amounts'][number] = { ...billedTotal(proposed), id: correction.fieldId!, role: 'tax', label: 'Tax' };
    proposed.sections[0].amounts.push(tax);
    proposed.status = 'partial';
    proposed.issues.push({ code: 'warning', severity: 'warning', message: 'Check the tax notice.', sectionId: 'model-section', fieldId: tax.id, field: 'tax', evidence: tax.evidence });
    const snapshot: SupportingDocument = structuredClone(proposed);
    const plan: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, proposed, [correction]);
    assert.equal(plan.blockingConflict, undefined);
    assert.equal(plan.invalidatesApproval, false);
    assert.equal(plan.analysis.sections[0].sectionId, correction.sectionId);
    assert.equal(billedTotal(plan.analysis).id, correction.fieldId);
    assert.equal(billedTotal(plan.analysis).candidates[0].coefficient, '4875');
    const rekeyedTax: DocumentSection['amounts'][number] | undefined = plan.analysis.sections[0].amounts.find((item: DocumentSection['amounts'][number]): boolean => item.role === 'tax');
    assert.ok(rekeyedTax);
    assert.notEqual(rekeyedTax.id, tax.id);
    assert.ok(plan.analysis.issues.some((issue: SupportingDocument['issues'][number]): boolean => issue.fieldId === rekeyedTax.id && issue.sectionId === correction.sectionId));
    assert.equal(billedTotal(new SupportingDocumentState(plan.analysis, [correction]).effective).candidates[0].coefficient, '900719925474099312');
    assert.ok(supportingDocumentSchema.safeParse(plan.analysis).success);
    assert.deepEqual(proposed, snapshot);
});

test('requires renewed approval for changed amount or reference eligibility, and preserves it for positional evidence changes', (): void => {
    const previous: StoredSupportingDocument = retainedDocument('fixtures');
    const same: SupportingDocument = modelProposal(previous);
    assert.notDeepEqual(same.input, previous.result.input);
    assert.equal(prepareReceiptAnalysisVersion(previous, same, []).invalidatesApproval, false);
    const changed: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, modelProposal(previous, 'EUR 48.75'), []);
    assert.equal(changed.invalidatesApproval, true);
    assert.ok(changed.changes.some((change: ReceiptVersionPlan['changes'][number]): boolean => change.after === '48.75 EUR'));
    const reference: DocumentSection['references'][number] = same.sections[0].references[0];
    reference.evidence[0].rawText = 'Invoice Number: A-DIFFERENT-REFERENCE';
    const eligibility: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, same, []);
    assert.equal(eligibility.invalidatesApproval, true);
    assert.ok(eligibility.changes.some((change: ReceiptVersionPlan['changes'][number]): boolean => change.label === 'Matching evidence'));
});

test('keeps fields from unpaired invoice sections with their respective current and proposed sections', (): void => {
    const previous: StoredSupportingDocument = retainedDocument('fixtures');
    const proposed: SupportingDocument = modelProposal(previous, 'EUR 48.75');
    proposed.sections[0].references[0].candidates = ['DIFFERENT-INVOICE'];
    previous.result.sections[0].amounts.push({ ...billedTotal(previous.result), id: 'unrecognized-tax', role: 'tax', label: 'Tax', candidates: [] });
    const { changes, conflicts }: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, proposed, []);
    const sections: ReceiptVersionPlan['changes'] = changes.filter((change: ReceiptVersionPlan['changes'][number]): boolean => change.kind === 'section');
    assert.equal(sections.length, 2);
    assert.equal(sections[0].before, sections[1].after);
    const totals: ReceiptVersionPlan['changes'] = changes.filter((change: ReceiptVersionPlan['changes'][number]): boolean => change.label === 'Billed total');
    assert.equal(totals.length, 2);
    assert.equal(totals[0].section, sections[0].before);
    assert.equal(totals[0].after, null);
    assert.equal(totals[1].section, sections[1].after);
    assert.equal(totals[1].before, null);
    assert.ok(changes.some((change: ReceiptVersionPlan['changes'][number]): boolean => change.label === 'Tax' && change.section === sections[0].before && change.unrecognized === true));
    assert.ok(conflicts.some((conflict: string): boolean => conflict.includes('could not be matched')));
});

test('blocks adoption when a manually corrected total has a conflicting currency or ambiguous candidates', (): void => {
    const previous: StoredSupportingDocument = retainedDocument('fixtures');
    const correction: DocumentCorrection = amountCorrection(previous);
    const changed: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, modelProposal(previous, 'USD 48.75'), [correction]);
    assert.ok(changed.blockingConflict);

    const ambiguous: SupportingDocument = modelProposal(previous, 'EUR 48.75');
    const total: DocumentSection['amounts'][number] = billedTotal(ambiguous);
    ambiguous.sections[0].amounts.push({ ...total, id: 'alternate-total', candidates: [{ coefficient: '4900', currency: 'EUR', scale: 2 }] });
    const conflict: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, ambiguous, [correction]);
    assert.ok(conflict.blockingConflict);
    assert.ok(conflict.conflicts.includes(conflict.blockingConflict));
});

test('keeps manually supplied missing fields when still absent and flags an extracted replacement', (): void => {
    const document: StoredSupportingDocument = retainedDocument('fixtures');
    const previous: StoredSupportingDocument = { ...document, result: modelProposal(document, undefined, true) };
    const edit: DocumentCorrection = { documentId: document.id, sectionId: previous.result.sections[0].sectionId, fieldId: null, revision: 2,
        change: { kind: 'date', value: '2032-05-20' } };
    const missing: ReceiptVersionPlan = prepareReceiptAnalysisVersion(previous, modelProposal(document, undefined, true), [edit]);
    assert.equal(missing.blockingConflict, undefined);
    assert.equal(missing.invalidatesApproval, false);
    assert.ok(prepareReceiptAnalysisVersion(previous, modelProposal(document), [edit]).blockingConflict);
});
