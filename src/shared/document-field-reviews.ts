import { z } from 'zod';
import { documentScalarConflicts, type DocumentIssue, type DocumentSection, type SupportingDocument } from './supporting-document.js';
import type { StoredDocumentImport } from './workspace-documents.js';

const fieldId: z.ZodString = z.string().min(1).max(128);
export const documentFieldReviewTarget: { documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodString } = { documentId: z.uuid(), sectionId: fieldId, fieldId };
export const documentFieldReviewSchema: z.ZodObject<{ documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodString; confirmed: z.ZodBoolean; revision: z.ZodNumber; signature: z.ZodString }, z.core.$strict> = z.strictObject({
    ...documentFieldReviewTarget, confirmed: z.boolean(), revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER), signature: z.string().min(1)
});
export type DocumentFieldReview = z.infer<typeof documentFieldReviewSchema>;
export type DocumentFieldReviewTarget = Pick<DocumentFieldReview, 'documentId' | 'sectionId' | 'fieldId'>;
type DocumentField = DocumentSection['amounts'][number] | DocumentSection['dates'][number] | DocumentSection['merchants'][number] | DocumentSection['references'][number] | DocumentSection['currencies'][number];
const confirmableIssues: ReadonlySet<string> = new Set(['unconfirmed-merchant', 'unconfirmed-field-association', 'reconstructed-total']);

export function documentFieldReviewKey(target: DocumentFieldReviewTarget): string {
    return JSON.stringify([target.documentId, target.sectionId, target.fieldId]);
}

function findField(analysis: SupportingDocument, sectionId: string, fieldId: string): { section: DocumentSection; field: DocumentField; kind: string } | null {
    const section: DocumentSection | undefined = analysis.sections.find((item: DocumentSection): boolean => item.sectionId === sectionId);
    if (!section) {
        return null;
    }
    for (const kind of ['amounts', 'dates', 'merchants', 'references', 'currencies'] as const) {
        const field: DocumentField | undefined = section[kind].find((item: DocumentField): boolean => item.id === fieldId);
        if (field) {
            return { section, field, kind };
        }
    }
    return null;
}

export function documentFieldSignature(analysis: SupportingDocument, sectionId: string, fieldId: string): string | null {
    const item: ReturnType<typeof findField> = findField(analysis, sectionId, fieldId);
    // Exclude derived issues: resolving a warning must not invalidate its own confirmation.
    return item ? JSON.stringify([analysis.input?.source, analysis.input?.extraction, analysis.parserVersion, item.section.kind, item.kind, item.field]) : null;
}

export function documentFieldConfirmationIssue(analysis: SupportingDocument, sectionId: string, fieldId: string): string | null {
    const item: ReturnType<typeof findField> = findField(analysis, sectionId, fieldId);
    if (!item) {
        return 'This document field is no longer available.';
    }
    const { field, section }: NonNullable<typeof item> = item;
    if (field.candidates.length !== 1) {
        return field.candidates.length ? 'Choose a single value before confirming this field.' : 'Add a value before confirming this field.';
    }
    if (field.role === 'unknown' || section.kind === 'unknown') {
        return 'The meaning of this field must be established before it can be confirmed.';
    }
    if (item.kind === 'amounts' && (field.candidates[0] as DocumentSection['amounts'][number]['candidates'][number]).currency === null) {
        return 'Add a currency before confirming this amount.';
    }
    if (documentScalarConflicts(section).has(fieldId)) {
        return 'Resolve the conflicting values before confirming this field.';
    }
    const blocking: DocumentIssue | undefined = analysis.issues.find((issue: DocumentIssue): boolean => issue.fieldId === fieldId &&
        (issue.severity === 'error' || !confirmableIssues.has(issue.code)));
    return blocking ? 'Resolve the field issues before confirming this value.' : null;
}

export function isDocumentFieldConfirmed(analysis: SupportingDocument, target: DocumentFieldReviewTarget, reviews: readonly DocumentFieldReview[]): boolean {
    const review: DocumentFieldReview | undefined = reviews.find((item: DocumentFieldReview): boolean => documentFieldReviewKey(item) === documentFieldReviewKey(target));
    return review?.confirmed === true && review.signature === documentFieldSignature(analysis, target.sectionId, target.fieldId) &&
        documentFieldConfirmationIssue(analysis, target.sectionId, target.fieldId) === null;
}

export function applyDocumentFieldReviews(imports: StoredDocumentImport[], reviews: ReadonlyMap<string, DocumentFieldReview>): StoredDocumentImport[] {
    if (!reviews.size) {
        return imports;
    }
    return imports.map((run: StoredDocumentImport): StoredDocumentImport => ({ ...run, files: run.files.map((file: StoredDocumentImport['files'][number]): StoredDocumentImport['files'][number] => {
        if (file.status !== 'imported') {
            return file;
        }
        const analysis: SupportingDocument = file.record.result;
        const confirmed: Set<string> = new Set([...reviews.values()].filter((review: DocumentFieldReview): boolean => review.documentId === file.record.id &&
            isDocumentFieldConfirmed(analysis, review, [review])).map((review: DocumentFieldReview): string => review.fieldId));
        const issues: DocumentIssue[] = analysis.issues.filter((issue: DocumentIssue): boolean => !issue.fieldId || !confirmed.has(issue.fieldId) || !confirmableIssues.has(issue.code));
        const status: SupportingDocument['status'] = issues.length ? 'partial' : 'complete';
        return issues.length === analysis.issues.length ? file : { ...file, record: { ...file.record, result: { ...analysis, issues, status } } };
    }) }));
}
