import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { DocumentImports } from './app/document-imports.js';
import { MatchSuggestions } from './app/match-suggestions.js';
import type { WorkspaceBridge, WorkspaceCommand, WorkspaceState } from './shared/protocol.js';
import { StatementImports } from './statement-imports.js';

declare global { interface Window { receiptmatch: WorkspaceBridge; } }

type WorkspaceSection = 'sources' | 'matches';

@Component({
  selector: 'app-root', standalone: true, imports: [StatementImports, DocumentImports, MatchSuggestions],
  templateUrl: './app/workspace-shell.html'
})
class ReceiptMatchApp {
  readonly state = signal<WorkspaceState>({ workspace: null, busy: true, error: null, statementImport: null, importOutcome: null, documentImport: null, documentOutcome: null });
  readonly commandError = signal<string | null>(null);
  private readonly navigation = signal<{ loadRevision: number; section: WorkspaceSection } | null>(null);
  readonly section = computed(() => {
    const navigation = this.navigation();
    return navigation && navigation.loadRevision === this.state().workspace?.loadRevision ? navigation.section : 'sources';
  });
  private stateRevision = 0;
  private commandGeneration = 0;
  private disposed = false;
  constructor() {
    const unsubscribe = window.receiptmatch.subscribe(state => {
      if (this.disposed) return;
      this.stateRevision++; this.commandError.set(null); this.state.set(state);
    });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.commandGeneration++; unsubscribe(); });
    void this.run({ type: 'get-state' });
  }
  async run(command: WorkspaceCommand) {
    const generation = ++this.commandGeneration; const revision = this.stateRevision;
    const loadRevision = this.state().workspace?.loadRevision;
    try {
      const result = await window.receiptmatch.command(command);
      if (this.disposed || generation !== this.commandGeneration) return;
      // Subscribed state is authoritative even when an older command reply arrives later.
      if (revision === this.stateRevision) { this.commandError.set(null); this.state.set(result); }
      if ((command.type === 'new' || command.type === 'open') && result.workspace && result.workspace.loadRevision !== loadRevision) {
        requestAnimationFrame(() => {
          if (!this.disposed && generation === this.commandGeneration && result.workspace?.loadRevision === this.state().workspace?.loadRevision) document.getElementById('workspace-name')?.focus();
        });
      }
    } catch {
      if (!this.disposed && generation === this.commandGeneration && revision === this.stateRevision) this.commandError.set('The workspace action could not be completed. Please try again.');
    }
  }
  showSection(section: WorkspaceSection) {
    const workspace = this.state().workspace;
    if (!workspace || section === this.section()) return;
    this.navigation.set({ loadRevision: workspace.loadRevision, section });
    requestAnimationFrame(() => {
      if (!this.disposed && this.state().workspace?.loadRevision === workspace.loadRevision && this.section() === section) {
        document.getElementById(section === 'sources' ? 'sources-heading' : 'matches-heading')?.focus();
      }
    });
  }
  rename(event: Event) { void this.run({ type: 'rename', name: (event.target as HTMLInputElement).value }); }
}

void bootstrapApplication(ReceiptMatchApp);
