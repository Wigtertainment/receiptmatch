import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { OriginalPreviewButton } from './original-preview-button.js';
import { amountEntryExample, formatAmountEntry, parseAmountEntry } from '../shared/amount-entry.js';
import { calendarDateSchema, type ImportIssue, type ImportPage, type PositionedSpan, type SourceEvidence } from '../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../shared/display.js';
import { formatDocumentTotal } from '../shared/document-display.js';
import {
    applyDocumentCorrections, documentCorrectionKey, type DocumentCorrection, type DocumentCorrectionTarget, type DocumentCorrectionValue
} from '../shared/document-corrections.js';
import { sameMoneyValue } from '../shared/money.js';
import type { DocumentImportSummary, WorkspaceCommand, WorkspaceState } from '../shared/protocol.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../shared/supporting-document.js';
import type { DocumentFileResult, DocumentFormat, StoredDocumentImport } from '../shared/workspace-documents.js';

function expanded(event: Event) { return (event.target as HTMLDetailsElement).open; }
function basename(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extractionLabels = { 'embedded-text': 'Embedded text', 'local-ocr': 'Local OCR' };
function regionText({ x, y, width, height }: PositionedSpan['region']) {
    const format = (value: number) => numberFormat.format(value);
    return `x ${format(x)}, y ${format(y)}, width ${format(width)}, height ${format(height)}`;
}
const kinds: Record<DocumentSection['kind'], string> = {
    'billing-summary': 'Billing summary', invoice: 'Invoice', receipt: 'Receipt', 'credit-note': 'Credit note',
    'payment-information': 'Payment information', unknown: 'Unrecognized section'
};
const amountRoles: Record<DocumentSection['amounts'][number]['role'], string> = {
    'billed-total': 'Billed total', 'balance-due': 'Balance due', payment: 'Payment', 'refund-payment': 'Refund paid', 'credit-note-component': 'Credit note component',
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
interface FieldCorrectionView {
    target: DocumentCorrectionTarget;
    kind: DocumentCorrectionValue['kind'];
    role: string;
    inputValue: string;
    currency: string;
    key: string;
    corrected: DocumentCorrection | undefined;
}
interface FieldView {
    id: string; role: string; label: string; values: string[]; evidence: SourceEvidence[]; issues: DocumentIssue[];
    reviewNeeded: boolean; newConflict: string | undefined; correction?: FieldCorrectionView;
}

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
export class DocumentAnalysis {
    readonly analysis = input.required<SupportingDocument>();
    readonly fieldHeading = input('Extracted fields');
    readonly format = input<DocumentFormat | null>(null);
    readonly documentId = input<string | null>(null);
    readonly busy = input(false);
    readonly workspaceError = input<string | null>(null);
    readonly projectedIssues = input<DocumentIssue[] | null>(null);
    readonly corrections = input<ReadonlyMap<string, DocumentCorrection> | null>(null);
    readonly correction = output<DocumentCorrectionTarget & { change: DocumentCorrectionValue }>();
    readonly sourceOpen = signal(false);
    readonly openDetails = signal<ReadonlySet<string>>(new Set());
    private readonly edit = signal<{ field: FieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined } | null>(null);
    readonly editing = computed(() => {
        const edit = this.edit();
        if (!edit || edit.field.target.documentId !== this.documentId()) return null;
        const saved = this.corrections()?.get(edit.field.key);
        const change = saved?.change;
        return {
            ...edit.field,
            inputValue: change?.kind === 'amount' ? formatAmountEntry(change.value) : change?.value ?? edit.field.inputValue,
            currency: change?.kind === 'amount' ? change.value.currency : edit.field.currency,
            applied: saved?.revision !== edit.originalRevision
        };
    });
    readonly correctionError = signal<string | null>(null);
    readonly editorId = computed(() => `document-correction-${this.documentId()}`);
    readonly amountExample = amountEntryExample;
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
        const effectiveFieldIssues = new Map<string, DocumentIssue[]>();
        for (const issue of this.projectedIssues() ?? analysis.issues) {
            if (!issue.fieldId) continue;
            const issues = effectiveFieldIssues.get(issue.fieldId) ?? [];
            issues.push(issue);
            effectiveFieldIssues.set(issue.fieldId, issues);
        }
        const missingBySection = new Map<string, Set<string>>();
        for (const issue of analysis.issues) {
            if (issue.sectionId && issue.fieldId === null && issue.field && issue.code === 'missing-field') {
                const missing = missingBySection.get(issue.sectionId) ?? new Set<string>();
                missing.add(issue.field);
                missingBySection.set(issue.sectionId, missing);
            }
            if (!issue.fieldId) continue;
            const issues = fieldIssues.get(issue.fieldId) ?? [];
            issues.push(issue);
            fieldIssues.set(issue.fieldId, issues);
        }
        const field = (source: { id: string; label: string; evidence: SourceEvidence[] }, role: string, values: string[], correction?: FieldCorrectionView): FieldView => {
            const issues = fieldIssues.get(source.id) ?? [];
            const effective = effectiveFieldIssues.get(source.id) ?? [];
            const newConflict = issues.some(issue => issue.code === 'conflicting-field') ? undefined : effective.find(issue => issue.code === 'conflicting-field')?.message;
            return { ...source, role, values, issues, reviewNeeded: effective.length > 0, newConflict, correction };
        };
        const documentId = this.documentId();
        const corrections = this.corrections();
        return analysis.sections.map(section => {
            const declared = [...new Set(section.currencies.filter(value => value.role === 'settlement').flatMap(value => value.candidates))];
            const editable = (fieldId: string | null, kind: DocumentCorrectionValue['kind'], role: string, inputValue = '', currency = '') => {
                if (!documentId) return undefined;
                const target = { documentId, sectionId: section.sectionId, fieldId };
                const key = documentCorrectionKey(target, kind);
                return { target, kind, role, inputValue, currency, key, corrected: corrections?.get(key) };
            };
            const missingFields: FieldCorrectionView[] = [];
            const missing = missingBySection.get(section.sectionId);
            if (documentId && missing && section.kind !== 'unknown') {
                const totalRole = section.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
                if (missing.has('billed-total') && !section.amounts.some(value => value.role === totalRole)) {
                    missingFields.push(editable(null, 'amount', amountRoles[totalRole], '', declared.length === 1 ? declared[0] : '')!);
                }
                if (missing.has('issue') && !section.dates.some(value => value.role === 'issue')) missingFields.push(editable(null, 'date', 'Issue date')!);
            }
            return {
                id: section.sectionId, kind: kinds[section.kind], evidence: section.evidence, pages: section.pageIds.map(pageId => this.pageNumber(pageId)), missingFields,
                fields: [
                    ...section.amounts.map(value => {
                        const currencies = [...new Set(value.candidates.flatMap(candidate => candidate.currency ? [candidate.currency] : []))];
                        const currency = currencies.length === 1 ? currencies[0] : !currencies.length && declared.length === 1 ? declared[0] : '';
                        const initial = value.candidates.length === 1 ? formatAmountEntry(value.candidates[0]) : '';
                        return field(value, amountRoles[value.role], value.candidates.map(candidate => formatMoney(candidate)),
                            editable(value.id, 'amount', amountRoles[value.role], initial, currency));
                    }),
                    ...section.dates.map(value => field(value, dateRoles[value.role], value.candidates.map(candidate => formatCalendarDate(candidate)),
                        editable(value.id, 'date', dateRoles[value.role], value.candidates.length === 1 ? value.candidates[0] : ''))),
                    ...section.merchants.map(value => field(value, 'Merchant', value.candidates)),
                    ...section.references.map(value => field(value, referenceRoles[value.role], value.candidates)),
                    ...section.currencies.map(value => field(value, currencyRoles[value.role], value.candidates))
                ]
            };
        });
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
        if (!expanded(event) && this.edit()?.field.target.fieldId === id) this.edit.set(null);
        this.openDetails.update(current => {
            const next = new Set(current);
            if (expanded(event)) next.add(id);
            else for (const key of next) if (key === id || key.startsWith(id + '/')) next.delete(key);
            return next;
        });
    }
    toggleSource(event: Event) { this.sourceOpen.set(expanded(event)); }
    correctedValue(change: DocumentCorrectionValue) {
        return change.kind === 'amount' ? formatMoney(change.value) : formatCalendarDate(change.value);
    }
    startCorrection(field: FieldCorrectionView, event: Event) {
        if (this.busy()) return;
        this.correctionError.set(null);
        this.edit.set({ field, trigger: event.currentTarget as HTMLElement, originalRevision: field.corrected?.revision });
        requestAnimationFrame(() => {
            if (this.editing()?.key === field.key) document.getElementById(this.editorId() + '-heading')?.focus();
        });
    }
    closeCorrection() {
        const edit = this.edit();
        this.edit.set(null);
        edit?.trigger.focus();
    }
    applyCorrection(event: Event) {
        event.preventDefault();
        const editing = this.editing();
        if (!editing || this.busy()) return;
        const fields = new FormData(event.currentTarget as HTMLFormElement);
        const entered = String(fields.get('value') ?? '').trim();
        let change: DocumentCorrectionValue;
        if (editing.kind === 'date') {
            const date = calendarDateSchema.safeParse(entered);
            if (!date.success) { this.correctionError.set('Enter a valid date.'); return; }
            change = { kind: 'date', value: date.data };
        } else {
            const currency = String(fields.get('currency') ?? '').trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(currency)) { this.correctionError.set('Enter a three-letter currency code, for example EUR.'); return; }
            const amount = parseAmountEntry(entered, currency);
            if (!amount) { this.correctionError.set(`Enter an amount without grouping separators, for example ${this.amountExample}.`); return; }
            change = { kind: 'amount', value: amount };
        }
        const previous = this.corrections()?.get(editing.key)?.change;
        if ((change.kind === 'date' && previous?.kind === 'date' && change.value === previous.value) ||
            (change.kind === 'amount' && previous?.kind === 'amount' && sameMoneyValue(change.value, previous.value))) {
            this.correctionError.set('Enter a different value to update this correction.'); return;
        }
        this.correctionError.set(null);
        this.correction.emit({ ...editing.target, change });
    }
}

