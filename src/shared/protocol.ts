import type { MatchApprovalSelection } from "./match-approvals.js";
import { z } from 'zod';
import type { LocalOcrRequest, LocalOcrStatus } from './local-ocr-settings.js';
import type { ExtractionProgress } from './pdf-extraction.js';
import type { BankImportSummary, StoredBankImport } from './workspace-import.js';
import type { ImportIssue } from './bank-import.js';
import type { DocumentImportProgress, StoredDocumentImport } from './workspace-documents.js';
import type { SupportingDocument } from './supporting-document.js';
import { matchReviewSchema, type MatchDetails, type MatchReviewCounts, type MatchSummary } from './workspace-matching.js';
import { bankCorrectionChangesSchema, type BankCorrection } from './bank-corrections.js';
import { documentCorrectionTarget, documentCorrectionValueSchema, type DocumentCorrection } from './document-corrections.js';
import { matchApprovalSelectionSchema } from './match-approvals.js';
import type { OriginalAdoptionRequest, OriginalAdoptionResult, OriginalAnalysisResult, OriginalPreviewRequest, OriginalPreviewResult, OriginalRelinkResult } from './original-preview.js';
import { exportFilenamePatternLimit } from './export-filename.js';
import type { DocumentExportResponse } from './document-export.js';
import type { DuplicateDecision } from './transaction-duplicates.js';

