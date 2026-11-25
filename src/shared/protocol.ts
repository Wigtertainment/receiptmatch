import type { MatchApprovalSelection } from "./match-approvals.js";
import { z } from 'zod';
import type { LocalOcrRequest, LocalOcrStatus } from './local-ocr-settings.js';
import type { ExtractionProgress } from './pdf-extraction.js';
import type { IBankImportSummary, StoredBankImport } from './workspace-import.js';
import type { BankImportResult, ImportIssue } from './bank-import.js';
import type { IDocumentImportProgress, StoredDocumentImport } from './workspace-documents.js';
import type { SupportingDocument } from './supporting-document.js';
import { matchReviewSchema, type IMatchDetails, type MatchReviewCounts, type IMatchSummary } from './workspace-matching.js';
import { bankCorrectionChangesSchema, type BankCorrection } from './bank-corrections.js';
import { documentFieldDispositionSchema, documentFieldReviewTarget, type DocumentFieldReview } from './document-field-reviews.js';
import { documentCorrectionTarget, documentCorrectionValueSchema, type DocumentCorrection } from './document-corrections.js';
import { matchApprovalSelectionSchema } from './match-approvals.js';
import type { OriginalAdoptionRequest, OriginalAdoptionResult, OriginalAnalysisResult, OriginalPreviewRequest, IOriginalPreviewResult, OriginalRelinkResult } from './original-preview.js';
import { exportFilenamePatternLimit } from './export-filename.js';
import type { DocumentExportResponse } from './document-export.js';
import type { DuplicateDecision } from './transaction-duplicates.js';
import type { ReceiptAiAcceptRequest, ReceiptAiDiscardRequest, ReceiptAiPreviewResult, ReceiptAiRequest } from './receipt-ai.js';
import type { StatementAiAcceptRequest, StatementAiDiscardRequest, StatementAiPreviewResult, StatementAiRequest } from './statement-ai.js';

export const workspaceName: z.ZodString = z.string().max(120);
interface ICommandShape<K extends string> { type: z.ZodLiteral<K> }
interface IRevisionedCommandShape<K extends string> extends ICommandShape<K> { revision: z.ZodNumber }
interface IStatementAiCommandShape<K extends string> extends ICommandShape<K> { token: z.ZodUUID }
interface IRemoveStatementCommandShape extends IRevisionedCommandShape<'remove-statement'> { importId: z.ZodUUID }
type DocumentFieldReviewShape = typeof documentFieldReviewTarget;
interface ISetDocumentFieldConfirmedShape extends IRevisionedCommandShape<'set-document-field-confirmed'>, DocumentFieldReviewShape { confirmed: z.ZodBoolean }
interface ISetDocumentFieldDispositionShape extends IRevisionedCommandShape<'set-document-field-disposition'>, DocumentFieldReviewShape {
  disposition: z.ZodNullable<typeof documentFieldDispositionSchema>;
}
interface IRenameCommandShape extends ICommandShape<'rename'> { name: z.ZodString }
interface ISetTransactionIgnoredCommandShape extends IRevisionedCommandShape<'set-transaction-ignored'> {
  transactionId: z.ZodUUID;
  ignored: z.ZodBoolean;
  remember: z.ZodOptional<z.ZodLiteral<true>>;
}
interface IReviewMatchCommandShape extends IRevisionedCommandShape<'review-match'> { transactionId: z.ZodUUID; review: typeof matchReviewSchema }
interface ISetDuplicateDecisionCommandShape extends IRevisionedCommandShape<'set-duplicate-decision'> {
  transactionId: z.ZodUUID;
  otherTransactionId: z.ZodUUID;
  decision: z.ZodEnum<z.core.util.ToEnum<'separate' | 'keep-first' | 'keep-second' | 'clear'>>;
}
interface ICorrectBankRowCommandShape extends IRevisionedCommandShape<'correct-bank-row'> { rowId: z.ZodUUID; changes: typeof bankCorrectionChangesSchema }
type DocumentCorrectionShape = typeof documentCorrectionTarget;
interface ICorrectDocumentFieldCommandShape extends IRevisionedCommandShape<'correct-document-field'>, DocumentCorrectionShape {
  change: typeof documentCorrectionValueSchema;
}
interface IApproveMatchesCommandShape extends ICommandShape<'approve-matches'> { loadRevision: z.ZodNumber; selections: z.ZodArray<typeof matchApprovalSelectionSchema> }

