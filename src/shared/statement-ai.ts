import { z } from 'zod';
import type { BankImportResult, TransactionCandidate, UnresolvedDraft } from './bank-import.js';
import { originalAdoptionRequestSchema, type OriginalAdoptionRequest } from './original-preview.js';

export const statementAiRequestSchema: z.ZodObject<{ importId: z.ZodUUID; loadRevision: z.ZodNumber }, z.core.$strict> = z.strictObject({
    importId: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type StatementAiRequest = z.infer<typeof statementAiRequestSchema>;
export const statementAiDiscardRequestSchema: z.ZodObject<{ token: z.ZodUUID; loadRevision: z.ZodNumber }, z.core.$strict> = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type StatementAiDiscardRequest = z.infer<typeof statementAiDiscardRequestSchema>;
export const statementAiAcceptRequestSchema: typeof originalAdoptionRequestSchema = originalAdoptionRequestSchema;
export type StatementAiAcceptRequest = OriginalAdoptionRequest;

export interface StatementAiRow { id: string; kind: 'transaction' | 'draft'; row: TransactionCandidate | UnresolvedDraft }
export interface StatementAiChange { kind: 'unchanged' | 'added' | 'removed' | 'changed' | 'promoted' | 'demoted'; before: StatementAiRow | null; after: StatementAiRow | null }
export interface StatementAiSummary {
    unchanged: number; added: number; removed: number; changed: number; promoted: number; demoted: number;
    beforeTransactions: number; beforeDrafts: number; afterTransactions: number; afterDrafts: number;
}
export type StatementAiResult = { status: 'ready'; model: 'nuextract3'; result: BankImportResult } |
    { status: 'cancelled' } | { status: 'failed' | 'unavailable'; error: string };
export type StatementAiPreviewResult = (Extract<StatementAiResult, { status: 'ready' }> & {
    token: string; previous: BankImportResult; changes: StatementAiChange[]; summary: StatementAiSummary; conflicts: string[]; blockingConflict?: string
}) | Exclude<StatementAiResult, { status: 'ready' }>;
