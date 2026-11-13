import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import { importIssue } from '../src/shared/bank-import.js';
import { applyBankCorrections, bankCorrectionSchema, type BankCorrection } from '../src/shared/bank-corrections.js';
import { applyDocumentCorrections, documentCorrectionKey, documentCorrectionSchema, type DocumentCorrection } from '../src/shared/document-corrections.js';
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
import { evaluateReviewMatches } from './review-matching.js';
import { approvedExportDocuments, copyApprovedDocuments } from './document-export.js';
import { writeReconciliationExport } from './reconciliation-export.js';
import type { DocumentExportReport, ReconciliationExportReport } from '../src/shared/document-export.js';
import { indexStatementOverlaps } from '../src/shared/statement-overlaps.js';
import { duplicatePairKey, excludeDuplicateTransactions, secondaryDuplicateId, validateDuplicateDecisions, type DuplicateDecision } from '../src/shared/transaction-duplicates.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import { analyzeSource, type AnalyzedSource, type ReplacementExtraction } from './source-analysis.js';
import { prepareAdoption, supportingDocumentSource } from './source-adoption.js';

export interface WorkspaceDialogs {
  open(): Promise<string | null>;
  save(name: string): Promise<string | null>;
  unsaved(name: string): Promise<'save' | 'discard' | 'cancel'>;
  relinkOriginal?(source: OriginalSource): Promise<string | null>;
  analyzeOriginal?(source: OriginalSource): Promise<string | null>;
}

function message(error: unknown): string {
  if (error instanceof ZodError) {
    if (error.issues.length && error.issues.every(issue => issue.path.length === 1 && issue.path[0] === 'name')) return 'Enter a workspace name between 1 and 120 characters.';
    return 'This workspace contains invalid or unsupported data and could not be opened or saved.';
  }
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'EEXIST') return 'A file already exists at that location. Choose a different filename.';
    if (['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))) return 'The selected location is not writable. Choose another location and try again.';
    if (error.code === 'ENOENT') return 'The selected file or folder is no longer available.';
    if (String(error.code).startsWith('SQLITE_')) return 'This workspace could not be read or saved. It may be damaged or in use.';
  }
  return error instanceof Error ? error.message : 'The workspace operation could not be completed. Please try again.';
}

export class WorkspaceSession {
  private metadata: WorkspaceMetadata | null = null;
  private saved: SavedWorkspace | null = null;
  private busy = false;
  private error: string | null = null;
  private approvalIssue: WorkspaceState['approvalIssue'];
  private importRecords: StoredBankImport[] = [];
  private effectiveImports: StoredBankImport[] = [];
  private bankCorrections = new Map<string, BankCorrection>();
  private documentRecords: StoredDocumentImport[] = [];
  private effectiveDocuments: StoredDocumentImport[] = [];
  private documentCorrections = new Map<string, DocumentCorrection>();
  private matches: TransactionMatch[] = [];
  private reviewMatches: { source: TransactionMatch[]; results: ReviewMatch[] } | null = null;
  private matchDecisions = new Map<string, string | null>();
  private reviewApprovals = new Map<string, ReviewApprovalState>();
  private duplicateDecisions = new Map<string, DuplicateDecision>();
  private sourceRelocations = new Map<string, string>();
  private sourceReplacements = new Map<string, string>();
  private archivedSourceReviews = new Map<string, Map<string, string | null>>();
  private pendingAnalysis: { token: string; revision: number; oldSourceId: string; replacement: AnalyzedSource;
    plan: ReturnType<typeof prepareAdoption> } | null = null;
  private importController: AbortController | null = null;
  private statementImport: WorkspaceState['statementImport'] = null;
  private importOutcome: WorkspaceState['importOutcome'] = null;
  private documentImport: WorkspaceState['documentImport'] = null;
  private documentOutcome: WorkspaceState['documentOutcome'] = null;
  private loadRevision = 0;
  private matchRevision = 0;
  constructor(private readonly dialogs: WorkspaceDialogs, private readonly changed?: (state: WorkspaceState) => void, private readonly importService?: BankImportService,
    private readonly documentService?: DocumentImportService, private readonly extractReplacement?: ReplacementExtraction) {}

