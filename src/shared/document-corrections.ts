import type { ImportIssue } from "./bank-import.js";
import { z } from 'zod';
import { calendarDateSchema } from './bank-import.js';
import { moneySchema } from './money.js';
import { documentScalarConflicts, type DocumentIssue, type DocumentSection, type SupportingDocument } from './supporting-document.js';
import type { StoredDocumentImport, StoredSupportingDocument } from './workspace-documents.js';

const fieldId: z.ZodString = z.string().min(1).max(128);
const text: z.ZodString = z.string().trim().min(1).max(16384);
const referenceRole: z.ZodEnum<{ invoice: 'invoice'; receipt: 'receipt'; payment: 'payment'; order: 'order'; customer: 'customer'; account: 'account'; table: 'table'; 'related-invoice': 'related-invoice'; unknown: 'unknown' }> = z.enum(['invoice', 'receipt', 'payment', 'order', 'customer', 'account', 'table', 'related-invoice', 'unknown']);
const currencyRole: z.ZodEnum<{ settlement: 'settlement'; 'informational-fx': 'informational-fx'; unknown: 'unknown' }> = z.enum(['settlement', 'informational-fx', 'unknown']);
const amountChange: z.ZodObject<{ kind: z.ZodLiteral<'amount'>; value: typeof moneySchema }, z.core.$strict> = z.strictObject({ kind: z.literal('amount'), value: moneySchema });
const dateChange: z.ZodObject<{ kind: z.ZodLiteral<'date'>; value: typeof calendarDateSchema }, z.core.$strict> = z.strictObject({ kind: z.literal('date'), value: calendarDateSchema });
const merchantChange: z.ZodObject<{ kind: z.ZodLiteral<'merchant'>; value: z.ZodString }, z.core.$strict> = z.strictObject({ kind: z.literal('merchant'), value: text });
const referenceChange: z.ZodObject<{ kind: z.ZodLiteral<'reference'>; role: typeof referenceRole; value: z.ZodString }, z.core.$strict> = z.strictObject({ kind: z.literal('reference'), role: referenceRole, value: text });
const currencyChange: z.ZodObject<{ kind: z.ZodLiteral<'currency'>; role: typeof currencyRole; value: z.ZodString }, z.core.$strict> = z.strictObject({ kind: z.literal('currency'), role: currencyRole, value: moneySchema.shape.currency });
export const documentCorrectionTarget: { documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodNullable<z.ZodString> } = { documentId: z.uuid(), sectionId: fieldId, fieldId: fieldId.nullable() };
export const documentCorrectionValueSchema: z.ZodDiscriminatedUnion<[typeof amountChange, typeof dateChange, typeof merchantChange, typeof referenceChange, typeof currencyChange], 'kind'> = z.discriminatedUnion('kind', [amountChange, dateChange, merchantChange, referenceChange, currencyChange]);
export const documentCorrectionSchema: z.ZodObject<{ revision: z.ZodNumber; change: typeof documentCorrectionValueSchema; documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodNullable<z.ZodString> }, z.core.$strict> = z.strictObject({
    ...documentCorrectionTarget, revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER), change: documentCorrectionValueSchema
});
export type DocumentCorrection = z.infer<typeof documentCorrectionSchema>;
export type DocumentCorrectionValue = z.infer<typeof documentCorrectionValueSchema>;
export type DocumentCorrectionTarget = Pick<DocumentCorrection, 'documentId' | 'sectionId' | 'fieldId'>;
export type MissingDocumentCorrectionField = { kind: 'merchant'; role: 'merchant'; label: string } |
    { kind: 'reference'; role: DocumentSection['references'][number]['role']; label: string } |
    { kind: 'currency'; role: DocumentSection['currencies'][number]['role']; label: string };
type DocumentField = DocumentSection['amounts' | 'dates' | 'merchants' | 'references' | 'currencies'][number];
const collections: Record<DocumentCorrectionValue['kind'], 'amounts' | 'dates' | 'merchants' | 'references' | 'currencies'> = { amount: 'amounts', date: 'dates', merchant: 'merchants', reference: 'references', currency: 'currencies' };

