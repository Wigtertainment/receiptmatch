import { advanceReviewRevision, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import { activeStatements } from '../src/shared/source-replacements.js';
import { excludeDuplicateTransactions, secondaryDuplicateId, type DuplicateDecision } from '../src/shared/transaction-duplicates.js';
import type { DocumentFileResult, StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { ISavedWorkspace } from './store.js';

type ReviewState = Pick<ISavedWorkspace, 'matchDecisions' | 'reviewApprovals' | 'duplicateDecisions' | 'sourceReplacements' | 'archivedSourceReviews'>;

function remainingArchivedReviews(
  current: ReviewState['archivedSourceReviews'], replacements: ReadonlyMap<string, string>, removedRows: ReadonlySet<string>
): ReviewState['archivedSourceReviews'] {
  const archives: ReviewState['archivedSourceReviews'] = new Map();
  for (const [sourceId, reviews] of current) {
    if (!replacements.has(sourceId)) {
      continue;
    }
    const remaining: Map<string, string | null> = new Map([...reviews].filter(([id]: [string, string | null]): boolean => !removedRows.has(id)));
    if (remaining.size) {
      archives.set(sourceId, remaining);
    }
  }
  return archives;
}

function restoreAvailableReviews(
  candidates: ReadonlyMap<string, string | null>, active: StoredBankImport[], remaining: StoredBankImport[],
  documents: readonly StoredDocumentImport[], state: ReviewState
): void {
  if (!candidates.size) {
    return;
  }
  const bookingIds: Set<string> = new Set(active.flatMap((record: StoredBankImport): string[] =>
    record.transactions.map((row: StoredBankImport['transactions'][number]): string => row.transactionId)));
  const archivedBookings: Map<string, string> = new Map(remaining.flatMap((record: StoredBankImport): [string, string][] => {
    const sourceId: string = record.result.sourceProvenance!.sourceId;
    return state.sourceReplacements.has(sourceId) ?
      record.transactions.map((row: StoredBankImport['transactions'][number]): [string, string] => [row.transactionId, sourceId]) : [];
  }));
  const documentSources: Map<string, string> = new Map(documents.flatMap((run: StoredDocumentImport): [string, string][] =>
    run.files.flatMap((file: DocumentFileResult): [string, string][] =>
      file.status === 'imported' ? [[file.record.id, file.record.result.input!.source.sourceId]] : [])));
  const assigned: Set<string | null> = new Set(state.matchDecisions.values());
  const claims: Map<string | null, string[]> = new Map();
  for (const [bookingId, documentId] of candidates) {
    const bankSource: string | undefined = archivedBookings.get(bookingId);
    const docSource: string | undefined = documentId === null ? undefined : documentSources.get(documentId);
    if ((!bankSource && !bookingIds.has(bookingId)) || state.matchDecisions.has(bookingId) || (documentId !== null && !docSource)) {
      continue;
    }
    const sourceId: string | undefined = bankSource ?? docSource;
    if (sourceId && state.sourceReplacements.has(sourceId)) {
      archiveReview(state.archivedSourceReviews, sourceId, bookingId, documentId);
    } else if (documentId === null || !assigned.has(documentId)) {
      const bookings: string[] = claims.get(documentId) ?? [];
      bookings.push(bookingId);
      claims.set(documentId, bookings);
    }
  }
  applyReviewClaims(claims, state);
}

function applyReviewClaims(claims: ReadonlyMap<string | null, string[]>, state: ReviewState): void {
  for (const [documentId, bookings] of claims) {
    if (documentId !== null && bookings.length !== 1) {
      continue;
    }
    for (const bookingId of bookings) {
      state.matchDecisions.set(bookingId, documentId);
      state.reviewApprovals.set(bookingId, advanceReviewRevision(state.reviewApprovals.get(bookingId)));
    }
  }
}

function archiveReview(archives: ReviewState['archivedSourceReviews'], sourceId: string, bookingId: string, documentId: string | null): void {
  const reviews: Map<string, string | null> = archives.get(sourceId) ?? new Map<string, string | null>();
  if (!reviews.has(bookingId)) {
    reviews.set(bookingId, documentId);
    archives.set(sourceId, reviews);
  }
}

export function prepareStatementRemoval(
  sourceId: string, removedRows: ReadonlySet<string>, remaining: StoredBankImport[], documents: readonly StoredDocumentImport[], state: ReviewState
): ReviewState & Record<'active', StoredBankImport[]> {
  const sourceReplacements: Map<string, string> = new Map(state.sourceReplacements);
  const predecessor: string | undefined = [...sourceReplacements].find(([, target]: [string, string]): boolean => target === sourceId)?.[0];
  const successor: string | undefined = sourceReplacements.get(sourceId);
  const candidates: Map<string, string | null> = new Map(predecessor && !successor ? state.archivedSourceReviews.get(predecessor) : undefined);
  sourceReplacements.delete(sourceId);
  if (predecessor) {
    if (successor) {
      sourceReplacements.set(predecessor, successor);
    } else {
      sourceReplacements.delete(predecessor);
    }
  }

  const duplicateDecisions: Map<string, DuplicateDecision> = new Map(state.duplicateDecisions);
  for (const [key, decision] of state.duplicateDecisions) {
    if (removedRows.has(decision.firstId) || removedRows.has(decision.secondId)) {
      duplicateDecisions.delete(key);
      const secondary: string | null = secondaryDuplicateId(decision);
      if (secondary && decision.archivedReview && !candidates.has(secondary)) {
        candidates.set(secondary, decision.archivedReview.documentId);
      }
    }
  }
  const matchDecisions: Map<string, string | null> = new Map(state.matchDecisions);
  const reviewApprovals: Map<string, ReviewApprovalState> = new Map(state.reviewApprovals);
  for (const id of removedRows) {
    matchDecisions.delete(id);
    reviewApprovals.delete(id);
  }
  const active: StoredBankImport[] = excludeDuplicateTransactions(activeStatements(remaining, sourceReplacements), duplicateDecisions.values());
  const archivedSourceReviews: ReviewState['archivedSourceReviews'] = remainingArchivedReviews(state.archivedSourceReviews, sourceReplacements, removedRows);
  const next: ReviewState = { sourceReplacements, duplicateDecisions, matchDecisions, reviewApprovals, archivedSourceReviews };
  restoreAvailableReviews(candidates, active, remaining, documents, next);
  return { ...next, active };
}
