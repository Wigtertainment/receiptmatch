import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import type { ImportIssue, ImportPage, PositionedSpan, SourceEvidence } from '../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../shared/display.js';
import type { DocumentImportSummary, WorkspaceCommand, WorkspaceState } from '../shared/protocol.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../shared/supporting-document.js';
import type { DocumentFileResult, DocumentFormat, StoredDocumentImport } from '../shared/workspace-documents.js';

function expanded(event: Event) { return (event.target as HTMLDetailsElement).open; }
function basename(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extractionLabels = { 'embedded-text': 'Embedded text', 'local-ocr': 'Local English OCR' };
function regionText({ x, y, width, height }: PositionedSpan['region']) {
    const format = (value: number) => numberFormat.format(value);
    return `x ${format(x)}, y ${format(y)}, width ${format(width)}, height ${format(height)}`;
}
const kinds: Record<DocumentSection['kind'], string> = {
    'billing-summary': 'Billing summary', invoice: 'Invoice', receipt: 'Receipt', 'credit-note': 'Credit note',
    'payment-information': 'Payment information', unknown: 'Unrecognized section'
};
const amountRoles: Record<DocumentSection['amounts'][number]['role'], string> = {
    'billed-total': 'Billed total', 'balance-due': 'Balance due', payment: 'Payment', 'credit-note-component': 'Credit note component',
    'informational-fx': 'Informational FX value', tax: 'Tax', subtotal: 'Subtotal', 'line-item': 'Line item', unknown: 'Unrecognized amount'
};
const dateRoles: Record<DocumentSection['dates'][number]['role'], string> = {
    issue: 'Issue date', payment: 'Payment date', due: 'Due date', 'service-period': 'Service period', 'service-start': 'Service start',
    'service-end': 'Service end', unknown: 'Unrecognized date'
};
const referenceRoles: Record<DocumentSection['references'][number]['role'], string> = {
    invoice: 'Invoice reference', receipt: 'Receipt reference', payment: 'Payment reference', order: 'Order reference',
    customer: 'Customer reference', account: 'Account reference', table: 'Table reference', 'related-invoice': 'Related invoice reference', unknown: 'Reference'
};
const currencyRoles: Record<DocumentSection['currencies'][number]['role'], string> = {
    settlement: 'Settlement currency', 'informational-fx': 'Informational exchange currency', unknown: 'Currency'
};
interface FieldView { id: string; role: string; label: string; values: string[]; evidence: SourceEvidence[]; issues: DocumentIssue[]; }

@Component({
    selector: 'app-document-source-page', standalone: true,
    template: `
        <details class="source-details source-page" [open]="isOpen()" (toggle)="toggle($event)">
            <summary>Page {{ page().pageNumber }} · {{ page().spans.length }} text spans</summary>
            @if (isOpen()) {
                @if (page().status === 'failed') { <p>This page could not be read.</p> }
                @else {
                    <ul class="evidence-list">
                        @for (span of spans(); track $index) {
                            <li>
                                <p class="raw-text">{{ span.text }}</p>
                                <p class="evidence-origin">{{ extractionLabels[span.method] }}</p>
                                <p class="evidence-region">Region in {{ units() }}: {{ regionText(span.region) }}</p>
                            </li>
                        } @empty { <li>No readable text was retained for this page.</li> }
                    </ul>
                    @if (remaining() > 0) {
                        <button class="button-secondary compact" (click)="showMore()">Show {{ nextCount() }} more text spans</button>
                    }
                }
            }
        </details>
    `
})
class DocumentSourcePage {
    readonly page = input.required<ImportPage>();
    readonly units = input.required<string>();
    readonly initiallyOpen = input(false);
    private readonly opened = signal<boolean | null>(null);
    private readonly limit = signal(100);
    readonly isOpen = computed(() => this.opened() ?? this.initiallyOpen());
    readonly spans = computed(() => this.page().spans.slice(0, this.limit()));
    readonly remaining = computed(() => this.page().spans.length - this.spans().length);
    readonly nextCount = computed(() => Math.min(this.remaining(), 100));
    readonly extractionLabels = extractionLabels;
    readonly regionText = regionText;
    toggle(event: Event) { this.opened.set(expanded(event)); }
    showMore() { this.limit.update(value => value + 100); }
}

@Component({
    selector: 'app-document-analysis', standalone: true, imports: [DocumentSourcePage, NgTemplateOutlet],
    templateUrl: './document-analysis.html'
})
class DocumentAnalysis {
    readonly analysis = input.required<SupportingDocument>();
    readonly format = input<DocumentFormat | null>(null);
    readonly sourceOpen = signal(false);
    readonly openDetails = signal<ReadonlySet<string>>(new Set());
    readonly units = computed(() => this.format() === 'pdf' ? 'PDF points' : 'pixels');
    readonly pages = computed(() => this.analysis().input?.pages ?? []);
    private readonly pageNumbers = computed(() => new Map(this.pages().map(page => [page.pageId, page.pageNumber])));
    readonly extractionLabel = (method: SourceEvidence['method']) => extractionLabels[method];
    readonly regionText = regionText;
    readonly generalIssues = computed(() => {
        const analysis = this.analysis();
        const extractionIssues = analysis.input?.issues ?? [];
        const signature = ({ code, message, field, evidence }: Pick<ImportIssue, 'code' | 'message' | 'field' | 'evidence'>) =>
            JSON.stringify([code, message, field, evidence]);
        const extractionSignatures = new Set(extractionIssues.map(signature));
        return [
            ...analysis.issues.filter(issue => issue.fieldId === null && (issue.sectionId !== null || !extractionSignatures.has(signature(issue))))
                .map(issue => ({ ...issue, context: this.issueContext(issue) })),
            ...extractionIssues.map(issue => ({
                ...issue, context: [issue.severity === 'error' ? 'Error' : 'Warning', issue.pageId && `Page ${this.pageNumber(issue.pageId)}`,
                    issue.field?.replaceAll('-', ' ')].filter(Boolean).join(' · ')
            }))
        ];
    });
    readonly sections = computed(() => {
        const analysis = this.analysis();
        const fieldIssues = new Map<string, DocumentIssue[]>();
        for (const issue of analysis.issues) {
            if (!issue.fieldId) continue;
            const issues = fieldIssues.get(issue.fieldId) ?? [];
            issues.push(issue);
            fieldIssues.set(issue.fieldId, issues);
        }
        const field = (source: { id: string; label: string; evidence: SourceEvidence[] }, role: string, values: string[]): FieldView =>
            ({ ...source, role, values, issues: fieldIssues.get(source.id) ?? [] });
        return analysis.sections.map(section => ({
            id: section.sectionId, kind: kinds[section.kind], evidence: section.evidence, pages: section.pageIds.map(pageId => this.pageNumber(pageId)),
            fields: [
                ...section.amounts.map(value => field(value, amountRoles[value.role], value.candidates.map(candidate => formatMoney(candidate)))),
                ...section.dates.map(value => field(value, dateRoles[value.role], value.candidates.map(candidate => formatCalendarDate(candidate)))),
                ...section.merchants.map(value => field(value, 'Merchant', value.candidates)),
                ...section.references.map(value => field(value, referenceRoles[value.role], value.candidates)),
                ...section.currencies.map(value => field(value, currencyRoles[value.role], value.candidates))
            ]
        }));
    });
    readonly hasFields = computed(() => this.sections().some(section => section.fields.length > 0));
    private readonly sectionNumbers = computed(() => new Map(this.analysis().sections.map((section, index) => [section.sectionId, index + 1])));
    pageNumber(pageId: string) { return this.pageNumbers().get(pageId) ?? 'Unknown'; }
    issueContext(issue: DocumentIssue) {
        const section = issue.sectionId && this.sectionNumbers().get(issue.sectionId);
        const label = issue.field === 'issue' ? 'Issue date' : issue.field?.replaceAll('-', ' ');
        return [section && `Section ${section}`, label].filter(Boolean).join(' · ');
    }
    toggleDetail(id: string, event: Event) {
        this.openDetails.update(current => {
            const next = new Set(current);
            if (expanded(event)) next.add(id);
            else for (const key of next) if (key === id || key.startsWith(id + '/')) next.delete(key);
            return next;
        });
    }
    toggleSource(event: Event) { this.sourceOpen.set(expanded(event)); }
}

interface ReportCache { workspaceKey: string; requestKey: string; records: Map<string, StoredDocumentImport>; }

@Component({
    selector: 'app-document-imports', standalone: true, imports: [DocumentAnalysis],
    templateUrl: './document-imports.html'
})
export class DocumentImports {
    readonly state = input.required<WorkspaceState>();
    readonly workspaceCommand = output<WorkspaceCommand>();
    readonly workspaceKey = computed(() => {
        const workspace = this.state().workspace;
        return workspace ? JSON.stringify([workspace.id, workspace.loadRevision]) : '';
    });
    readonly summaries = computed(() => this.state().workspace?.documentImports ?? []);
    private readonly openReports = signal<{ workspaceKey: string; ids: Set<string> }>({ workspaceKey: '', ids: new Set() });
    private readonly retryVersion = signal(0);
    private readonly cache = signal<ReportCache | null>(null);
    private readonly failedRequest = signal<string | null>(null);
    private readonly requestKey = computed(() => {
        const open = this.openReports();
        const summaries = this.summaries();
        if (open.workspaceKey !== this.workspaceKey() || !summaries.some(report => open.ids.has(report.id))) return null;
        return JSON.stringify([this.workspaceKey(), summaries.map(report => report.id)]);
    });
    readonly records = computed(() => {
        const cache = this.cache();
        return cache?.workspaceKey === this.workspaceKey() ? cache.records : null;
    });
    readonly detailsError = computed(() => this.requestKey() !== null && this.failedRequest() === this.requestKey());
    readonly openFileIds = signal<ReadonlySet<string>>(new Set());
    readonly basename = basename;
    readonly timestamp = (value: string) => dateTimeFormat.format(new Date(value));
    readonly filePath = (file: DocumentFileResult) => file.status === 'imported' ? file.record.filePath : file.filePath;
    readonly fileStatus = (file: DocumentFileResult) => {
        switch (file.status) {
            case 'imported': return file.record.result.status === 'partial' ? 'Imported · review needed' : 'Imported';
            case 'skipped': return 'Skipped duplicate';
            case 'failed': return 'Failed';
            case 'unsupported': return 'Unsupported';
        }
    };

    constructor() {
        effect(() => {
            const workspaceKey = this.workspaceKey();
            untracked(() => {
                if (this.cache()?.workspaceKey !== workspaceKey) this.cache.set(null);
                if (this.openReports().workspaceKey !== workspaceKey) {
                    this.openReports.set({ workspaceKey, ids: new Set() });
                    this.openFileIds.set(new Set());
                }
            });
        });
        effect(onCleanup => {
            const requestKey = this.requestKey();
            this.retryVersion();
            if (!requestKey) return;
            const { workspaceKey, summaries } = untracked(() => ({ workspaceKey: this.workspaceKey(), summaries: this.summaries() }));
            if (untracked(() => this.cache()?.requestKey === requestKey)) return;
            let current = true;
            onCleanup(() => { current = false; });
            this.failedRequest.set(null);
            const isCurrent = () => current && requestKey === this.requestKey();
            void Promise.resolve().then(() => isCurrent() ? window.receiptmatch.documentImports() : null).then(records => {
                if (!isCurrent()) return;
                if (!Array.isArray(records) || records.length !== summaries.length ||
                    records.some((record, index) => record?.id !== summaries[index].id || record.folderPath !== summaries[index].folderPath)) {
                    throw new Error('The report does not match the current workspace.');
                }
                this.cache.set({ workspaceKey, requestKey, records: new Map(records.map(record => [record.id, record])) });
            }).catch(() => {
                if (isCurrent()) this.failedRequest.set(requestKey);
            });
        });
    }
    isReportOpen(id: string) { return this.openReports().workspaceKey === this.workspaceKey() && this.openReports().ids.has(id); }
    toggleReport(id: string, event: Event) {
        if (!this.summaries().some(report => report.id === id)) return;
        const workspaceKey = this.workspaceKey();
        const ids = new Set(this.openReports().workspaceKey === workspaceKey ? this.openReports().ids : []);
        if (expanded(event)) ids.add(id);
        else ids.delete(id);
        this.openReports.set({ workspaceKey, ids });
        if (!ids.has(id)) this.openFileIds.update(open => new Set([...open].filter(key => !key.startsWith(id + '/'))));
    }
    toggleFile(key: string, event: Event) {
        this.openFileIds.update(current => {
            const next = new Set(current);
            if (expanded(event)) next.add(key);
            else next.delete(key);
            return next;
        });
    }
    retryDetails() { this.retryVersion.update(value => value + 1); }
    reportCounts(report: DocumentImportSummary) {
        const counts = [`${report.imported} imported`, `${report.skipped} skipped`, `${report.failed} failed`, `${report.unsupported} unsupported`];
        if (report.directoryIssues) counts.push(`${report.directoryIssues} folder ${report.directoryIssues === 1 ? 'issue' : 'issues'}`);
        return counts.join(' · ');
    }
    progressText() {
        const current = this.state().documentImport;
        if (!current) return '';
        if (current.cancelling) return 'Cancelling analysis…';
        const progress = current.progress;
        if (!progress) return 'Choose a folder in the dialog.';
        if (progress.phase === 'scanning') return 'Scanning the folder…';
        const phases = { loading: 'Opening document', text: 'Reading embedded text', rendering: 'Preparing page image', ocr: 'Reading with local English OCR', 'page-complete': 'Page read' };
        const extraction = progress.extraction;
        const page = extraction?.pageNumber && extraction.pageCount ? ` · Page ${extraction.pageNumber} of ${extraction.pageCount}` : '';
        const filename = progress.filePath ? ` · ${basename(progress.filePath)}` : '';
        return (extraction ? phases[extraction.phase] : 'Analyzing file') + filename + page;
    }
}
