import { Component, DestroyRef, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import type { WorkspaceBridge, WorkspaceCommand, WorkspaceState } from './shared/protocol.js';

declare global { interface Window { receiptmatch: WorkspaceBridge; } }

@Component({
  selector: 'app-root', standalone: true,
  template: `
    <header class="toolbar">
      <div class="identity"><span class="brand-mark" aria-hidden="true">r<span>m</span></span><strong>ReceiptMatch</strong></div>
      <div class="toolbar-state" aria-live="polite">{{ state().workspace ? (state().workspace!.dirty ? 'Unsaved changes' : 'All changes saved') : 'Your local workspace' }}</div>
      <nav aria-label="Workspace actions"><button (click)="run({type:'new'})" [disabled]="state().busy" title="New workspace (Ctrl+N)">New</button><button (click)="run({type:'open'})" [disabled]="state().busy" title="Open workspace (Ctrl+O)">Open</button><button class="button-primary compact" (click)="run({type:'save'})" [disabled]="state().busy || !state().workspace || !state().workspace!.dirty" title="Save workspace (Ctrl+S)">Save</button></nav>
    </header>
    <main>
      @if (state().error) { <div class="error" role="alert"><span aria-hidden="true">!</span><p>{{ state().error }}</p></div> }
      @if (state().workspace; as workspace) {
        <section class="workspace-view" aria-labelledby="workspace-heading">
          <div class="eyebrow"><span class="status-dot" [class.unsaved]="workspace.dirty"></span> WORKSPACE</div>
          <h1 id="workspace-heading">A place for your records.</h1>
          <p class="intro">Keep your reconciliation work together, on your computer.</p>
          <div class="workspace-details">
            <label for="workspace-name">Workspace name</label>
            <input id="workspace-name" type="text" maxlength="120" autocomplete="off" [value]="workspace.name" (input)="rename($event)" [disabled]="state().busy" aria-describedby="name-help">
            <p id="name-help" class="field-help">Choose a name you’ll recognise when you return.</p>
            <div class="location-row"><span class="detail-label">Location</span><p class="file-location" [title]="workspace.filePath || ''">{{ workspace.filePath || 'Not saved yet' }}</p></div>
            <div class="saved-row"><span class="detail-label">Status</span><p aria-live="polite">{{ workspace.dirty ? 'You have unsaved changes.' : 'Your workspace is saved on this computer.' }}</p></div>
          </div>
          @if (!workspace.filePath) { <div class="save-prompt"><p>Save your workspace to come back to it later.</p><button class="button-primary" (click)="run({type:'save'})" [disabled]="state().busy">Save workspace <span aria-hidden="true">↗</span></button></div> }
        </section>
      } @else {
        <section class="welcome" aria-labelledby="welcome-heading">
          <div class="eyebrow">LOCAL BY DESIGN</div>
          <h1 id="welcome-heading">Your records.<br>Your workspace.</h1>
          <p class="intro">Start a workspace for your financial records,<br class="wide-only"> or pick up where you left off.</p>
          <div class="welcome-actions"><button class="button-primary" (click)="run({type:'new'})" [disabled]="state().busy">Create workspace <span aria-hidden="true">+</span></button><button class="button-secondary" (click)="run({type:'open'})" [disabled]="state().busy">Open workspace <span aria-hidden="true">↗</span></button></div>
          <div class="local-note"><svg aria-hidden="true" width="17" height="18" viewBox="0 0 17 18" fill="none"><rect x="3" y="7" width="11" height="9" rx="2" stroke="currentColor"/><path d="M5.5 7V4a3 3 0 0 1 6 0v3" stroke="currentColor"/></svg><p>Stored locally. No account needed.</p></div>
          <div class="paper-detail" aria-hidden="true"><div class="paper-top"></div><div class="paper-line long"></div><div class="paper-line"></div><div class="paper-divider"></div><div class="paper-line medium"></div><div class="paper-stamp">✓</div></div>
        </section>
      }
    </main>
    <footer><span>ReceiptMatch</span><span>Local files. Your control.</span></footer>
  `
})
class ReceiptMatchApp {
  readonly state = signal<WorkspaceState>({ workspace: null, busy: true, error: null, statementImport: null, importOutcome: null });
  constructor() {
    inject(DestroyRef).onDestroy(window.receiptmatch.subscribe(state => this.state.set(state)));
    void this.run({ type: 'get-state' });
  }
  async run(command: WorkspaceCommand) {
    try {
      this.state.set(await window.receiptmatch.command(command));
      if ((command.type === 'new' || command.type === 'open') && this.state().workspace) requestAnimationFrame(() => document.getElementById('workspace-name')?.focus());
    } catch { this.state.update(state => ({ ...state, busy: false, error: 'The workspace action could not be completed. Please try again.' })); }
  }
  rename(event: Event) { void this.run({ type: 'rename', name: (event.target as HTMLInputElement).value }); }
}

void bootstrapApplication(ReceiptMatchApp);
