import { z } from 'zod';
import type { DocumentCorrection } from './document-corrections.js';

const revision = z.number().int().positive();
export const matchApprovalSelectionSchema = z.strictObject({
    transactionId: z.uuid(), documentId: z.uuid(), transactionRevision: revision, documentRevision: revision, associationRevision: revision,
});
const matchApprovalSchema = matchApprovalSelectionSchema.extend({ batchId: z.uuid(), approvedAt: z.iso.datetime() });
export const reviewApprovalStateSchema = z.strictObject({ associationRevision: revision, approval: matchApprovalSchema.nullable() });
export type MatchApprovalSelection = z.infer<typeof matchApprovalSelectionSchema>;
export type MatchApproval = z.infer<typeof matchApprovalSchema>;
export type ReviewApprovalState = z.infer<typeof reviewApprovalStateSchema>;
export type MatchApprovalStatus =
    | { status: 'none' | 'approved' | 'revoked' }
    | { status: 'stale'; change: 'booking' | 'document' | 'booking-and-document' };

export function advanceReviewRevision(previous?: ReviewApprovalState): ReviewApprovalState {
    return { associationRevision: revision.parse((previous?.associationRevision ?? 1) + 1), approval: previous?.approval ?? null };
}

export function documentRevisionIndex(corrections: Iterable<DocumentCorrection>): Map<string, number> {
    const revisions = new Map<string, number>();
    for (const { documentId, revision } of corrections) revisions.set(documentId, Math.max(revisions.get(documentId) ?? 1, revision));
    return revisions;
}

export function sameApprovalSelection(left: MatchApprovalSelection, right: MatchApprovalSelection): boolean {
    return left.transactionId === right.transactionId && left.documentId === right.documentId && left.transactionRevision === right.transactionRevision &&
        left.documentRevision === right.documentRevision && left.associationRevision === right.associationRevision;
}

export function approvalSelectionFor(
    transactionId: string, documentId: string, transactionRevision = 1, documentRevision = 1, associationRevision = 1,
): MatchApprovalSelection {
    return { transactionId, documentId, transactionRevision, documentRevision, associationRevision };
}

export function matchApprovalStatus(approval: MatchApproval | null | undefined, current: MatchApprovalSelection | null): MatchApprovalStatus {
    if (!approval) return { status: 'none' };
    if (!current || approval.transactionId !== current.transactionId || approval.documentId !== current.documentId ||
        approval.associationRevision !== current.associationRevision) return { status: 'revoked' };
    const bookingChanged = approval.transactionRevision !== current.transactionRevision;
    const documentChanged = approval.documentRevision !== current.documentRevision;
    if (!bookingChanged && !documentChanged) return { status: 'approved' };
    return { status: 'stale', change: bookingChanged ? (documentChanged ? 'booking-and-document' : 'booking') : 'document' };
}
