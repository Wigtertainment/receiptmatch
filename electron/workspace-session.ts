import type { BankImportSummary } from "../src/shared/workspace-import.js";
import type { DocumentImportSummary } from "../src/shared/protocol.js";
import type { ImportIssue, SourceEvidence } from "../src/shared/bank-import.js";
import type { DocumentIssue, DocumentSection, SupportingDocument } from "../src/shared/supporting-document.js";
import type { MatchApproval } from "../src/shared/match-approvals.js";
import type { ExtractionProgress } from "../src/shared/pdf-extraction.js";
import type { StatementOverlap } from "../src/shared/statement-overlaps.js";
import type { StoredSupportingDocument } from "../src/shared/workspace-documents.js";
import type { DocumentImportProgress } from "../src/shared/workspace-documents.js";
import type { BankImportRunResult } from "../src/shared/workspace-import.js";
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { ZodError, type ZodSafeParseResult } from 'zod';
import type { DocumentSnapshot, DocumentSnapshotRequest, WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import { importIssue, type TransactionCandidate, type UnresolvedDraft } from '../src/shared/bank-import.js';
import { applyBankCorrections, bankCorrectionSchema, type BankCorrection } from '../src/shared/bank-corrections.js';
import { documentCorrectionKey, documentCorrectionSchema, type DocumentCorrection, type DocumentCorrectionValue } from '../src/shared/document-corrections.js';
import { sameMoneyValue } from '../src/shared/money.js';
import { advanceReviewRevision, currentMatchApprovals, documentRevisionIndex, sameApprovalSelection,
  type MatchApprovalSelection, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import { originalSourceExtensions, type OriginalAdoptionRequest, type OriginalAdoptionResult, type OriginalAnalysisResult, type OriginalPreviewRequest,
  type OriginalRelinkResult } from '../src/shared/original-preview.js';
import type { OriginalSource } from './original-preview.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { createWorkspace, isSourceRelocationPath, loadWorkspace, newMetadata, saveWorkspace, validateSourceReplacements, type SavedWorkspace, type WorkspaceMetadata } from './store.js';
import type { BankImportService } from './import/service.js';
import { readSourceSnapshot } from './import/source.js';
import type { DocumentImportService } from './documents/service.js';
import { storedDocumentImportSchema, type StoredDocumentImport, type WorkspaceSource } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchReviewCounts, MatchSummary, ReviewMatch, TransactionMatch } from '../src/shared/workspace-matching.js';
import { suggestWorkspaceMatches } from './matching.js';
import { describeMatch, summarizeMatches } from './match-view.js';
import { WorkspaceDocumentState } from './documents/document-state.js';
import { evaluateReviewMatches } from './review-matching.js';
import { approvedExportDocuments, copyApprovedDocuments, type ApprovedExportDocument } from './document-export.js';
import { writeReconciliationExport } from './reconciliation-export.js';
import type { DocumentExportReport, ReconciliationExportReport } from '../src/shared/document-export.js';
import { indexStatementOverlaps } from '../src/shared/statement-overlaps.js';
import { duplicatePairKey, excludeDuplicateTransactions, excludeTransactions, secondaryDuplicateId, validateDuplicateDecisions, type DuplicateDecision } from '../src/shared/transaction-duplicates.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import { analyzeSource, type AnalyzedSource, type ReplacementExtraction } from './source-analysis.js';
import { prepareAdoption, supportingDocumentSource } from './source-adoption.js';
import { readTransactionIgnoreRules, setTransactionIgnoreRule, transactionIgnoreRuleKey, transactionsIgnoredByRules } from './transaction-ignore-rules.js';
import type { $ZodIssue } from 'zod/v4/core';

export interface WorkspaceDialogs {
  open(): Promise<string | null>;
  save(name: string): Promise<string | null>;
  unsaved(name: string): Promise<'save' | 'discard' | 'cancel'>;
  relinkOriginal?(source: OriginalSource): Promise<string | null>;
  analyzeOriginal?: (source: OriginalSource) => Promise<string | null>;
}

function message(error: unknown): string {
  if (error instanceof ZodError) {
    if (error.issues.length && error.issues.every((issue: $ZodIssue): boolean => issue.path.length === 1 && issue.path[0] === 'name')) {
      return 'Enter a workspace name between 1 and 120 characters.';
    }
    return 'This workspace contains invalid or unsupported data and could not be opened or saved.';
  }
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'EEXIST') {
      return 'A file already exists at that location. Choose a different filename.';
    }
    if (['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))) {
      return 'The selected location is not writable. Choose another location and try again.';
    }
    if (error.code === 'ENOENT') {
      return 'The selected file or folder is no longer available.';
    }
    if (String(error.code).startsWith('SQLITE_')) {
      return 'This workspace could not be read or saved. It may be damaged or in use.';
    }
  }
  return error instanceof Error ? error.message : 'The workspace operation could not be completed. Please try again.';
}

function sameDocumentCorrection(previous: DocumentCorrectionValue, change: DocumentCorrectionValue): boolean {
  if (change.kind === 'amount') {
    return previous.kind === 'amount' && sameMoneyValue(previous.value, change.value);
  }
  return previous.kind === 'date' && previous.value === change.value;
}

export class WorkspaceSession {
  private metadata: WorkspaceMetadata | null = null;
  private saved: SavedWorkspace | null = null;
  private busy: boolean = false;
  private error: string | null = null;
  private approvalIssue: WorkspaceState['approvalIssue'];
  private importRecords: StoredBankImport[] = [];
  private effectiveImports: StoredBankImport[] = [];
  private bankCorrections: Map<string, BankCorrection> = new Map<string, BankCorrection>();
  private documentRecords: StoredDocumentImport[] = [];
  private documentView: WorkspaceDocumentState | null = null;
  private documentCorrections: Map<string, DocumentCorrection> = new Map<string, DocumentCorrection>();
  private matches: TransactionMatch[] = [];
  private reviewMatches: { source: TransactionMatch[]; results: ReviewMatch[] } | null = null;
  private ignoredTransactions: Set<string> = new Set<string>();
  private ignoreRules: Set<string> = new Set<string>();
  private ruleMatches: { imports: StoredBankImport[]; rules: ReadonlySet<string>; ids: ReadonlySet<string> } | null = null;
  private matchDecisions: Map<string, string | null> = new Map<string, string | null>();
  private reviewApprovals: Map<string, ReviewApprovalState> = new Map<string, ReviewApprovalState>();
  private duplicateDecisions: Map<string, DuplicateDecision> = new Map<string, DuplicateDecision>();
  private sourceRelocations: Map<string, string> = new Map<string, string>();
  private sourceReplacements: Map<string, string> = new Map<string, string>();
  private archivedSourceReviews: Map<string, Map<string, string | null>> = new Map<string, Map<string, string | null>>();
  private pendingAnalysis: { token: string; revision: number; oldSourceId: string; replacement: AnalyzedSource;
    plan: ReturnType<typeof prepareAdoption> } | null = null;
  private importController: AbortController | null = null;
  private statementImport: WorkspaceState['statementImport'] = null;
  private importOutcome: WorkspaceState['importOutcome'] = null;
  private documentImport: WorkspaceState['documentImport'] = null;
  private documentOutcome: WorkspaceState['documentOutcome'] = null;
  private loadRevision: number = 0;
  private matchRevision: number = 0;
  constructor(private readonly dialogs: WorkspaceDialogs, private readonly changed?: (state: WorkspaceState) => void, private readonly importService?: BankImportService,
    private readonly documentService?: DocumentImportService, private readonly extractReplacement?: ReplacementExtraction,
    private readonly ignoreRulesDirectory?: string) {}

