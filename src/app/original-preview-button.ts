import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, TemplateRef, computed, inject, input, signal, viewChild } from '@angular/core';
import type { OriginalAnalysisComparison, OriginalPreviewRequest, OriginalPreviewResult } from '../shared/original-preview.js';

interface PreviewFeedback extends OriginalPreviewResult {
    source: OriginalPreviewRequest;
    pending: 'open' | 'relink' | 'analyze' | 'adopt' | null;
    actionError?: string;
    notice?: string;
    comparison?: OriginalAnalysisComparison;
}

@Component({
    selector: 'app-original-preview-button',
    standalone: true,
    imports: [NgTemplateOutlet],
    styles: [`
      .analysis-dialog { width: min(48rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); border: 1px solid var(--outline); border-radius: 8px; padding: 1.25rem; color: var(--ink); }
      .analysis-dialog::backdrop { background: #172d2a80; }
      .analysis-dialog h3 { margin: 0; }
      .analysis-dialog h4 { margin-bottom: .25rem; }
      .analysis-paths dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
      .analysis-paths dt { font-weight: 650; }
      .analysis-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .analysis-table th, .analysis-table td { border-bottom: 1px solid var(--divider); padding: .4rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; white-space: pre-wrap; }
      .analysis-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
      .analysis-conflicts { padding: .65rem; background: var(--workspace-background); }
      .analysis-conflicts h4 { margin-top: 0; }
    `],
    template: `
      @let current = feedback();
      @let canRelink = current?.status === 'missing' || current?.status === 'changed';
      @if (sourceId()) {
      <button #openButton type="button" [class]="iconOnly() ? 'preview-icon' : 'button-secondary compact'" [attr.aria-label]="'Open original ' + sourceName()"
        [attr.title]="iconOnly() ? (current?.pending === 'open' ? 'Opening…' : 'Open original') : null"
        [attr.aria-busy]="current?.pending === 'open' ? 'true' : null"
        [attr.aria-disabled]="current?.pending || loadRevision() === undefined ? 'true' : null" (click)="open()">
        @if (iconOnly()) {
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.1 15.1 4.9 4.9" />
          </svg>
        } @else {
          {{ current?.pending === 'open' ? 'Opening…' : 'Open original' }}
        }
      </button>
      <ng-template #feedbackContent>
      @if (current?.error; as error) {
        <p class="original-preview-error" role="alert">
          {{ error }}
          @if (canRelink) { Relink an identical copy or analyze a changed file. }
          @if (!current?.comparison) { {{ current?.actionError }} }
        </p>
      }
      @if (canRelink) {
        <button type="button" class="button-secondary compact" [attr.aria-label]="'Relink original ' + sourceName()"
          [attr.aria-busy]="current?.pending === 'relink' ? 'true' : null"
          [attr.aria-disabled]="current?.pending ? 'true' : null" (click)="relink(openButton)">
          {{ current?.pending === 'relink' ? 'Relinking…' : 'Relink original' }}
        </button>
        <button type="button" class="button-secondary compact" [attr.aria-label]="'Analyze changed file for ' + sourceName()"
          [attr.aria-busy]="current?.pending === 'analyze' ? 'true' : null"
          [attr.aria-disabled]="current?.pending ? 'true' : null" (click)="analyze()">
          {{ current?.pending === 'analyze' ? 'Analyzing…' : 'Analyze changed file' }}
        </button>
      }
      @if (current?.notice; as notice) {
        <p class="muted" role="status">{{ notice }}</p>
      }
      </ng-template>
      @if (!iconOnly()) {
        <ng-container [ngTemplateOutlet]="feedbackContent" />
      }
      @if (current?.comparison; as comparison) {
        <dialog #analysisDialog class="analysis-dialog" aria-label="Review analyzed file" (cancel)="closeAnalysis(analysisDialog, $event)" (close)="dismissAnalysis()">
          <h3 tabindex="-1" autofocus>Review analyzed file</h3>
          <dl class="analysis-paths">
            <dt>Previous source</dt><dd>{{ comparison.oldPath }}</dd>
            <dt>Analyzed file</dt><dd>{{ comparison.newPath }}</dd>
          </dl>
          <p>{{ comparison.preserved }} existing review decisions retained · {{ comparison.revoked }} approvals revoked</p>
          @if (comparison.changes.length) {
            <table class="analysis-table" aria-label="Extracted changes">
              <thead><tr><th scope="col">Detail</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
              <tbody>
                @for (change of comparison.changes; track $index) {
                  <tr><th scope="row">{{ change.label }}</th><td>{{ change.before ?? '—' }}</td><td>{{ change.after ?? '—' }}</td></tr>
                }
              </tbody>
            </table>
          } @else {
            <p>No changes to extracted details were found.</p>
          }
          @if (comparison.conflicts.length) {
            <div class="analysis-conflicts">
              <h4>Conflicts requiring review</h4>
              <ul>@for (conflict of comparison.conflicts; track $index) { <li>{{ conflict }}</li> }</ul>
              <label>
                <input #acknowledgement type="checkbox" [checked]="acknowledgeConflicts()" [disabled]="current?.pending === 'adopt'"
                  (change)="acknowledgeConflicts.set(acknowledgement.checked)" />
                I understand that ambiguous items stay in the previous analysis and newly extracted items need review.
              </label>
            </div>
          }
          @if (current?.actionError; as error) { <p class="original-preview-error" role="alert">{{ error }}</p> }
          <div class="analysis-actions">
            <button type="button" class="button-primary compact" [disabled]="!!current?.pending || (comparison.conflicts.length > 0 && !acknowledgeConflicts())"
              (click)="applyAnalysis(analysisDialog, openButton)">{{ current?.pending === 'adopt' ? 'Applying…' : 'Apply analyzed file' }}</button>
            <button type="button" class="button-secondary compact" [disabled]="current?.pending === 'adopt'" (click)="closeAnalysis(analysisDialog)">Cancel</button>
          </div>
        </dialog>
      }
      }
    `
})
export class OriginalPreviewButton {
    readonly kind = input.required<'statement' | 'document'>();
    readonly sourceId = input.required<string | undefined>();
    readonly sourceName = input.required<string>();
    readonly loadRevision = input.required<number | undefined>();
    readonly iconOnly = input(false);
    readonly acknowledgeConflicts = signal(false);
    private readonly request = signal<PreviewFeedback | null>(null);
    private readonly destroyed = inject(DestroyRef);
    private readonly analysisDialog = viewChild<ElementRef<HTMLDialogElement>>('analysisDialog');
    readonly feedbackContent = viewChild<TemplateRef<unknown>>('feedbackContent');
    readonly feedback = computed(() => {
        const request = this.request();
        return request && request.source.id === this.sourceId() && request.source.kind === this.kind() && request.source.loadRevision === this.loadRevision() ? request : null;
    });
    readonly hasFeedback = computed(() => {
        const current = this.feedback();
        return !!(current?.error || current?.notice || current?.status === 'missing' || current?.status === 'changed');
    });