type CommandSchema<Shape extends Record<keyof Shape, z.core.$ZodType>> = z.ZodObject<z.core.util.Flatten<Shape>, z.core.$strict>;
type SimpleCommandSchema<K extends string> = CommandSchema<ICommandShape<K>>;
type WorkspaceCommandSchemas = [
  CommandSchema<ISetDocumentFieldDispositionShape>,
  CommandSchema<ISetDocumentFieldConfirmedShape>,
  CommandSchema<IStatementAiCommandShape<'try-statement-ai'>>,
  CommandSchema<IStatementAiCommandShape<'confirm-statement-ai'>>,
  CommandSchema<IStatementAiCommandShape<'discard-statement-ai'>>,
  CommandSchema<IRemoveStatementCommandShape>,
  SimpleCommandSchema<'get-state'>,
  SimpleCommandSchema<'new'>,
  SimpleCommandSchema<'open'>,
  SimpleCommandSchema<'save'>,
  SimpleCommandSchema<'import-statement'>,
  SimpleCommandSchema<'import-documents'>,
  SimpleCommandSchema<'cancel-import'>,
  CommandSchema<IRenameCommandShape>,
  CommandSchema<ISetTransactionIgnoredCommandShape>,
  CommandSchema<IReviewMatchCommandShape>,
  CommandSchema<ISetDuplicateDecisionCommandShape>,
  CommandSchema<ICorrectBankRowCommandShape>,
  CommandSchema<ICorrectDocumentFieldCommandShape>,
  CommandSchema<IApproveMatchesCommandShape>,
];

export const commandSchema: z.ZodDiscriminatedUnion<WorkspaceCommandSchemas, 'type'> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set-document-field-disposition'), revision: z.number().int().nonnegative(), ...documentFieldReviewTarget, disposition: documentFieldDispositionSchema.nullable() }),
  z.strictObject({ type: z.literal('set-document-field-confirmed'), revision: z.number().int().nonnegative(), ...documentFieldReviewTarget, confirmed: z.boolean() }),
  z.strictObject({ type: z.literal('try-statement-ai'), token: z.uuid() }),
  z.strictObject({ type: z.literal('confirm-statement-ai'), token: z.uuid() }),
  z.strictObject({ type: z.literal('discard-statement-ai'), token: z.uuid() }),
  z.strictObject({ type: z.literal('remove-statement'), importId: z.uuid(), revision: z.number().int().nonnegative() }),
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
interface IExportSettingsSaveShape extends ICommandShape<'save'> { pattern: z.ZodString }
type ExportSettingsRequestSchemas = [SimpleCommandSchema<'read'>, CommandSchema<IExportSettingsSaveShape>];
export const exportSettingsRequestSchema: z.ZodDiscriminatedUnion<ExportSettingsRequestSchemas, 'type'> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read') }),
  z.strictObject({ type: z.literal('save'), pattern: z.string().max(exportFilenamePatternLimit) }),
]);
export type ExportSettingsRequest = z.infer<typeof exportSettingsRequestSchema>;
interface IMatchRequestShape { revision: z.ZodNumber; transactionId: z.ZodOptional<z.ZodUUID> }
interface IDocumentSnapshotRequestShape { loadRevision: z.ZodNumber; revision: z.ZodNumber }
export const matchRequestSchema: z.ZodObject<z.core.util.Flatten<IMatchRequestShape>, z.core.$strict> =
  z.strictObject({ revision: z.number().int().nonnegative(), transactionId: z.uuid().optional() });
export const documentSnapshotRequestSchema: z.ZodObject<z.core.util.Flatten<IDocumentSnapshotRequestShape>, z.core.$strict> =
  z.strictObject({ loadRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative() });
export type DocumentSnapshotRequest = z.infer<typeof documentSnapshotRequestSchema>;
export type OriginalDocumentFields = Pick<SupportingDocument, 'sections' | 'issues'>;
export interface IDocumentSnapshot extends DocumentSnapshotRequest {
  reviewBases?: Record<string, OriginalDocumentFields>;
  reports: StoredDocumentImport[];
  originals: Record<string, OriginalDocumentFields>;
}
interface IDocumentExportRequestShape { loadRevision: z.ZodNumber; includeCsv: z.ZodDefault<z.ZodBoolean> }
export const documentExportRequestSchema: z.ZodObject<z.core.util.Flatten<IDocumentExportRequestShape>, z.core.$strict> =
  z.strictObject({ loadRevision: z.number().int().nonnegative(), includeCsv: z.boolean().default(false) });
