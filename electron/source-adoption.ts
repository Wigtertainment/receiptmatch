import { applyBankCorrections, type BankCorrection } from '../src/shared/bank-corrections.js';
import { applyDocumentCorrections, documentCorrectionKey, type DocumentCorrection } from '../src/shared/document-corrections.js';
import { advanceReviewRevision, type MatchApproval, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import type { OriginalAnalysisComparison } from '../src/shared/original-preview.js';
import { excludedDuplicateIds, type DuplicateDecision } from '../src/shared/transaction-duplicates.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { AnalyzedSource } from './source-analysis.js';
import { compareDocuments, compareStatements } from './source-comparison.js';

interface AdoptionContext {
    reviews: ReadonlyMap<string, string | null>;
    approvals: ReadonlyMap<string, ReviewApprovalState>;
    currentApprovals: ReadonlyMap<string, MatchApproval>;
    bankCorrections: ReadonlyMap<string, BankCorrection>;
    documentCorrections: ReadonlyMap<string, DocumentCorrection>;
    duplicates: ReadonlyMap<string, DuplicateDecision>;
    ignoredTransactions: ReadonlySet<string>;
}

type StatementSource = Extract<AnalyzedSource, { kind: 'statement' }>;
type DocumentSource = Extract<AnalyzedSource, { kind: 'document' }>;
interface AdoptionPlan {
    changes: OriginalAnalysisComparison['changes'];
    conflicts: string[];
    blockingConflict: string | undefined;
    preserved: number;
    revoked: number;
    archive: Map<string, string | null>;
    reviews: Map<string, string | null>;
    approvals: Map<string, ReviewApprovalState>;
    bankCorrections: Map<string, BankCorrection>;
    documentCorrections: Map<string, DocumentCorrection>;
    ignoredTransactions: Set<string>;
}

function transferBankCorrection(state: AdoptionPlan, replacement: StatementSource, label: string, edit?: BankCorrection, unchanged?: string): void {
    if (edit && unchanged) {
        const correction: BankCorrection = { ...edit, rowId: unchanged };
        try {
            applyBankCorrections([replacement.record], new Map([[unchanged, correction]]));
            state.bankCorrections.set(unchanged, correction);
        } catch {
            state.conflicts.push(`${label}: its correction could not be carried forward.`);
        }
    } else if (edit) {
        state.conflicts.push(`${label}: its correction stays with the archived statement.`);
    }
}

function transferIgnoreDecision(state: AdoptionPlan, id: string, next: string | undefined, label: string, canTransfer: boolean): void {
    if (!state.ignoredTransactions.delete(id)) {
        return;
    }
    if (next && canTransfer) {
        state.ignoredTransactions.add(next);
    } else {
        state.conflicts.push(`${label}: its ignore decision could not be transferred safely.`);
    }
}

function transferBankReview(state: AdoptionPlan, id: string, next: string | undefined, label: string, canTransfer: boolean, excluded: boolean, changed: boolean): boolean {
    const review: string | null | undefined = state.reviews.get(id);
    if (review === undefined) {
        return false;
    }
    state.archive.set(id, review);
    state.reviews.delete(id);
    state.approvals.set(id, advanceReviewRevision(state.approvals.get(id)));
    if (next && !excluded && canTransfer) {
        state.reviews.set(next, review);
        state.approvals.set(next, advanceReviewRevision());
        state.preserved++;
    } else {
        state.conflicts.push(`${label}: its review stays in history because it could not be transferred safely.`);
    }
    if (changed) {
        state.conflicts.push(`${label}: its booking details changed and the replacement needs a new review.`);
    }
    return true;
}

function transferBankApproval(state: AdoptionPlan, approval: MatchApproval | undefined, edit: BankCorrection | undefined, unchanged: string | undefined): void {
    if (!approval) {
        return;
    }
    if (unchanged && state.reviews.has(unchanged) && (!edit || state.bankCorrections.has(unchanged))) {
        const { associationRevision }: ReviewApprovalState = state.approvals.get(unchanged)!;
        state.approvals.set(unchanged, { associationRevision, approval: { ...approval, transactionId: unchanged,
            transactionRevision: state.bankCorrections.get(unchanged)?.revision ?? 1, associationRevision } });
    } else {
        state.revoked++;
    }
}

function prepareStatementAdoption(original: StatementSource, replacement: StatementSource, context: AdoptionContext, state: AdoptionPlan): void {
    const comparison: ReturnType<typeof compareStatements> = compareStatements(original.record, replacement.record);
    if (!comparison.compatible) {
        throw new Error('The selected statement belongs to a different bank or account.');
    }
    state.changes = comparison.changes;
    state.conflicts.push(...comparison.conflicts);
    const oldRows: string[] = [...original.record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId), ...original.record.drafts.map((row: { rowId: string; draftId: string; }): string => row.draftId)];
    const oldIds: Set<string> = new Set(oldRows);
    state.blockingConflict = [...context.duplicates.values()].some((decision: DuplicateDecision): boolean | "" | null => decision.primaryId && oldIds.has(decision.primaryId)) ?
        'This statement contains a leading booking. Undo its duplicate exclusion before replacing the statement so the other booking can be reviewed.' : undefined;
    if (state.blockingConflict) {
        state.conflicts.push(state.blockingConflict);
    }
    const duplicateIds: Set<string> = new Set([...context.duplicates.values()].flatMap((decision: DuplicateDecision): string[] => [decision.firstId, decision.secondId]));
    const excluded: Set<string> = excludedDuplicateIds(context.duplicates.values());
    for (const [index, id] of oldRows.entries()) {
        const next: string | undefined = comparison.pairs.get(id) ?? comparison.draftPairs.get(id);
        const isBooking: boolean = index < original.record.transactions.length;
        const label: string = isBooking ? `Booking ${index + 1}` : `Unresolved row ${index - original.record.transactions.length + 1}`;
        const edit: BankCorrection | undefined = context.bankCorrections.get(id);
        transferBankCorrection(state, replacement, label, edit, next);
        if (duplicateIds.has(id)) {
            state.conflicts.push(`${label}: its duplicate decision stays with the archived statement and needs review on the replacement.`);
        }
        const canTransfer: boolean = isBooking || (next !== undefined && state.bankCorrections.has(next));
        transferIgnoreDecision(state, id, next, label, canTransfer);
        if (!transferBankReview(state, id, next, label, canTransfer, excluded.has(id), comparison.changedPairs.has(id))) {
            continue;
        }
        transferBankApproval(state, context.currentApprovals.get(id), edit, next);
    }
}

