import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, TemplateRef, computed, inject, input, signal, viewChild, type Signal, type WritableSignal, type InputSignal } from '@angular/core';
import { WigButtonComponent, WigCheckboxComponent, WigIconButtonComponent } from '@wigtertainment-ltd/comp-lib';
import type { OriginalAdoptionResult, OriginalAnalysisComparison, OriginalAnalysisResult, OriginalPreviewRequest, OriginalPreviewResult, OriginalRelinkResult } from '../shared/original-preview.js';

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
    imports: [NgTemplateOutlet, WigButtonComponent, WigCheckboxComponent, WigIconButtonComponent],
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
      @if (iconTooltip(); as tooltip) {
        <wig-icon-button #openButton [iconTemplate]="externalIcon" [text]="true" [ariaLabel]="'Open original ' + sourceName()"
          [tooltip]="tooltip" tooltipPosition="top" [loading]="current?.pending === 'open'" [disabled]="!!current?.pending || loadRevision() === undefined" (click)="open()" />
      } @else {
      <wig-button #openButton [buttonStyle]="iconOnly() ? iconButtonStyle : undefined" [label]="iconOnly() ? '' : current?.pending === 'open' ? 'Opening…' : 'Open original'"
        [iconTemplate]="iconOnly() ? externalIcon : undefined" [text]="iconOnly()" [severity]="iconOnly() ? 'primary' : 'secondary'"
        [ariaLabel]="'Open original ' + sourceName()" [buttonTitle]="iconOnly() ? 'Open original' : undefined"
        [loading]="current?.pending === 'open'" [disabled]="!!current?.pending || loadRevision() === undefined" (click)="open()" />
      }
      <ng-template #externalIcon>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 5h6v6m0-6-9 9M10 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
        </svg>
      </ng-template>
      <ng-template #feedbackContent>
      @if (current?.error; as error) {
        <p class="original-preview-error" role="alert">
          {{ error }}
          @if (canRelink) { Relink an identical copy or analyze a changed file. }
          @if (!current?.comparison) { {{ current?.actionError }} }
        </p>
      }
      @if (canRelink) {
        <wig-button severity="secondary" [label]="current?.pending === 'relink' ? 'Relinking…' : 'Relink original'" [ariaLabel]="'Relink original ' + sourceName()"
          [loading]="current?.pending === 'relink'" [disabled]="!!current?.pending" (click)="relink()" />
        <wig-button severity="secondary" [label]="current?.pending === 'analyze' ? 'Analyzing…' : 'Analyze changed file'" [ariaLabel]="'Analyze changed file for ' + sourceName()"
          [loading]="current?.pending === 'analyze'" [disabled]="!!current?.pending" (click)="analyze()" />
      }
      @if (current?.notice; as notice) {
        <p class="muted" role="status">{{ notice }}</p>
      }
      </ng-template>
      @if (!iconOnly() || iconTooltip()) {
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
              <wig-checkbox label="I understand that ambiguous items stay in the previous analysis and newly extracted items need review."
                [checked]="acknowledgeConflicts()" [disabled]="current?.pending === 'adopt'" (checkedChange)="acknowledgeConflicts.set($event)" />
            </div>
          }
          @if (current?.actionError; as error) { <p class="original-preview-error" role="alert">{{ error }}</p> }
          <div class="analysis-actions">
            <wig-button [label]="current?.pending === 'adopt' ? 'Applying…' : 'Apply analyzed file'" [loading]="current?.pending === 'adopt'"
              [disabled]="!!current?.pending || (comparison.conflicts.length > 0 && !acknowledgeConflicts())" (click)="applyAnalysis(analysisDialog)" />
            <wig-button label="Cancel" severity="secondary" [disabled]="current?.pending === 'adopt'" (click)="closeAnalysis(analysisDialog)" />
          </div>
        </dialog>
      }
      }
    `
})
export class OriginalPreviewButton {
    readonly kind: InputSignal<"statement" | "document"> = input.required<'statement' | 'document'>();
    readonly sourceId: InputSignal<string | undefined> = input.required<string | undefined>();
    readonly sourceName: InputSignal<string> = input.required<string>();
    readonly loadRevision: InputSignal<number | undefined> = input.required<number | undefined>();
    readonly iconOnly: InputSignal<boolean> = input(false);
    readonly iconTooltip: InputSignal<string | undefined> = input<string>();
    readonly iconButtonStyle: { width: string; 'min-width': string; 'min-height': string; padding: string; } = { width: '44px', 'min-width': '44px', 'min-height': '44px', padding: '0' };
    readonly acknowledgeConflicts: WritableSignal<boolean> = signal(false);
    private readonly request: WritableSignal<PreviewFeedback | null> = signal<PreviewFeedback | null>(null);
    private readonly destroyed: DestroyRef = inject(DestroyRef);
	private readonly openButton: Signal<ElementRef<HTMLElement> | undefined> = viewChild('openButton', { read: ElementRef<HTMLElement> });
    private readonly analysisDialog: Signal<ElementRef<HTMLDialogElement> | undefined> = viewChild<ElementRef<HTMLDialogElement>>('analysisDialog');
    readonly feedbackContent: Signal<TemplateRef<unknown> | undefined> = viewChild<TemplateRef<unknown>>('feedbackContent');
    readonly feedback: Signal<PreviewFeedback | null> = computed((): PreviewFeedback | null => {
        const request: PreviewFeedback | null = this.request();
        return request && request.source.id === this.sourceId() && request.source.kind === this.kind() && request.source.loadRevision === this.loadRevision() ? request : null;
    });
    readonly hasFeedback: Signal<boolean> = computed((): boolean => {
        const current: PreviewFeedback | null = this.feedback();
        return Boolean(current?.error) || Boolean(current?.notice) || current?.status === 'missing' || current?.status === 'changed';
    });

    async open(): Promise<void> {
        const loadRevision: number | undefined = this.loadRevision(), id: string | undefined = this.sourceId();
        if (id === undefined || loadRevision === undefined || this.feedback()?.pending) {
            return;
        }
        const request: PreviewFeedback = { source: { kind: this.kind(), id, loadRevision }, pending: 'open', error: null };
        this.request.set(request);
        try {
            const result: OriginalPreviewResult = await window.receiptmatch.openOriginal(request.source);
            if (this.request() === request) {
                this.request.set({ ...request, ...result, pending: null });
            }
        } catch {
            if (this.request() === request) {
                this.request.set({ ...request, pending: null, error: 'The original could not be opened. Try again.' });
            }
        }
    }

    async relink(): Promise<void> {
        const current: PreviewFeedback | null = this.feedback();
        if (!current || current.pending || (current.status !== 'missing' && current.status !== 'changed')) {
            return;
        }
        const request: PreviewFeedback = { ...current, pending: 'relink', actionError: undefined };
        this.request.set(request);
        const failure: "The original could not be relinked. Try again." = 'The original could not be relinked. Try again.';
        try {
            const result: OriginalRelinkResult = await window.receiptmatch.relinkOriginal(request.source);
            if (this.request() !== request) {
                return;
            }
            if (result.status === 'linked') {
                this.request.set({ source: request.source, pending: null, error: null, notice: 'Original relinked. You can open it again.' });
                this.restoreOpenFocus(request.source);
            } else {
                this.request.set({ ...request, pending: null, actionError: result.status === 'failed' ? result.error ?? failure : undefined });
            }
        } catch {
            if (this.request() === request) {
                this.request.set({ ...request, pending: null, actionError: failure });
            }
        }
    }

    async analyze(): Promise<void> {
        const current: PreviewFeedback | null = this.feedback();
        if (!current || current.pending || (current.status !== 'missing' && current.status !== 'changed')) {
            return;
        }
        const request: PreviewFeedback = { ...current, pending: 'analyze', comparison: undefined, actionError: undefined };
        this.request.set(request);
        try {
            const result: OriginalAnalysisResult = await window.receiptmatch.analyzeOriginal(request.source);
            if (this.destroyed.destroyed || this.feedback() !== request) {
                return;
            }
            if (result.status !== 'ready') {
                this.request.set({ ...request, pending: null, actionError: result.status === 'failed' ? result.error : undefined });
                return;
            }
            this.acknowledgeConflicts.set(false);
            const ready: PreviewFeedback = { ...request, pending: null, comparison: result.comparison };
            this.request.set(ready);
            requestAnimationFrame((): void => {
                if (this.destroyed.destroyed || this.feedback() !== ready) {
                    return;
                }
                this.analysisDialog()?.nativeElement.showModal();
            });
        } catch {
            if (this.request() === request) {
                this.request.set({ ...request, pending: null, actionError: 'The file could not be analyzed. Try again.' });
            }
        }
    }

    async applyAnalysis(dialog: HTMLDialogElement): Promise<void> {
        const current: PreviewFeedback | null = this.feedback();
        const acknowledgeConflicts: boolean = this.acknowledgeConflicts();
        if (!current?.comparison || current.pending || (current.comparison.conflicts.length && !acknowledgeConflicts)) {
            return;
        }
        const request: PreviewFeedback = { ...current, pending: 'adopt', actionError: undefined };
        this.request.set(request);
        try {
            const result: OriginalAdoptionResult = await window.receiptmatch.acceptOriginalAnalysis({ token: current.comparison.token, loadRevision: request.source.loadRevision, acknowledgeConflicts });
            if (this.destroyed.destroyed || this.request() !== request) {
                return;
            }
            if (result.status === 'adopted') {
                if (dialog.open) {
                    dialog.close();
                }
                this.request.set({ source: request.source, pending: null, error: null, notice: 'Analyzed file applied.' });
                this.restoreOpenFocus(request.source);
            } else {
                this.request.set({ ...request, pending: null, actionError: result.error });
            }
        } catch {
            if (this.request() === request) {
                this.request.set({ ...request, pending: null, actionError: 'The analyzed file could not be applied. Try again.' });
            }
        }
    }

    private restoreOpenFocus(source: OriginalPreviewRequest): void {
        requestAnimationFrame((): void => {
            if (!this.destroyed.destroyed && this.feedback()?.source === source) {
                this.openButton()?.nativeElement.querySelector('button')?.focus();
            }
        });
    }

    closeAnalysis(dialog: HTMLDialogElement, event?: Event): void {
        event?.preventDefault();
        if (this.feedback()?.pending !== 'adopt') {
            dialog.close();
        }
    }

    dismissAnalysis(): void {
        const current: PreviewFeedback | null = this.feedback();
        if (current?.comparison) {
            this.request.set({ ...current, comparison: undefined, actionError: undefined });
        }
        this.acknowledgeConflicts.set(false);
    }
}