export interface IDocumentImportSummary { id: string; folderPath: string; status: 'finished' | 'cancelled'; imported: number; skipped: number; failed: number; unsupported: number; directoryIssues: number; }
export interface IWorkspaceView {
  id: string; loadRevision: number; matchRevision: number; name: string; filePath: string | null; dirty: boolean; savedAt: string | null;
  imports: IBankImportSummary[]; documentImports: IDocumentImportSummary[]; matchReviewCounts: MatchReviewCounts; bankCorrections: BankCorrection[];
  documentFieldReviews?: DocumentFieldReview[]; documentCorrections: DocumentCorrection[]; approvedDocumentCount: number;
  duplicateDecisions: DuplicateDecision[];
  supersededStatements: string[];
  supersededDocuments: string[];
}
export interface IImportOutcome { status: 'imported' | 'skipped' | 'cancelled' | 'failed' | 'unsupported'; importId: string | null; issues: ImportIssue[]; }
interface IStatementFallbackOffer { stage: 'offer'; token: string; fileName: string }
interface IStatementFallbackReview { stage: 'review'; token: string; fileName: string; result: BankImportResult }
export type StatementFallbackState = IStatementFallbackOffer | IStatementFallbackReview;

interface IWorkspaceApprovalIssue { transactionId: string; reason: 'selection-changed' | 'not-assigned' | 'document-unavailable' }
interface IWorkspaceImportProgress<T> { cancelling: boolean; progress: T | null; localAi?: true }
interface IWorkspaceDocumentOutcome { status: 'finished' | 'cancelled' | 'failed'; importId: string | null; issues: ImportIssue[] }

export interface IWorkspaceState {
  workspace: IWorkspaceView | null;
  busy: boolean;
  error: string | null;
  approvalIssue?: IWorkspaceApprovalIssue;
  statementImport: IWorkspaceImportProgress<ExtractionProgress> | null;
  statementFallback?: StatementFallbackState;
  importOutcome: IImportOutcome | null;
  documentImport: IWorkspaceImportProgress<IDocumentImportProgress> | null;
  documentOutcome: IWorkspaceDocumentOutcome | null;
}
export interface IWorkspaceBridge {
  appVersion(): Promise<string>;
  command(value: WorkspaceCommand): Promise<IWorkspaceState>;
  bankImports(): Promise<StoredBankImport[]>;
  documentImports(): Promise<StoredDocumentImport[]>;
  documentSnapshot(request: DocumentSnapshotRequest): Promise<IDocumentSnapshot | null>;
  matchSummaries(revision: number): Promise<IMatchSummary[] | null>;
  matchDetails(revision: number, transactionId: string): Promise<IMatchDetails | null>;
  openOriginal(request: OriginalPreviewRequest): Promise<IOriginalPreviewResult>;
  relinkOriginal(request: OriginalPreviewRequest): Promise<OriginalRelinkResult>;
  analyzeOriginal(request: OriginalPreviewRequest): Promise<OriginalAnalysisResult>;
  reanalyzeReceipt(request: ReceiptAiRequest): Promise<ReceiptAiPreviewResult>;
  acceptReceiptAnalysis(request: ReceiptAiAcceptRequest): Promise<OriginalAdoptionResult>;
  discardReceiptAnalysis(request: ReceiptAiDiscardRequest): Promise<void>;
  reanalyzeStatement(request: StatementAiRequest): Promise<StatementAiPreviewResult>;
  acceptStatementAnalysis(request: StatementAiAcceptRequest): Promise<OriginalAdoptionResult>;
  discardStatementAnalysis(request: StatementAiDiscardRequest): Promise<void>;
  acceptOriginalAnalysis(request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult>;
  exportSettings(request: ExportSettingsRequest): Promise<string>;
  localOcr(request: LocalOcrRequest): Promise<LocalOcrStatus>;
  exportDocuments(loadRevision: number): Promise<DocumentExportResponse>;
  exportReconciliation(loadRevision: number): Promise<DocumentExportResponse>;
  subscribe(listener: (state: IWorkspaceState) => void): () => void;
}