interface ReportCache { workspaceKey: string; requestKey: string; records: Map<string, StoredDocumentImport>; }

@Component({
    selector: 'app-document-imports', standalone: true, imports: [DocumentAnalysis, OriginalPreviewButton],
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
    private latestReportId: string | null = null;
    readonly correctionsByDocument = computed(() => {
        const byDocument = new Map<string, Map<string, DocumentCorrection>>();
        for (const correction of this.state().workspace?.documentCorrections ?? []) {
            const fields = byDocument.get(correction.documentId) ?? new Map<string, DocumentCorrection>();
            fields.set(documentCorrectionKey(correction, correction.change.kind), correction);
            byDocument.set(correction.documentId, fields);
        }
        return byDocument;
    });
    readonly fileRows = computed(() => {
        const records = this.records();
        const open = this.openReports();
        const rows = new Map<string, { file: DocumentFileResult; total: string | null; projectedIssues: DocumentIssue[] | null }[]>();
        if (records && open.workspaceKey === this.workspaceKey()) {
            const corrections = this.correctionsByDocument();
            for (const id of open.ids) {
                const record = records.get(id);
                if (!record) continue;
                const fields = new Map(record.files.flatMap(file => file.status === 'imported' ? [...(corrections.get(file.record.id) ?? [])] : []));
                const [effective] = applyDocumentCorrections([record], fields);
                rows.set(id, record.files.map((file, index) => {
                    const projected = effective.files[index];
                    return { file, total: this.billedTotal(projected), projectedIssues: projected.status === 'imported' ? projected.record.result.issues : null };
                }));
            }
        }
        return rows;
    });
    readonly basename = basename;
    readonly timestamp = (value: string) => dateTimeFormat.format(new Date(value));
    readonly filePath = (file: DocumentFileResult) => file.status === 'imported' ? file.record.filePath : file.filePath;
    readonly fileStatus = (file: DocumentFileResult, reviewNeeded: boolean) => {
        switch (file.status) {
            case 'imported': return reviewNeeded ? 'Imported · review needed' : 'Imported';
            case 'skipped': return 'Skipped duplicate';
            case 'failed': return 'Failed';
            case 'unsupported': return 'Unsupported';
        }
    };

    constructor() {
        effect(() => {
            const workspaceKey = this.workspaceKey();
            const latestId = this.summaries().at(-1)?.id ?? null;
            untracked(() => {
                if (this.cache()?.workspaceKey !== workspaceKey) this.cache.set(null);
                const open = this.openReports();
                if (open.workspaceKey !== workspaceKey) {
                    this.openReports.set({ workspaceKey, ids: new Set() });
                    this.openFileIds.set(new Set());
                } else if (latestId && latestId !== this.latestReportId) {
                    this.openReports.set({ workspaceKey, ids: new Set([...open.ids, latestId]) });
                }
                this.latestReportId = latestId;
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
        if (this.isReportOpen(id) === expanded(event)) return;
        const workspaceKey = this.workspaceKey();
        const ids = new Set(this.openReports().workspaceKey === workspaceKey ? this.openReports().ids : []);
        if (expanded(event)) ids.add(id);
        else ids.delete(id);
        this.openReports.set({ workspaceKey, ids });
        if (!ids.has(id)) this.openFileIds.update(open => new Set([...open].filter(key => !key.startsWith('document-file-' + id + '-'))));
    }
    toggleFile(key: string) {
        this.openFileIds.update(current => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    }
    private billedTotal(file: DocumentFileResult) {
        return file.status === 'imported' ? formatDocumentTotal(file.record.result) : null;
    }
    correctField(value: DocumentCorrectionTarget & { change: DocumentCorrectionValue }) {
        const workspace = this.state().workspace;
        if (workspace && !this.state().busy) this.workspaceCommand.emit({ ...value, type: 'correct-document-field', revision: workspace.matchRevision });
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
        const phases = { loading: 'Opening document', text: 'Reading embedded text', rendering: 'Preparing page image', ocr: 'Reading with local OCR', 'page-complete': 'Page read' };
        const extraction = progress.extraction;
        const page = extraction?.pageNumber && extraction.pageCount ? ` · Page ${extraction.pageNumber} of ${extraction.pageCount}` : '';
        const filename = progress.filePath ? ` · ${basename(progress.filePath)}` : '';
        return (extraction ? phases[extraction.phase] : 'Analyzing file') + filename + page;
    }
}