export function documentCorrectionKey(target: DocumentCorrectionTarget, kind: DocumentCorrectionValue['kind'], role?: string): string {
    const key: (string | null | undefined)[] = [target.documentId, target.sectionId, target.fieldId, target.fieldId === null ? kind : null];
    if (target.fieldId === null && (kind === 'reference' || kind === 'currency')) {
        key.push(role);
    }
    return JSON.stringify(key);
}

export function missingDocumentCorrectionFields(section: DocumentSection): MissingDocumentCorrectionField[] {
    if (section.kind === 'unknown') {
        return [];
    }
    const missing: MissingDocumentCorrectionField[] = [];
    if (!section.merchants.length) {
        missing.push({ kind: 'merchant', role: 'merchant', label: 'Merchant' });
    }
    const role: 'invoice' | 'receipt' | 'payment' = section.kind === 'receipt' ? 'receipt' : section.kind === 'payment-information' ? 'payment' : 'invoice';
    if (!section.references.some((field: DocumentSection['references'][number]): boolean => field.role === role)) {
        missing.push({ kind: 'reference', role, label: role === 'receipt' ? 'Receipt reference' : role === 'payment' ? 'Payment reference' : 'Invoice reference' });
    }
    if (!section.currencies.some((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement') && section.amounts.some((field: DocumentSection['amounts'][number]): boolean => field.role !== 'informational-fx' && field.candidates.some((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => value.currency === null))) {
        missing.push({ kind: 'currency', role: 'settlement', label: 'Settlement currency' });
    }
    return missing;
}

function correctExistingField(section: DocumentSection, original: DocumentSection, fieldId: string, change: DocumentCorrectionValue): void {
    const collection: typeof collections[DocumentCorrectionValue['kind']] = collections[change.kind];
    const index: number = section[collection].findIndex((field: DocumentField): boolean => field.id === fieldId);
    const source: DocumentField | undefined = original[collection].find((field: DocumentField): boolean => field.id === fieldId);
    if (index < 0 || !source || ('role' in change && source.role !== change.role)) {
        throw new Error('The document field for this correction is not available or has a different role.');
    }
    switch (change.kind) {
        case 'amount': section.amounts[index] = { ...section.amounts[index], candidates: [change.value] }; break;
        case 'date': section.dates[index] = { ...section.dates[index], candidates: [change.value] }; break;
        case 'merchant': section.merchants[index] = { ...section.merchants[index], candidates: [change.value], correctedByUser: true }; break;
        case 'reference': {
            const reference: DocumentSection['references'][number] = { ...section.references[index], candidates: [change.value], correctedByUser: true };
            delete reference.confirmedByUser;
            section.references[index] = reference;
            break;
        }
        case 'currency': section.currencies[index] = { ...section.currencies[index], candidates: [change.value], correctedByUser: true }; break;
    }
}

function supplyMissingField(section: DocumentSection, original: DocumentSection, issues: DocumentIssue[], change: DocumentCorrectionValue, sectionNumber: number,
    ids: Set<string>, suppliedFields: Map<string, Set<string>>): void {
    const missing: string = change.kind === 'amount' ? 'billed-total' : change.kind === 'date' ? 'issue' : change.kind === 'reference' ? 'document-reference' : change.kind;
    const totalRole: 'billed-total' | 'credit-note-component' = original.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
    const legacy: boolean = change.kind === 'amount' || change.kind === 'date';
    const exists: boolean = change.kind === 'amount' ? original.amounts.some((field: DocumentSection['amounts'][number]): boolean => field.role === totalRole) : original.dates.some((field: DocumentSection['dates'][number]): boolean => field.role === 'issue');
    const allowed: boolean = legacy ? !exists && issues.some((issue: DocumentIssue): boolean => issue.sectionId === section.sectionId && issue.fieldId === null && issue.field === missing && issue.code === 'missing-field') :
        missingDocumentCorrectionFields(original).some((slot: MissingDocumentCorrectionField): boolean => slot.kind === change.kind && (!('role' in change) || slot.role === change.role));
    if (original.kind === 'unknown' || !allowed) {
        throw new Error('This document section has no matching missing field to correct.');
    }
    const base: string = 'manual-' + change.kind + '-' + sectionNumber + ('role' in change ? '-' + change.role : '');
    let id: string = base;
    for (let suffix: number = 2; ids.has(id); suffix++) {
        id = base + '-' + suffix;
    }
    ids.add(id);
    switch (change.kind) {
        case 'amount': section.amounts.push({ id, role: totalRole, label: 'Manually entered total', candidates: [change.value], evidence: [] }); break;
        case 'date': section.dates.push({ id, role: 'issue', label: 'Manually entered issue date', candidates: [change.value], evidence: [] }); break;
        case 'merchant': section.merchants.push({ id, role: 'merchant', label: 'Manually entered merchant', candidates: [change.value], evidence: [], correctedByUser: true }); break;
        case 'reference': section.references.push({ id, role: change.role, label: 'Manually entered reference', candidates: [change.value], evidence: [], correctedByUser: true }); break;
        case 'currency': section.currencies.push({ id, role: change.role, label: 'Manually entered currency', candidates: [change.value], evidence: [], correctedByUser: true }); break;
    }
    const roles: Set<string> = suppliedFields.get(section.sectionId) ?? new Set();
    roles.add(missing);
    suppliedFields.set(section.sectionId, roles);
}

function applySettlementCurrency(section: DocumentSection, original: DocumentSection, explicitAmounts: ReadonlySet<string>, correctedFields: Set<string>): void {
    const currencies: Set<string> = new Set(section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement').flatMap((field: DocumentSection['currencies'][number]): string[] => field.candidates));
    if (currencies.size !== 1) {
        return;
    }
    const currency: string = [...currencies][0];
    section.amounts = section.amounts.map((field: DocumentSection['amounts'][number]): DocumentSection['amounts'][number] => {
        const source: DocumentSection['amounts'][number] | undefined = original.amounts.find((item: DocumentSection['amounts'][number]): boolean => item.id === field.id);
        if (field.role === 'informational-fx' || explicitAmounts.has(field.id) || !source || source.candidates.some((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => value.currency !== null)) {
            return field;
        }
        correctedFields.add(field.id);
        return { ...field, candidates: field.candidates.map((value: DocumentSection['amounts'][number]['candidates'][number]): DocumentSection['amounts'][number]['candidates'][number] => ({ ...value, currency })) };
    });
}

function settlementConflicts(section: DocumentSection): Set<string> {
    const declarations: DocumentSection['currencies'] = section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement');
    const currencies: Set<string> = new Set(declarations.flatMap((field: DocumentSection['currencies'][number]): string[] => field.candidates));
    const conflicts: Set<string> = new Set();
    if (currencies.size === 1) {
        for (const field of section.amounts) {
            if (['billed-total', 'balance-due', 'credit-note-component'].includes(field.role) && field.candidates.some((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => value.currency !== null && !currencies.has(value.currency))) {
                conflicts.add(field.id);
            }
        }
        if (conflicts.size) {
            for (const declaration of declarations) {
                conflicts.add(declaration.id);
            }
        }
    }
    return conflicts;
}

function correctedIssues(result: SupportingDocument, affectedSections: Set<DocumentSection>, settlementSections: Set<string>, suppliedFields: Map<string, Set<string>>, correctedFields: Set<string>): DocumentIssue[] {
    const conflicts: Map<string, Set<string>> = new Map([...affectedSections].map((section: DocumentSection): [string, Set<string>] => [section.sectionId,
        new Set([...documentScalarConflicts(section), ...(settlementSections.has(section.sectionId) ? settlementConflicts(section) : [])])]));
    const issues: DocumentIssue[] = result.issues.filter((issue: DocumentIssue): boolean => {
        if (issue.sectionId && issue.field && issue.fieldId === null && issue.code === 'missing-field' && suppliedFields.get(issue.sectionId)?.has(issue.field)) {
            return false;
        }
        if (!issue.fieldId) {
            return true;
        }
        if (correctedFields.has(issue.fieldId) && ['ambiguous-field', 'unresolved-field', 'missing-currency', 'unconfirmed-merchant'].includes(issue.code)) {
            return false;
        }
        const sectionConflicts: Set<string> | undefined = issue.sectionId ? conflicts.get(issue.sectionId) : undefined;
        return issue.code !== 'conflicting-field' || !sectionConflicts || sectionConflicts.has(issue.fieldId);
    });
    const reported: Set<string | null> = new Set(issues.filter((issue: DocumentIssue): boolean => issue.code === 'conflicting-field').map((issue: DocumentIssue): string | null => issue.fieldId));
    for (const section of affectedSections) {
        for (const field of [...section.amounts, ...section.dates, ...section.references, ...section.currencies]) {
            if (conflicts.get(section.sectionId)!.has(field.id) && !reported.has(field.id)) {
                issues.push({ code: 'conflicting-field', severity: 'warning', message: 'Values for this field still conflict within the document section.', sectionId: section.sectionId, fieldId: field.id, field: field.role, evidence: field.evidence });
            }
        }
    }
    return issues;
}

export function applyDocumentFieldCorrections(result: SupportingDocument, corrections: readonly DocumentCorrection[], original: SupportingDocument = result): SupportingDocument {
    if (!corrections.length) {
        return result;
    }
    const sections: DocumentSection[] = result.sections.map((section: DocumentSection): DocumentSection => ({ ...section, amounts: [...section.amounts], dates: [...section.dates], merchants: [...section.merchants], references: [...section.references], currencies: [...section.currencies] }));
    const bySection: Map<string, DocumentSection> = new Map(sections.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
    const originals: Map<string, DocumentSection> = new Map(original.sections.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
    const ids: Set<string> = new Set(sections.flatMap((section: DocumentSection): string[] => [section.sectionId, ...[...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies].map((field: DocumentField): string => field.id)]));
    const correctedFields: Set<string> = new Set();
    const explicitAmounts: Set<string> = new Set(corrections.filter((correction: DocumentCorrection): boolean => correction.change.kind === 'amount' && correction.fieldId !== null).map((correction: DocumentCorrection): string => correction.fieldId!));
    const suppliedFields: Map<string, Set<string>> = new Map();
    const affectedSections: Set<DocumentSection> = new Set();
    const settlementSections: Set<string> = new Set();
    for (const { sectionId, fieldId, change } of corrections) {
        const section: DocumentSection | undefined = bySection.get(sectionId);
        const source: DocumentSection | undefined = originals.get(sectionId);
        if (!section || !source) {
            throw new Error('The document section for this correction is not available.');
        }
        affectedSections.add(section);
        if (change.kind === 'currency' && change.role === 'settlement') {
            settlementSections.add(sectionId);
        }
        if (fieldId !== null) {
            correctExistingField(section, source, fieldId, change);
            correctedFields.add(fieldId);
        } else {
            supplyMissingField(section, source, original.issues, change, sections.indexOf(section) + 1, ids, suppliedFields);
        }
    }
    for (const sectionId of settlementSections) {
        applySettlementCurrency(bySection.get(sectionId)!, originals.get(sectionId)!, explicitAmounts, correctedFields);
    }
    const issues: DocumentIssue[] = correctedIssues(result, affectedSections, settlementSections, suppliedFields, correctedFields);
    const extended: boolean = corrections.some((correction: DocumentCorrection): boolean => !['amount', 'date'].includes(correction.change.kind));
    return { ...result, sections, issues, ...(extended ? { status: issues.length ? 'partial' : 'complete' } as const : {}) };
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
