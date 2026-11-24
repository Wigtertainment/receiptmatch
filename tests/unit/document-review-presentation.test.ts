import assert from 'node:assert/strict';
import { test } from 'vitest';
import { documentIssueNeedsReview, documentNeedsReview } from '../../src/shared/document-review-presentation.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../../src/shared/supporting-document.js';
import { retainedDocument } from './document-fixtures.js';

test('optional extraction uncertainty is a note while required values, errors and conflicts remain actionable', (): void => {
    const analysis: SupportingDocument = retainedDocument(process.cwd()).result;
    const section: DocumentSection = analysis.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    const tax: DocumentSection['amounts'][number] = { ...total, id: 'optional-tax', role: 'tax', candidates: [] };
    section.amounts.push(tax);
    const issue: DocumentIssue = { code: 'unresolved-field', severity: 'warning', message: 'No single reading.', sectionId: section.sectionId,
        fieldId: tax.id, field: 'tax', evidence: tax.evidence };
    analysis.issues = [issue];
    analysis.status = 'partial';
    assert.equal(documentIssueNeedsReview(issue, analysis), false);
    assert.equal(documentNeedsReview(analysis), false);
    assert.equal(documentIssueNeedsReview({ ...issue, severity: 'error' }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, code: 'conflicting-field' }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, code: 'new-unknown-issue' }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, code: 'rejected-field' }, analysis), false);
    assert.equal(documentIssueNeedsReview({ ...issue, code: 'unavailable-field' }, analysis), false);
    assert.equal(documentIssueNeedsReview({ ...issue, code: 'unavailable-field', fieldId: total.id, field: total.role }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, fieldId: total.id, field: total.role }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, fieldId: 'no-such-field' }, analysis), true);
    assert.equal(documentIssueNeedsReview({ ...issue, fieldId: null }, analysis), true);
    analysis.input!.issues.push({ code: 'extraction-warning', severity: 'warning', message: 'Unreadable source.', pageId: null, rowId: null, field: null, evidence: [] });
    assert.equal(documentNeedsReview(analysis), true);
});

test('a rejected false duplicate becomes a handled note only when a usable replacement remains', (): void => {
    const analysis: SupportingDocument = retainedDocument(process.cwd()).result;
    const section: DocumentSection = analysis.sections[0];
    const total: DocumentSection['amounts'][number] = section.amounts[0];
    const duplicate: DocumentSection['amounts'][number] = { ...total, id: 'false-total', candidates: [] };
    section.amounts.push(duplicate);
    const rejected: DocumentIssue = { code: 'rejected-field', severity: 'warning', message: 'False recognition.', sectionId: section.sectionId,
        fieldId: duplicate.id, field: duplicate.role, evidence: duplicate.evidence };
    analysis.issues = [rejected];
    assert.equal(documentIssueNeedsReview(rejected, analysis), false);
    analysis.issues = [{ ...rejected, code: 'unavailable-field' }];
    assert.equal(documentIssueNeedsReview(analysis.issues[0], analysis), true);
    analysis.issues = [rejected, { ...rejected, code: 'conflicting-field', fieldId: total.id }];
    assert.equal(documentIssueNeedsReview(rejected, analysis), true);
    analysis.issues = [rejected];
    total.candidates = [];
    assert.equal(documentIssueNeedsReview(rejected, analysis), true);
});