export const workspaceName: z.ZodString = z.string().max(120);
export const commandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{ type: z.ZodLiteral<"get-state">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"new">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"open">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"save">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"import-statement">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"import-documents">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"cancel-import">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"rename">; name: z.ZodString; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"set-transaction-ignored">; revision: z.ZodNumber; transactionId: z.ZodUUID; ignored: z.ZodBoolean; remember: z.ZodOptional<z.ZodLiteral<true>>; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"review-match">; revision: z.ZodNumber; transactionId: z.ZodUUID; review: z.ZodDiscriminatedUnion<[z.ZodObject<{ status: z.ZodLiteral<"open">; }, z.core.$strict>, z.ZodObject<{ status: z.ZodLiteral<"assigned">; documentId: z.ZodUUID; }, z.core.$strict>, z.ZodObject<{ status: z.ZodLiteral<"completed-without-document">; }, z.core.$strict>], "status">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"set-duplicate-decision">; revision: z.ZodNumber; transactionId: z.ZodUUID; otherTransactionId: z.ZodUUID; decision: z.ZodEnum<{ separate: "separate"; "keep-first": "keep-first"; "keep-second": "keep-second"; clear: "clear"; }>; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"correct-bank-row">; revision: z.ZodNumber; rowId: z.ZodUUID; changes: z.ZodObject<{ bookingDate: z.ZodOptional<z.ZodISODate>; accountAmount: z.ZodOptional<z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>>; }, z.core.$strict>; }, z.core.$strict>, z.ZodObject<{ change: z.ZodDiscriminatedUnion<[z.ZodObject<{ kind: z.ZodLiteral<"amount">; value: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>; }, z.core.$strict>, z.ZodObject<{ kind: z.ZodLiteral<"date">; value: z.ZodISODate; }, z.core.$strict>], "kind">; documentId: z.ZodUUID; sectionId: z.ZodString; fieldId: z.ZodNullable<z.ZodString>; type: z.ZodLiteral<"correct-document-field">; revision: z.ZodNumber; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"approve-matches">; loadRevision: z.ZodNumber; selections: z.ZodArray<z.ZodObject<{ transactionId: z.ZodUUID; documentId: z.ZodUUID; transactionRevision: z.ZodNumber; documentRevision: z.ZodNumber; associationRevision: z.ZodNumber; }, z.core.$strict>>; }, z.core.$strict>], "type"> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-state') }),
  z.strictObject({ type: z.literal('new') }),
  z.strictObject({ type: z.literal('open') }),
  z.strictObject({ type: z.literal('save') }),
  z.strictObject({ type: z.literal('import-statement') }),
  z.strictObject({ type: z.literal('import-documents') }),
  z.strictObject({ type: z.literal('cancel-import') }),
  z.strictObject({ type: z.literal('rename'), name: workspaceName }),
  z.strictObject({ type: z.literal('set-transaction-ignored'), revision: z.number().int().nonnegative(), transactionId: z.uuid(), ignored: z.boolean(), remember: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('review-match'), revision: z.number().int().nonnegative(), transactionId: z.uuid(), review: matchReviewSchema }),
  z.strictObject({ type: z.literal('set-duplicate-decision'), revision: z.number().int().nonnegative(), transactionId: z.uuid(), otherTransactionId: z.uuid(),
    decision: z.enum(['separate', 'keep-first', 'keep-second', 'clear']) }),
  z.strictObject({ type: z.literal('correct-bank-row'), revision: z.number().int().nonnegative(), rowId: z.uuid(), changes: bankCorrectionChangesSchema }),
  z.strictObject({ type: z.literal('correct-document-field'), revision: z.number().int().nonnegative(), ...documentCorrectionTarget, change: documentCorrectionValueSchema }),
  z.strictObject({ type: z.literal('approve-matches'), loadRevision: z.number().int().nonnegative(), selections: z.array(matchApprovalSelectionSchema).min(1)
    .refine((rows: MatchApprovalSelection[]): boolean => new Set(rows.map((row: MatchApprovalSelection): string => row.transactionId.toLowerCase())).size === rows.length) })
]);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
export const exportSettingsRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{ type: z.ZodLiteral<"read">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"save">; pattern: z.ZodString; }, z.core.$strict>], "type"> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read') }),
  z.strictObject({ type: z.literal('save'), pattern: z.string().max(exportFilenamePatternLimit) }),
]);
export type ExportSettingsRequest = z.infer<typeof exportSettingsRequestSchema>;
export const matchRequestSchema: z.ZodObject<{ revision: z.ZodNumber; transactionId: z.ZodOptional<z.ZodUUID>; }, z.core.$strict> = z.strictObject({ revision: z.number().int().nonnegative(), transactionId: z.uuid().optional() });
export const documentSnapshotRequestSchema: z.ZodObject<{ loadRevision: z.ZodNumber; revision: z.ZodNumber; }, z.core.$strict> = z.strictObject({ loadRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative() });
export type DocumentSnapshotRequest = z.infer<typeof documentSnapshotRequestSchema>;
export type OriginalDocumentFields = Pick<SupportingDocument, 'sections' | 'issues'>;
export interface DocumentSnapshot extends DocumentSnapshotRequest {
  reports: StoredDocumentImport[];
  originals: Record<string, OriginalDocumentFields>;
}
export const documentExportRequestSchema: z.ZodObject<{ loadRevision: z.ZodNumber; includeCsv: z.ZodDefault<z.ZodBoolean>; }, z.core.$strict> = z.strictObject({ loadRevision: z.number().int().nonnegative(), includeCsv: z.boolean().default(false) });
export interface DocumentImportSummary { id: string; folderPath: string; status: 'finished' | 'cancelled'; imported: number; skipped: number; failed: number; unsupported: number; directoryIssues: number; }
export interface WorkspaceView {
  id: string; loadRevision: number; matchRevision: number; name: string; filePath: string | null; dirty: boolean; savedAt: string | null;
  imports: BankImportSummary[]; documentImports: DocumentImportSummary[]; matchReviewCounts: MatchReviewCounts; bankCorrections: BankCorrection[];
  documentCorrections: DocumentCorrection[]; approvedDocumentCount: number;
  duplicateDecisions: DuplicateDecision[];
  supersededStatements: string[];
  supersededDocuments: string[];
}
export interface ImportOutcome { status: 'imported' | 'skipped' | 'cancelled' | 'failed' | 'unsupported'; importId: string | null; issues: ImportIssue[]; }
export interface WorkspaceState {
  workspace: WorkspaceView | null;
  busy: boolean;
  error: string | null;
  approvalIssue?: { transactionId: string; reason: 'selection-changed' | 'not-assigned' | 'document-unavailable' };
  statementImport: { cancelling: boolean; progress: ExtractionProgress | null } | null;
  importOutcome: ImportOutcome | null;
  documentImport: { cancelling: boolean; progress: DocumentImportProgress | null } | null;
  documentOutcome: { status: 'finished' | 'cancelled' | 'failed'; importId: string | null; issues: ImportIssue[] } | null;
}
export interface WorkspaceBridge {
  command(value: WorkspaceCommand): Promise<WorkspaceState>;
  bankImports(): Promise<StoredBankImport[]>;
  documentImports(): Promise<StoredDocumentImport[]>;
  documentSnapshot(request: DocumentSnapshotRequest): Promise<DocumentSnapshot | null>;
  matchSummaries(revision: number): Promise<MatchSummary[] | null>;
  matchDetails(revision: number, transactionId: string): Promise<MatchDetails | null>;
  openOriginal(request: OriginalPreviewRequest): Promise<OriginalPreviewResult>;
  relinkOriginal(request: OriginalPreviewRequest): Promise<OriginalRelinkResult>;
  analyzeOriginal(request: OriginalPreviewRequest): Promise<OriginalAnalysisResult>;
  acceptOriginalAnalysis(request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult>;
  exportSettings(request: ExportSettingsRequest): Promise<string>;
  localOcr(request: LocalOcrRequest): Promise<LocalOcrStatus>;
  exportDocuments(loadRevision: number): Promise<DocumentExportResponse>;
  exportReconciliation(loadRevision: number): Promise<DocumentExportResponse>;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
}
