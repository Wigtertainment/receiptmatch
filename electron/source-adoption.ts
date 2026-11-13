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
}

export function prepareAdoption(original: AnalyzedSource, replacement: AnalyzedSource, context: AdoptionContext) {
    const reviews = new Map(context.reviews), approvals = new Map(context.approvals);
    const bankCorrections = new Map(context.bankCorrections), documentCorrections = new Map(context.documentCorrections);
    const archive = new Map<string, string | null>();
    const conflicts: string[] = [];
    let changes: OriginalAnalysisComparison['changes'], preserved = 0, revoked = 0;
    let blockingConflict: string | undefined;
    if (original.kind === 'statement' && replacement.kind === 'statement') {
        const comparison = compareStatements(original.record, replacement.record);
        if (!comparison.compatible) throw new Error('The selected statement belongs to a different bank or account.');
        changes = comparison.changes;
        conflicts.push(...comparison.conflicts);
        const oldRows = [...original.record.transactions.map(row => row.transactionId), ...original.record.drafts.map(row => row.draftId)];
        const oldIds = new Set(oldRows);
        blockingConflict = [...context.duplicates.values()].some(decision => decision.primaryId && oldIds.has(decision.primaryId)) ?
            'This statement contains a leading booking. Undo its duplicate exclusion before replacing the statement so the other booking can be reviewed.' : undefined;
        if (blockingConflict) conflicts.push(blockingConflict);
        const duplicateIds = new Set([...context.duplicates.values()].flatMap(decision => [decision.firstId, decision.secondId]));
        const excluded = excludedDuplicateIds(context.duplicates.values());
        for (const [index, id] of oldRows.entries()) {
            const unchanged = comparison.pairs.get(id) ?? comparison.draftPairs.get(id);
            const next = unchanged;
            const label = index < original.record.transactions.length ? `Booking ${index + 1}` : `Unresolved row ${index - original.record.transactions.length + 1}`;
            const edit = context.bankCorrections.get(id);
            if (edit && unchanged) {
                const correction = { ...edit, rowId: unchanged };
                try {
                    applyBankCorrections([replacement.record], new Map([[unchanged, correction]]));
                    bankCorrections.set(unchanged, correction);
                } catch { conflicts.push(`${label}: its correction could not be carried forward.`); }
            } else if (edit) conflicts.push(`${label}: its correction stays with the archived statement.`);
            if (duplicateIds.has(id)) conflicts.push(`${label}: its duplicate decision stays with the archived statement and needs review on the replacement.`);
            const review = reviews.get(id);
            if (review === undefined) continue;
            archive.set(id, review);
            reviews.delete(id);
            approvals.set(id, advanceReviewRevision(approvals.get(id)));
            if (next && !excluded.has(id) && (index < original.record.transactions.length || bankCorrections.has(next))) {
                reviews.set(next, review);
                approvals.set(next, advanceReviewRevision());
                preserved++;
            }
            else conflicts.push(`${label}: its review stays in history because it could not be transferred safely.`);
            if (comparison.changedPairs.has(id)) conflicts.push(`${label}: its booking details changed and the replacement needs a new review.`);
            const approval = context.currentApprovals.get(id);
            if (!approval) continue;
            if (unchanged && reviews.has(unchanged) && (!edit || bankCorrections.has(unchanged))) {
                const { associationRevision } = approvals.get(unchanged)!;
                approvals.set(unchanged, { associationRevision, approval: { ...approval, transactionId: unchanged,
                    transactionRevision: bankCorrections.get(unchanged)?.revision ?? 1, associationRevision } });
            } else revoked++;
        }
    } else if (original.kind === 'document' && replacement.kind === 'document') {
        const comparison = compareDocuments(original.record, replacement.record);
        changes = comparison.changes;
        conflicts.push(...comparison.conflicts);
        const excluded = excludedDuplicateIds(context.duplicates.values());
        for (const [id, documentId] of reviews) {
            if (documentId !== original.record.id) continue;
            archive.set(id, documentId);
            if (comparison.sections.size === original.record.result.sections.length) {
                reviews.set(id, replacement.record.id);
                preserved++;
            }
            else {
                reviews.delete(id);
                conflicts.push('The prior document assignment stays in history because the replacement does not have a corresponding section.');
            }
            approvals.set(id, advanceReviewRevision(approvals.get(id)));
            if (context.currentApprovals.has(id) && !excluded.has(id)) revoked++;
        }
        for (const edit of context.documentCorrections.values()) {
            if (edit.documentId !== original.record.id) continue;
            const sectionId = comparison.sections.get(edit.sectionId);
            const fieldId = edit.fieldId === null ? null : comparison.fields.get(edit.fieldId);
            if (!sectionId || fieldId === undefined) {
                conflicts.push('A manual document correction stays with the archived document because its field changed or is ambiguous.');
                continue;
            }
            const correction = { ...edit, documentId: replacement.record.id, sectionId, fieldId };
            const key = documentCorrectionKey(correction, edit.change.kind);
            const transferred = new Map([...documentCorrections].filter(([, value]) => value.documentId === replacement.record.id)).set(key, correction);
            try {
                applyDocumentCorrections([replacement.run], transferred);
                documentCorrections.set(key, correction);
            } catch { conflicts.push('A manual document correction could not be carried forward to the new analysis.'); }
        }
    } else throw new Error('The replacement must have the same source type.');
    const uniqueConflicts = [...new Set(conflicts)];
    if (uniqueConflicts.length > 100) uniqueConflicts.splice(99, uniqueConflicts.length - 99, `${uniqueConflicts.length - 99} additional conflicts remain in the archived analysis.`);
    return { changes, conflicts: uniqueConflicts, blockingConflict, preserved, revoked, archive, reviews, approvals, bankCorrections, documentCorrections };
}

export function supportingDocumentSource(imports: StoredDocumentImport[], id: string): Extract<AnalyzedSource, { kind: 'document' }> | null {
    for (const run of imports) for (const file of run.files) {
        if (file.status === 'imported' && file.record.id === id) return { kind: 'document', record: file.record, run };
    }
    return null;
}
