import { Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild,
    type InputSignal, type OutputEmitterRef, type Signal, type WritableSignal } from '@angular/core';
import { WigButtonComponent, WigIconButtonComponent } from '@wigtertainment-ltd/comp-lib';
import type { LocalOcrStatus } from '../../shared/local-ocr-settings.js';
import type { OriginalAdoptionResult } from '../../shared/original-preview.js';
import type { IWorkspaceState, IWorkspaceView } from '../../shared/protocol.js';
import type { IStatementAiChange, StatementAiPreviewResult, StatementAiRequest } from '../../shared/statement-ai.js';
import type { StoredBankImport } from '../../shared/workspace-import.js';
import { LocalAiIcon } from '../shared/local-ai-icon.component.js';
import { OriginalPreviewButton } from '../shared/original-preview-button.component.js';
import { AnalysisBooking } from './analysis-booking.component.js';

type Preview = Extract<StatementAiPreviewResult, Record<'status', 'ready'>>;
interface IAnalysisContext { request: StatementAiRequest; revision: number; workspaceId: string; name: string }
interface IAnalysisReview { context: IAnalysisContext; result: Preview }

@Component({ selector: 'app-statement-reanalysis', standalone: true, imports: [WigButtonComponent, WigIconButtonComponent, LocalAiIcon, OriginalPreviewButton, AnalysisBooking],
    templateUrl: './statement-reanalysis.component.html' })
export class StatementReanalysis {
    constructor() {
        effect((): void => {
            const review: IAnalysisReview | null = this.review();
            const pending: IAnalysisContext | null = this.pending();
            const active: boolean = this.active();
            const workspace: IWorkspaceView | null = this.state().workspace;
            const id: string = this.record().id;
            if (pending && !active && this.state().statementImport?.localAi && !this.state().statementImport?.cancelling) {
                untracked((): void => {
                    void window.receiptmatch.command({ type: 'cancel-import' }).catch((): undefined => undefined);
                });
            }
            if (review && !this.applying() && (!active || workspace?.id !== review.context.workspaceId || workspace.loadRevision !== review.context.request.loadRevision ||
                workspace.matchRevision !== review.context.revision || id !== review.context.request.importId)) {
                untracked((): void => {
                    this.release(review);
                    this.error.set(active ? 'The workspace changed. Analyze this statement again.' : null);
                    this.restoreFocus();
                });
            }
        });

        this.destroyed.onDestroy((): void => {
            const review: IAnalysisReview | null = this.review();
            if (review && !this.applying()) {
                this.discardToken(review);
            }
        });
    }

    readonly state: InputSignal<IWorkspaceState> = input.required<IWorkspaceState>();
    readonly record: InputSignal<StoredBankImport> = input.required<StoredBankImport>();
    readonly active: InputSignal<boolean> = input(true);
    readonly applied: OutputEmitterRef<void> = output<void>();
    readonly settingsRequested: OutputEmitterRef<void> = output<void>();
    private readonly injector: Injector = inject(Injector);
    private readonly destroyed: DestroyRef = inject(DestroyRef);
    private readonly trigger: Signal<ElementRef<HTMLElement> | undefined> = viewChild('trigger', { read: ElementRef<HTMLElement> });
    private readonly dialog: Signal<ElementRef<HTMLDialogElement> | undefined> = viewChild<ElementRef<HTMLDialogElement>>('reviewDialog');
    private readonly heading: Signal<ElementRef<HTMLHeadingElement> | undefined> = viewChild<ElementRef<HTMLHeadingElement>>('reviewHeading');
    private readonly changesHeading: Signal<ElementRef<HTMLHeadingElement> | undefined> = viewChild<ElementRef<HTMLHeadingElement>>('changesHeading');
    readonly pending: WritableSignal<IAnalysisContext | null> = signal<IAnalysisContext | null>(null);
    readonly review: WritableSignal<IAnalysisReview | null> = signal<IAnalysisReview | null>(null);
    readonly applying: WritableSignal<boolean> = signal(false);
    readonly acknowledged: WritableSignal<boolean> = signal(false);
    readonly includeUnchanged: WritableSignal<boolean> = signal(false);
    readonly page: WritableSignal<number> = signal(0);
    readonly error: WritableSignal<string | null> = signal<string | null>(null);
    readonly feedback: WritableSignal<string | null> = signal<string | null>(null);
    readonly needsSettings: WritableSignal<boolean> = signal(false);
    readonly archived: Signal<boolean> = computed((): boolean => this.state().workspace?.supersededStatements.includes(this.record().id) ?? false);
    readonly changes: Signal<IStatementAiChange[]> = computed((): IStatementAiChange[] => (this.review()?.result.changes ?? [])
        .filter((change: IStatementAiChange): boolean => this.includeUnchanged() || change.kind !== 'unchanged')
        .sort((a: IStatementAiChange, b: IStatementAiChange): number => Number(a.kind === 'unchanged') - Number(b.kind === 'unchanged')));
    readonly pageCount: Signal<number> = computed((): number => Math.max(1, Math.ceil(this.changes().length / 20)));
    readonly visibleChanges: Signal<IStatementAiChange[]> = computed((): IStatementAiChange[] => this.changes().slice(this.page() * 20, (this.page() + 1) * 20));
    readonly canApply: Signal<boolean> = computed((): boolean => {
        const preview: Preview | undefined = this.review()?.result;
        return !!preview && !preview.blockingConflict && (!preview.conflicts.length || this.acknowledged()) && !this.applying() && !this.state().busy;
    });
    readonly labels: Record<IStatementAiChange['kind'], string> = { unchanged: 'Unchanged', added: 'Added', removed: 'Removed', changed: 'Changed', promoted: 'Resolved draft', demoted: 'Now unresolved' };

