import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild,
    type EffectCleanupRegisterFn, type InputSignal, type OutputEmitterRef, type Signal, type WritableSignal } from '@angular/core';
import { DrawerSize, type TableConfig, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigCheckboxComponent, WigDrawerComponent,
    WigIconButtonComponent, WigTableComponent, WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { DocumentAnalysis, type FieldDispositionChange } from './document-analysis.component.js';
import { LocalAiIcon } from '../shared/local-ai-icon.component.js';
import { OriginalPreviewButton } from '../shared/original-preview-button.component.js';
import type { ImportIssue } from '../../shared/bank-import.js';
import { documentCorrectionKey, type DocumentCorrection, type DocumentCorrectionTarget, type DocumentCorrectionValue } from '../../shared/document-corrections.js';
import { formatDocumentTotal } from '../../shared/document-display.js';
import type { DocumentFieldReviewTarget } from '../../shared/document-field-reviews.js';
import { documentNeedsReview } from '../../shared/document-review-presentation.js';
import type { INuExtractSettingsStatus } from '../../shared/local-ocr-settings.js';
import type { OriginalAdoptionResult } from '../../shared/original-preview.js';
import type { ExtractionProgress } from '../../shared/pdf-extraction.js';
import type { IDocumentImportSummary, IDocumentSnapshot, OriginalDocumentFields, WorkspaceCommand, IWorkspaceState, IWorkspaceView } from '../../shared/protocol.js';
import type { IReceiptAiChange, ReceiptAiField, ReceiptAiPreviewResult, IReceiptAiProposal, ReceiptAiRequest } from '../../shared/receipt-ai.js';
import type { SupportingDocument } from '../../shared/supporting-document.js';
import type { DocumentFileResult, DocumentFormat, IDocumentImportProgress, StoredDocumentImport, StoredSupportingDocument } from '../../shared/workspace-documents.js';

function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function pageProgress(extraction?: ExtractionProgress | null): string {
    return extraction?.pageNumber && extraction.pageCount ? ` · Page ${extraction.pageNumber} of ${extraction.pageCount}` : '';
}

const dateTimeFormat: Intl.DateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface DocumentFileRow { file: DocumentFileResult; total: string | null; original: OriginalDocumentFields | null; reviewBase: OriginalDocumentFields | null; }
interface ReportCache { workspaceKey: string; requestKey: string; records: Map<string, StoredDocumentImport>; originals: Record<string, OriginalDocumentFields>; reviewBases: Record<string, OriginalDocumentFields>; }
interface ReceiptAnalysisContext {
    request: ReceiptAiRequest; workspaceKey: string; matchRevision: number; name: string; format: DocumentFormat; documentId: string; trigger: HTMLButtonElement;
}
interface ReceiptAnalysisReview { context: ReceiptAnalysisContext; result: Extract<ReceiptAiPreviewResult, { status: 'ready' }>; }
interface ReceiptAnalysisFeedback { context: ReceiptAnalysisContext; message: string; error: boolean; }

@Component({
    selector: 'app-document-imports', standalone: true,
    imports: [DocumentAnalysis, LocalAiIcon, OriginalPreviewButton, NgTemplateOutlet, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigCheckboxComponent,
        WigDrawerComponent, WigIconButtonComponent, WigTableComponent, WigTemplateDirective],
    templateUrl: './document-imports.component.html'
})
export class DocumentImports {
    readonly state: InputSignal<IWorkspaceState> = input.required<IWorkspaceState>();
    readonly active: InputSignal<boolean> = input(true);
    readonly workspaceCommand: OutputEmitterRef<WorkspaceCommand> = output<WorkspaceCommand>();
    private readonly destroyed: DestroyRef = inject(DestroyRef);
    private readonly aiDialog: Signal<ElementRef<HTMLDialogElement> | undefined> = viewChild<ElementRef<HTMLDialogElement>>('aiDialog');
    private readonly documentsHeading: Signal<ElementRef<HTMLHeadingElement> | undefined> = viewChild<ElementRef<HTMLHeadingElement>>('documentsHeading');
    readonly aiPending: WritableSignal<ReceiptAnalysisContext | null> = signal<ReceiptAnalysisContext | null>(null);
    readonly aiImport: Signal<IWorkspaceState['documentImport']> = computed((): IWorkspaceState['documentImport'] => {
        const active: IWorkspaceState['documentImport'] = this.state().documentImport;
        return active?.localAi ? active : null;
    });
    readonly aiReview: WritableSignal<ReceiptAnalysisReview | null> = signal<ReceiptAnalysisReview | null>(null);
    readonly aiWarnings: Signal<{ before: number; after: number } | undefined> = computed((): { before: number; after: number } | undefined => {
        const warning: IReceiptAiChange | undefined = this.aiReview()?.result.changes.find((change: IReceiptAiChange): boolean => change.kind === 'warnings');
        return warning ? { before: warning.before?.split(', ').length ?? 0, after: warning.after?.split(', ').length ?? 0 } : undefined;
    });
    readonly aiFeedback: WritableSignal<ReceiptAnalysisFeedback | null> = signal<ReceiptAnalysisFeedback | null>(null);
    readonly aiApplying: WritableSignal<boolean> = signal(false);
    readonly aiApplyError: WritableSignal<string | null> = signal<string | null>(null);
    readonly aiEvidenceOpen: WritableSignal<boolean> = signal(false);
    readonly acknowledgeAiConflicts: WritableSignal<boolean> = signal(false);
    readonly aiSelectedFields: WritableSignal<ReceiptAiField[]> = signal<ReceiptAiField[]>([]);
    readonly aiCurrency: WritableSignal<string> = signal('');
    private readonly aiNeedsCurrency: Signal<boolean> = computed((): boolean =>
        this.aiSelectedFields().includes('billed-total') && this.aiReview()?.result.proposals?.some((proposal: IReceiptAiProposal): boolean =>
            proposal.field === 'billed-total' && proposal.needsCurrency === true) === true);
    readonly aiCanApply: Signal<boolean> = computed((): boolean => {
        const review: ReceiptAnalysisReview | null = this.aiReview();
        return !!review && this.aiSelectedFields().length > 0 && !this.aiApplying() && !this.state().busy && !review.result.blockingConflict &&
            (!review.result.conflicts.length || this.acknowledgeAiConflicts()) && (!this.aiNeedsCurrency() || /^[A-Z]{3}$/i.test(this.aiCurrency()));
    });
    readonly workspaceKey: Signal<string> = computed((): string => {
        const workspace: IWorkspaceView | null = this.state().workspace;
        return workspace ? JSON.stringify([workspace.id, workspace.loadRevision]) : '';
    });
    readonly summaries: Signal<IDocumentImportSummary[]> = computed((): IDocumentImportSummary[] => this.state().workspace?.documentImports ?? []);
    readonly reportItems: Signal<{ id: string; header: string; template: string; data: IDocumentImportSummary; }[]> = computed((): { id: string; header: string; template: string; data: IDocumentImportSummary; }[] => this.summaries().map((report: IDocumentImportSummary): { id: string; header: string; template: string; data: IDocumentImportSummary; } => ({
        id: report.id, header: `${basename(report.folderPath)} · ${report.status === 'cancelled' ? 'Cancelled' : 'Finished'} · ${this.reportCounts(report)}`,
        template: 'report', data: report
    })));
    private readonly retryVersion: WritableSignal<number> = signal(0);
    private readonly cache: WritableSignal<ReportCache | null> = signal<ReportCache | null>(null);
    private readonly failedRequest: WritableSignal<string | null> = signal<string | null>(null);
    private readonly requestKey: Signal<string | null> = computed((): string | null => {
        const summaries: IDocumentImportSummary[] = this.summaries();
        if (!summaries.length) {
            return null;
        }
        return JSON.stringify([this.workspaceKey(), this.state().workspace?.matchRevision]);
    });
    readonly records: Signal<Map<string, StoredDocumentImport> | null> = computed((): Map<string, StoredDocumentImport> | null => {
        const cache: ReportCache | null = this.cache();
        return cache?.workspaceKey === this.workspaceKey() ? cache.records : null;
    });
    readonly detailsCurrent: Signal<boolean> = computed((): boolean => this.cache()?.requestKey === this.requestKey());
    readonly detailsError: Signal<boolean> = computed((): boolean => this.requestKey() !== null && this.failedRequest() === this.requestKey());
    private readonly selectedFile: WritableSignal<{ workspaceKey: string; reportId: string; index: number; } | null> = signal<{ workspaceKey: string; reportId: string; index: number } | null>(null);
    readonly selectedFileRow: Signal<DocumentFileRow | undefined> = computed((): DocumentFileRow | undefined => {
        const selection: { workspaceKey: string; reportId: string; index: number; } | null = this.selectedFile();
        return selection?.workspaceKey === this.workspaceKey() ? this.fileRows().get(selection.reportId)?.[selection.index] : undefined;
    });
    readonly detailsDrawerSize: DrawerSize.md = DrawerSize.md;
    readonly fileColumns: TableConfig<{ index: number }> = { columns: [
        { field: 'index', text: 'Document', type: 'custom', template: 'name' },
        { field: 'index', text: 'Billed total', type: 'custom', template: 'total' },
        { field: 'index', text: 'Status', type: 'custom', template: 'status' },
        { field: 'index', text: 'Actions', type: 'custom', template: 'actions' }
    ] };
    readonly correctionsByDocument: Signal<Map<string, Map<string, DocumentCorrection>>> = computed((): Map<string, Map<string, DocumentCorrection>> => {
        const byDocument: Map<string, Map<string, DocumentCorrection>> = new Map<string, Map<string, DocumentCorrection>>();
        for (const correction of this.state().workspace?.documentCorrections ?? []) {
            const fields: Map<string, DocumentCorrection> = byDocument.get(correction.documentId) ?? new Map<string, DocumentCorrection>();
            fields.set(documentCorrectionKey(correction, correction.change.kind, 'role' in correction.change ? correction.change.role : undefined), correction);
            byDocument.set(correction.documentId, fields);
        }
        return byDocument;
    });
    readonly fileRows: Signal<Map<string, DocumentFileRow[]>> = computed((): Map<string, DocumentFileRow[]> => {
        const records: Map<string, StoredDocumentImport> | null = this.records();
        const rows: Map<string, DocumentFileRow[]> = new Map<string, DocumentFileRow[]>();
        if (records) {
            const originals: Record<string, OriginalDocumentFields> | undefined = this.cache()?.originals;
            for (const { id } of this.summaries()) {
                const record: StoredDocumentImport | undefined = records.get(id);
                if (!record) {
                    continue;
                }
                rows.set(id, record.files.map((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): DocumentFileRow => ({
                    file, total: this.billedTotal(file), original: file.status === 'imported' ? originals?.[file.record.id] ?? null : null,
                    reviewBase: file.status === 'imported' ? this.cache()?.reviewBases[file.record.id] ?? null : null,
                })));
            }
        }
        return rows;
    });
    // WigTable tracks rows by object identity. Keep the action components mounted when a report is refreshed.
    readonly tableRows: Signal<{ workspaceKey: string; reports: Map<string, { index: number; }[]>; }> = computed((): { workspaceKey: string; reports: Map<string, { index: number; }[]>; } => ({
        workspaceKey: this.workspaceKey(),
        reports: new Map([...this.fileRows()].map(([id, rows]: [string, DocumentFileRow[]]): [string, { index: number; }[]] => [id, rows.map((_: DocumentFileRow, index: number): { index: number; } => ({ index }))]))
    }), { equal: (previous: { workspaceKey: string; reports: Map<string, { index: number; }[]>; }, next: { workspaceKey: string; reports: Map<string, { index: number; }[]>; }): boolean => previous.workspaceKey === next.workspaceKey && previous.reports.size === next.reports.size &&
        [...previous.reports].every(([id, rows]: [string, { index: number; }[]]): boolean => next.reports.get(id)?.length === rows.length) });
    readonly basename: (path: string) => string = basename;
    readonly timestamp: (value: string) => string = (value: string): string => dateTimeFormat.format(new Date(value));
    readonly filePath: (file: DocumentFileResult) => string = (file: DocumentFileResult): string => file.status === 'imported' ? file.record.filePath : file.filePath;
    readonly fileStatus: (file: DocumentFileResult, reviewNeeded: boolean) => "Imported · review needed" | "Imported" | "Skipped duplicate" | "Failed" | "Unsupported" = (file: DocumentFileResult, reviewNeeded: boolean): "Imported · review needed" | "Imported" | "Skipped duplicate" | "Failed" | "Unsupported" => {
        switch (file.status) {
            case 'imported': return reviewNeeded ? 'Imported · review needed' : 'Imported';
            case 'skipped': return 'Skipped duplicate';
            case 'failed': return 'Failed';
            case 'unsupported': return 'Unsupported';
        }
    };
    readonly documentNeedsReview: (analysis: SupportingDocument) => boolean = documentNeedsReview;

    constructor() {
        effect((): void => {
            const workspaceKey: string = this.workspaceKey();
            untracked((): void => {
                if (this.cache()?.workspaceKey !== workspaceKey) {
                    this.cache.set(null);
                }
                this.selectedFile.set(null);
                this.aiPending.set(null);
                this.clearAiReview();
                this.aiFeedback.set(null);
            });
        });

        effect((): void => {
            const review: ReceiptAnalysisReview | null = this.aiReview();
            if (review && !this.aiApplying() && review.context.matchRevision !== this.state().workspace?.matchRevision) {
                this.discardAiToken(review);
                this.clearAiReview();
                this.finishAiRequest(review.context, 'The workspace changed. Analyze the receipt again.', true, true);
            }
        });

        afterRenderEffect((): void => {
            const dialog: HTMLDialogElement | undefined = this.aiDialog()?.nativeElement;
            if (dialog && this.active() && this.aiReview()?.context.workspaceKey === this.workspaceKey() && !dialog.open) {
                dialog.showModal();
            } else if (dialog?.open && !this.active()) {
                dialog.close();
            }
        });

        effect((onCleanup: EffectCleanupRegisterFn): void => {
            const requestKey: string | null = this.requestKey();
            this.retryVersion();
            if (!requestKey) {
                return;
            }
            const { workspaceKey, summaries, workspace }: { workspaceKey: string; summaries: IDocumentImportSummary[]; workspace: IWorkspaceView | null; } = untracked((): { workspaceKey: string; summaries: IDocumentImportSummary[]; workspace: IWorkspaceView | null; } => ({ workspaceKey: this.workspaceKey(), summaries: this.summaries(), workspace: this.state().workspace }));
            if (!workspace) {
                return;
            }
            const { loadRevision, matchRevision: revision }: IWorkspaceView = workspace;
            if (untracked((): boolean => this.cache()?.requestKey === requestKey)) {
                return;
            }
            let current: boolean = true;
            onCleanup((): void => {
                current = false;
            });
            this.failedRequest.set(null);
            const isCurrent: () => boolean = (): boolean => current && requestKey === this.requestKey();
            void window.receiptmatch.documentSnapshot({ loadRevision, revision }).then((snapshot: IDocumentSnapshot | null): void => {
                if (!isCurrent()) {
                    return;
                }
                if (snapshot?.loadRevision !== loadRevision || snapshot.revision !== revision) {
                    throw new Error('The document snapshot is stale.');
                }
                const records: StoredDocumentImport[] = snapshot.reports;
                if (!Array.isArray(records) || records.length !== summaries.length ||
                    records.some((record: StoredDocumentImport, index: number): boolean => record?.id !== summaries[index].id || record.folderPath !== summaries[index].folderPath)) {
                    throw new Error('The report does not match the current workspace.');
                }
                this.cache.set({ workspaceKey, requestKey, records: new Map(records.map((record: StoredDocumentImport): [string, StoredDocumentImport] => [record.id, record])), originals: snapshot.originals, reviewBases: snapshot.reviewBases ?? {} });
            }).catch((): void => {
                if (isCurrent()) {
                    this.failedRequest.set(requestKey);
                }
            });
        });
    }

    openFile(reportId: string, index: number): void {
        this.selectedFile.set({ workspaceKey: this.workspaceKey(), reportId, index });
    }

    closeFile(): void {
        this.selectedFile.set(null);
    }

    reanalysisFormat(file: DocumentFileResult): DocumentFormat | null {
        if (file.status === 'imported') {
            return file.record.result.input && !this.state().workspace?.supersededDocuments?.includes(file.record.id) ? file.record.format : null;
        }
        return null;
    }

    isAiPendingRow(reportId: string, fileIndex: number): boolean {
        const request: ReceiptAiRequest | undefined = this.aiPending()?.request;
        return request?.reportId === reportId && request.fileIndex === fileIndex;
    }

    aiProgressText(): string {
        const active: IWorkspaceState['documentImport'] = this.aiImport();
        if (!active) {
            return 'Checking NuExtract3 availability…';
        }
        const device: 'cpu' | 'gpu' | undefined = active.progress?.extraction?.device;
        return active.cancelling ? 'Cancelling AI analysis…' :
            'Analyzing with NuExtract3' + (device ? ' on ' + device.toUpperCase() : '') + (pageProgress(active.progress?.extraction) || '…');
    }

    async activateAiRow(reportId: string, fileIndex: number, event: MouseEvent): Promise<void> {
        if (this.isAiPendingRow(reportId, fileIndex)) {
            const active: IWorkspaceState['documentImport'] = this.aiImport();
            if (active && !active.cancelling) {
                this.workspaceCommand.emit({ type: 'cancel-import' });
            }
            return;
        }
        const trigger: HTMLButtonElement | null = event.target instanceof Element ? event.target.closest('button') : null;
        if (trigger) {
            await this.reanalyze(reportId, fileIndex, trigger);
        }
    }

    private async reanalyze(reportId: string, fileIndex: number, trigger: HTMLButtonElement): Promise<void> {
        const workspace: IWorkspaceView | null = this.state().workspace;
        const file: DocumentFileResult | undefined = this.fileRows().get(reportId)?.[fileIndex]?.file;
        const format: DocumentFormat | null = file ? this.reanalysisFormat(file) : null;
        if (!workspace || file?.status !== 'imported' || !format || this.state().busy || this.aiPending() || this.aiReview() || !this.detailsCurrent()) {
            return;
        }
        const context: ReceiptAnalysisContext = {
            request: { reportId, fileIndex, loadRevision: workspace.loadRevision },
            workspaceKey: this.workspaceKey(), matchRevision: workspace.matchRevision, name: basename(this.filePath(file)), format, documentId: file.record.id, trigger,
        };
        this.aiPending.set(context);
        this.aiFeedback.set(null);
        try {
            const result: ReceiptAiPreviewResult = await this.requestAiAnalysis(context);
            if (!this.currentAiWorkspace(context) || this.aiPending() !== context) {
                return;
            }
            if (result.status === 'ready') {
                this.aiReview.set({ context, result });
            } else {
                this.finishAiRequest(context, result.status === 'cancelled' ? 'AI analysis cancelled.' : result.error, result.status === 'failed');
            }
        } catch {
            this.finishAiRequest(context, 'AI analysis could not be completed. Try again.', true);
        } finally {
            if (this.aiPending() === context) {
                this.aiPending.set(null);
            }
        }
    }

    private async requestAiAnalysis(context: ReceiptAnalysisContext): Promise<ReceiptAiPreviewResult> {
        const nuExtract: INuExtractSettingsStatus = await window.receiptmatch.localOcr({ type: 'status' });
        if (!this.currentAiWorkspace(context) || this.aiPending() !== context) {
            return { status: 'cancelled' };
        }
        if (this.state().busy || this.state().workspace?.matchRevision !== context.matchRevision) {
            return { status: 'failed', error: 'The workspace changed. Analyze the receipt again.' };
        }
        if (!nuExtract.installed) {
            return { status: 'failed', error: 'Download NuExtract3 under Settings → Document recognition to analyze this receipt with AI.' };
        }
        if (nuExtract.busy) {
            return { status: 'failed', error: 'Wait for the NuExtract3 operation in Settings to finish, then try again.' };
        }
        if (nuExtract.device === 'cpu' && !nuExtract.cpuAvailable) {
            return { status: 'failed', error: 'Choose an available device for NuExtract3 under Settings → Document recognition.' };
        }
        return window.receiptmatch.reanalyzeReceipt(context.request);
    }

    selectAiField(proposal: IReceiptAiProposal, selected: boolean): void {
        if (!proposal.unavailable && !this.aiApplying()) {
            const fields: ReceiptAiField[] = this.aiSelectedFields().filter((field: ReceiptAiField): boolean => field !== proposal.field);
            this.aiSelectedFields.set(selected ? [...fields, proposal.field] : fields);
            this.aiApplyError.set(null);
        }
    }

    updateAiCurrency(value: string): void {
        this.aiCurrency.set(value);
        this.aiApplyError.set(null);
    }

    async applyAiReview(): Promise<void> {
        const review: ReceiptAnalysisReview | null = this.aiReview();
        if (!review || !this.aiCanApply()) {
            return;
        }
        const selectedFields: ReceiptAiField[] = this.aiSelectedFields();
        this.aiApplying.set(true);
        this.aiApplyError.set(null);
        try {
            const result: OriginalAdoptionResult = await window.receiptmatch.acceptReceiptAnalysis({
                token: review.result.token, loadRevision: review.context.request.loadRevision, acknowledgeConflicts: this.acknowledgeAiConflicts(),
                selectedFields, ...(this.aiNeedsCurrency() ? { currency: this.aiCurrency().toUpperCase() } : {}),
            });
            if (!this.currentAiWorkspace(review.context) || this.aiReview() !== review) {
                return;
            }
            if (result.status === 'adopted') {
                this.clearAiReview();
                this.finishAiRequest(review.context, `Applied ${selectedFields.length} AI ${selectedFields.length === 1 ? 'suggestion' : 'suggestions'}.`, false, true);
            } else {
                this.aiApplyError.set(result.error);
            }
        } catch {
            if (this.aiReview() === review) {
                this.aiApplyError.set('The AI analysis could not be applied. Try again.');
            }
        } finally {
            if (this.aiReview() === review) {
                this.aiApplying.set(false);
            }
        }
    }

    discardAiReview(event?: Event): void {
        event?.preventDefault();
        const review: ReceiptAnalysisReview | null = this.aiReview();
        if (review && !this.aiApplying()) {
            this.discardAiToken(review);
            this.clearAiReview();
            this.finishAiRequest(review.context, 'AI analysis discarded.', false, true);
        }
    }

    private discardAiToken(review: ReceiptAnalysisReview): void {
        void window.receiptmatch.discardReceiptAnalysis({ token: review.result.token, loadRevision: review.context.request.loadRevision }).catch((): undefined => undefined);
    }

    private clearAiReview(): void {
        this.aiDialog()?.nativeElement.close();
        this.aiReview.set(null);
        this.aiApplying.set(false);
        this.aiApplyError.set(null);
        this.aiEvidenceOpen.set(false);
        this.acknowledgeAiConflicts.set(false);
        this.aiSelectedFields.set([]);
        this.aiCurrency.set('');
    }

    private currentAiWorkspace(context: ReceiptAnalysisContext): boolean {
        return !this.destroyed.destroyed && this.workspaceKey() === context.workspaceKey;
    }

    private finishAiRequest(context: ReceiptAnalysisContext, message: string, error: boolean, restoreFocus: boolean = false): void {
        if (!this.currentAiWorkspace(context)) {
            return;
        }
        const feedback: ReceiptAnalysisFeedback = { context, message, error };
        this.aiFeedback.set(feedback);
        requestAnimationFrame((): void => {
            if (this.currentAiWorkspace(context) && this.aiFeedback() === feedback && this.active() && (restoreFocus || document.activeElement === document.body)) {
                if (context.trigger.isConnected && !context.trigger.disabled) {
                    context.trigger.focus();
                } else {
                    this.documentsHeading()?.nativeElement.focus();
                }
            }
        });
    }

    private billedTotal(file: DocumentFileResult): string | null {
        return file.status === 'imported' ? formatDocumentTotal(file.record.result) : null;
    }

    correctField(value: DocumentCorrectionTarget & { change: DocumentCorrectionValue }): void {
        const workspace: IWorkspaceView | null = this.state().workspace;
        if (workspace && !this.state().busy && this.detailsCurrent()) {
            this.workspaceCommand.emit({ ...value, type: 'correct-document-field', revision: workspace.matchRevision });
        }
    }

    confirmField(value: DocumentFieldReviewTarget & { confirmed: boolean }): void {
        const workspace: IWorkspaceView | null = this.state().workspace;
        if (workspace && !this.state().busy && this.detailsCurrent()) {
            this.workspaceCommand.emit({ ...value, type: 'set-document-field-confirmed', revision: workspace.matchRevision });
        }
    }

    setFieldDisposition(value: FieldDispositionChange): void {
        const workspace: IWorkspaceView | null = this.state().workspace;
        if (workspace && !this.state().busy && this.detailsCurrent()) {
            this.workspaceCommand.emit({ ...value, type: 'set-document-field-disposition', revision: workspace.matchRevision });
        }
    }

    retryDetails(): void {
        this.retryVersion.update((value: number): number => value + 1);
    }

    reportCounts(report: IDocumentImportSummary): string {
        const counts: string[] = [`${report.imported} imported`, `${report.skipped} skipped`, `${report.failed} failed`, `${report.unsupported} unsupported`];
        if (report.directoryIssues) {
            counts.push(`${report.directoryIssues} folder ${report.directoryIssues === 1 ? 'issue' : 'issues'}`);
        }
        return counts.join(' · ');
    }

    progressText(): string {
        const current: IWorkspaceState['documentImport'] = this.state().documentImport;
        if (!current || current.localAi) {
            return '';
        }
        if (current.cancelling) {
            return 'Cancelling analysis…';
        }
        const progress: IDocumentImportProgress | null = current.progress;
        if (!progress) {
            return 'Choose a folder in the dialog.';
        }
        if (progress.phase === 'scanning') {
            return 'Scanning the folder…';
        }
        const phases: { loading: string; text: string; rendering: string; ocr: string; 'page-complete': string; } = { loading: 'Opening document', text: 'Reading embedded text', rendering: 'Preparing page image', ocr: 'Reading with local OCR', 'page-complete': 'Page read' };
        const extraction: ExtractionProgress | null = progress.extraction;
        const filename: string = progress.filePath ? ` · ${basename(progress.filePath)}` : '';
        return (extraction ? phases[extraction.phase] : 'Analyzing file') + filename + pageProgress(extraction);
    }
}
