import type { ImportIssue, SourceEvidence } from "./bank-import.js";
import type { DocumentIssue } from "./supporting-document.js";
import type { StoredSupportingDocument } from "./workspace-documents.js";
import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import { documentScalarConflicts, type DocumentSection, type SupportingDocument } from './supporting-document.js';
import type { StoredDocumentImport } from './workspace-documents.js';

const fieldId: z.ZodString = z.string().min(1).max(128);
export const documentCorrectionTarget: { documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodNullable<z.ZodString>; } = { documentId: z.uuid(), sectionId: fieldId, fieldId: fieldId.nullable() };
export const documentCorrectionValueSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{ kind: z.ZodLiteral<"amount">; value: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>; }, z.core.$strict>, z.ZodObject<{ kind: z.ZodLiteral<"date">; value: z.ZodISODate; }, z.core.$strict>], "kind"> = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('amount'), value: moneySchema }),
    z.strictObject({ kind: z.literal('date'), value: calendarDateSchema })
]);
export const documentCorrectionSchema: z.ZodObject<{ revision: z.ZodNumber; change: typeof documentCorrectionValueSchema; documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodNullable<z.ZodString>; }, z.core.$strict> = z.strictObject({
    ...documentCorrectionTarget, revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER), change: documentCorrectionValueSchema
});
export type DocumentCorrection = z.infer<typeof documentCorrectionSchema>;
export type DocumentCorrectionValue = z.infer<typeof documentCorrectionValueSchema>;
export type DocumentCorrectionTarget = Pick<DocumentCorrection, 'documentId' | 'sectionId' | 'fieldId'>;

export function documentCorrectionKey(target: DocumentCorrectionTarget, kind: DocumentCorrectionValue['kind']): string {
    return JSON.stringify([target.documentId, target.sectionId, target.fieldId, target.fieldId === null ? kind : null]);
}

function correctExistingField(section: DocumentSection, originalSection: DocumentSection, fieldId: string, change: DocumentCorrectionValue): void {
    const originalFields: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] = change.kind === 'amount' ? originalSection.amounts : originalSection.dates;
    const fields: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] = change.kind === 'amount' ? section.amounts : section.dates;
    const index: number = fields.findIndex((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === fieldId);
    if (index < 0 || !originalFields.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === fieldId)) {
        throw new Error('The document field for this correction is not available.');
    }
    if (change.kind === 'amount') {
        section.amounts[index] = { ...section.amounts[index], candidates: [change.value] };
    } else {
        section.dates[index] = { ...section.dates[index], candidates: [change.value] };
    }
}

function supplyMissingField(section: DocumentSection, originalSection: DocumentSection, issues: DocumentIssue[], change: DocumentCorrectionValue,
    sectionNumber: number, ids: Set<string>, suppliedFields: Map<string, Set<string>>): void {
    const sectionId: string = section.sectionId;
    const missing: "billed-total" | "issue" = change.kind === 'amount' ? 'billed-total' : 'issue';
    const totalRole: "billed-total" | "credit-note-component" = originalSection.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
    const exists: boolean = change.kind === 'amount' ? originalSection.amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === totalRole) : originalSection.dates.some((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'issue');
    const isMissing: boolean = issues.some((issue: DocumentIssue): boolean => issue.sectionId === sectionId && issue.fieldId === null && issue.field === missing && issue.code === 'missing-field');
    if (exists || originalSection.kind === 'unknown' || !isMissing) {
        throw new Error('This document section has no matching missing field to correct.');
    }
    const base: string = `manual-${change.kind}-${sectionNumber}`;
    let id: string = base;
    for (let suffix: number = 2; ids.has(id); suffix++) {
        id = `${base}-${suffix}`;
    }
    ids.add(id);
    if (change.kind === 'amount') {
        section.amounts.push({ id, role: totalRole, label: 'Manually entered total', candidates: [change.value], evidence: [] });
    } else {
        section.dates.push({ id, role: 'issue', label: 'Manually entered issue date', candidates: [change.value], evidence: [] });
    }
    const roles: Set<string> = suppliedFields.get(sectionId) ?? new Set();
    roles.add(missing);
    suppliedFields.set(sectionId, roles);
}

