import { ZodError } from 'zod';
import type { WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, type SavedWorkspace, type WorkspaceMetadata } from './store.js';

export interface WorkspaceDialogs {
  open(): Promise<string | null>;
  save(name: string): Promise<string | null>;
  unsaved(name: string): Promise<'save' | 'discard' | 'cancel'>;
}

function message(error: unknown): string {
  if (error instanceof ZodError) return 'Enter a workspace name between 1 and 120 characters.';
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
  constructor(private readonly dialogs: WorkspaceDialogs, private readonly changed?: (state: WorkspaceState) => void) {}

  state(): WorkspaceState {
    return { workspace: this.metadata ? { id: this.metadata.id, name: this.metadata.name, dirty: !this.saved || this.metadata.name !== this.saved.metadata.name, filePath: this.saved?.filePath ?? null, savedAt: this.saved?.metadata.savedAt ?? null } : null, busy: this.busy, error: this.error };
  }
  rejectRequest(): WorkspaceState { return { ...this.state(), error: 'This workspace request is not supported.' }; }
  private publish() { this.changed?.(this.state()); }
  private async save(): Promise<boolean> {
    if (!this.metadata) return false;
    if (!this.metadata.name.trim()) throw new Error('Enter a workspace name before saving.');
    if (this.saved) this.saved = await saveWorkspace(this.saved, this.metadata);
    else {
      const destination = await this.dialogs.save(this.metadata.name);
      if (!destination) return false;
      this.saved = await createWorkspace(destination, this.metadata);
    }
    this.metadata = { ...this.saved.metadata };
    return true;
  }
  private async canLeave(): Promise<boolean> {
    if (!this.state().workspace?.dirty) return true;
    const choice = await this.dialogs.unsaved(this.metadata!.name);
    if (choice === 'cancel') return false;
    return choice === 'discard' || await this.save();
  }
  async dispatch(command: WorkspaceCommand): Promise<WorkspaceState> {
    if (command.type === 'get-state') return this.state();
    if (this.busy) return { ...this.state(), error: 'Finish the current workspace action before starting another.' };
    if (command.type === 'rename') {
      if (this.metadata) this.metadata = { ...this.metadata, name: command.name };
      this.error = null; this.publish(); return this.state();
    }
    this.busy = true; this.error = null; this.publish();
    try {
      switch (command.type) {
        case 'save': await this.save(); break;
        case 'new':
          if (await this.canLeave()) { this.metadata = newMetadata(); this.saved = null; }
          break;
        case 'open': {
          if (!await this.canLeave()) break;
          const selected = await this.dialogs.open();
          if (!selected) break;
          const loaded = await loadWorkspace(selected);
          this.metadata = { ...loaded.metadata }; this.saved = loaded;
          break;
        }
      }
    } catch (error) { this.error = message(error); }
    finally { this.busy = false; this.publish(); }
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