  state(): WorkspaceState {
    const imports = this.effectiveImports.map(record => ({
      id: record.id, filePath: record.filePath, bankId: record.result.adapter!.bankId,
      status: record.result.status === 'complete' ? 'complete' as const : 'partial' as const,
      transactions: record.result.transactions.length, drafts: record.result.unresolvedDrafts.length, issues: record.result.issues.length
    }));
    const sameImports = this.saved?.imports.length === this.importRecords.length && this.importRecords.every((record, index) => record.id === this.saved!.imports[index].id);
    const sameDocuments = this.saved?.documentImports.length === this.documentRecords.length && this.documentRecords.every((record, index) => record.id === this.saved!.documentImports[index].id);
    const matchReviewCounts: MatchReviewCounts = { open: 0, assigned: 0, 'completed-without-document': 0 };
    for (const { transactionId } of this.matches) {
      const documentId = this.matchDecisions.get(transactionId);
      matchReviewCounts[documentId === undefined ? 'open' : documentId === null ? 'completed-without-document' : 'assigned']++;
    }
    const documentImports = this.documentRecords.map(record => ({
      id: record.id, folderPath: record.folderPath, status: record.status,
      imported: record.files.filter(file => file.status === 'imported').length, skipped: record.files.filter(file => file.status === 'skipped').length,
      failed: record.files.filter(file => file.status === 'failed').length, unsupported: record.files.filter(file => file.status === 'unsupported').length,
      directoryIssues: record.directoryIssues.length
    }));
    return {
      workspace: this.metadata ? {
        id: this.metadata.id, loadRevision: this.loadRevision, matchRevision: this.matchRevision, name: this.metadata.name,
        dirty: !this.saved || this.metadata.name !== this.saved.metadata.name || !sameImports || !sameDocuments ||
          !isDeepStrictEqual(this.matchDecisions, this.saved.matchDecisions) || !isDeepStrictEqual(this.bankCorrections, this.saved.bankCorrections) ||
          !isDeepStrictEqual(this.documentCorrections, this.saved.documentCorrections) || !isDeepStrictEqual(this.reviewApprovals, this.saved.reviewApprovals) ||
          !isDeepStrictEqual(this.duplicateDecisions, this.saved.duplicateDecisions) || !isDeepStrictEqual(this.sourceRelocations, this.saved.sourceRelocations) ||
          !isDeepStrictEqual(this.sourceReplacements, this.saved.sourceReplacements),
        filePath: this.saved?.filePath ?? null, savedAt: this.saved?.metadata.savedAt ?? null, imports, documentImports, matchReviewCounts,
        approvedDocumentCount: this.currentApprovals().size,
        bankCorrections: structuredClone([...this.bankCorrections.values()]), documentCorrections: structuredClone([...this.documentCorrections.values()]),
        duplicateDecisions: structuredClone([...this.duplicateDecisions.values()]),
        supersededStatements: this.importRecords.filter(record => this.sourceReplacements.has(record.result.sourceProvenance!.sourceId)).map(record => record.id),
        supersededDocuments: this.documentRecords.flatMap(run => run.files.flatMap(file => file.status === 'imported' &&
          this.sourceReplacements.has(file.record.result.input!.source.sourceId) ? [file.record.id] : []))
      } : null,
      busy: this.busy, error: this.error, ...(this.approvalIssue ? { approvalIssue: { ...this.approvalIssue } } : {}),
      statementImport: structuredClone(this.statementImport), importOutcome: structuredClone(this.importOutcome),
      documentImport: structuredClone(this.documentImport), documentOutcome: structuredClone(this.documentOutcome)
    };
  }
  bankImports(): StoredBankImport[] { return structuredClone(this.importRecords); }
  documentImports(): StoredDocumentImport[] { return structuredClone(this.documentRecords); }
  savedWorkspaceFingerprint(): string | null { return this.saved?.fingerprint ?? null; }
  private importedOriginal({ kind, id, loadRevision }: OriginalPreviewRequest): (OriginalSource & { sourceId: string }) | null {
    if (!this.metadata || this.loadRevision !== loadRevision) return null;
    if (kind === 'statement') {
      const record = this.importRecords.find(item => item.id === id);
      if (!record) return null;
      const { sha256, sourceId } = record.result.sourceProvenance!;
      return { filePath: record.filePath, sha256, sourceId, format: 'pdf' };
    }
    for (const record of this.documentRecords) for (const file of record.files) {
      if (file.status === 'imported' && file.record.id === id) {
        const { sha256, sourceId } = file.record.result.input!.source;
        return { filePath: file.record.filePath, sha256, sourceId, format: file.record.format };
      }
    }
    return null;
  }
  originalSource(request: OriginalPreviewRequest): OriginalSource | null {
    const source = this.importedOriginal(request);
    if (!source) return null;
    return { filePath: this.sourceRelocations.get(source.sourceId) ?? source.filePath, sha256: source.sha256, format: source.format };
  }
  async relinkOriginal(request: OriginalPreviewRequest): Promise<OriginalRelinkResult> {
    if (this.busy) return { status: 'failed', error: 'Finish the current workspace action before relinking a file.' };
    const source = this.importedOriginal(request);
    if (!source || !this.dialogs.relinkOriginal) return { status: 'failed', error: 'The original is not available in this workspace.' };
    const currentPath = this.sourceRelocations.get(source.sourceId) ?? source.filePath;
    this.busy = true;
    try {
      this.publish();
      const selected = await this.dialogs.relinkOriginal({ filePath: currentPath, sha256: source.sha256, format: source.format });
      if (selected === null) return { status: 'cancelled' };
      if (!isSourceRelocationPath(selected, source.format)) return { status: 'failed', error: 'Choose an original file of the same type.' };
      const bytes = await readSourceSnapshot(selected, originalSourceExtensions[source.format]);
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        return { status: 'failed', error: 'The selected file differs from the imported original. Choose an identical copy.' };
      }
      if (selected === source.filePath) this.sourceRelocations.delete(source.sourceId);
      else this.sourceRelocations.set(source.sourceId, selected);
      return { status: 'linked' };
    } catch {
      return { status: 'failed', error: 'The selected original could not be read. Choose the file again.' };
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async analyzeOriginal(request: OriginalPreviewRequest): Promise<OriginalAnalysisResult> {
    if (this.busy) return { status: 'failed', error: 'Finish the current workspace action before analyzing a file.' };
    const source = this.importedOriginal(request);
    const choose = this.dialogs.analyzeOriginal, extract = this.extractReplacement;
    if (!source || this.sourceReplacements.has(source.sourceId) || !choose || !extract) {
      return { status: 'failed', error: 'Only an active source can be replaced.' };
    }
    const statement = request.kind === 'statement' ? this.importRecords.find(record => record.id === request.id) : null;
    const original: AnalyzedSource | null = statement ? { kind: 'statement', record: statement } : supportingDocumentSource(this.documentRecords, request.id);
    if (!original) return { status: 'failed', error: 'The original analysis is unavailable.' };
    this.pendingAnalysis = null;
    this.busy = true;
    try {
      this.publish();
      const oldPath = this.sourceRelocations.get(source.sourceId) ?? source.filePath;
      const newPath = await choose({ ...source, filePath: oldPath });
      if (newPath === null) return { status: 'cancelled' };
      if (!isSourceRelocationPath(newPath, source.format)) return { status: 'failed', error: 'Choose a replacement file of the same type.' };
      const bytes = await readSourceSnapshot(newPath, originalSourceExtensions[source.format]);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash === source.sha256) return { status: 'failed', error: 'This file is identical to the original. Use Relink original.' };
      if (this.sources().some(item => item.sha256 === hash)) return { status: 'failed', error: 'This file has already been imported into the workspace.' };
      const replacement = await analyzeSource(request.kind, newPath, source.format, bytes, extract);
      const plan = prepareAdoption(original, replacement, { reviews: this.matchDecisions, approvals: this.reviewApprovals, currentApprovals: this.currentApprovals(),
        bankCorrections: this.bankCorrections, documentCorrections: this.documentCorrections, duplicates: this.duplicateDecisions });
      const token = randomUUID();
      this.pendingAnalysis = { token, revision: this.matchRevision, oldSourceId: source.sourceId, replacement, plan };
      const { changes, conflicts, preserved, revoked } = plan;
      return { status: 'ready', comparison: { token, oldPath, newPath, changes, conflicts, preserved, revoked } };
    } catch (error) {
      return { status: 'failed', error: message(error) };
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async acceptOriginalAnalysis(request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult> {
    if (this.busy) return { status: 'failed', error: 'Finish the current workspace action before applying this analysis.' };
    const pending = this.pendingAnalysis;
    if (!this.metadata || request.loadRevision !== this.loadRevision || pending?.token !== request.token || pending.revision !== this.matchRevision) {
      return { status: 'failed', error: 'The workspace changed. Analyze the replacement again.' };
    }
    const { replacement, plan, oldSourceId } = pending;
    if (plan.blockingConflict) return { status: 'failed', error: plan.blockingConflict };
    if (plan.conflicts.length && !request.acknowledgeConflicts) return { status: 'failed', error: 'Review and acknowledge the unresolved differences first.' };
    this.busy = true;
    try {
      this.publish();
      const record = replacement.record;
      const provenance = replacement.kind === 'statement' ? replacement.record.result.sourceProvenance! : replacement.record.result.input!.source;
      const format = replacement.kind === 'statement' ? 'pdf' : replacement.record.format;
      const bytes = await readSourceSnapshot(record.filePath, originalSourceExtensions[format]);
      if (createHash('sha256').update(bytes).digest('hex') !== provenance.sha256) {
        this.pendingAnalysis = null;
        return { status: 'failed', error: 'The replacement changed after analysis. Analyze it again.' };
      }
      const banks = replacement.kind === 'statement' ? [...this.importRecords, replacement.record] : this.importRecords;
      const documents = replacement.kind === 'document' ? [...this.documentRecords, replacement.run] : this.documentRecords;
      const replacements = validateSourceReplacements(new Map(this.sourceReplacements).set(oldSourceId, provenance.sourceId), banks, documents);
      const correctedBanks = applyBankCorrections(banks, plan.bankCorrections);
      const correctedDocuments = applyDocumentCorrections(documents, plan.documentCorrections);
      const active = excludeDuplicateTransactions(activeStatements(correctedBanks, replacements), this.duplicateDecisions.values());
      const matches = suggestWorkspaceMatches(active, activeSupportingDocuments(correctedDocuments, replacements));
      if (plan.archive.size) this.archivedSourceReviews.set(oldSourceId, plan.archive);
      this.importRecords = banks;
      this.documentRecords = documents;
      this.sourceReplacements = replacements;
      this.bankCorrections = plan.bankCorrections;
      this.documentCorrections = plan.documentCorrections;
      this.effectiveImports = correctedBanks;
      this.effectiveDocuments = correctedDocuments;
      this.matchDecisions = plan.reviews;
      this.reviewApprovals = plan.approvals;
      this.matches = matches;
      this.pendingAnalysis = null;
      this.loadRevision++;
      this.matchRevision++;
      return { status: 'adopted' };
    } catch (error) {
      return { status: 'failed', error: message(error) };
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  matchResults(): TransactionMatch[] { return structuredClone(this.matches); }
  private activeImports(imports = this.effectiveImports, decisions = this.duplicateDecisions) {
    return excludeDuplicateTransactions(activeStatements(imports, this.sourceReplacements), decisions.values());
  }
  private activeDocuments(imports = this.effectiveDocuments) {
    return activeSupportingDocuments(imports, this.sourceReplacements);
  }
  private restoreMatches(saved: SavedWorkspace) {
    this.duplicateDecisions = structuredClone(saved.duplicateDecisions);
    this.sourceReplacements = new Map(saved.sourceReplacements);
    this.archivedSourceReviews = structuredClone(saved.archivedSourceReviews);
    const active = this.activeImports();
    this.matches = active === this.effectiveImports ? structuredClone(saved.matches) : suggestWorkspaceMatches(active, this.activeDocuments());
  }
  private matchesForReview(): ReviewMatch[] {
    if (this.reviewMatches?.source !== this.matches) this.reviewMatches = {
      source: this.matches, results: evaluateReviewMatches(this.matches, this.activeImports(), this.activeDocuments())
    };
    return this.reviewMatches.results;
  }
  matchSummaries(revision: number): MatchSummary[] | null {
    return this.metadata && revision === this.matchRevision ? summarizeMatches(
      this.matchesForReview(), this.activeImports(), this.matchDecisions, this.bankCorrections, this.reviewApprovals, documentRevisionIndex(this.documentCorrections.values())
    ) : null;
  }
  matchDetails(revision: number, transactionId: string): MatchDetails | null {
    if (!this.metadata || revision !== this.matchRevision) return null;
    const match = this.matchesForReview().find(row => row.transactionId === transactionId);
    return match ? describeMatch(match, this.effectiveImports, this.effectiveDocuments, this.documentCorrections) : null;
  }
  private currentApprovals() {
    return currentMatchApprovals(this.reviewApprovals, this.matchDecisions, this.bankCorrections, documentRevisionIndex(this.documentCorrections.values()));
  }
  async exportApprovedDocuments(loadRevision: number, destination: string, pattern: string): Promise<DocumentExportReport> {
    if (this.busy) throw new Error('Finish the current workspace action before exporting.');
    if (!this.metadata || loadRevision !== this.loadRevision) throw new Error('The workspace changed before the export started.');
    this.busy = true;
    try {
      this.publish();
      const documents = approvedExportDocuments(this.activeImports(), this.activeDocuments(this.documentRecords), this.currentApprovals(), this.sourceRelocations);
      return await copyApprovedDocuments(destination, pattern, documents, [...this.sources().map(source => source.filePath), ...this.sourceRelocations.values()]);
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async exportReconciliation(loadRevision: number, destination: string, pattern: string): Promise<ReconciliationExportReport> {
    if (this.busy) throw new Error('Finish the current workspace action before exporting.');
    if (!this.metadata || loadRevision !== this.loadRevision) throw new Error('The workspace changed before the export started.');
    const snapshot = this.saved;
    if (!snapshot) throw new Error('Save the workspace before exporting a reconciliation report.');
    this.busy = true;
    try {
      this.publish();
      return await writeReconciliationExport(snapshot, destination, pattern);
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  private sources(): WorkspaceSource[] {
    const sources = new Map((this.saved?.sources ?? []).map(source => [source.id, source]));
    for (const record of this.importRecords) {
      const source = record.result.sourceProvenance!;
      sources.set(source.sourceId, { id: source.sourceId, filePath: record.filePath, sha256: source.sha256 });
    }
    for (const record of this.documentRecords) for (const file of record.files) if (file.status === 'imported') {
      const source = file.record.result.input!.source;
      sources.set(source.sourceId, { id: source.sourceId, filePath: file.record.filePath, sha256: source.sha256 });
    }
    return structuredClone([...sources.values()]);
  }
  rejectRequest(): WorkspaceState { return { ...this.state(), error: 'This workspace request is not supported.' }; }
  private publish() { this.changed?.(this.state()); }
  private async save(): Promise<boolean> {
    if (!this.metadata) return false;
    if (!this.metadata.name.trim()) throw new Error('Enter a workspace name before saving.');
    if (this.saved) this.saved = await saveWorkspace(
      this.saved, this.metadata, this.importRecords, this.documentRecords, this.matchDecisions, this.bankCorrections, this.documentCorrections,
      this.reviewApprovals, this.duplicateDecisions, this.sourceRelocations, this.sourceReplacements, this.archivedSourceReviews
    );
    else {
      const destination = await this.dialogs.save(this.metadata.name);
      if (!destination) return false;
      this.saved = await createWorkspace(
        destination, this.metadata, this.importRecords, this.documentRecords, this.matchDecisions, this.bankCorrections, this.documentCorrections,
        this.reviewApprovals, this.duplicateDecisions, this.sourceRelocations, this.sourceReplacements, this.archivedSourceReviews
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
    this.effectiveDocuments = applyDocumentCorrections(this.documentRecords, this.documentCorrections);
    this.restoreMatches(this.saved);
    return true;
  }
  private async canLeave(): Promise<boolean> {
    if (!this.state().workspace?.dirty) return true;
    const choice = await this.dialogs.unsaved(this.metadata!.name);
    if (choice === 'cancel') return false;
    return choice === 'discard' || await this.save();
  }
  private failedImport(code: string, detail: string) {
    this.importOutcome = { status: 'failed', importId: null, issues: [importIssue(code, detail)] };
  }
  private async importStatement() {
    const controller = this.importController!; const workspaceId = this.metadata!.id;
    if (!this.importService) { this.failedImport('import-unavailable', 'Statement import is not available.'); return; }
    const result = await this.importService.run({
      existing: this.bankImports(), existingSources: this.sources(), signal: controller.signal,
      onProgress: progress => {
        if (this.importController !== controller || controller.signal.aborted || this.metadata?.id !== workspaceId || !this.statementImport) return;
        this.statementImport = { cancelling: false, progress: structuredClone(progress) }; this.publish();
      }
    });
    if (controller.signal.aborted || this.metadata?.id !== workspaceId || result.status === 'cancelled') {
      this.importOutcome = { status: 'cancelled', importId: null, issues: [] }; return;
    }
    if (result.status === 'imported') {
      const validated = storedBankImportSchema.safeParse(result.record);
      if (!validated.success) { this.failedImport('invalid-import', 'The statement import could not be validated.'); return; }
      const record = validated.data;
      const duplicate = this.importRecords.find(existing => existing.result.sourceProvenance?.sha256 === record.result.sourceProvenance?.sha256);
      if (duplicate) { this.importOutcome = { status: 'skipped', importId: duplicate.id, issues: [] }; return; }
      if (this.sources().some(source => source.sha256 === record.result.sourceProvenance?.sha256)) {
        this.importOutcome = { status: 'skipped', importId: null, issues: [] }; return;
      }
      const identities = (value: StoredBankImport) => [
        value.id, value.result.sourceProvenance!.sourceId, ...value.accounts.flatMap(account => [account.accountId, account.statementId]),
        ...value.transactions.map(row => row.transactionId), ...value.drafts.map(row => row.draftId)
      ];
      const existingIds = new Set([...this.importRecords.flatMap(identities), ...this.documentIdentities(), ...this.sources().map(source => source.id), this.metadata!.id].map(id => id.toLowerCase()));
      if (identities(record).some(id => existingIds.has(id.toLowerCase()))) { this.failedImport('invalid-import', 'The statement import contains reused workspace identities.'); return; }
      const imports = [...this.importRecords, record];
      const effective = [...this.effectiveImports, record];
      const matches = suggestWorkspaceMatches(this.activeImports(effective), this.activeDocuments());
      this.importRecords = imports;
      this.effectiveImports = effective;
      this.matches = matches;
      this.matchRevision++;
      this.importOutcome = { status: 'imported', importId: record.id, issues: structuredClone(record.result.issues) };
    } else if (result.status === 'skipped') {
      if (result.importId === null) {
        if (!this.sources().some(source => source.id === result.existingSourceId)) { this.failedImport('invalid-import', 'The duplicate source could not be identified.'); return; }
        this.importOutcome = { status: 'skipped', importId: null, issues: [] }; return;
      }
      if (!this.importRecords.some(record => record.id === result.importId)) {
        this.failedImport('invalid-import', 'The existing statement import could not be identified.'); return;
      }
      this.importOutcome = { status: 'skipped', importId: result.importId, issues: [] };
    } else this.importOutcome = { status: result.status, importId: null, issues: structuredClone(result.issues) };
  }
  private documentIdentities(): string[] {
    return this.documentRecords.flatMap(record => [record.id, ...record.files.flatMap(file => file.status === 'imported'
      ? [file.record.id, file.record.result.input!.source.sourceId] : file.status === 'failed' && file.analysis?.input ? [file.analysis.input.source.sourceId] : [])]);
  }
  private async importDocuments() {
    const controller = this.importController!; const workspaceId = this.metadata!.id;
    if (!this.documentService) { this.documentOutcome = { status: 'failed', importId: null, issues: [importIssue('import-unavailable', 'Document import is not available.')] }; return; }
    const result = await this.documentService.run({
      existingSources: this.sources(), signal: controller.signal,
      onProgress: progress => {
        if (this.importController !== controller || controller.signal.aborted || this.metadata?.id !== workspaceId || !this.documentImport) return;
        this.documentImport = { cancelling: false, progress: structuredClone(progress) }; this.publish();
      }
    });
    if (this.metadata?.id !== workspaceId || !result) { this.documentOutcome = { status: 'cancelled', importId: null, issues: [] }; return; }
    const checked = storedDocumentImportSchema.safeParse(result);
    if (!checked.success) throw new Error('The document import could not be validated.');
    const record = checked.data;
    if (controller.signal.aborted && record.status !== 'cancelled') { this.documentOutcome = { status: 'cancelled', importId: null, issues: [] }; return; }
    const identities = new Set([this.metadata.id, ...this.documentIdentities(), ...this.sources().map(source => source.id), ...this.importRecords.flatMap(bank => [
      bank.id, ...bank.accounts.flatMap(account => [account.accountId, account.statementId]), ...bank.transactions.map(row => row.transactionId), ...bank.drafts.map(row => row.draftId)
    ])].map(id => id.toLowerCase()));
    const sources = new Map(this.sources().map(source => [source.id, source]));
    const hashes = new Set([...sources.values()].flatMap(source => source.sha256 ? [source.sha256] : []));
    const reserve = (id: string) => { if (identities.has(id.toLowerCase())) throw new Error('The document import reuses a workspace identity.'); identities.add(id.toLowerCase()); };
    reserve(record.id);
    for (const file of record.files) {
      if (file.status === 'imported') {
        const source = file.record.result.input!.source;
        reserve(file.record.id); reserve(source.sourceId);
        if (hashes.has(source.sha256)) throw new Error('The document import contains content already present in the workspace.');
        hashes.add(source.sha256); sources.set(source.sourceId, { id: source.sourceId, filePath: file.record.filePath, sha256: source.sha256 });
      } else if (file.status === 'skipped') {
        if (sources.get(file.existingSourceId)?.sha256 !== file.sha256) throw new Error('The skipped file does not identify existing source content.');
      } else if (file.status === 'failed' && file.analysis?.input) reserve(file.analysis.input.source.sourceId);
    }
    const imports = [...this.documentRecords, record];
    const effective = [...this.effectiveDocuments, record];
    const hasNewDocuments = record.files.some(file => file.status === 'imported');
    const matches = hasNewDocuments ? suggestWorkspaceMatches(this.activeImports(), this.activeDocuments(effective)) : this.matches;
    this.documentRecords = imports;
    this.effectiveDocuments = effective;
    this.matches = matches;
    if (hasNewDocuments) this.matchRevision++;
    this.documentOutcome = { status: record.status, importId: record.id, issues: [] };
  }
  private reviewMatch({ revision, transactionId, review }: Extract<WorkspaceCommand, { type: 'review-match' }>) {
    if (!this.metadata || revision !== this.matchRevision) throw new Error('The match review has changed. Refresh it before making a decision.');
    if (!this.matches.some(match => match.transactionId === transactionId)) throw new Error('This transaction is no longer available for review.');
    if (review.status === 'assigned') {
      if (!this.activeDocuments(this.documentRecords).some(record => record.files.some(file => file.status === 'imported' && file.record.id === review.documentId))) {
        throw new Error('This supporting document is not available in the workspace.');
      }
      for (const [owner, documentId] of this.matchDecisions) {
        if (owner !== transactionId && documentId === review.documentId) throw new Error('This document is already assigned. Remove its existing assignment first.');
      }
    }
    const documentId = review.status === 'assigned' ? review.documentId : review.status === 'completed-without-document' ? null : undefined;
    if (this.matchDecisions.get(transactionId) === documentId) return;
    const approval = advanceReviewRevision(this.reviewApprovals.get(transactionId));
    if (documentId === undefined) this.matchDecisions.delete(transactionId);
    else this.matchDecisions.set(transactionId, documentId);
    this.reviewApprovals.set(transactionId, approval);
    this.matchRevision++;
  }
  private setDuplicateDecision({ revision, transactionId, otherTransactionId, decision }: Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>) {
    if (!this.metadata || revision !== this.matchRevision) throw new Error('The duplicate review has changed. Refresh it before making a decision.');
    const key = duplicatePairKey(transactionId, otherTransactionId);
    const previous = this.duplicateDecisions.get(key);
    const active = activeStatements(this.effectiveImports, this.sourceReplacements);
    const isActive = (id: string) => active.some(record => record.transactions.some(row => row.transactionId === id));
    const duplicates = new Map(this.duplicateDecisions), reviews = new Map(this.matchDecisions), approvals = new Map(this.reviewApprovals);
    let history: { sourceId: string; transactionId: string; documentId: string } | undefined;
    let secondary: string | null;
    if (decision === 'clear') {
      if (!previous) return;
      secondary = secondaryDuplicateId(previous);
      if (secondary && isActive(secondary) && previous.archivedReview) {
        const { documentId } = previous.archivedReview;
        const source = documentId ? supportingDocumentSource(this.documentRecords, documentId) : null;
        const superseded = source?.kind === 'document' && this.sourceReplacements.has(source.record.result.input!.source.sourceId);
        if (documentId && [...reviews.values()].includes(documentId)) {
          throw new Error('The archived document is now assigned to another booking. Remove that assignment before undoing this decision.');
        }
        if (!superseded) reviews.set(secondary, documentId);
        else if (documentId) history = { sourceId: source!.record.result.input!.source.sourceId, transactionId: secondary, documentId };
      }
      duplicates.delete(key);
    } else {
      if (previous) throw new Error('Undo the existing duplicate decision before choosing again.');
      const statement = this.effectiveImports.find(record => record.transactions.some(row => row.transactionId === transactionId));
      if (!statement || !indexStatementOverlaps(active)(statement.id).get(transactionId)
        .some(row => row.transactionId === otherTransactionId)) {
        throw new Error('These bookings are no longer possible duplicates.');
      }
      const [firstId, secondId] = [transactionId, otherTransactionId].sort();
      const primaryId = decision === 'keep-first' ? transactionId : decision === 'keep-second' ? otherTransactionId : null;
      secondary = primaryId === null ? null : primaryId === firstId ? secondId : firstId;
      const documentId = secondary ? reviews.get(secondary) : undefined;
      duplicates.set(key, { firstId, secondId, primaryId, archivedReview: documentId === undefined ? null : { documentId } });
      if (secondary) reviews.delete(secondary);
    }
    validateDuplicateDecisions(duplicates.values(), this.effectiveImports);
    if (secondary && this.matchDecisions.get(secondary) !== reviews.get(secondary)) {
      approvals.set(secondary, advanceReviewRevision(approvals.get(secondary)));
    }
    const matches = secondary ? suggestWorkspaceMatches(this.activeImports(this.effectiveImports, duplicates), this.activeDocuments()) : this.matches;
    if (history) {
      const archived = new Map(this.archivedSourceReviews.get(history.sourceId));
      archived.set(history.transactionId, history.documentId);
      this.archivedSourceReviews.set(history.sourceId, archived);
    }
    this.duplicateDecisions = duplicates;
    this.matchDecisions = reviews;
    this.reviewApprovals = approvals;
    this.matches = matches;
    this.matchRevision++;
  }
  private approveMatches({ loadRevision, selections }: Extract<WorkspaceCommand, { type: 'approve-matches' }>) {
    if (!this.metadata || loadRevision !== this.loadRevision) throw new Error('The workspace has changed. Select the transactions again before approving.');
    const rows = new Map(this.matchSummaries(this.matchRevision)!.map(row => [row.transactionId, row]));
    const documents = new Set(this.documentRecords.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [file.record.id] : [])));
    const pending: MatchApprovalSelection[] = [];
    for (const selection of selections) {
      const row = rows.get(selection.transactionId);
      const current = row?.approvalSelection;
      const reason = !current ? 'not-assigned' : !documents.has(current.documentId) ? 'document-unavailable' :
        !sameApprovalSelection(current, selection) ? 'selection-changed' : null;
      if (reason) {
        this.approvalIssue = { transactionId: selection.transactionId, reason };
        const label = row?.description.trim().split(/\r?\n/, 1)[0].slice(0, 120) || selection.transactionId;
        if (reason === 'not-assigned') throw new Error(`Transaction “${label}” has no assigned document.`);
        if (reason === 'document-unavailable') throw new Error(`The document assigned to “${label}” is unavailable.`);
        throw new Error(`The selection for “${label}” has changed. Review it again before approving.`);
      }
      if (!row?.approval && current) pending.push(current);
    }
    if (!pending.length) return;
    const batchId = randomUUID();
    const approvedAt = new Date().toISOString();
    for (const selection of pending) this.reviewApprovals.set(selection.transactionId, { associationRevision: selection.associationRevision,
      approval: { ...selection, batchId, approvedAt } });
    this.matchRevision++;
  }
  private correctBankRow({ revision, rowId, changes }: Extract<WorkspaceCommand, { type: 'correct-bank-row' }>) {
    if (!this.metadata || revision !== this.matchRevision) throw new Error('The statement has changed. Refresh it before correcting a row.');
    let current;
    for (const record of this.effectiveImports) {
      if (this.sourceReplacements.has(record.result.sourceProvenance!.sourceId)) continue;
      const transaction = record.transactions.find(row => row.transactionId === rowId);
      const draft = record.drafts.find(row => row.draftId === rowId);
      if (transaction) current = record.result.transactions.find(row => row.rowId === transaction.rowId);
      if (draft) current = record.result.unresolvedDrafts.find(row => row.rowId === draft.rowId);
      if (current) break;
    }
    if (!current) throw new Error('This statement row is no longer available.');
    const bookingDate = changes.bookingDate !== current.bookingDate?.value ? changes.bookingDate : undefined;
    const amount = changes.accountAmount;
    const previousAmount = current.accountAmount?.value;
    const accountAmount = amount && previousAmount && sameMoneyValue(amount, previousAmount) ? undefined : amount;
    if (bookingDate === undefined && accountAmount === undefined) return;
    const previous = this.bankCorrections.get(rowId);
    const correction = bankCorrectionSchema.parse({ ...previous, rowId, revision: (previous?.revision ?? 1) + 1,
      ...(bookingDate === undefined ? {} : { bookingDate }), ...(accountAmount === undefined ? {} : { accountAmount }) });
    const corrections = new Map(this.bankCorrections).set(rowId, correction);
    const effective = applyBankCorrections(this.importRecords, corrections);
    const matches = suggestWorkspaceMatches(this.activeImports(effective), this.activeDocuments());
    const before = this.effectiveImports.some(record => record.transactions.some(row => row.transactionId === rowId));
    if (before && !effective.some(record => record.transactions.some(row => row.transactionId === rowId))) {
      throw new Error('A correction cannot return an existing transaction to an unresolved draft.');
    }
    this.bankCorrections = corrections;
    this.effectiveImports = effective;
    this.matches = matches;
    this.matchRevision++;
  }
  private correctDocumentField({ revision, documentId, sectionId, fieldId, change }: Extract<WorkspaceCommand, { type: 'correct-document-field' }>) {
    if (!this.metadata || revision !== this.matchRevision) throw new Error('The document has changed. Refresh it before correcting a field.');
    if (!supportingDocumentSource(this.activeDocuments(this.documentRecords), documentId)) throw new Error('This document is no longer active.');
    const target = { documentId, sectionId, fieldId };
    const key = documentCorrectionKey(target, change.kind);
    const previous = this.documentCorrections.get(key);
    if (previous?.change.kind === 'amount' && change.kind === 'amount' && sameMoneyValue(previous.change.value, change.value)) return;
    if (previous?.change.kind === 'date' && change.kind === 'date' && previous.change.value === change.value) return;
    if (!previous && fieldId !== null) {
      const file = this.documentRecords.flatMap(record => record.files).find(file => file.status === 'imported' && file.record.id === documentId);
      if (file?.status === 'imported' && !file.record.result.issues.some(issue => issue.fieldId === fieldId)) {
        const section = file.record.result.sections.find(section => section.sectionId === sectionId);
        if (change.kind === 'date') {
          const candidates = section?.dates.find(field => field.id === fieldId)?.candidates;
          if (candidates?.length === 1 && candidates[0] === change.value) return;
        } else {
          const candidates = section?.amounts.find(field => field.id === fieldId)?.candidates;
          const amount = candidates?.[0];
          if (candidates?.length === 1 && amount?.currency && sameMoneyValue({ ...amount, currency: amount.currency }, change.value)) return;
        }
      }
    }
    let latest = 1;
    for (const correction of this.documentCorrections.values()) if (correction.documentId === documentId) latest = Math.max(latest, correction.revision);
    const correction = documentCorrectionSchema.parse({ ...target, revision: latest + 1, change });
    const corrections = new Map(this.documentCorrections).set(key, correction);
    const effective = applyDocumentCorrections(this.documentRecords, corrections);
    const matches = suggestWorkspaceMatches(this.activeImports(), this.activeDocuments(effective));
    this.documentCorrections = corrections;
    this.effectiveDocuments = effective;
    this.matches = matches;
    this.matchRevision++;
  }
  async dispatch(command: WorkspaceCommand): Promise<WorkspaceState> {
    if (command.type === 'get-state') return this.state();
    if (command.type === 'cancel-import') {
      if (this.importController && (this.statementImport || this.documentImport) && !this.importController.signal.aborted) {
        if (this.statementImport) this.statementImport = { ...this.statementImport, cancelling: true };
        if (this.documentImport) this.documentImport = { ...this.documentImport, cancelling: true };
        this.importController.abort(); this.publish();
      }
      return this.state();
    }
    if (this.busy) return { ...this.state(), error: 'Finish the current workspace action before starting another.' };
    if (command.type === 'rename') {
      if (this.metadata) this.metadata = { ...this.metadata, name: command.name };
      this.error = null; this.approvalIssue = undefined; this.publish(); return this.state();
    }
    if (command.type === 'import-statement') {
      if (!this.metadata) { this.error = 'Create or open a workspace before importing a statement.'; this.publish(); return this.state(); }
      this.importController = new AbortController(); this.statementImport = { cancelling: false, progress: null }; this.importOutcome = null;
    }
    if (command.type === 'import-documents') {
      if (!this.metadata) { this.error = 'Create or open a workspace before analyzing documents.'; this.publish(); return this.state(); }
      this.importController = new AbortController(); this.documentImport = { cancelling: false, progress: null }; this.documentOutcome = null;
    }
    this.busy = true; this.error = null; this.approvalIssue = undefined; this.publish();
    try {
      switch (command.type) {
        case 'save': await this.save(); break;
        case 'review-match': this.reviewMatch(command); break;
        case 'set-duplicate-decision': this.setDuplicateDecision(command); break;
        case 'approve-matches': this.approveMatches(command); break;
        case 'correct-bank-row': this.correctBankRow(command); break;
        case 'correct-document-field': this.correctDocumentField(command); break;
        case 'import-statement': await this.importStatement(); break;
        case 'import-documents': await this.importDocuments(); break;
        case 'new':
          if (await this.canLeave()) {
            this.metadata = newMetadata(); this.saved = null; this.importRecords = []; this.documentRecords = []; this.matches = []; this.matchDecisions.clear();
            this.bankCorrections.clear(); this.effectiveImports = [];
            this.documentCorrections.clear(); this.effectiveDocuments = [];
            this.reviewApprovals.clear(); this.duplicateDecisions.clear(); this.sourceRelocations.clear();
            this.sourceReplacements.clear(); this.archivedSourceReviews.clear(); this.pendingAnalysis = null;
            this.importOutcome = null; this.documentOutcome = null; this.loadRevision++; this.matchRevision++;
          }
          break;
        case 'open': {
          if (!await this.canLeave()) break;
          const selected = await this.dialogs.open();
          if (!selected) break;
          const loaded = await loadWorkspace(selected);
          this.metadata = { ...loaded.metadata }; this.saved = loaded; this.importRecords = structuredClone(loaded.imports); this.documentRecords = structuredClone(loaded.documentImports);
          this.matchDecisions = new Map(loaded.matchDecisions);
          this.reviewApprovals = new Map(loaded.reviewApprovals);
          this.sourceRelocations = new Map(loaded.sourceRelocations);
          this.bankCorrections = new Map(loaded.bankCorrections);
          this.effectiveImports = applyBankCorrections(this.importRecords, this.bankCorrections);
          this.documentCorrections = new Map(loaded.documentCorrections);
          this.effectiveDocuments = applyDocumentCorrections(this.documentRecords, this.documentCorrections);
          this.restoreMatches(loaded);
          this.pendingAnalysis = null;
          this.importOutcome = null; this.documentOutcome = null; this.loadRevision++; this.matchRevision++;
          break;
        }
      }
    } catch (error) {
      if (command.type === 'import-statement') {
        if (this.importController?.signal.aborted) this.importOutcome = { status: 'cancelled', importId: null, issues: [] };
        else this.failedImport('import-failed', 'The statement could not be imported.');
      } else if (command.type === 'import-documents') {
        this.documentOutcome = { status: this.importController?.signal.aborted ? 'cancelled' : 'failed', importId: null,
          issues: this.importController?.signal.aborted ? [] : [importIssue('import-failed', message(error))] };
      } else this.error = message(error);
    }
    finally {
      if (command.type === 'import-statement') { this.importController = null; this.statementImport = null; }
      if (command.type === 'import-documents') { this.importController = null; this.documentImport = null; }
      this.busy = false; this.publish();
    }
    return this.state();
  }
  async requestClose(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true; this.error = null; this.approvalIssue = undefined; this.publish();
    try { return await this.canLeave(); }
    catch (error) { this.error = message(error); return false; }
    finally { this.busy = false; this.publish(); }
  }
}