    async open() {
        const loadRevision = this.loadRevision(), id = this.sourceId();
        if (id === undefined || loadRevision === undefined || this.feedback()?.pending) return;
        const request: PreviewFeedback = { source: { kind: this.kind(), id, loadRevision }, pending: 'open', error: null };
        this.request.set(request);
        try {
            const result = await window.receiptmatch.openOriginal(request.source);
            if (this.request() === request) this.request.set({ ...request, ...result, pending: null });
        } catch {
            if (this.request() === request) this.request.set({ ...request, pending: null, error: 'The original could not be opened. Try again.' });
        }
    }

    async relink(openButton: HTMLButtonElement) {
        const current = this.feedback();
        if (!current || current.pending || (current.status !== 'missing' && current.status !== 'changed')) return;
        const request: PreviewFeedback = { ...current, pending: 'relink', actionError: undefined };
        this.request.set(request);
        const failure = 'The original could not be relinked. Try again.';
        try {
            const result = await window.receiptmatch.relinkOriginal(request.source);
            if (this.request() !== request) return;
            if (result.status === 'linked') {
                if (this.feedback() === request && openButton.isConnected) openButton.focus();
                this.request.set({ source: request.source, pending: null, error: null, notice: 'Original relinked. You can open it again.' });
            } else {
                this.request.set({ ...request, pending: null, actionError: result.status === 'failed' ? result.error ?? failure : undefined });
            }
        } catch {
            if (this.request() === request) this.request.set({ ...request, pending: null, actionError: failure });
        }
    }

    async analyze() {
        const current = this.feedback();
        if (!current || current.pending || (current.status !== 'missing' && current.status !== 'changed')) return;
        const request: PreviewFeedback = { ...current, pending: 'analyze', comparison: undefined, actionError: undefined };
        this.request.set(request);
        try {
            const result = await window.receiptmatch.analyzeOriginal(request.source);
            if (this.destroyed.destroyed || this.feedback() !== request) return;
            if (result.status !== 'ready') {
                this.request.set({ ...request, pending: null, actionError: result.status === 'failed' ? result.error : undefined });
                return;
            }
            this.acknowledgeConflicts.set(false);
            const ready: PreviewFeedback = { ...request, pending: null, comparison: result.comparison };
            this.request.set(ready);
            requestAnimationFrame(() => {
                if (this.destroyed.destroyed || this.feedback() !== ready) return;
                this.analysisDialog()?.nativeElement.showModal();
            });
        } catch {
            if (this.request() === request) this.request.set({ ...request, pending: null, actionError: 'The file could not be analyzed. Try again.' });
        }
    }

    async applyAnalysis(dialog: HTMLDialogElement, openButton: HTMLButtonElement) {
        const current = this.feedback();
        const acknowledgeConflicts = this.acknowledgeConflicts();
        if (!current?.comparison || current.pending || (current.comparison.conflicts.length && !acknowledgeConflicts)) return;
        const request: PreviewFeedback = { ...current, pending: 'adopt', actionError: undefined };
        this.request.set(request);
        try {
            const result = await window.receiptmatch.acceptOriginalAnalysis({ token: current.comparison.token, loadRevision: request.source.loadRevision, acknowledgeConflicts });
            if (this.destroyed.destroyed || this.request() !== request) return;
            if (result.status === 'adopted') {
                if (dialog.open) dialog.close();
                this.request.set({ source: request.source, pending: null, error: null, notice: 'Analyzed file applied.' });
                if (this.feedback() && openButton.isConnected) openButton.focus();
            } else {
                this.request.set({ ...request, pending: null, actionError: result.error });
            }
        } catch {
            if (this.request() === request) this.request.set({ ...request, pending: null, actionError: 'The analyzed file could not be applied. Try again.' });
        }
    }

    closeAnalysis(dialog: HTMLDialogElement, event?: Event) {
        event?.preventDefault();
        if (this.feedback()?.pending !== 'adopt') dialog.close();
    }

    dismissAnalysis() {
        const current = this.feedback();
        if (current?.comparison) this.request.set({ ...current, comparison: undefined, actionError: undefined });
        this.acknowledgeConflicts.set(false);
    }
}
