import { z } from 'zod';
import type { ExtractionProgress } from './pdf-extraction.js';
import type { BankImportSummary, StoredBankImport } from './workspace-import.js';
import type { ImportIssue } from './bank-import.js';
import type { DocumentImportProgress, StoredDocumentImport } from './workspace-documents.js';
import { matchReviewSchema, type MatchDetails, type MatchReviewCounts, type MatchSummary } from './workspace-matching.js';
import { bankCorrectionChangesSchema, type BankCorrection } from './bank-corrections.js';
import { documentCorrectionTarget, documentCorrectionValueSchema, type DocumentCorrection } from './document-corrections.js';
import type { OriginalPreviewRequest, OriginalPreviewResult } from './original-preview.js';

export const workspaceName = z.string().max(120);
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-state') }),
  z.strictObject({ type: z.literal('new') }),
  z.strictObject({ type: z.literal('open') }),
  z.strictObject({ type: z.literal('save') }),
  z.strictObject({ type: z.literal('import-statement') }),
  z.strictObject({ type: z.literal('import-documents') }),
  z.strictObject({ type: z.literal('cancel-import') }),
  z.strictObject({ type: z.literal('rename'), name: workspaceName }),
  z.strictObject({ type: z.literal('review-match'), revision: z.number().int().nonnegative(), transactionId: z.uuid(), review: matchReviewSchema }),
  z.strictObject({ type: z.literal('correct-bank-row'), revision: z.number().int().nonnegative(), rowId: z.uuid(), changes: bankCorrectionChangesSchema }),
  z.strictObject({ type: z.literal('correct-document-field'), revision: z.number().int().nonnegative(), ...documentCorrectionTarget, change: documentCorrectionValueSchema })
]);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
export const matchRequestSchema = z.strictObject({ revision: z.number().int().nonnegative(), transactionId: z.uuid().optional() });
export interface DocumentImportSummary { id: string; folderPath: string; status: 'finished' | 'cancelled'; imported: number; skipped: number; failed: number; unsupported: number; directoryIssues: number; }
export interface WorkspaceView {
  id: string; loadRevision: number; matchRevision: number; name: string; filePath: string | null; dirty: boolean; savedAt: string | null;
  imports: BankImportSummary[]; documentImports: DocumentImportSummary[]; matchReviewCounts: MatchReviewCounts; bankCorrections: BankCorrection[];
  documentCorrections: DocumentCorrection[];
}
export interface ImportOutcome { status: 'imported' | 'skipped' | 'cancelled' | 'failed' | 'unsupported'; importId: string | null; issues: ImportIssue[]; }
export interface WorkspaceState {
  workspace: WorkspaceView | null;
  busy: boolean;
  error: string | null;
  statementImport: { cancelling: boolean; progress: ExtractionProgress | null } | null;
  importOutcome: ImportOutcome | null;
  documentImport: { cancelling: boolean; progress: DocumentImportProgress | null } | null;
  documentOutcome: { status: 'finished' | 'cancelled' | 'failed'; importId: string | null; issues: ImportIssue[] } | null;
}
export interface WorkspaceBridge {
  command(value: WorkspaceCommand): Promise<WorkspaceState>;
  bankImports(): Promise<StoredBankImport[]>;
  documentImports(): Promise<StoredDocumentImport[]>;
  matchSummaries(revision: number): Promise<MatchSummary[] | null>;
  matchDetails(revision: number, transactionId: string): Promise<MatchDetails | null>;
  openOriginal(request: OriginalPreviewRequest): Promise<OriginalPreviewResult>;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
}
