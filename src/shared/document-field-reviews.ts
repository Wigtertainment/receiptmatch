import { z } from 'zod';
import { documentScalarConflicts, type DocumentIssue, type DocumentSection, type SupportingDocument } from './supporting-document.js';
import type { StoredDocumentImport } from './workspace-documents.js';

interface IDocumentFieldReviewTargetShape { documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodString }
interface IDocumentFieldReviewShape extends IDocumentFieldReviewTargetShape {
    confirmed: z.ZodBoolean;
    revision: z.ZodNumber;
    signature: z.ZodString;
    disposition: z.ZodOptional<typeof documentFieldDispositionSchema>;
}

const fieldId: z.ZodString = z.string().min(1).max(128);
export const documentFieldReviewTarget: IDocumentFieldReviewTargetShape = { documentId: z.uuid(), sectionId: fieldId, fieldId };
export const documentFieldDispositionSchema: z.ZodEnum<z.core.util.ToEnum<'rejected' | 'unavailable'>> = z.enum(['rejected', 'unavailable']);
export type DocumentFieldDisposition = z.infer<typeof documentFieldDispositionSchema>;
export const documentFieldReviewSchema: z.ZodObject<z.core.util.Flatten<IDocumentFieldReviewShape>, z.core.$strict> = z.strictObject({
    ...documentFieldReviewTarget, confirmed: z.boolean(), revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER), signature: z.string().min(1), disposition: documentFieldDispositionSchema.optional()
}).refine((review: Pick<DocumentFieldReview, 'confirmed' | 'disposition'>): boolean => !(review.confirmed && review.disposition), 'A field cannot be confirmed and excluded at the same time.');
export type DocumentFieldReview = z.infer<typeof documentFieldReviewSchema>;
export type DocumentFieldReviewTarget = Pick<DocumentFieldReview, 'documentId' | 'sectionId' | 'fieldId'>;
type DocumentField = DocumentSection['amounts'][number] | DocumentSection['dates'][number] | DocumentSection['merchants'][number] | DocumentSection['references'][number] | DocumentSection['currencies'][number];
interface ILocatedDocumentField { section: DocumentSection; field: DocumentField; kind: string }

const confirmableIssues: ReadonlySet<string> = new Set(['unconfirmed-merchant', 'unconfirmed-field-association', 'reconstructed-total']);

export function documentFieldReviewKey(target: DocumentFieldReviewTarget): string {
    return JSON.stringify([target.documentId, target.sectionId, target.fieldId]);
}

