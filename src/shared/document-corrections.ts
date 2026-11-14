import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import { documentScalarConflicts, type DocumentSection, type SupportingDocument } from './supporting-document.js';
import type { StoredDocumentImport } from './workspace-documents.js';

const fieldId = z.string().min(1).max(128);
export const documentCorrectionTarget = { documentId: z.uuid(), sectionId: fieldId, fieldId: fieldId.nullable() };
export const documentCorrectionValueSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('amount'), value: moneySchema }),
    z.strictObject({ kind: z.literal('date'), value: calendarDateSchema })
]);
export const documentCorrectionSchema = z.strictObject({
    ...documentCorrectionTarget, revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER), change: documentCorrectionValueSchema
});
export type DocumentCorrection = z.infer<typeof documentCorrectionSchema>;
export type DocumentCorrectionValue = z.infer<typeof documentCorrectionValueSchema>;
export type DocumentCorrectionTarget = Pick<DocumentCorrection, 'documentId' | 'sectionId' | 'fieldId'>;

export function documentCorrectionKey(target: DocumentCorrectionTarget, kind: DocumentCorrectionValue['kind']): string {
    return JSON.stringify([target.documentId, target.sectionId, target.fieldId, target.fieldId === null ? kind : null]);
}

export function applyDocumentFieldCorrections(
    result: SupportingDocument, corrections: readonly DocumentCorrection[], original = result,
): SupportingDocument {
    if (!corrections.length) return result;
    const sections = result.sections.map(section => ({ ...section, amounts: [...section.amounts], dates: [...section.dates] }));
    const bySection = new Map(sections.map(section => [section.sectionId, section]));
    const originals = new Map(original.sections.map(section => [section.sectionId, section]));
    const ids = new Set(sections.flatMap(section => [section.sectionId, ...[...section.amounts, ...section.dates, ...section.merchants, ...section.references,
        ...section.currencies].map(field => field.id)]));
    const correctedFields = new Set<string>();
    const suppliedFields = new Map<string, Set<string>>();
    const affectedSections = new Set<DocumentSection>();
    for (const { sectionId, fieldId, change } of corrections) {
        const section = bySection.get(sectionId);
        const originalSection = originals.get(sectionId);
        if (!section || !originalSection) throw new Error('The document section for this correction is not available.');
        affectedSections.add(section);
        if (fieldId !== null) {
            const originalFields = change.kind === 'amount' ? originalSection.amounts : originalSection.dates;
            const fields = change.kind === 'amount' ? section.amounts : section.dates;
            const index = fields.findIndex(field => field.id === fieldId);
            if (index < 0 || !originalFields.some(field => field.id === fieldId)) throw new Error('The document field for this correction is not available.');
            if (change.kind === 'amount') section.amounts[index] = { ...section.amounts[index], candidates: [change.value] };
            else section.dates[index] = { ...section.dates[index], candidates: [change.value] };
            correctedFields.add(fieldId);
            continue;
        }
        const missing = change.kind === 'amount' ? 'billed-total' : 'issue';
        const totalRole = originalSection.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
        const exists = change.kind === 'amount' ? originalSection.amounts.some(field => field.role === totalRole) : originalSection.dates.some(field => field.role === 'issue');
        const isMissing = original.issues.some(issue => issue.sectionId === sectionId && issue.fieldId === null && issue.field === missing && issue.code === 'missing-field');
        if (exists || originalSection.kind === 'unknown' || !isMissing) {
            throw new Error('This document section has no matching missing field to correct.');
        }
        const base = `manual-${change.kind}-${sections.indexOf(section) + 1}`;
        let id = base;
        for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
        ids.add(id);
        if (change.kind === 'amount') section.amounts.push({ id, role: totalRole, label: 'Manually entered total', candidates: [change.value], evidence: [] });
        else section.dates.push({ id, role: 'issue', label: 'Manually entered issue date', candidates: [change.value], evidence: [] });
        const roles = suppliedFields.get(sectionId) ?? new Set();
        roles.add(missing);
        suppliedFields.set(sectionId, roles);
    }
    const conflicts = new Map([...affectedSections].map(section => [section.sectionId, documentScalarConflicts(section)]));
    const issues = result.issues.filter(issue => {
        if (issue.sectionId && issue.field && issue.fieldId === null && issue.code === 'missing-field' && suppliedFields.get(issue.sectionId)?.has(issue.field)) return false;
        if (!issue.fieldId) return true;
        if (correctedFields.has(issue.fieldId) && ['ambiguous-field', 'unresolved-field', 'missing-currency'].includes(issue.code)) return false;
        const sectionConflicts = issue.sectionId ? conflicts.get(issue.sectionId) : undefined;
        return issue.code !== 'conflicting-field' || !sectionConflicts || sectionConflicts.has(issue.fieldId);
    });
    const reported = new Set(issues.filter(issue => issue.code === 'conflicting-field').map(issue => issue.fieldId));
    for (const section of affectedSections) {
        const unresolved = conflicts.get(section.sectionId)!;
        for (const field of [...section.amounts, ...section.dates, ...section.references, ...section.currencies]) {
            if (unresolved.has(field.id) && !reported.has(field.id)) issues.push({ code: 'conflicting-field', severity: 'warning',
                message: 'Values for this field still conflict within the document section.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
        }
    }
    return { ...result, sections, issues };
}

// This projection retains original evidence and never rewrites an extraction manifest.
export function applyDocumentCorrections(imports: StoredDocumentImport[], corrections: ReadonlyMap<string, DocumentCorrection>): StoredDocumentImport[] {
    if (!corrections.size) return imports;
    const pending = new Map<string, DocumentCorrection[]>();
    for (const correction of corrections.values()) {
        const fields = pending.get(correction.documentId) ?? [];
        fields.push(correction);
        pending.set(correction.documentId, fields);
    }
    const records = imports.map(record => {
        const files = record.files.map(file => {
            if (file.status !== 'imported') return file;
            const fields = pending.get(file.record.id);
            if (!fields) return file;
            pending.delete(file.record.id);
            return { ...file, record: { ...file.record, result: applyDocumentFieldCorrections(file.record.result, fields) } };
        });
        return files.some((file, index) => file !== record.files[index]) ? { ...record, files } : record;
    });
    if (pending.size) throw new Error('A correction refers to a document outside the workspace imports.');
    return records;
}
