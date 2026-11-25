import { z } from 'zod';
import type { BankImportResult, TransactionCandidate, UnresolvedDraft } from './bank-import.js';
import { originalAdoptionRequestSchema, type OriginalAdoptionRequest } from './original-preview.js';

interface IStatementAiRequestShape {
    importId: z.ZodUUID;
    loadRevision: z.ZodNumber;
}

export const statementAiRequestSchema: z.ZodObject<z.core.util.Flatten<IStatementAiRequestShape>, z.core.$strict> = z.strictObject({
    importId: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type StatementAiRequest = z.infer<typeof statementAiRequestSchema>;
export const statementAiDiscardRequestSchema: z.ZodObject<Pick<typeof originalAdoptionRequestSchema.shape, 'token' | 'loadRevision'>, z.core.$strict> = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type StatementAiDiscardRequest = z.infer<typeof statementAiDiscardRequestSchema>;
export const statementAiAcceptRequestSchema: typeof originalAdoptionRequestSchema = originalAdoptionRequestSchema;
export type StatementAiAcceptRequest = OriginalAdoptionRequest;

export interface IStatementAiRow { id: string; kind: 'transaction' | 'draft'; row: TransactionCandidate | UnresolvedDraft }
export interface IStatementAiChange { kind: 'unchanged' | 'added' | 'removed' | 'changed' | 'promoted' | 'demoted'; before: IStatementAiRow | null; after: IStatementAiRow | null }
export interface IStatementAiSummary {
    unchanged: number; added: number; removed: number; changed: number; promoted: number; demoted: number;
    beforeTransactions: number; beforeDrafts: number; afterTransactions: number; afterDrafts: number;
}
interface IStatementAiReady { status: 'ready'; model: 'nuextract3'; result: BankImportResult }
interface IStatementAiFailure { status: 'failed' | 'unavailable'; error: string }
interface IStatementAiPreview extends IStatementAiReady {
    token: string;
    previous: BankImportResult;
    changes: IStatementAiChange[];
    summary: IStatementAiSummary;
    conflicts: string[];
    blockingConflict?: string;
}
type IncompleteStatementAiResult = Record<'status', 'cancelled'> | IStatementAiFailure;
export type StatementAiResult = IStatementAiReady | IncompleteStatementAiResult;
export type StatementAiPreviewResult = IStatementAiPreview | IncompleteStatementAiResult;