function findField(analysis: SupportingDocument, sectionId: string, fieldId: string): ILocatedDocumentField | null {
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

export function isDocumentFieldConfirmed(analysis: SupportingDocument, target: DocumentFieldReviewTarget, reviews: readonly DocumentFieldReview[], effective: SupportingDocument = analysis): boolean {
    const review: DocumentFieldReview | undefined = reviews.find((item: DocumentFieldReview): boolean => documentFieldReviewKey(item) === documentFieldReviewKey(target));
    return review?.confirmed === true && !review.disposition && review.signature === documentFieldSignature(analysis, target.sectionId, target.fieldId) &&
        documentFieldConfirmationIssue(effective, target.sectionId, target.fieldId) === null;
}

export function activeDocumentFieldDisposition(analysis: SupportingDocument, target: DocumentFieldReviewTarget, reviews: readonly DocumentFieldReview[]): DocumentFieldDisposition | null {
    const review: DocumentFieldReview | undefined = reviews.find((item: DocumentFieldReview): boolean => documentFieldReviewKey(item) === documentFieldReviewKey(target));
    return review?.disposition && isActiveDocumentFieldReview(analysis, review) ? review.disposition : null;
}

export function isActiveDocumentFieldReview(analysis: SupportingDocument, review: DocumentFieldReview): boolean {
    return review.signature === documentFieldSignature(analysis, review.sectionId, review.fieldId) &&
        (!!review.disposition || review.confirmed);
}

export function hasUsableDocumentFieldSibling(analysis: SupportingDocument, sectionId: string, fieldId: string): boolean {
    const item: ReturnType<typeof findField> = findField(analysis, sectionId, fieldId);
    if (!item || item.field.role === 'unknown' || item.section.kind === 'unknown') {
        return false;
    }
    const fields: DocumentField[] = item.section[item.kind as 'amounts' | 'dates' | 'merchants' | 'references' | 'currencies'];
    return fields.some((field: DocumentField): boolean => field.id !== fieldId && field.role === item.field.role &&
        documentFieldConfirmationIssue(analysis, sectionId, field.id) === null);
}

function suppressFields<T extends DocumentField>(fields: T[], dispositions: ReadonlyMap<string, DocumentFieldReview>): T[] {
    return fields.map((field: T): T => {
        if (!dispositions.has(field.id)) {
            return field;
        }
        const cleared: T = { ...field, candidates: [] };
        Reflect.deleteProperty(cleared, 'confirmedByUser');
        Reflect.deleteProperty(cleared, 'correctedByUser');
        return cleared;
    });
}

function reviewedSections(analysis: SupportingDocument, documentId: string, dispositions: ReadonlyMap<string, DocumentFieldReview>, independentCurrencies: ReadonlySet<string>): DocumentSection[] {
    return analysis.sections.map((section: DocumentSection): DocumentSection => {
        const currencyExcluded: boolean = section.currencies.some((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement' && dispositions.has(field.id));
        const amounts: DocumentSection['amounts'] = suppressFields(section.amounts, dispositions).map((field: DocumentSection['amounts'][number]): DocumentSection['amounts'][number] => {
            const target: DocumentFieldReviewTarget = { documentId, sectionId: section.sectionId, fieldId: field.id };
            if (!currencyExcluded || field.role === 'informational-fx' || !field.candidates.length || independentCurrencies.has(documentFieldReviewKey(target))) {
                return field;
            }
            return { ...field, candidates: field.candidates.map((value: DocumentSection['amounts'][number]['candidates'][number]): DocumentSection['amounts'][number]['candidates'][number] => ({ ...value, currency: null })) };
        });
        return { ...section, amounts, dates: suppressFields(section.dates, dispositions), merchants: suppressFields(section.merchants, dispositions),
            references: suppressFields(section.references, dispositions), currencies: suppressFields(section.currencies, dispositions) };
    });
}

function dispositionIssues(analysis: SupportingDocument, sections: DocumentSection[], dispositions: ReadonlyMap<string, DocumentFieldReview>): DocumentIssue[] {
    const issues: DocumentIssue[] = [...dispositions.values()].map((review: DocumentFieldReview): DocumentIssue => ({
        code: review.disposition === 'rejected' ? 'rejected-field' : 'unavailable-field', severity: 'warning',
        message: review.disposition === 'rejected' ? 'This field was marked as incorrectly recognized. Its values are excluded until the decision is reset or the field is corrected.' : 'This field could not be determined from the original. Its values remain unresolved until the decision is reset or the field is corrected.',
        sectionId: review.sectionId, fieldId: review.fieldId, field: findField(analysis, review.sectionId, review.fieldId)!.field.role,
        evidence: findField(analysis, review.sectionId, review.fieldId)!.field.evidence
    }));
    for (const section of sections) {
        const currencyExcluded: boolean = section.currencies.some((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement' && dispositions.has(field.id));
        if (!currencyExcluded) {
            continue;
        }
        for (const field of section.amounts) {
            if (field.candidates.some((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => value.currency === null) &&
                !analysis.issues.some((issue: DocumentIssue): boolean => issue.fieldId === field.id && issue.code === 'missing-currency')) {
                issues.push({ code: 'missing-currency', severity: 'warning', message: 'The inferred currency is unresolved because its settlement currency declaration was excluded.',
                    sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
            }
        }
    }
    return issues;
}

function remainingScalarConflicts(section: DocumentSection): Set<string> {
    const conflicts: Set<string> = documentScalarConflicts(section);
    const declarations: DocumentSection['currencies'] = section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement');
    const currencies: Set<string> = new Set(declarations.flatMap((field: DocumentSection['currencies'][number]): string[] => field.candidates));
    if (declarations.some((field: DocumentSection['currencies'][number]): boolean => field.correctedByUser === true) && currencies.size === 1) {
        const mismatched: DocumentSection['amounts'] = section.amounts.filter((field: DocumentSection['amounts'][number]): boolean => ['billed-total', 'balance-due', 'credit-note-component'].includes(field.role) &&
            field.candidates.some((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => !!value.currency && !currencies.has(value.currency)));
        if (mismatched.length) {
            for (const field of [...mismatched, ...declarations]) {
                conflicts.add(field.id);
            }
        }
    }
    return conflicts;
}

function reviewedDocument(analysis: SupportingDocument, documentId: string, reviews: readonly DocumentFieldReview[], independentCurrencies: ReadonlySet<string>): SupportingDocument {
    const active: DocumentFieldReview[] = reviews.filter((review: DocumentFieldReview): boolean => review.documentId === documentId && isActiveDocumentFieldReview(analysis, review));
    if (!active.length) {
        return analysis;
    }
    const dispositions: Map<string, DocumentFieldReview> = new Map(active.filter((review: DocumentFieldReview): boolean => !!review.disposition).map((review: DocumentFieldReview): [string, DocumentFieldReview] => [review.fieldId, review]));
    const sections: DocumentSection[] = dispositions.size ? reviewedSections(analysis, documentId, dispositions, independentCurrencies) : analysis.sections;
    const conflicts: Map<string, Set<string>> = new Map(sections.filter((section: DocumentSection): boolean => active.some((review: DocumentFieldReview): boolean => !!review.disposition && review.sectionId === section.sectionId))
        .map((section: DocumentSection): [string, Set<string>] => [section.sectionId, remainingScalarConflicts(section)]));
    const originalIssues: DocumentIssue[] = analysis.issues.filter((issue: DocumentIssue): boolean => issue.severity === 'error' || issue.code !== 'conflicting-field' || !issue.sectionId || !conflicts.has(issue.sectionId) || conflicts.get(issue.sectionId)!.has(issue.fieldId!));
    const issues: DocumentIssue[] = [...originalIssues, ...dispositionIssues(analysis, sections, dispositions)];
    for (const section of sections) {
        for (const fieldId of conflicts.get(section.sectionId) ?? []) {
            if (!issues.some((issue: DocumentIssue): boolean => issue.fieldId === fieldId && issue.code === 'conflicting-field')) {
                const field: DocumentField = findField({ ...analysis, sections }, section.sectionId, fieldId)!.field;
                issues.push({ code: 'conflicting-field', severity: 'warning', message: 'Values for this field still conflict within the document section.', sectionId: section.sectionId, fieldId, field: field.role, evidence: field.evidence });
            }
        }
    }
    const effective: SupportingDocument = { ...analysis, sections, issues };
    const confirmed: Set<string> = new Set(active.filter((review: DocumentFieldReview): boolean => isDocumentFieldConfirmed(analysis, review, [review], effective)).map((review: DocumentFieldReview): string => review.fieldId));
    const remaining: DocumentIssue[] = issues.filter((issue: DocumentIssue): boolean => !issue.fieldId || !confirmed.has(issue.fieldId) || !confirmableIssues.has(issue.code));
    return { ...effective, issues: remaining, status: remaining.length ? 'partial' : 'complete' };
}

export function applyDocumentFieldReviews(imports: StoredDocumentImport[], reviews: ReadonlyMap<string, DocumentFieldReview>, independentCurrencies: ReadonlySet<string> = new Set()): StoredDocumentImport[] {
    if (!reviews.size) {
        return imports;
    }
    const entries: DocumentFieldReview[] = [...reviews.values()];
    return imports.map((run: StoredDocumentImport): StoredDocumentImport => ({ ...run, files: run.files.map((file: StoredDocumentImport['files'][number]): StoredDocumentImport['files'][number] => {
        if (file.status !== 'imported') {
            return file;
        }
        const result: SupportingDocument = reviewedDocument(file.record.result, file.record.id, entries, independentCurrencies);
        return result === file.record.result ? file : { ...file, record: { ...file.record, result } };
    }) }));
}
