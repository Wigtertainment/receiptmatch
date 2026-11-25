import { Component, computed, DestroyRef, inject, signal, viewChild, type Signal, type WritableSignal } from '@angular/core';
import { WigAlertComponent, WigButtonComponent, WigInputComponent } from '@wigtertainment-ltd/comp-lib';
import { DocumentImports } from '../documents/document-imports.component.js';
import { ExportSettings } from '../settings/export-settings.component.js';
import { LocalOcrSettings } from '../settings/local-ocr-settings.component.js';
import { InputLength } from '../shared/input-length.directive.js';
import { MatchSuggestions } from '../matching/match-suggestions.component.js';
import type { IWorkspaceBridge, WorkspaceCommand, IWorkspaceState, IWorkspaceView } from '../../shared/protocol.js';
import { StatementImports } from '../statements/statement-imports.component.js';

declare global {
  var receiptmatch: IWorkspaceBridge;
}

type WorkspaceSection = 'sources' | 'matches' | 'export-settings' | 'settings';
interface IWorkspaceNavigation { loadRevision: number; section: WorkspaceSection }

@Component({
  selector: 'app-root', standalone: true,
  imports: [StatementImports, DocumentImports, MatchSuggestions, ExportSettings, LocalOcrSettings, WigAlertComponent, WigButtonComponent, WigInputComponent, InputLength],
  templateUrl: './workspace-shell.component.html'
})
export class WorkspaceShell {
  constructor() {
    const unsubscribe: () => void = window.receiptmatch.subscribe((state: IWorkspaceState): void => {
      if (this.disposed) {
        return;
      }
      this.stateRevision++; this.commandError.set(null); this.state.set(state);
    });
    inject(DestroyRef).onDestroy((): void => {
      this.disposed = true; this.commandGeneration++; unsubscribe();
    });
    void this.run({ type: 'get-state' });
    void window.receiptmatch.appVersion().then((version: string): void => {
      if (!this.disposed) {
        this.version.set(version);
      }
    }).catch((): null => null);
  }

  readonly version: WritableSignal<string | null> = signal<string | null>(null);
  readonly state: WritableSignal<IWorkspaceState> = signal<IWorkspaceState>({ workspace: null, busy: true, error: null, statementImport: null, importOutcome: null, documentImport: null, documentOutcome: null });
  readonly commandError: WritableSignal<string | null> = signal<string | null>(null);
  readonly welcomeSettings: WritableSignal<boolean> = signal(false);
  private readonly welcomeSettingsButton: Signal<WigButtonComponent | undefined> = viewChild<WigButtonComponent>('welcomeSettingsButton');
  private readonly navigation: WritableSignal<IWorkspaceNavigation | null> = signal<IWorkspaceNavigation | null>(null);
  readonly section: Signal<WorkspaceSection> = computed((): WorkspaceSection => {
    const navigation: IWorkspaceNavigation | null = this.navigation();
    return navigation && navigation.loadRevision === this.state().workspace?.loadRevision ? navigation.section : 'sources';
  });
  private stateRevision: number = 0;
  private commandGeneration: number = 0;
  private disposed: boolean = false;

  async run(command: WorkspaceCommand): Promise<void> {
    const generation: number = ++this.commandGeneration; const revision: number = this.stateRevision;
    const loadRevision: number | undefined = this.state().workspace?.loadRevision;
    try {
      const result: IWorkspaceState = await window.receiptmatch.command(command);
      if (this.disposed || generation !== this.commandGeneration) {
        return;
      }
      // Subscribed state is authoritative even when an older command reply arrives later.
      if (revision === this.stateRevision) {
        this.commandError.set(null); this.state.set(result);
      }
      if ((command.type === 'new' || command.type === 'open') && result.workspace && result.workspace.loadRevision !== loadRevision) {
        requestAnimationFrame((): void => {
          if (!this.disposed && generation === this.commandGeneration && result.workspace?.loadRevision === this.state().workspace?.loadRevision) {
            document.getElementById('workspace-name')?.focus();
          }
        });
      }
    } catch {
      if (!this.disposed && generation === this.commandGeneration && revision === this.stateRevision) {
        this.commandError.set('The workspace action could not be completed. Please try again.');
      }
    }
  }

  showSection(section: WorkspaceSection): void {
    const workspace: IWorkspaceView | null = this.state().workspace;
    if (!workspace || section === this.section()) {
      return;
    }
    this.navigation.set({ loadRevision: workspace.loadRevision, section });
    requestAnimationFrame((): void => {
      if (!this.disposed && this.state().workspace?.loadRevision === workspace.loadRevision && this.section() === section) {
        document.getElementById(section + '-heading')?.focus();
      }
    });
  }

  showWelcomeSettings(open: boolean): void {
    this.welcomeSettings.set(open);
    requestAnimationFrame((): void => {
      if (!this.disposed && !this.state().workspace && this.welcomeSettings() === open) {
        if (open) {
          document.getElementById('settings-heading')?.focus();
        } else {
          this.welcomeSettingsButton()?.nativeButton.focus();
        }
      }
    });
  }

  showFileLocationTooltip(path: HTMLElement): void {
    path.title = path.scrollWidth > path.clientWidth ? path.textContent ?? '' : '';
  }

  rename(name: string): void {
    void this.run({ type: 'rename', name });
  }
}