function correctedIssues(result: SupportingDocument, affectedSections: Set<DocumentSection>, suppliedFields: Map<string, Set<string>>, correctedFields: Set<string>): DocumentIssue[] {
    const conflicts: Map<string, Set<string>> = new Map([...affectedSections].map((section: DocumentSection): [string, Set<string>] => [section.sectionId, documentScalarConflicts(section)]));
    const issues: DocumentIssue[] = result.issues.filter((issue: DocumentIssue): boolean => {
        if (issue.sectionId && issue.field && issue.fieldId === null && issue.code === 'missing-field' && suppliedFields.get(issue.sectionId)?.has(issue.field)) {
            return false;
        }
        if (!issue.fieldId) {
            return true;
        }
        if (correctedFields.has(issue.fieldId) && ['ambiguous-field', 'unresolved-field', 'missing-currency'].includes(issue.code)) {
            return false;
        }
        const sectionConflicts: Set<string> | undefined = issue.sectionId ? conflicts.get(issue.sectionId) : undefined;
        return issue.code !== 'conflicting-field' || !sectionConflicts || sectionConflicts.has(issue.fieldId);
    });
    const reported: Set<string | null> = new Set(issues.filter((issue: DocumentIssue): boolean => issue.code === 'conflicting-field').map((issue: DocumentIssue): string | null => issue.fieldId));
    for (const section of affectedSections) {
        const unresolved: Set<string> = conflicts.get(section.sectionId)!;
        for (const field of [...section.amounts, ...section.dates, ...section.references, ...section.currencies]) {
            if (unresolved.has(field.id) && !reported.has(field.id)) {
                issues.push({ code: 'conflicting-field', severity: 'warning',
                message: 'Values for this field still conflict within the document section.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
            }
        }
    }
    return issues;
}

export function applyDocumentFieldCorrections(
    result: SupportingDocument, corrections: readonly DocumentCorrection[], original: SupportingDocument = result,
): SupportingDocument {
    if (!corrections.length) {
        return result;
    }
    const sections: DocumentSection[] = result.sections.map((section: DocumentSection): DocumentSection => ({ ...section, amounts: [...section.amounts], dates: [...section.dates] }));
    const bySection: Map<string, DocumentSection> = new Map(sections.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
    const originals: Map<string, DocumentSection> = new Map(original.sections.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
    const ids: Set<string> = new Set(sections.flatMap((section: DocumentSection): string[] => [section.sectionId, ...[...section.amounts, ...section.dates, ...section.merchants, ...section.references,
        ...section.currencies].map((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string => field.id)]));
    const correctedFields: Set<string> = new Set<string>();
    const suppliedFields: Map<string, Set<string>> = new Map<string, Set<string>>();
    const affectedSections: Set<DocumentSection> = new Set<DocumentSection>();
    for (const { sectionId, fieldId, change } of corrections) {
        const section: DocumentSection | undefined = bySection.get(sectionId);
        const originalSection: DocumentSection | undefined = originals.get(sectionId);
        if (!section || !originalSection) {
            throw new Error('The document section for this correction is not available.');
        }
        affectedSections.add(section);
        if (fieldId !== null) {
            correctExistingField(section, originalSection, fieldId, change);
            correctedFields.add(fieldId);
            continue;
        }
        supplyMissingField(section, originalSection, original.issues, change, sections.indexOf(section) + 1, ids, suppliedFields);
    }
    const issues: DocumentIssue[] = correctedIssues(result, affectedSections, suppliedFields, correctedFields);
    return { ...result, sections, issues };
}

// This projection retains original evidence and never rewrites an extraction manifest.
export function applyDocumentCorrections(imports: StoredDocumentImport[], corrections: ReadonlyMap<string, DocumentCorrection>): StoredDocumentImport[] {
    if (!corrections.size) {
        return imports;
    }
    const pending: Map<string, DocumentCorrection[]> = new Map<string, DocumentCorrection[]>();
    for (const correction of corrections.values()) {
        const fields: DocumentCorrection[] = pending.get(correction.documentId) ?? [];
        fields.push(correction);
        pending.set(correction.documentId, fields);
    }
    const records: StoredDocumentImport[] = imports.map((record: StoredDocumentImport): StoredDocumentImport => {
        const files: ({ status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; })[] = record.files.map((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } => {
            if (file.status !== 'imported') {
                return file;
            }
            const fields: DocumentCorrection[] | undefined = pending.get(file.record.id);
            if (!fields) {
                return file;
            }
            pending.delete(file.record.id);
            return { ...file, record: { ...file.record, result: applyDocumentFieldCorrections(file.record.result, fields) } };
        });
        return files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }, index: number): boolean => file !== record.files[index]) ? { ...record, files } : record;
    });
    if (pending.size) {
        throw new Error('A correction refers to a document outside the workspace imports.');
    }
    return records;
}