  state(): WorkspaceState {
    const imports: BankImportSummary[] = this.effectiveImports.map((record: StoredBankImport): BankImportSummary => ({
      id: record.id, filePath: record.filePath, bankId: record.result.adapter!.bankId,
      status: record.result.status === 'complete' ? 'complete' as const : 'partial' as const,
      transactions: record.result.transactions.length, drafts: record.result.unresolvedDrafts.length, issues: record.result.issues.length
    }));
    const sameImports: boolean = this.saved?.imports.length === this.importRecords.length && this.importRecords.every((record: StoredBankImport, index: number): boolean => record.id === this.saved!.imports[index].id);
    const sameDocuments: boolean = this.saved?.documentImports.length === this.documentRecords.length && this.documentRecords.every((record: StoredDocumentImport, index: number): boolean => record.id === this.saved!.documentImports[index].id);
    const matchReviewCounts: MatchReviewCounts = { open: 0, assigned: 0, 'completed-without-document': 0 };
    const ignored: ReadonlySet<string> = this.allIgnoredTransactions();
    for (const { transactionId } of this.matches) {
      if (ignored.has(transactionId)) {
        continue;
      }
      const documentId: string | null | undefined = this.matchDecisions.get(transactionId);
      matchReviewCounts[documentId === undefined ? 'open' : documentId === null ? 'completed-without-document' : 'assigned']++;
    }
    const documentImports: DocumentImportSummary[] = this.documentRecords.map((record: StoredDocumentImport): DocumentImportSummary => ({
      id: record.id, folderPath: record.folderPath, status: record.status,
      imported: record.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "imported"; record: StoredSupportingDocument; } => file.status === 'imported').length, skipped: record.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } => file.status === 'skipped').length,
      failed: record.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } => file.status === 'failed').length, unsupported: record.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "unsupported"; filePath: string; issues: ImportIssue[]; } => file.status === 'unsupported').length,
      directoryIssues: record.directoryIssues.length
    }));
    return {
      workspace: this.metadata ? {
        id: this.metadata.id, loadRevision: this.loadRevision, matchRevision: this.matchRevision, name: this.metadata.name,
        dirty: this.metadata.name !== this.saved?.metadata.name || !sameImports || !sameDocuments ||
          !isDeepStrictEqual(this.ignoredTransactions, this.saved.ignoredTransactions) || !isDeepStrictEqual(this.matchDecisions, this.saved.matchDecisions) || !isDeepStrictEqual(this.bankCorrections, this.saved.bankCorrections) ||
          !isDeepStrictEqual(this.documentCorrections, this.saved.documentCorrections) || !isDeepStrictEqual(this.reviewApprovals, this.saved.reviewApprovals) ||
          !isDeepStrictEqual(this.duplicateDecisions, this.saved.duplicateDecisions) || !isDeepStrictEqual(this.sourceRelocations, this.saved.sourceRelocations) ||
          !isDeepStrictEqual(this.sourceReplacements, this.saved.sourceReplacements),
        filePath: this.saved?.filePath ?? null, savedAt: this.saved?.metadata.savedAt ?? null, imports, documentImports, matchReviewCounts,
        approvedDocumentCount: this.exportableApprovals().size,
        bankCorrections: structuredClone([...this.bankCorrections.values()]), documentCorrections: structuredClone([...this.documentCorrections.values()]),
        duplicateDecisions: structuredClone([...this.duplicateDecisions.values()]),
        supersededStatements: this.importRecords.filter((record: StoredBankImport): boolean => this.sourceReplacements.has(record.result.sourceProvenance!.sourceId)).map((record: StoredBankImport): string => record.id),
        supersededDocuments: this.documentRecords.flatMap((run: StoredDocumentImport): string[] => run.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' &&
          this.sourceReplacements.has(file.record.result.input!.source.sourceId) ? [file.record.id] : []))
      } : null,
      busy: this.busy, error: this.error, ...(this.approvalIssue ? { approvalIssue: { ...this.approvalIssue } } : {}),
      statementImport: structuredClone(this.statementImport), importOutcome: structuredClone(this.importOutcome),
      documentImport: structuredClone(this.documentImport), documentOutcome: structuredClone(this.documentOutcome)
    };
  }

  bankImports(): StoredBankImport[] {
    return structuredClone(this.importRecords);
  }

  private documents(): WorkspaceDocumentState {
    if (this.documentView?.imports !== this.documentRecords || this.documentView.corrections !== this.documentCorrections) {
      this.documentView = new WorkspaceDocumentState(this.documentRecords, this.documentCorrections);
    }
    return this.documentView;
  }

  documentImports(): StoredDocumentImport[] {
    return structuredClone(this.documents().correctionBase);
  }

  documentSnapshot(request: DocumentSnapshotRequest): DocumentSnapshot | null {
    if (!this.metadata || request.loadRevision !== this.loadRevision || request.revision !== this.matchRevision) {
      return null;
    }
    const documents: WorkspaceDocumentState = this.documents();
    const originals: Record<string, { sections: DocumentSection[]; issues: DocumentIssue[]; }> = Object.fromEntries(documents.imports.flatMap((run: StoredDocumentImport): [string, { sections: DocumentSection[]; issues: DocumentIssue[]; }][] => run.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [[string, { sections: DocumentSection[]; issues: DocumentIssue[]; }]] => {
      if (file.status !== 'imported') {
        return [];
      }
      const { id, result: { sections, issues } }: StoredSupportingDocument = file.record;
      return [[id, { sections, issues }]];
    })));
    return structuredClone({ ...request, reports: documents.effective, originals });
  }

  savedWorkspaceFingerprint(): string | null {
    return this.saved?.fingerprint ?? null;
  }

  private importedOriginal({ kind, id, loadRevision }: OriginalPreviewRequest): (OriginalSource & { sourceId: string }) | null {
    if (!this.metadata || this.loadRevision !== loadRevision) {
      return null;
    }
    if (kind === 'statement') {
      const record: StoredBankImport | undefined = this.importRecords.find((item: StoredBankImport): boolean => item.id === id);
      if (!record) {
        return null;
      }
      const { sha256, sourceId }: { sourceId: string; sha256: string; extractionRunId: string; extractionVersion: string; pages: { pageId: string; pageNumber: number; width: number; height: number; }[]; } = record.result.sourceProvenance!;
      return { filePath: record.filePath, sha256, sourceId, format: 'pdf' };
    }
    for (const record of this.documentRecords) {
      for (const file of record.files) {
      if (file.status === 'imported' && file.record.id === id) {
        const { sha256, sourceId }: { sourceId: string; sha256: string; } = file.record.result.input!.source;
        return { filePath: file.record.filePath, sha256, sourceId, format: file.record.format };
      }
    }
    }
    return null;
  }

  originalSource(request: OriginalPreviewRequest): OriginalSource | null {
    const source: (OriginalSource & { sourceId: string; }) | null = this.importedOriginal(request);
    if (!source) {
      return null;
    }
    return { filePath: this.sourceRelocations.get(source.sourceId) ?? source.filePath, sha256: source.sha256, format: source.format };
  }

  async relinkOriginal(request: OriginalPreviewRequest): Promise<OriginalRelinkResult> {
    if (this.busy) {
      return { status: 'failed', error: 'Finish the current workspace action before relinking a file.' };
    }
    const source: (OriginalSource & { sourceId: string; }) | null = this.importedOriginal(request);
    if (!source || !this.dialogs.relinkOriginal) {
      return { status: 'failed', error: 'The original is not available in this workspace.' };
    }
    const currentPath: string = this.sourceRelocations.get(source.sourceId) ?? source.filePath;
    this.busy = true;
    try {
      this.publish();
      const selected: string | null = await this.dialogs.relinkOriginal({ filePath: currentPath, sha256: source.sha256, format: source.format });
      if (selected === null) {
        return { status: 'cancelled' };
      }
      if (!isSourceRelocationPath(selected, source.format)) {
        return { status: 'failed', error: 'Choose an original file of the same type.' };
      }
      const bytes: Uint8Array<ArrayBufferLike> = await readSourceSnapshot(selected, originalSourceExtensions[source.format]);
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        return { status: 'failed', error: 'The selected file differs from the imported original. Choose an identical copy.' };
      }
      if (selected === source.filePath) {
        this.sourceRelocations.delete(source.sourceId);
      } else {
        this.sourceRelocations.set(source.sourceId, selected);
      }
      return { status: 'linked' };
    } catch {
      return { status: 'failed', error: 'The selected original could not be read. Choose the file again.' };
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  async analyzeOriginal(request: OriginalPreviewRequest): Promise<OriginalAnalysisResult> {
    if (this.busy) {
      return { status: 'failed', error: 'Finish the current workspace action before analyzing a file.' };
    }
    const source: (OriginalSource & { sourceId: string; }) | null = this.importedOriginal(request);
    const choose: ((source: OriginalSource) => Promise<string | null>) | undefined = this.dialogs.analyzeOriginal, extract: ReplacementExtraction | undefined = this.extractReplacement;
    if (!source || this.sourceReplacements.has(source.sourceId) || !choose || !extract) {
      return { status: 'failed', error: 'Only an active source can be replaced.' };
    }
    const statement: StoredBankImport | null | undefined = request.kind === 'statement' ? this.importRecords.find((record: StoredBankImport): boolean => record.id === request.id) : null;
    const original: AnalyzedSource | null = statement ? { kind: 'statement', record: statement } : supportingDocumentSource(this.documentRecords, request.id);
    if (!original) {
      return { status: 'failed', error: 'The original analysis is unavailable.' };
    }
    this.pendingAnalysis = null;
    this.busy = true;
    try {
      this.publish();
      const oldPath: string = this.sourceRelocations.get(source.sourceId) ?? source.filePath;
      const newPath: string | null = await choose({ ...source, filePath: oldPath });
      if (newPath === null) {
        return { status: 'cancelled' };
      }
      if (!isSourceRelocationPath(newPath, source.format)) {
        return { status: 'failed', error: 'Choose a replacement file of the same type.' };
      }
      const bytes: Uint8Array<ArrayBufferLike> = await readSourceSnapshot(newPath, originalSourceExtensions[source.format]);
      const hash: string = createHash('sha256').update(bytes).digest('hex');
      if (hash === source.sha256) {
        return { status: 'failed', error: 'This file is identical to the original. Use Relink original.' };
      }
      if (this.sources().some((item: WorkspaceSource): boolean => item.sha256 === hash)) {
        return { status: 'failed', error: 'This file has already been imported into the workspace.' };
      }
      const replacement: AnalyzedSource = await analyzeSource(request.kind, newPath, source.format, bytes, extract);
      const plan: { changes: { label: string; before: string | null; after: string | null; }[]; conflicts: string[]; blockingConflict: string | undefined; preserved: number; revoked: number; archive: Map<string, string | null>; reviews: Map<string, string | null>; approvals: Map<string, ReviewApprovalState>; bankCorrections: Map<string, BankCorrection>; documentCorrections: Map<string, DocumentCorrection>; ignoredTransactions: Set<string>; } = prepareAdoption(original, replacement, { reviews: this.matchDecisions, approvals: this.reviewApprovals, currentApprovals: this.currentApprovals(),
        bankCorrections: this.bankCorrections, documentCorrections: this.documentCorrections, duplicates: this.duplicateDecisions,
        ignoredTransactions: this.ignoredTransactions });
      const token: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
      this.pendingAnalysis = { token, revision: this.matchRevision, oldSourceId: source.sourceId, replacement, plan };
      const { changes, conflicts, preserved, revoked }: { changes: { label: string; before: string | null; after: string | null; }[]; conflicts: string[]; blockingConflict: string | undefined; preserved: number; revoked: number; archive: Map<string, string | null>; reviews: Map<string, string | null>; approvals: Map<string, ReviewApprovalState>; bankCorrections: Map<string, BankCorrection>; documentCorrections: Map<string, DocumentCorrection>; ignoredTransactions: Set<string>; } = plan;
      return { status: 'ready', comparison: { token, oldPath, newPath, changes, conflicts, preserved, revoked } };
    } catch (error: unknown) {
      return { status: 'failed', error: message(error) };
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  async acceptOriginalAnalysis(request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult> {
    if (this.busy) {
      return { status: 'failed', error: 'Finish the current workspace action before applying this analysis.' };
    }
    const pending: { token: string; revision: number; oldSourceId: string; replacement: AnalyzedSource; plan: ReturnType<typeof prepareAdoption>; } | null = this.pendingAnalysis;
    if (!this.metadata || request.loadRevision !== this.loadRevision || pending?.token !== request.token || pending.revision !== this.matchRevision) {
      return { status: 'failed', error: 'The workspace changed. Analyze the replacement again.' };
    }
    const { replacement, plan, oldSourceId }: { token: string; revision: number; oldSourceId: string; replacement: AnalyzedSource; plan: ReturnType<typeof prepareAdoption>; } = pending;
    if (plan.blockingConflict) {
      return { status: 'failed', error: plan.blockingConflict };
    }
    if (plan.conflicts.length && !request.acknowledgeConflicts) {
      return { status: 'failed', error: 'Review and acknowledge the unresolved differences first.' };
    }
    this.busy = true;
    try {
      this.publish();
      const record: StoredBankImport | StoredSupportingDocument = replacement.record;
      const provenance: { sourceId: string; sha256: string; } = replacement.kind === 'statement' ? replacement.record.result.sourceProvenance! : replacement.record.result.input!.source;
      const format: "png" | "jpeg" | "pdf" = replacement.kind === 'statement' ? 'pdf' : replacement.record.format;
      const bytes: Uint8Array<ArrayBufferLike> = await readSourceSnapshot(record.filePath, originalSourceExtensions[format]);
      if (createHash('sha256').update(bytes).digest('hex') !== provenance.sha256) {
        this.pendingAnalysis = null;
        return { status: 'failed', error: 'The replacement changed after analysis. Analyze it again.' };
      }
      const banks: StoredBankImport[] = replacement.kind === 'statement' ? [...this.importRecords, replacement.record] : this.importRecords;
      const documents: StoredDocumentImport[] = replacement.kind === 'document' ? [...this.documentRecords, replacement.run] : this.documentRecords;
      const replacements: Map<string, string> = validateSourceReplacements(new Map(this.sourceReplacements).set(oldSourceId, provenance.sourceId), banks, documents);
      const correctedBanks: StoredBankImport[] = applyBankCorrections(banks, plan.bankCorrections);
      const active: StoredBankImport[] = excludeDuplicateTransactions(activeStatements(correctedBanks, replacements), this.duplicateDecisions.values());
      const documentView: WorkspaceDocumentState = new WorkspaceDocumentState(documents, plan.documentCorrections);
      const matches: TransactionMatch[] = suggestWorkspaceMatches(active, activeSupportingDocuments(documentView.effective, replacements));
      if (plan.archive.size) {
        this.archivedSourceReviews.set(oldSourceId, plan.archive);
      }
      this.importRecords = banks;
      this.documentRecords = documents;
      this.sourceReplacements = replacements;
      this.bankCorrections = plan.bankCorrections;
      this.documentCorrections = plan.documentCorrections;
      this.documentView = documentView;
      this.effectiveImports = correctedBanks;
      this.matchDecisions = plan.reviews;
      this.reviewApprovals = plan.approvals;
      this.ignoredTransactions = plan.ignoredTransactions;
      this.matches = matches;
      this.pendingAnalysis = null;
      this.loadRevision++;
      this.matchRevision++;
      return { status: 'adopted' };
    } catch (error: unknown) {
      return { status: 'failed', error: message(error) };
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  matchResults(): TransactionMatch[] {
    return structuredClone(this.matches);
  }

  private activeImports(imports: StoredBankImport[] = this.effectiveImports, decisions: Map<string, DuplicateDecision> = this.duplicateDecisions): StoredBankImport[] {
    return excludeDuplicateTransactions(activeStatements(imports, this.sourceReplacements), decisions.values());
  }

  private activeDocuments(imports: StoredDocumentImport[] = this.documents().effective): StoredDocumentImport[] {
    return activeSupportingDocuments(imports, this.sourceReplacements);
  }

  private restoreMatches(saved: SavedWorkspace): void {
    this.ignoredTransactions = new Set(saved.ignoredTransactions);
    this.duplicateDecisions = structuredClone(saved.duplicateDecisions);
    this.sourceReplacements = new Map(saved.sourceReplacements);
    this.archivedSourceReviews = structuredClone(saved.archivedSourceReviews);
    const active: StoredBankImport[] = this.activeImports();
    const documentView: WorkspaceDocumentState = this.documents();
    this.matches = active === this.effectiveImports && !this.sourceReplacements.size && !documentView.hasAutomaticChanges ?
      structuredClone(saved.matches) : suggestWorkspaceMatches(active, this.activeDocuments(documentView.effective));
  }

  private ignoredByRule(): ReadonlySet<string> {
    if (this.ruleMatches?.imports !== this.effectiveImports || this.ruleMatches.rules !== this.ignoreRules) {
      this.ruleMatches = { imports: this.effectiveImports, rules: this.ignoreRules, ids: transactionsIgnoredByRules(this.effectiveImports, this.ignoreRules) };
    }
    return this.ruleMatches.ids;
  }

  private allIgnoredTransactions(): ReadonlySet<string> {
    const byRule: ReadonlySet<string> = this.ignoredByRule();
    return byRule.size ? new Set([...this.ignoredTransactions, ...byRule]) : this.ignoredTransactions;
  }

  private matchesForReview(): ReviewMatch[] {
    if (this.reviewMatches?.source !== this.matches) {
      const active: StoredBankImport[] = this.activeImports(), imports: StoredBankImport[] = excludeTransactions(active, this.allIgnoredTransactions());
      const documents: StoredDocumentImport[] = this.activeDocuments();
      const matches: TransactionMatch[] = imports === active ? this.matches : suggestWorkspaceMatches(imports, documents);
      this.reviewMatches = { source: this.matches, results: evaluateReviewMatches(matches, imports, documents) };
    }
    return this.reviewMatches.results;
  }

  matchSummaries(revision: number): MatchSummary[] | null {
    return this.metadata && revision === this.matchRevision ? summarizeMatches(
      this.matchesForReview(), this.activeImports(), this.matchDecisions, this.bankCorrections, this.reviewApprovals,
      documentRevisionIndex(this.documentCorrections.values()), this.allIgnoredTransactions(), this.ignoredByRule()
    ) : null;
  }

  matchDetails(revision: number, transactionId: string): MatchDetails | null {
    if (!this.metadata || revision !== this.matchRevision) {
      return null;
    }
    const match: ReviewMatch | undefined = this.matchesForReview().find((row: ReviewMatch): boolean => row.transactionId === transactionId);
    return match ? describeMatch(match, this.effectiveImports, this.documents().effective, this.documentCorrections) : null;
  }

  private currentApprovals(): Map<string, MatchApproval> {
    return currentMatchApprovals(this.reviewApprovals, this.matchDecisions, this.bankCorrections, documentRevisionIndex(this.documentCorrections.values()));
  }

  private exportableApprovals(): Map<string, MatchApproval> {
    const approvals: Map<string, MatchApproval> = this.currentApprovals();
    for (const id of this.allIgnoredTransactions()) {
      approvals.delete(id);
    }
    return approvals;
  }

  async exportApprovedDocuments(loadRevision: number, destination: string, pattern: string): Promise<DocumentExportReport> {
    if (this.busy) {
      throw new Error('Finish the current workspace action before exporting.');
    }
    if (!this.metadata || loadRevision !== this.loadRevision) {
      throw new Error('The workspace changed before the export started.');
    }
    this.busy = true;
    try {
      this.publish();
      const documents: ApprovedExportDocument[] = approvedExportDocuments(this.activeImports(), this.activeDocuments(this.documentRecords), this.exportableApprovals(), this.sourceRelocations);
      return await copyApprovedDocuments(destination, pattern, documents, [...this.sources().map((source: WorkspaceSource): string => source.filePath), ...this.sourceRelocations.values()]);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  async exportReconciliation(loadRevision: number, destination: string, pattern: string): Promise<ReconciliationExportReport> {
    if (this.busy) {
      throw new Error('Finish the current workspace action before exporting.');
    }
    if (!this.metadata || loadRevision !== this.loadRevision) {
      throw new Error('The workspace changed before the export started.');
    }
    const snapshot: SavedWorkspace | null = this.saved;
    if (!snapshot) {
      throw new Error('Save the workspace before exporting a reconciliation report.');
    }
    this.busy = true;
    try {
      this.publish();
      const bank: StoredBankImport[] = applyBankCorrections(snapshot.imports, snapshot.bankCorrections);
      const ignored: Set<string> = new Set([...snapshot.ignoredTransactions, ...transactionsIgnoredByRules(bank, this.ignoreRules)]);
      return await writeReconciliationExport({ ...snapshot, ignoredTransactions: ignored }, destination, pattern);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private sources(): WorkspaceSource[] {
    const sources: Map<string, WorkspaceSource> = new Map((this.saved?.sources ?? []).map((source: WorkspaceSource): [string, WorkspaceSource] => [source.id, source]));
    for (const record of this.importRecords) {
      const source: { sourceId: string; sha256: string; extractionRunId: string; extractionVersion: string; pages: { pageId: string; pageNumber: number; width: number; height: number; }[]; } = record.result.sourceProvenance!;
      sources.set(source.sourceId, { id: source.sourceId, filePath: record.filePath, sha256: source.sha256 });
    }
    for (const record of this.documentRecords) {
      for (const file of record.files) {
        if (file.status === 'imported') {
      const source: { sourceId: string; sha256: string; } = file.record.result.input!.source;
      sources.set(source.sourceId, { id: source.sourceId, filePath: file.record.filePath, sha256: source.sha256 });
    }
      }
    }
    return structuredClone([...sources.values()]);
  }

  rejectRequest(): WorkspaceState {
    return { ...this.state(), error: 'This workspace request is not supported.' };
  }

  private publish(): void {
    this.changed?.(this.state());
  }

  private async save(): Promise<boolean> {
    if (!this.metadata) {
      return false;
    }
    if (!this.metadata.name.trim()) {
      throw new Error('Enter a workspace name before saving.');
    }
    if (this.saved) {
      this.saved = await saveWorkspace(
      this.saved, this.metadata, this.importRecords, this.documentRecords, this.matchDecisions, this.bankCorrections, this.documentCorrections,
      this.reviewApprovals, this.duplicateDecisions, this.sourceRelocations, this.sourceReplacements, this.archivedSourceReviews, this.ignoredTransactions
    );
    } else {
      const destination: string | null = await this.dialogs.save(this.metadata.name);
      if (!destination) {
        return false;
      }
      this.saved = await createWorkspace(
        destination, this.metadata, this.importRecords, this.documentRecords, this.matchDecisions, this.bankCorrections, this.documentCorrections,
        this.reviewApprovals, this.duplicateDecisions, this.sourceRelocations, this.sourceReplacements, this.archivedSourceReviews, this.ignoredTransactions
      );
    }
    this.metadata = { ...this.saved.metadata };
    this.importRecords = structuredClone(this.saved.imports);
    this.bankCorrections = new Map(this.saved.bankCorrections);
    this.effectiveImports = applyBankCorrections(this.importRecords, this.bankCorrections);
    this.documentRecords = structuredClone(this.saved.documentImports);
    this.documentCorrections = new Map(this.saved.documentCorrections);
    this.reviewApprovals = new Map(this.saved.reviewApprovals);
    this.sourceRelocations = new Map(this.saved.sourceRelocations);
    this.restoreMatches(this.saved);
    return true;
  }

  private async canLeave(): Promise<boolean> {
    if (!this.state().workspace?.dirty) {
      return true;
    }
    const choice: "save" | "discard" | "cancel" = await this.dialogs.unsaved(this.metadata!.name);
    if (choice === 'cancel') {
      return false;
    }
    return choice === 'discard' || await this.save();
  }

  private failedImport(code: string, detail: string): void {
    this.importOutcome = { status: 'failed', importId: null, issues: [importIssue(code, detail)] };
  }

  private async importStatement(): Promise<void> {
    const controller: AbortController = this.importController!; const workspaceId: string = this.metadata!.id;
    if (!this.importService) {
      this.failedImport('import-unavailable', 'Statement import is not available.'); return;
    }
    const result: BankImportRunResult = await this.importService.run({
      existing: this.bankImports(), existingSources: this.sources(), signal: controller.signal,
      onProgress: (progress: ExtractionProgress): void => {
        if (this.importController !== controller || controller.signal.aborted || this.metadata?.id !== workspaceId || !this.statementImport) {
          return;
        }
        this.statementImport = { cancelling: false, progress: structuredClone(progress) }; this.publish();
      }
    });
    if (controller.signal.aborted || this.metadata?.id !== workspaceId || result.status === 'cancelled') {
      this.importOutcome = { status: 'cancelled', importId: null, issues: [] }; return;
    }
    if (result.status === 'imported') {
      this.retainStatementImport(result.record, workspaceId);
    } else if (result.status === 'skipped') {
      if (result.importId === null) {
        if (!this.sources().some((source: WorkspaceSource): boolean => source.id === result.existingSourceId)) {
          this.failedImport('invalid-import', 'The duplicate source could not be identified.'); return;
        }
        this.importOutcome = { status: 'skipped', importId: null, issues: [] }; return;
      }
      if (!this.importRecords.some((record: StoredBankImport): boolean => record.id === result.importId)) {
        this.failedImport('invalid-import', 'The existing statement import could not be identified.'); return;
      }
      this.importOutcome = { status: 'skipped', importId: result.importId, issues: [] };
    } else {
      this.importOutcome = { status: result.status, importId: null, issues: structuredClone(result.issues) };
    }
  }

  private retainStatementImport(imported: StoredBankImport, workspaceId: string): void {
    const validated: ZodSafeParseResult<StoredBankImport> = storedBankImportSchema.safeParse(imported);
    if (!validated.success) {
      this.failedImport('invalid-import', 'The statement import could not be validated.'); return;
    }
    const record: StoredBankImport = validated.data;
    const duplicate: StoredBankImport | undefined = this.importRecords.find((existing: StoredBankImport): boolean => existing.result.sourceProvenance?.sha256 === record.result.sourceProvenance?.sha256);
    if (duplicate) {
      this.importOutcome = { status: 'skipped', importId: duplicate.id, issues: [] }; return;
    }
    if (this.sources().some((source: WorkspaceSource): boolean => source.sha256 === record.result.sourceProvenance?.sha256)) {
      this.importOutcome = { status: 'skipped', importId: null, issues: [] }; return;
    }
    const identities: (value: StoredBankImport) => string[] = (value: StoredBankImport): string[] => [
      value.id, value.result.sourceProvenance!.sourceId, ...value.accounts.flatMap((account: { sectionId: string; accountId: string; statementId: string; }): string[] => [account.accountId, account.statementId]),
      ...value.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId), ...value.drafts.map((row: { rowId: string; draftId: string; }): string => row.draftId)
    ];
    const existingIds: Set<string> = new Set([...this.importRecords.flatMap(identities), ...this.documentIdentities(), ...this.sources().map((source: WorkspaceSource): string => source.id), workspaceId].map((id: string): string => id.toLowerCase()));
    if (identities(record).some((id: string): boolean => existingIds.has(id.toLowerCase()))) {
      this.failedImport('invalid-import', 'The statement import contains reused workspace identities.'); return;
    }
    const imports: StoredBankImport[] = [...this.importRecords, record];
    const effective: StoredBankImport[] = [...this.effectiveImports, record];
    const matches: TransactionMatch[] = suggestWorkspaceMatches(this.activeImports(effective), this.activeDocuments());
    this.importRecords = imports;
    this.effectiveImports = effective;
    this.matches = matches;
    this.matchRevision++;
    this.importOutcome = { status: 'imported', importId: record.id, issues: structuredClone(record.result.issues) };
  }

  private documentIdentities(): string[] {
    return this.documentRecords.flatMap((record: StoredDocumentImport): string[] => [record.id, ...record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported'
      ? [file.record.id, file.record.result.input!.source.sourceId] : file.status === 'failed' && file.analysis?.input ? [file.analysis.input.source.sourceId] : [])]);
  }

  private async importDocuments(): Promise<void> {
    const controller: AbortController = this.importController!; const workspaceId: string = this.metadata!.id;
    if (!this.documentService) {
      this.documentOutcome = { status: 'failed', importId: null, issues: [importIssue('import-unavailable', 'Document import is not available.')] }; return;
    }
    const result: StoredDocumentImport | null = await this.documentService.run({
      existingSources: this.sources(), signal: controller.signal,
      onProgress: (progress: DocumentImportProgress): void => {
        if (this.importController !== controller || controller.signal.aborted || this.metadata?.id !== workspaceId || !this.documentImport) {
          return;
        }
        this.documentImport = { cancelling: false, progress: structuredClone(progress) }; this.publish();
      }
    });
    if (this.metadata?.id !== workspaceId || !result) {
      this.documentOutcome = { status: 'cancelled', importId: null, issues: [] }; return;
    }
    const checked: ZodSafeParseResult<StoredDocumentImport> = storedDocumentImportSchema.safeParse(result);
    if (!checked.success) {
      throw new Error('The document import could not be validated.');
    }
    const record: StoredDocumentImport = checked.data;
    if (controller.signal.aborted && record.status !== 'cancelled') {
      this.documentOutcome = { status: 'cancelled', importId: null, issues: [] }; return;
    }
    this.validateDocumentImport(record, workspaceId);
    const imports: StoredDocumentImport[] = [...this.documentRecords, record];
    const documentView: WorkspaceDocumentState = new WorkspaceDocumentState(imports, this.documentCorrections);
    const hasNewDocuments: boolean = record.files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "imported"; record: StoredSupportingDocument; } => file.status === 'imported');
    const matches: TransactionMatch[] = hasNewDocuments ? suggestWorkspaceMatches(this.activeImports(), this.activeDocuments(documentView.effective)) : this.matches;
    this.documentRecords = imports;
    this.documentView = documentView;
    this.matches = matches;
    if (hasNewDocuments) {
      this.matchRevision++;
    }
    this.documentOutcome = { status: record.status, importId: record.id, issues: [] };
  }

  private validateDocumentImport(record: StoredDocumentImport, workspaceId: string): void {
    const identities: Set<string> = new Set([workspaceId, ...this.documentIdentities(), ...this.sources().map((source: WorkspaceSource): string => source.id), ...this.importRecords.flatMap((bank: StoredBankImport): string[] => [
      bank.id, ...bank.accounts.flatMap((account: { sectionId: string; accountId: string; statementId: string; }): string[] => [account.accountId, account.statementId]), ...bank.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId), ...bank.drafts.map((row: { rowId: string; draftId: string; }): string => row.draftId)
    ])].map((id: string): string => id.toLowerCase()));
    const sources: Map<string, WorkspaceSource> = new Map(this.sources().map((source: WorkspaceSource): [string, WorkspaceSource] => [source.id, source]));
    const hashes: Set<string> = new Set([...sources.values()].flatMap((source: WorkspaceSource): string[] => source.sha256 ? [source.sha256] : []));
    const reserve: (id: string) => void = (id: string): void => {
      if (identities.has(id.toLowerCase())) {
        throw new Error('The document import reuses a workspace identity.');
      }
      identities.add(id.toLowerCase());
    };
    reserve(record.id);
    for (const file of record.files) {
      if (file.status === 'imported') {
        const source: { sourceId: string; sha256: string; } = file.record.result.input!.source;
        reserve(file.record.id); reserve(source.sourceId);
        if (hashes.has(source.sha256)) {
          throw new Error('The document import contains content already present in the workspace.');
        }
        hashes.add(source.sha256); sources.set(source.sourceId, { id: source.sourceId, filePath: file.record.filePath, sha256: source.sha256 });
      } else if (file.status === 'skipped') {
        if (sources.get(file.existingSourceId)?.sha256 !== file.sha256) {
          throw new Error('The skipped file does not identify existing source content.');
        }
      } else if (file.status === 'failed' && file.analysis?.input) {
        reserve(file.analysis.input.source.sourceId);
      }
    }
  }

  private reviewMatch({ revision, transactionId, review }: Extract<WorkspaceCommand, { type: 'review-match' }>): void {
    if (!this.metadata || revision !== this.matchRevision) {
      throw new Error('The match review has changed. Refresh it before making a decision.');
    }
    if (this.allIgnoredTransactions().has(transactionId) || !this.matches.some((match: TransactionMatch): boolean => match.transactionId === transactionId)) {
      throw new Error('This transaction is no longer available for review.');
    }
    if (review.status === 'assigned') {
      this.validateReviewAssignment(transactionId, review.documentId);
    }
    const documentId: string | null | undefined = review.status === 'assigned' ? review.documentId : review.status === 'completed-without-document' ? null : undefined;
    if (this.matchDecisions.get(transactionId) === documentId) {
      return;
    }
    const approval: ReviewApprovalState = advanceReviewRevision(this.reviewApprovals.get(transactionId));
    if (documentId === undefined) {
      this.matchDecisions.delete(transactionId);
    } else {
      this.matchDecisions.set(transactionId, documentId);
    }
    this.reviewApprovals.set(transactionId, approval);
    this.matchRevision++;
  }

  private validateReviewAssignment(transactionId: string, documentId: string): void {
    if (!this.activeDocuments(this.documentRecords).some((record: StoredDocumentImport): boolean => record.files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => file.status === 'imported' && file.record.id === documentId))) {
      throw new Error('This supporting document is not available in the workspace.');
    }
    for (const [owner, assignedDocument] of this.matchDecisions) {
      if (owner !== transactionId && assignedDocument === documentId) {
        throw new Error('This document is already assigned. Remove its existing assignment first.');
      }
    }
  }

  private async setTransactionIgnored({ revision, transactionId, ignored, remember }: Extract<WorkspaceCommand, { type: 'set-transaction-ignored' }>): Promise<void> {
    if (!this.metadata || revision !== this.matchRevision) {
      throw new Error('The match review has changed. Refresh it before changing the ignored status.');
    }
    if (!this.matches.some((row: TransactionMatch): boolean => row.transactionId === transactionId)) {
      throw new Error('This transaction is no longer available for review.');
    }
    const byRule: boolean = this.ignoredByRule().has(transactionId);
    const ignoredOnce: boolean = this.ignoredTransactions.has(transactionId);
    if (remember && !ignored) {
      throw new Error('Only an ignore decision can be remembered.');
    }
    if (remember || (!ignored && byRule)) {
      if (!this.ignoreRulesDirectory) {
        throw new Error('Remembered ignore rules are unavailable.');
      }
      const key: string = this.rememberedIgnoreRuleKey(transactionId);
      await setTransactionIgnoreRule(this.ignoreRulesDirectory, key, ignored);
      this.updateRememberedIgnoreRule(key, transactionId, ignored);
    } else {
      if (ignored === (byRule || ignoredOnce)) {
        return;
      }
      if (ignored) {
        this.ignoredTransactions.add(transactionId);
      } else {
        this.ignoredTransactions.delete(transactionId);
      }
    }
    this.reviewMatches = null;
    this.matchRevision++;
  }

  private rememberedIgnoreRuleKey(transactionId: string): string {
    const bank: StoredBankImport = this.effectiveImports.find((record: StoredBankImport): boolean => record.transactions.some((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === transactionId))!;
    const rowId: string = bank.transactions.find((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === transactionId)!.rowId;
    const key: string | null = transactionIgnoreRuleKey(bank.result.transactions.find((row: TransactionCandidate): boolean => row.rowId === rowId)!);
    if (!key) {
      throw new Error('A description is required to remember this booking.');
    }
    return key;
  }

  private updateRememberedIgnoreRule(key: string, transactionId: string, ignored: boolean): void {
    const rules: Set<string> = new Set(this.ignoreRules);
    if (ignored) {
      rules.add(key);
    } else {
      rules.delete(key);
    }
    this.ignoreRules = rules;
    this.ignoredTransactions.delete(transactionId);
  }

  private setDuplicateDecision({ revision, transactionId, otherTransactionId, decision }: Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>): void {
    if (!this.metadata || revision !== this.matchRevision) {
      throw new Error('The duplicate review has changed. Refresh it before making a decision.');
    }
    const key: string = duplicatePairKey(transactionId, otherTransactionId);
    const previous: DuplicateDecision | undefined = this.duplicateDecisions.get(key);
    if (decision === 'clear' && !previous) {
      return;
    }
    const active: StoredBankImport[] = activeStatements(this.effectiveImports, this.sourceReplacements);
    const duplicates: Map<string, DuplicateDecision> = new Map(this.duplicateDecisions), reviews: Map<string, string | null> = new Map(this.matchDecisions), approvals: Map<string, ReviewApprovalState> = new Map(this.reviewApprovals);
    let history: { sourceId: string; transactionId: string; documentId: string } | undefined;
    let secondary: string | null;
    if (decision === 'clear') {
      secondary = secondaryDuplicateId(previous!);
      history = this.restoreDuplicateAssignment(active, secondary, previous!.archivedReview, reviews);
      duplicates.delete(key);
    } else {
      if (previous) {
        throw new Error('Undo the existing duplicate decision before choosing again.');
      }
      const chosen: DuplicateDecision = this.chooseDuplicateDecision(active, transactionId, otherTransactionId, decision, reviews);
      secondary = secondaryDuplicateId(chosen);
      duplicates.set(key, chosen);
      if (secondary) {
        reviews.delete(secondary);
      }
    }
    validateDuplicateDecisions(duplicates.values(), this.effectiveImports);
    if (secondary && this.matchDecisions.get(secondary) !== reviews.get(secondary)) {
      approvals.set(secondary, advanceReviewRevision(approvals.get(secondary)));
    }
    const matches: TransactionMatch[] = secondary ? suggestWorkspaceMatches(this.activeImports(this.effectiveImports, duplicates), this.activeDocuments()) : this.matches;
    if (history) {
      const archived: Map<string, string | null> = new Map(this.archivedSourceReviews.get(history.sourceId));
      archived.set(history.transactionId, history.documentId);
      this.archivedSourceReviews.set(history.sourceId, archived);
    }
    this.duplicateDecisions = duplicates;
    this.matchDecisions = reviews;
    this.reviewApprovals = approvals;
    this.matches = matches;
    this.matchRevision++;
  }

  private restoreDuplicateAssignment(
    active: StoredBankImport[], secondary: string | null, review: DuplicateDecision['archivedReview'], reviews: Map<string, string | null>
  ): { sourceId: string; transactionId: string; documentId: string } | undefined {
    if (!secondary || !review || !active.some((record: StoredBankImport): boolean =>
      record.transactions.some((row: StoredBankImport['transactions'][number]): boolean => row.transactionId === secondary))) {
        return undefined;
      }
    const documentId: string | null = review.documentId;
    const source: { kind: "document"; record: StoredSupportingDocument; run: StoredDocumentImport; } | null = documentId ? supportingDocumentSource(this.documentRecords, documentId) : null;
    const superseded: boolean = source?.kind === 'document' && this.sourceReplacements.has(source.record.result.input!.source.sourceId);
    if (documentId && [...reviews.values()].includes(documentId)) {
      throw new Error('The archived document is now assigned to another booking. Remove that assignment before undoing this decision.');
    }
    if (!superseded) {
      reviews.set(secondary, documentId);
    } else if (documentId) {
      return { sourceId: source!.record.result.input!.source.sourceId, transactionId: secondary, documentId };
    }
    return undefined;
  }

  private chooseDuplicateDecision(
    active: StoredBankImport[], transactionId: string, otherTransactionId: string,
    decision: Exclude<Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>['decision'], 'clear'>, reviews: Map<string, string | null>
  ): DuplicateDecision {
    const statement: StoredBankImport | undefined = this.effectiveImports.find((record: StoredBankImport): boolean => record.transactions.some((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === transactionId));
    if (!statement || !indexStatementOverlaps(active)(statement.id).get(transactionId)
      .some((row: StatementOverlap): boolean => row.transactionId === otherTransactionId)) {
      throw new Error('These bookings are no longer possible duplicates.');
    }
    const [firstId, secondId]: string[] = [transactionId, otherTransactionId].sort();
    const primaryId: string | null = decision === 'keep-first' ? transactionId : decision === 'keep-second' ? otherTransactionId : null;
    const secondary: string | null = primaryId === null ? null : primaryId === firstId ? secondId : firstId;
    const documentId: string | null | undefined = secondary ? reviews.get(secondary) : undefined;
    return { firstId, secondId, primaryId, archivedReview: documentId === undefined ? null : { documentId } };
  }

  private approveMatches({ loadRevision, selections }: Extract<WorkspaceCommand, { type: 'approve-matches' }>): void {
    if (!this.metadata || loadRevision !== this.loadRevision) {
      throw new Error('The workspace has changed. Select the transactions again before approving.');
    }
    const rows: Map<string, MatchSummary> = new Map(this.matchSummaries(this.matchRevision)!.map((row: MatchSummary): [string, MatchSummary] => [row.transactionId, row]));
    const documents: Set<string> = new Set(this.documentRecords.flatMap((record: StoredDocumentImport): string[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.id] : [])));
    const pending: MatchApprovalSelection[] = [];
    for (const selection of selections) {
      const row: MatchSummary | undefined = rows.get(selection.transactionId);
      const current: MatchApprovalSelection = this.validateApprovalSelection(selection, row, documents);
      if (!row?.approval) {
        pending.push(current);
      }
    }
    if (!pending.length) {
      return;
    }
    const batchId: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
    const approvedAt: string = new Date().toISOString();
    for (const selection of pending) {
      this.reviewApprovals.set(selection.transactionId, { associationRevision: selection.associationRevision,
      approval: { ...selection, batchId, approvedAt } });
    }
    this.matchRevision++;
  }

  private validateApprovalSelection(selection: MatchApprovalSelection, row: MatchSummary | undefined, documents: ReadonlySet<string>): MatchApprovalSelection {
    const current: MatchApprovalSelection | null | undefined = row?.approvalSelection;
    if (!current) {
      return this.rejectApprovalSelection(selection.transactionId, row, 'not-assigned');
    }
    if (!documents.has(current.documentId)) {
      return this.rejectApprovalSelection(selection.transactionId, row, 'document-unavailable');
    }
    if (!sameApprovalSelection(current, selection)) {
      return this.rejectApprovalSelection(selection.transactionId, row, 'selection-changed');
    }
    return current;
  }

  private rejectApprovalSelection(transactionId: string, row: MatchSummary | undefined, reason: NonNullable<WorkspaceState['approvalIssue']>['reason']): never {
    this.approvalIssue = { transactionId, reason };
    const description: string | undefined = row?.description.trim().split(/\r?\n/, 1)[0].slice(0, 120);
    const label: string = description?.length ? description : transactionId;
    if (reason === 'not-assigned') {
      throw new Error(`Transaction “${label}” has no assigned document.`);
    }
    if (reason === 'document-unavailable') {
      throw new Error(`The document assigned to “${label}” is unavailable.`);
    }
    throw new Error(`The selection for “${label}” has changed. Review it again before approving.`);
  }

  private correctBankRow({ revision, rowId, changes }: Extract<WorkspaceCommand, { type: 'correct-bank-row' }>): void {
    if (!this.metadata || revision !== this.matchRevision) {
      throw new Error('The statement has changed. Refresh it before correcting a row.');
    }
    const current: TransactionCandidate | UnresolvedDraft | undefined = this.findEffectiveBankRow(rowId);
    if (!current) {
      throw new Error('This statement row is no longer available.');
    }
    const bookingDate: string | undefined = changes.bookingDate !== current.bookingDate?.value ? changes.bookingDate : undefined;
    const amount: { coefficient: string; currency: string; scale: number; } | undefined = changes.accountAmount;
    const previousAmount: { coefficient: string; currency: string; scale: number; }   | undefined = current.accountAmount?.value;
    const accountAmount: { coefficient: string; currency: string; scale: number; } | undefined = amount && previousAmount && sameMoneyValue(amount, previousAmount) ? undefined : amount;
    if (bookingDate === undefined && accountAmount === undefined) {
      return;
    }
    const previous: BankCorrection | undefined = this.bankCorrections.get(rowId);
    const correction: BankCorrection = bankCorrectionSchema.parse({ ...previous, rowId, revision: (previous?.revision ?? 1) + 1,
      ...(bookingDate === undefined ? {} : { bookingDate }), ...(accountAmount === undefined ? {} : { accountAmount }) });
    const corrections: Map<string, BankCorrection> = new Map(this.bankCorrections).set(rowId, correction);
    const effective: StoredBankImport[] = applyBankCorrections(this.importRecords, corrections);
    const matches: TransactionMatch[] = suggestWorkspaceMatches(this.activeImports(effective), this.activeDocuments());
    const before: boolean = this.effectiveImports.some((record: StoredBankImport): boolean => record.transactions.some((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === rowId));
    if (before && !effective.some((record: StoredBankImport): boolean => record.transactions.some((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === rowId))) {
      throw new Error('A correction cannot return an existing transaction to an unresolved draft.');
    }
    this.bankCorrections = corrections;
    this.effectiveImports = effective;
    this.matches = matches;
    this.matchRevision++;
  }

  private findEffectiveBankRow(rowId: string): TransactionCandidate | UnresolvedDraft | undefined {
    let current: TransactionCandidate | UnresolvedDraft | undefined;
    for (const record of this.effectiveImports) {
      if (this.sourceReplacements.has(record.result.sourceProvenance!.sourceId)) {
        continue;
      }
      const transaction: { rowId: string; transactionId: string; } | undefined = record.transactions.find((row: { rowId: string; transactionId: string; }): boolean => row.transactionId === rowId);
      const draft: { rowId: string; draftId: string; } | undefined = record.drafts.find((row: { rowId: string; draftId: string; }): boolean => row.draftId === rowId);
      if (transaction) {
        current = record.result.transactions.find((row: TransactionCandidate): boolean => row.rowId === transaction.rowId);
      }
      if (draft) {
        current = record.result.unresolvedDrafts.find((row: UnresolvedDraft): boolean => row.rowId === draft.rowId);
      }
      if (current) {
        break;
      }
    }
    return current;
  }

  private correctDocumentField({ revision, documentId, sectionId, fieldId, change }: Extract<WorkspaceCommand, { type: 'correct-document-field' }>): void {
    if (!this.metadata || revision !== this.matchRevision) {
      throw new Error('The document has changed. Refresh it before correcting a field.');
    }
    if (!supportingDocumentSource(this.activeDocuments(this.documentRecords), documentId)) {
      throw new Error('This document is no longer active.');
    }
    const target: { documentId: string; sectionId: string; fieldId: string | null; } = { documentId, sectionId, fieldId };
    const key: string = documentCorrectionKey(target, change.kind);
    const previous: DocumentCorrection | undefined = this.documentCorrections.get(key);
    if (previous) {
      if (sameDocumentCorrection(previous.change, change)) {
        return;
      }
    } else if (fieldId !== null && this.isOriginalDocumentValue(documentId, sectionId, fieldId, change)) {
      return;
    }
    let latest: number = 1;
    for (const correction of this.documentCorrections.values()) {
      if (correction.documentId === documentId) {
        latest = Math.max(latest, correction.revision);
      }
    }
    const correction: DocumentCorrection = documentCorrectionSchema.parse({ ...target, revision: latest + 1, change });
    const corrections: Map<string, DocumentCorrection> = new Map(this.documentCorrections).set(key, correction);
    const documentView: WorkspaceDocumentState = new WorkspaceDocumentState(this.documentRecords, corrections);
    const matches: TransactionMatch[] = suggestWorkspaceMatches(this.activeImports(), this.activeDocuments(documentView.effective));
    this.documentCorrections = corrections;
    this.documentView = documentView;
    this.matches = matches;
    this.matchRevision++;
  }

  private isOriginalDocumentValue(documentId: string, sectionId: string, fieldId: string, change: DocumentCorrectionValue): boolean {
    const file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } | undefined = this.documentRecords.flatMap((record: StoredDocumentImport): ({ status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; })[] => record.files).find((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => file.status === 'imported' && file.record.id === documentId);
    if (file?.status === 'imported' && !file.record.result.issues.some((issue: DocumentIssue): boolean => issue.fieldId === fieldId)) {
      const section: DocumentSection | undefined = file.record.result.sections.find((section: DocumentSection): boolean => section.sectionId === sectionId);
      if (change.kind === 'date') {
        const candidates: string[] | undefined = section?.dates.find((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === fieldId)?.candidates;
        return candidates?.length === 1 && candidates[0] === change.value;
      } else {
        const candidates: { coefficient: string; scale: number; currency: string | null; }[] | undefined = section?.amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === fieldId)?.candidates;
        const amount: { coefficient: string; scale: number; currency: string | null; } | undefined = candidates?.[0];
        return candidates?.length === 1 && !!amount?.currency && sameMoneyValue({ ...amount, currency: amount.currency }, change.value);
      }
    }
    return false;
  }

  async dispatch(command: WorkspaceCommand): Promise<WorkspaceState> {
    if (command.type === 'get-state') {
      return this.state();
    }
    if (command.type === 'cancel-import') {
      return this.cancelImport();
    }
    if (this.busy) {
      return { ...this.state(), error: 'Finish the current workspace action before starting another.' };
    }
    if (command.type === 'rename') {
      if (this.metadata) {
        this.metadata = { ...this.metadata, name: command.name };
      }
      this.error = null; this.approvalIssue = undefined; this.publish(); return this.state();
    }
    if (command.type === 'import-statement' || command.type === 'import-documents') {
      if (!this.beginImport(command.type)) {
        return this.state();
      }
    }
    this.busy = true; this.error = null; this.approvalIssue = undefined; this.publish();
    try {
      const pending: Promise<unknown> | undefined = this.runCommand(command);
      if (pending) {
        await pending;
      }
    } catch (error: unknown) {
      this.recordCommandError(command.type, error);
    } finally {
      if (command.type === 'import-statement') {
        this.importController = null; this.statementImport = null;
      }
      if (command.type === 'import-documents') {
        this.importController = null; this.documentImport = null;
      }
      this.busy = false; this.publish();
    }
    return this.state();
  }

  private cancelImport(): WorkspaceState {
    if (this.importController && (this.statementImport || this.documentImport) && !this.importController.signal.aborted) {
      if (this.statementImport) {
        this.statementImport = { ...this.statementImport, cancelling: true };
      }
      if (this.documentImport) {
        this.documentImport = { ...this.documentImport, cancelling: true };
      }
      this.importController.abort(); this.publish();
    }
    return this.state();
  }

  private beginImport(type: 'import-statement' | 'import-documents'): boolean {
    if (type === 'import-statement') {
      if (!this.metadata) {
        this.error = 'Create or open a workspace before importing a statement.'; this.publish(); return false;
      }
      this.importController = new AbortController(); this.statementImport = { cancelling: false, progress: null }; this.importOutcome = null;
    }
    if (type === 'import-documents') {
      if (!this.metadata) {
        this.error = 'Create or open a workspace before analyzing documents.'; this.publish(); return false;
      }
      this.importController = new AbortController(); this.documentImport = { cancelling: false, progress: null }; this.documentOutcome = null;
    }
    return true;
  }

  private runCommand(command: Exclude<WorkspaceCommand, { type: 'get-state' | 'cancel-import' | 'rename' }>): Promise<unknown> | undefined {
    switch (command.type) {
      case 'save': return this.save();
      case 'set-transaction-ignored': return this.setTransactionIgnored(command);
      case 'review-match': this.reviewMatch(command); break;
      case 'set-duplicate-decision': this.setDuplicateDecision(command); break;
      case 'approve-matches': this.approveMatches(command); break;
      case 'correct-bank-row': this.correctBankRow(command); break;
      case 'correct-document-field': this.correctDocumentField(command); break;
      case 'import-statement': return this.importStatement();
      case 'import-documents': return this.importDocuments();
      case 'new': return this.newWorkspace();
      case 'open': return this.openWorkspace();
    }
    return undefined;
  }

  private async newWorkspace(): Promise<void> {
    if (!await this.canLeave()) {
      return;
    }
    if (this.ignoreRulesDirectory) {
      this.ignoreRules = await readTransactionIgnoreRules(this.ignoreRulesDirectory);
    }
    this.metadata = newMetadata(); this.saved = null; this.importRecords = []; this.documentRecords = []; this.matches = []; this.matchDecisions.clear();
    this.bankCorrections.clear(); this.effectiveImports = [];
    this.documentCorrections.clear(); this.documentView = null;
    this.reviewApprovals.clear(); this.ignoredTransactions.clear(); this.duplicateDecisions.clear(); this.sourceRelocations.clear();
    this.sourceReplacements.clear(); this.archivedSourceReviews.clear(); this.pendingAnalysis = null;
    this.importOutcome = null; this.documentOutcome = null; this.loadRevision++; this.matchRevision++;
  }

  private async openWorkspace(): Promise<void> {
    if (!await this.canLeave()) {
      return;
    }
    const selected: string | null = await this.dialogs.open();
    if (!selected) {
      return;
    }
    const loaded: SavedWorkspace = await loadWorkspace(selected);
    if (this.ignoreRulesDirectory) {
      this.ignoreRules = await readTransactionIgnoreRules(this.ignoreRulesDirectory);
    }
    this.metadata = { ...loaded.metadata }; this.saved = loaded; this.importRecords = structuredClone(loaded.imports); this.documentRecords = structuredClone(loaded.documentImports);
    this.matchDecisions = new Map(loaded.matchDecisions);
    this.reviewApprovals = new Map(loaded.reviewApprovals);
    this.sourceRelocations = new Map(loaded.sourceRelocations);
    this.bankCorrections = new Map(loaded.bankCorrections);
    this.effectiveImports = applyBankCorrections(this.importRecords, this.bankCorrections);
    this.documentCorrections = new Map(loaded.documentCorrections);
    this.restoreMatches(loaded);
    this.pendingAnalysis = null;
    this.importOutcome = null; this.documentOutcome = null; this.loadRevision++; this.matchRevision++;
  }

  private recordCommandError(type: WorkspaceCommand['type'], error: unknown): void {
    if (type === 'import-statement') {
      if (this.importController?.signal.aborted) {
        this.importOutcome = { status: 'cancelled', importId: null, issues: [] };
      } else {
        this.failedImport('import-failed', 'The statement could not be imported.');
      }
    } else if (type === 'import-documents') {
      this.documentOutcome = { status: this.importController?.signal.aborted ? 'cancelled' : 'failed', importId: null,
        issues: this.importController?.signal.aborted ? [] : [importIssue('import-failed', message(error))] };
    } else {
      this.error = message(error);
    }
  }

  async requestClose(): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true; this.error = null; this.approvalIssue = undefined; this.publish();
    try {
      return await this.canLeave();
    } catch (error: unknown) {
      this.error = message(error); return false;
    } finally {
      this.busy = false; this.publish();
    }
  }
}
