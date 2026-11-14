import { z } from 'zod';
import type { DocumentCorrection } from './document-corrections.js';

const revision: z.ZodNumber = z.number().int().positive();
export const matchApprovalSelectionSchema: z.ZodObject<{ transactionId: z.ZodUUID; documentId: z.ZodUUID; transactionRevision: z.ZodNumber; documentRevision: z.ZodNumber; associationRevision: z.ZodNumber; }, z.core.$strict> = z.strictObject({
    transactionId: z.uuid(), documentId: z.uuid(), transactionRevision: revision, documentRevision: revision, associationRevision: revision,
});
const matchApprovalSchema: z.ZodObject<{ transactionId: z.ZodUUID; documentId: z.ZodUUID; transactionRevision: z.ZodNumber; documentRevision: z.ZodNumber; associationRevision: z.ZodNumber; batchId: z.ZodUUID; approvedAt: z.ZodISODateTime; }, z.core.$strict> = matchApprovalSelectionSchema.extend({ batchId: z.uuid(), approvedAt: z.iso.datetime() });
export const reviewApprovalStateSchema: z.ZodObject<{ associationRevision: z.ZodNumber; approval: z.ZodNullable<typeof matchApprovalSchema>; }, z.core.$strict> = z.strictObject({ associationRevision: revision, approval: matchApprovalSchema.nullable() });
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
    const revisions: Map<string, number> = new Map<string, number>();
    for (const { documentId, revision } of corrections) {
        revisions.set(documentId, Math.max(revisions.get(documentId) ?? 1, revision));
    }
    return revisions;
}

export function sameApprovalSelection(left: MatchApprovalSelection, right: MatchApprovalSelection): boolean {
    return left.transactionId === right.transactionId && left.documentId === right.documentId && left.transactionRevision === right.transactionRevision &&
        left.documentRevision === right.documentRevision && left.associationRevision === right.associationRevision;
}

export function approvalSelectionFor(
    transactionId: string, documentId: string, transactionRevision: number = 1, documentRevision: number = 1, associationRevision: number = 1,
): MatchApprovalSelection {
    return { transactionId, documentId, transactionRevision, documentRevision, associationRevision };
}

export function currentMatchApprovals(
    reviews: ReadonlyMap<string, ReviewApprovalState>, decisions: ReadonlyMap<string, string | null>,
    bookingRevisions: ReadonlyMap<string, { revision: number }>, documentRevisions: ReadonlyMap<string, number>,
): Map<string, MatchApproval> {
    const approvals: Map<string, MatchApproval> = new Map<string, MatchApproval>();
    for (const [transactionId, { approval, associationRevision }] of reviews) {
        const documentId: string | null | undefined = decisions.get(transactionId);
        if (!documentId || !approval) {
            continue;
        }
        const selection: MatchApprovalSelection = approvalSelectionFor(transactionId, documentId, bookingRevisions.get(transactionId)?.revision, documentRevisions.get(documentId), associationRevision);
        if (matchApprovalStatus(approval, selection).status === 'approved') {
            approvals.set(transactionId, approval);
        }
    }
    return approvals;
}

export function matchApprovalStatus(approval: MatchApproval | null | undefined, current: MatchApprovalSelection | null): MatchApprovalStatus {
    if (!approval) {
        return { status: 'none' };
    }
    if (approval.transactionId !== current?.transactionId || approval.documentId !== current.documentId ||
        approval.associationRevision !== current.associationRevision) {
            return { status: 'revoked' };
        }
    const bookingChanged: boolean = approval.transactionRevision !== current.transactionRevision;
    const documentChanged: boolean = approval.documentRevision !== current.documentRevision;
    if (!bookingChanged && !documentChanged) {
        return { status: 'approved' };
    }
    return { status: 'stale', change: bookingChanged ? (documentChanged ? 'booking-and-document' : 'booking') : 'document' };
}
