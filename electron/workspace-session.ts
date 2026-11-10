import { ZodError } from 'zod';
import type { WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import { importIssue } from '../src/shared/bank-import.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, type SavedWorkspace, type WorkspaceMetadata } from './store.js';
import type { BankImportService } from './import/service.js';

export interface WorkspaceDialogs {
  open(): Promise<string | null>;
  save(name: string): Promise<string | null>;
  unsaved(name: string): Promise<'save' | 'discard' | 'cancel'>;
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
  private importRecords: StoredBankImport[] = [];
  private importController: AbortController | null = null;
  private statementImport: WorkspaceState['statementImport'] = null;
  private importOutcome: WorkspaceState['importOutcome'] = null;
  private loadRevision = 0;
  constructor(private readonly dialogs: WorkspaceDialogs, private readonly changed?: (state: WorkspaceState) => void, private readonly importService?: BankImportService) {}

  state(): WorkspaceState {
    const imports = this.importRecords.map(record => ({
      id: record.id, filePath: record.filePath, bankId: record.result.adapter!.bankId,
      status: record.result.status === 'complete' ? 'complete' as const : 'partial' as const,
      transactions: record.result.transactions.length, drafts: record.result.unresolvedDrafts.length, issues: record.result.issues.length
    }));
    const sameImports = this.saved?.imports.length === this.importRecords.length && this.importRecords.every((record, index) => record.id === this.saved!.imports[index].id);
    return {
      workspace: this.metadata ? {
        id: this.metadata.id, loadRevision: this.loadRevision, name: this.metadata.name, dirty: !this.saved || this.metadata.name !== this.saved.metadata.name || !sameImports,
        filePath: this.saved?.filePath ?? null, savedAt: this.saved?.metadata.savedAt ?? null, imports
      } : null,
      busy: this.busy, error: this.error, statementImport: structuredClone(this.statementImport), importOutcome: structuredClone(this.importOutcome)
    };
  }
  bankImports(): StoredBankImport[] { return structuredClone(this.importRecords); }
  rejectRequest(): WorkspaceState { return { ...this.state(), error: 'This workspace request is not supported.' }; }
  private publish() { this.changed?.(this.state()); }
  private async save(): Promise<boolean> {
    if (!this.metadata) return false;
    if (!this.metadata.name.trim()) throw new Error('Enter a workspace name before saving.');
    if (this.saved) this.saved = await saveWorkspace(this.saved, this.metadata, this.importRecords);
    else {
      const destination = await this.dialogs.save(this.metadata.name);
      if (!destination) return false;
      this.saved = await createWorkspace(destination, this.metadata, this.importRecords);
    }
    this.metadata = { ...this.saved.metadata };
    this.importRecords = structuredClone(this.saved.imports);
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
      existing: this.bankImports(), signal: controller.signal,
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
      const identities = (value: StoredBankImport) => [
        value.id, value.result.sourceProvenance!.sourceId, ...value.accounts.flatMap(account => [account.accountId, account.statementId]),
        ...value.transactions.map(row => row.transactionId), ...value.drafts.map(row => row.draftId)
      ];
      const existingIds = new Set(this.importRecords.flatMap(identities));
      if (identities(record).some(id => existingIds.has(id))) { this.failedImport('invalid-import', 'The statement import contains reused workspace identities.'); return; }
      this.importRecords = [...this.importRecords, record];
      this.importOutcome = { status: 'imported', importId: record.id, issues: structuredClone(record.result.issues) };
    } else if (result.status === 'skipped') {
      if (!this.importRecords.some(record => record.id === result.importId)) {
        this.failedImport('invalid-import', 'The existing statement import could not be identified.'); return;
      }
      this.importOutcome = { status: 'skipped', importId: result.importId, issues: [] };
    } else this.importOutcome = { status: result.status, importId: null, issues: structuredClone(result.issues) };
  }
  async dispatch(command: WorkspaceCommand): Promise<WorkspaceState> {
    if (command.type === 'get-state') return this.state();
    if (command.type === 'cancel-import') {
      if (this.importController && this.statementImport && !this.importController.signal.aborted) {
        this.statementImport = { ...this.statementImport, cancelling: true }; this.importController.abort(); this.publish();
      }
      return this.state();
    }
    if (this.busy) return { ...this.state(), error: 'Finish the current workspace action before starting another.' };
    if (command.type === 'rename') {
      if (this.metadata) this.metadata = { ...this.metadata, name: command.name };
      this.error = null; this.publish(); return this.state();
    }
    if (command.type === 'import-statement') {
      if (!this.metadata) { this.error = 'Create or open a workspace before importing a statement.'; this.publish(); return this.state(); }
      this.importController = new AbortController(); this.statementImport = { cancelling: false, progress: null }; this.importOutcome = null;
    }
    this.busy = true; this.error = null; this.publish();
    try {
      switch (command.type) {
        case 'save': await this.save(); break;
        case 'import-statement': await this.importStatement(); break;
        case 'new':
          if (await this.canLeave()) { this.metadata = newMetadata(); this.saved = null; this.importRecords = []; this.importOutcome = null; this.loadRevision++; }
          break;
        case 'open': {
          if (!await this.canLeave()) break;
          const selected = await this.dialogs.open();
          if (!selected) break;
          const loaded = await loadWorkspace(selected);
          this.metadata = { ...loaded.metadata }; this.saved = loaded; this.importRecords = structuredClone(loaded.imports); this.importOutcome = null; this.loadRevision++;
          break;
        }
      }
    } catch (error) {
      if (command.type === 'import-statement') {
        if (this.importController?.signal.aborted) this.importOutcome = { status: 'cancelled', importId: null, issues: [] };
        else this.failedImport('import-failed', 'The statement could not be imported.');
      } else this.error = message(error);
    }
    finally {
      if (command.type === 'import-statement') { this.importController = null; this.statementImport = null; }
      this.busy = false; this.publish();
    }
    return this.state();
  }
  async requestClose(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true; this.error = null; this.publish();
    try { return await this.canLeave(); }
    catch (error) { this.error = message(error); return false; }
    finally { this.busy = false; this.publish(); }
  }
}
