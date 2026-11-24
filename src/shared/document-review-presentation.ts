import type { DocumentIssue, DocumentSection, SupportingDocument } from './supporting-document.js';
import { hasUsableDocumentFieldSibling } from './document-field-reviews.js';

const optionalWarnings: ReadonlySet<string> = new Set(['ambiguous-field', 'unresolved-field', 'missing-currency', 'unconfirmed-field-association', 'rejected-field', 'unavailable-field']);

function optionalField(section: DocumentSection, fieldId: string): boolean {
    return section.amounts.some((field: DocumentSection['amounts'][number]): boolean => field.id === fieldId &&
        ['tax', 'subtotal', 'line-item', 'informational-fx'].includes(field.role)) ||
        section.dates.some((field: DocumentSection['dates'][number]): boolean => field.id === fieldId &&
            ['due', 'service-period', 'service-start', 'service-end'].includes(field.role)) ||
        section.references.some((field: DocumentSection['references'][number]): boolean => field.id === fieldId &&
            ['order', 'customer', 'account', 'table', 'related-invoice'].includes(field.role)) ||
        section.currencies.some((field: DocumentSection['currencies'][number]): boolean => field.id === fieldId && field.role === 'informational-fx');
}

export function documentIssueNeedsReview(issue: DocumentIssue, analysis: SupportingDocument): boolean {
    if (issue.severity === 'error' || !issue.sectionId || !issue.fieldId || !optionalWarnings.has(issue.code)) {
        return true;
    }
    const section: DocumentSection | undefined = analysis.sections.find((item: DocumentSection): boolean => item.sectionId === issue.sectionId);
    const replaced: boolean = analysis.issues.some((item: DocumentIssue): boolean => item.fieldId === issue.fieldId && item.code === 'rejected-field') &&
        hasUsableDocumentFieldSibling(analysis, issue.sectionId, issue.fieldId);
    return !section || !(optionalField(section, issue.fieldId) || replaced);
}

export function documentNeedsReview(analysis: SupportingDocument): boolean {
    return analysis.status === 'failed' || Boolean(analysis.input?.issues.length) || analysis.issues.some((issue: DocumentIssue): boolean => documentIssueNeedsReview(issue, analysis));
}