function transferDocumentCorrections(original: DocumentSource, replacement: DocumentSource, corrections: ReadonlyMap<string, DocumentCorrection>, comparison: ReturnType<typeof compareDocuments>, state: AdoptionPlan): void {
    for (const edit of corrections.values()) {
        if (edit.documentId !== original.record.id) {
            continue;
        }
        const sectionId: string | undefined = comparison.sections.get(edit.sectionId);
        const fieldId: string | null | undefined = edit.fieldId === null ? null : comparison.fields.get(edit.fieldId);
        if (!sectionId || fieldId === undefined) {
            state.conflicts.push('A manual document correction stays with the archived document because its field changed or is ambiguous.');
            continue;
        }
        const correction: DocumentCorrection = { ...edit, documentId: replacement.record.id, sectionId, fieldId };
        const key: string = documentCorrectionKey(correction, edit.change.kind);
        const transferred: Map<string, DocumentCorrection> = new Map([...state.documentCorrections].filter(([, value]: [string, DocumentCorrection]): boolean => value.documentId === replacement.record.id)).set(key, correction);
        try {
            applyDocumentCorrections([replacement.run], transferred);
            state.documentCorrections.set(key, correction);
        } catch {
            state.conflicts.push('A manual document correction could not be carried forward to the new analysis.');
        }
    }
}

function prepareDocumentAdoption(original: DocumentSource, replacement: DocumentSource, context: AdoptionContext, state: AdoptionPlan): void {
    const comparison: ReturnType<typeof compareDocuments> = compareDocuments(original.record, replacement.record);
    state.changes = comparison.changes;
    state.conflicts.push(...comparison.conflicts);
    const excluded: Set<string> = excludedDuplicateIds(context.duplicates.values());
    for (const [id, documentId] of state.reviews) {
        if (documentId !== original.record.id) {
            continue;
        }
        state.archive.set(id, documentId);
        if (comparison.sections.size === original.record.result.sections.length) {
            state.reviews.set(id, replacement.record.id);
            state.preserved++;
        } else {
            state.reviews.delete(id);
            state.conflicts.push('The prior document assignment stays in history because the replacement does not have a corresponding section.');
        }
        state.approvals.set(id, advanceReviewRevision(state.approvals.get(id)));
        if (context.currentApprovals.has(id) && !excluded.has(id)) {
            state.revoked++;
        }
    }
    transferDocumentCorrections(original, replacement, context.documentCorrections, comparison, state);
}

export function prepareAdoption(original: AnalyzedSource, replacement: AnalyzedSource, context: AdoptionContext): AdoptionPlan {
    const state: AdoptionPlan = {
        changes: [], conflicts: [], blockingConflict: undefined, preserved: 0, revoked: 0, archive: new Map(),
        reviews: new Map(context.reviews), approvals: new Map(context.approvals), bankCorrections: new Map(context.bankCorrections),
        documentCorrections: new Map(context.documentCorrections), ignoredTransactions: new Set(context.ignoredTransactions),
    };
    if (original.kind === 'statement' && replacement.kind === 'statement') {
        prepareStatementAdoption(original, replacement, context, state);
    } else if (original.kind === 'document' && replacement.kind === 'document') {
        prepareDocumentAdoption(original, replacement, context, state);
    } else {
        throw new Error('The replacement must have the same source type.');
    }
    const uniqueConflicts: string[] = [...new Set(state.conflicts)];
    if (uniqueConflicts.length > 100) {
        uniqueConflicts.splice(99, uniqueConflicts.length - 99, `${uniqueConflicts.length - 99} additional conflicts remain in the archived analysis.`);
    }
    return { ...state, conflicts: uniqueConflicts };
}

export function supportingDocumentSource(imports: StoredDocumentImport[], id: string): Extract<AnalyzedSource, { kind: 'document' }> | null {
    for (const run of imports) {
        for (const file of run.files) {
        if (file.status === 'imported' && file.record.id === id) {
            return { kind: 'document', record: file.record, run };
        }
    }
    }
    return null;
}