    private current(context: IAnalysisContext): boolean {
        const workspace: IWorkspaceView | null = this.state().workspace;
        return !this.destroyed.destroyed && this.active() && workspace?.id === context.workspaceId && workspace.loadRevision === context.request.loadRevision && this.record().id === context.request.importId;
    }

    async analyze(): Promise<void> {
        const workspace: IWorkspaceView | null = this.state().workspace;
        if (!workspace || this.state().busy || this.pending() || this.review() || this.archived()) {
            return;
        }
        const context: IAnalysisContext = { request: { importId: this.record().id, loadRevision: workspace.loadRevision }, revision: workspace.matchRevision,
            workspaceId: workspace.id, name: this.record().filePath.split(/[\\/]/).at(-1) ?? this.record().filePath };
        this.pending.set(context);
        this.error.set(null); this.feedback.set(null); this.needsSettings.set(false);
        try {
            const result: StatementAiPreviewResult = await this.requestAnalysis(context);
            if (!this.current(context)) {
                if (result.status === 'ready') {
                    this.discardToken({ context, result });
                }
                return;
            }
            if (result.status === 'ready') {
                this.openReview({ context, result });
            } else if (result.status === 'cancelled') {
                this.feedback.set('AI analysis cancelled. Your current statement is unchanged.'); this.restoreFocus();
            } else {
                this.needsSettings.set(result.status === 'unavailable');
                this.error.set(result.error); this.restoreFocus();
            }
        } catch {
            if (this.current(context)) {
                this.error.set('The local AI analysis could not be completed. Try again.'); this.restoreFocus();
            }
        } finally {
            if (this.pending() === context) {
                this.pending.set(null);
            }
        }
    }

    private async requestAnalysis(context: IAnalysisContext): Promise<StatementAiPreviewResult> {
        const status: LocalOcrStatus = await window.receiptmatch.localOcr({ type: 'status' });
        if (!this.current(context)) {
            return { status: 'cancelled' };
        }
        if (!status.installed || status.busy || (status.device === 'cpu' && !status.cpuAvailable)) {
            return { status: 'unavailable', error: !status.installed ? 'Download NuExtract3 in Document recognition settings to analyze this statement with local AI.' :
                status.busy ? 'Wait for the recognition setup to finish, then try again.' : 'Choose an available recognition device in Settings.' };
        }
        if (this.state().busy || this.state().workspace?.matchRevision !== context.revision) {
            return { status: 'failed', error: 'The workspace changed. Analyze this statement again.' };
        }
        return window.receiptmatch.reanalyzeStatement(context.request);
    }

    private openReview(review: IAnalysisReview): void {
        this.review.set(review); this.acknowledged.set(false); this.includeUnchanged.set(false); this.page.set(0);
        afterNextRender({ write: (): void => {
            if (this.review() === review && this.current(review.context)) {
                this.dialog()?.nativeElement.showModal(); this.heading()?.nativeElement.focus();
            }
        } }, { injector: this.injector });
    }

    async apply(): Promise<void> {
        const review: IAnalysisReview | null = this.review();
        if (!review || !this.canApply()) {
            return;
        }
        this.applying.set(true); this.error.set(null);
        try {
            const result: OriginalAdoptionResult = await window.receiptmatch.acceptStatementAnalysis({ token: review.result.token,
                loadRevision: review.context.request.loadRevision, acknowledgeConflicts: this.acknowledged() });
            if (!this.current(review.context)) {
                return;
            }
            if (result.status === 'adopted') {
                this.release(review); this.feedback.set('AI analysis applied. Save the workspace to keep this version.');
                this.applied.emit(); this.restoreFocus();
            } else {
                this.error.set(result.error);
            }
        } catch {
            if (this.current(review.context)) {
                this.error.set('The AI analysis could not be applied. Try again.');
            }
        } finally {
            this.applying.set(false);
        }
    }

    discard(event?: Event): void {
        event?.preventDefault();
        const review: IAnalysisReview | null = this.review();
        if (review && !this.applying()) {
            this.release(review); this.error.set(null); this.feedback.set('AI analysis discarded. Your current statement is unchanged.'); this.restoreFocus();
        }
    }

    private release(review: IAnalysisReview): void {
        this.discardToken(review);
        this.dialog()?.nativeElement.close(); this.review.set(null);
    }

    private discardToken(review: IAnalysisReview): void {
        void window.receiptmatch.discardStatementAnalysis({ token: review.result.token, loadRevision: review.context.request.loadRevision }).catch((): undefined => undefined);
    }

    private restoreFocus(): void {
        requestAnimationFrame((): void => {
            if (!this.destroyed.destroyed && this.active()) {
                this.trigger()?.nativeElement.querySelector('button')?.focus();
            }
        });
    }

    showUnchanged(checked: boolean): void {
        this.includeUnchanged.set(checked); this.page.set(0);
    }

    changePage(value: number): void {
        if (value >= 0 && value < this.pageCount()) {
            this.page.set(value);
            afterNextRender({ write: (): void => this.changesHeading()?.nativeElement.focus() }, { injector: this.injector });
        }
    }
}
