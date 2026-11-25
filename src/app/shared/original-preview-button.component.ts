import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, TemplateRef, computed, inject, input, signal, viewChild, type Signal, type WritableSignal, type InputSignal } from '@angular/core';
import { WigButtonComponent, WigCheckboxComponent, WigIconButtonComponent } from '@wigtertainment-ltd/comp-lib';
import type { OriginalAdoptionResult, OriginalAnalysisComparison, OriginalAnalysisResult, OriginalPreviewRequest, OriginalPreviewResult, OriginalRelinkResult } from '../../shared/original-preview.js';

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
    templateUrl: './original-preview-button.component.html'
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
