import type { StoredSupportingDocument } from "../shared/workspace-documents.js";
import type { ExtractionProgress, LocalOcrModel } from "../shared/pdf-extraction.js";
import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild, type EffectCleanupRegisterFn, type OutputEmitterRef, type Signal, type WritableSignal, type InputSignal } from '@angular/core';
import { DrawerSize, type TableConfig, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigCheckboxComponent, WigDrawerComponent, WigIconButtonComponent, WigInputComponent, WigTableComponent, WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { InputLength } from './input-length.js';
import { OriginalPreviewButton } from './original-preview-button.js';
import { amountEntryExample, formatAmountEntry, parseAmountEntry } from '../shared/amount-entry.js';
import { calendarDateSchema, type ImportIssue, type ImportPage, type PositionedSpan, type SourceEvidence } from '../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../shared/display.js';
import { formatDocumentTotal } from '../shared/document-display.js';
import {
    documentCorrectionKey, type DocumentCorrection, type DocumentCorrectionTarget, type DocumentCorrectionValue
} from '../shared/document-corrections.js';
import { sameMoneyValue } from '../shared/money.js';
import type { OriginalAdoptionResult } from '../shared/original-preview.js';
import type { DocumentImportSummary, DocumentSnapshot, OriginalDocumentFields, WorkspaceCommand, WorkspaceState, WorkspaceView } from '../shared/protocol.js';
import type { ReceiptAiChange, ReceiptAiPreviewResult, ReceiptAiRequest } from '../shared/receipt-ai.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../shared/supporting-document.js';
import type { DocumentFileResult, DocumentFormat, DocumentImportProgress, StoredDocumentImport } from '../shared/workspace-documents.js';
import type { ZodSafeParseResult } from 'zod';

function expanded(event: Event): boolean {
    return (event.target as HTMLDetailsElement).open;
}

function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function pageProgress(extraction?: ExtractionProgress | null): string {
    return extraction?.pageNumber && extraction.pageCount ? ` · Page ${extraction.pageNumber} of ${extraction.pageCount}` : '';
}

interface ReceiptChangeGroup {
    label: 'Changed' | 'Added' | 'Removed';
    changes: ReceiptAiChange[];
}

interface ReceiptChangeSummary {
    groups: ReceiptChangeGroup[];
    sections: { label: string; entries: { heading: string; fields: ReceiptAiChange[] }[] }[];
    warnings?: { before: number; after: number };
    matching?: string | null;
    omitted?: string | null;
}

function summarizeReceiptChanges(changes: ReceiptAiChange[]): ReceiptChangeSummary {
    const groups: ReceiptChangeSummary['groups'] = [{ label: 'Changed', changes: [] }, { label: 'Added', changes: [] }, { label: 'Removed', changes: [] }];
    const sections: ReceiptChangeSummary['sections'] = [{ label: 'Current analysis', entries: [] }, { label: 'AI proposal', entries: [] }];
    const summary: ReceiptChangeSummary = { groups, sections };
    for (const change of changes) {
        const { kind, before, after, section }: ReceiptAiChange = change;
        const side: ReceiptChangeSummary['sections'][number] = sections[after === null ? 0 : 1];
        switch (kind) {
            case 'warnings': summary.warnings = { before: before?.split(', ').length ?? 0, after: after?.split(', ').length ?? 0 }; break;
            case 'matching': summary.matching = after; break;
            case 'omitted': summary.omitted = after; break;
            case 'section': side.entries.push({ heading: (after ?? before)!, fields: [] }); break;
            default: addReceiptFieldChange(change, groups, side, section);
        }
    }
    summary.groups = groups.filter((group: ReceiptChangeGroup): boolean => group.changes.length > 0);
    summary.sections = sections.filter((side: ReceiptChangeSummary['sections'][number]): boolean => side.entries.length > 0);
    return summary;
}

function addReceiptFieldChange(change: ReceiptAiChange, groups: ReceiptChangeGroup[], side: ReceiptChangeSummary['sections'][number], section?: string): void {
    const { before, after }: ReceiptAiChange = change;
    if (change.unrecognized) {
        return;
    }
    if (section) {
        side.entries.find((entry: ReceiptChangeSummary['sections'][number]['entries'][number]): boolean => entry.heading === section)?.fields.push(change);
    } else {
        groups[before === null ? 1 : after === null ? 2 : 0].changes.push(change);
    }
}

const numberFormat: Intl.NumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateTimeFormat: Intl.DateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const extractionLabels: { 'embedded-text': string; 'local-ocr': string; } = { 'embedded-text': 'Embedded text', 'local-ocr': 'Local OCR' };
function regionText({ x, y, width, height }: PositionedSpan['region']): string {
    const format: (value: number) => string = (value: number): string => numberFormat.format(value);
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
    reviewNeeded: boolean; originalValues?: string[]; correction?: FieldCorrectionView;
}

@Component({
    selector: 'app-document-source-page', standalone: true, imports: [WigButtonComponent],
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
                        <wig-button severity="secondary" [label]="'Show ' + nextCount() + ' more text spans'" (click)="showMore()" />
                    }
                }
            }
        </details>
    `
})
class DocumentSourcePage {
    readonly page: InputSignal<ImportPage> = input.required<ImportPage>();
    readonly units: InputSignal<string> = input.required<string>();
    readonly initiallyOpen: InputSignal<boolean> = input(false);
    private readonly opened: WritableSignal<boolean | null> = signal<boolean | null>(null);
    private readonly limit: WritableSignal<number> = signal(100);
    readonly isOpen: Signal<boolean> = computed((): boolean => this.opened() ?? this.initiallyOpen());
    readonly spans: Signal<PositionedSpan[]> = computed((): PositionedSpan[] => this.page().spans.slice(0, this.limit()));
    readonly remaining: Signal<number> = computed((): number => this.page().spans.length - this.spans().length);
    readonly nextCount: Signal<number> = computed((): number => Math.min(this.remaining(), 100));
    readonly extractionLabels: { 'embedded-text': string; 'local-ocr': string; } = extractionLabels;
    readonly regionText: ({ x, y, width, height }: PositionedSpan["region"]) => string = regionText;
    toggle(event: Event): void {
        this.opened.set(expanded(event));
    }

    showMore(): void {
        this.limit.update((value: number): number => value + 100);
    }
}

@Component({
    selector: 'app-document-analysis', standalone: true,
    imports: [DocumentSourcePage, NgTemplateOutlet, WigButtonComponent, WigAlertComponent, WigInputComponent, InputLength],
    templateUrl: './document-analysis.html'
})
export class DocumentAnalysis {
    readonly analysis: InputSignal<SupportingDocument> = input.required<SupportingDocument>();
    readonly fieldHeading: InputSignal<string> = input('Extracted fields');
    readonly format: InputSignal<"png" | "pdf" | "jpeg" | null> = input<DocumentFormat | null>(null);
    readonly documentId: InputSignal<string | null> = input<string | null>(null);
    readonly busy: InputSignal<boolean> = input(false);
    readonly workspaceError: InputSignal<string | null> = input<string | null>(null);
    readonly original: InputSignal<OriginalDocumentFields | null> = input<OriginalDocumentFields | null>(null);
    readonly corrections: InputSignal<ReadonlyMap<string, DocumentCorrection> | null> = input<ReadonlyMap<string, DocumentCorrection> | null>(null);
    readonly correction: OutputEmitterRef<DocumentCorrectionTarget & { change: DocumentCorrectionValue; }> = output<DocumentCorrectionTarget & { change: DocumentCorrectionValue }>();
    readonly sourceOpen: WritableSignal<boolean> = signal(false);
    readonly openDetails: WritableSignal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
    private readonly edit: WritableSignal<{ field: FieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined; } | null> = signal<{ field: FieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined } | null>(null);
    readonly editing: Signal<{ inputValue: string; currency: string; applied: boolean; target: DocumentCorrectionTarget; kind: DocumentCorrectionValue["kind"]; role: string; key: string; corrected: DocumentCorrection | undefined; } | null> = computed((): { inputValue: string; currency: string; applied: boolean; target: DocumentCorrectionTarget; kind: DocumentCorrectionValue["kind"]; role: string; key: string; corrected: DocumentCorrection | undefined; } | null => {
        const edit: { field: FieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined; } | null = this.edit();
        if (edit?.field.target.documentId !== this.documentId()) {
            return null;
        }
        const saved: DocumentCorrection | undefined = this.corrections()?.get(edit.field.key);
        const change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; } | undefined = saved?.change;
        return {
            ...edit.field,
            inputValue: change?.kind === 'amount' ? formatAmountEntry(change.value) : change?.value ?? edit.field.inputValue,
            currency: change?.kind === 'amount' ? change.value.currency : edit.field.currency,
            applied: saved?.revision !== edit.originalRevision
        };
    });
    readonly correctionError: WritableSignal<string | null> = signal<string | null>(null);
    readonly editorId: Signal<string> = computed((): string => `document-correction-${this.documentId()}`);
    readonly amountExample: string = amountEntryExample;
    readonly units: Signal<"PDF points" | "pixels"> = computed((): "PDF points" | "pixels" => this.format() === 'pdf' ? 'PDF points' : 'pixels');
    readonly pages: Signal<ImportPage[]> = computed((): ImportPage[] => this.analysis().input?.pages ?? []);
    private readonly pageNumbers: Signal<Map<string, number>> = computed((): Map<string, number> => new Map(this.pages().map((page: ImportPage): [string, number] => [page.pageId, page.pageNumber])));
    readonly extractionLabel: (method: SourceEvidence["method"]) => string = (method: SourceEvidence['method']): string => extractionLabels[method];
    readonly regionText: ({ x, y, width, height }: PositionedSpan["region"]) => string = regionText;
    readonly generalIssues: Signal<({ context: string; code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; } | { context: string; code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: SourceEvidence[]; })[]> = computed((): ({ context: string; code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; } | { context: string; code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: SourceEvidence[]; })[] => {
        const analysis: SupportingDocument = this.analysis();
        const extractionIssues: ImportIssue[] = analysis.input?.issues ?? [];
        const signature: ({ code, message, field, evidence }: Pick<ImportIssue, "code" | "message" | "field" | "evidence">) => string = ({ code, message, field, evidence }: Pick<ImportIssue, 'code' | 'message' | 'field' | 'evidence'>): string =>
            JSON.stringify([code, message, field, evidence]);
        const extractionSignatures: Set<string> = new Set(extractionIssues.map(signature));
        return [
            ...analysis.issues.filter((issue: DocumentIssue): boolean => issue.fieldId === null && (issue.sectionId !== null || !extractionSignatures.has(signature(issue))))
                .map((issue: DocumentIssue): { context: string; code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; } => ({ ...issue, context: this.issueContext(issue) })),
            ...extractionIssues.map((issue: ImportIssue): { context: string; code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: SourceEvidence[]; } => ({
                ...issue, context: [issue.severity === 'error' ? 'Error' : 'Warning', issue.pageId && `Page ${this.pageNumber(issue.pageId)}`,
                    issue.field?.replaceAll('-', ' ')].filter(Boolean).join(' · ')
            }))
        ];
    });
    readonly sections: Signal<{ id: string; kind: string; evidence: SourceEvidence[]; pages: (number | "Unknown")[]; missingFields: FieldCorrectionView[]; fields: FieldView[]; }[]> = computed((): { id: string; kind: string; evidence: SourceEvidence[]; pages: (number | "Unknown")[]; missingFields: FieldCorrectionView[]; fields: FieldView[]; }[] => {
        const analysis: SupportingDocument = this.analysis();
        const fieldIssues: Map<string, DocumentIssue[]> = new Map<string, DocumentIssue[]>();

        const missingBySection: Map<string, Set<string>> = new Map<string, Set<string>>();
        for (const issue of analysis.issues) {
            if (!issue.fieldId) {
                continue;
            }
            const issues: DocumentIssue[] = fieldIssues.get(issue.fieldId) ?? [];
            issues.push(issue);
            fieldIssues.set(issue.fieldId, issues);
        }
        for (const issue of (this.original()?.issues ?? analysis.issues)) {
            if (issue.sectionId && issue.fieldId === null && issue.field && issue.code === 'missing-field') {
                const missing: Set<string> = missingBySection.get(issue.sectionId) ?? new Set<string>();
                missing.add(issue.field);
                missingBySection.set(issue.sectionId, missing);
            }
        }
        const field: (source: { id: string; label: string; evidence: SourceEvidence[]; }, role: string, values: string[], correction?: FieldCorrectionView, originalValues?: string[]) => FieldView = (source: { id: string; label: string; evidence: SourceEvidence[] }, role: string, values: string[],
            correction?: FieldCorrectionView, originalValues?: string[]): FieldView => {
            const issues: DocumentIssue[] = fieldIssues.get(source.id) ?? [];
            return { ...source, role, values, issues, reviewNeeded: issues.length > 0, correction, originalValues };
        };
        const documentId: string | null = this.documentId();
        const corrections: ReadonlyMap<string, DocumentCorrection> | null = this.corrections();
        const originalSections: Map<string, DocumentSection> = new Map((this.original()?.sections ?? analysis.sections).map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
        return analysis.sections.map((section: DocumentSection): { id: string; kind: string; evidence: SourceEvidence[]; pages: (number | "Unknown")[]; missingFields: FieldCorrectionView[]; fields: FieldView[]; } => {
            const original: DocumentSection = originalSections.get(section.sectionId)!;
            const originalAmounts: Map<string, { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }> = new Map(original.amounts.map((value: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): [string, { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }] => [value.id, value]));
            const originalDates: Map<string, { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }> = new Map(original.dates.map((value: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): [string, { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }] => [value.id, value]));
            const declared: string[] = [...new Set(section.currencies.filter((value: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => value.role === 'settlement').flatMap((value: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] => value.candidates))];
            const editable: (fieldId: string | null, kind: DocumentCorrectionValue["kind"], role: string, inputValue?: string, currency?: string) => FieldCorrectionView | undefined = (fieldId: string | null, kind: DocumentCorrectionValue['kind'], role: string, inputValue: string = '', currency: string = ''): FieldCorrectionView | undefined => {
                if (!documentId) {
                    return undefined;
                }
                const target: { documentId: string; sectionId: string; fieldId: string | null; } = { documentId, sectionId: section.sectionId, fieldId };
                const key: string = documentCorrectionKey(target, kind);
                return { target, kind, role, inputValue, currency, key, corrected: corrections?.get(key) };
            };
            const missingFields: FieldCorrectionView[] = [];
            const missing: Set<string> | undefined = missingBySection.get(section.sectionId);
            if (documentId && missing && section.kind !== 'unknown') {
                const totalRole: "billed-total" | "credit-note-component" = section.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
                if (missing.has('billed-total') && !original.amounts.some((value: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => value.role === totalRole)) {
                    missingFields.push(editable(null, 'amount', amountRoles[totalRole], '', declared.length === 1 ? declared[0] : '')!);
                }
                if (missing.has('issue') && !original.dates.some((value: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => value.role === 'issue')) {
                    missingFields.push(editable(null, 'date', 'Issue date')!);
                }
            }
            return {
                id: section.sectionId, kind: kinds[section.kind], evidence: section.evidence, pages: section.pageIds.map((pageId: string): number | "Unknown" => this.pageNumber(pageId)), missingFields,
                fields: [
                    ...section.amounts.filter((value: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => !documentId || originalAmounts.has(value.id) || value.evidence.length > 0).map((value: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): FieldView => {
                        const previous: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | undefined = originalAmounts.get(value.id);
                        const currencies: string[] = [...new Set(value.candidates.flatMap((candidate: { coefficient: string; scale: number; currency: string | null; }): string[] => candidate.currency ? [candidate.currency] : []))];
                        const currency: string = currencies.length === 1 ? currencies[0] : !currencies.length && declared.length === 1 ? declared[0] : '';
                        const initial: string = value.candidates.length === 1 ? formatAmountEntry(value.candidates[0]) : '';
                        return field(value, amountRoles[value.role], value.candidates.map((candidate: { coefficient: string; scale: number; currency: string | null; }): string => formatMoney(candidate)),
                            previous ? editable(value.id, 'amount', amountRoles[value.role], initial, currency) : undefined,
                            previous?.candidates.map((candidate: { coefficient: string; scale: number; currency: string | null; }): string => formatMoney(candidate)));
                    }),
                    ...section.dates.filter((value: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => !documentId || originalDates.has(value.id) || value.evidence.length > 0).map((value: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): FieldView => {
                        const previous: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | undefined = originalDates.get(value.id);
                        return field(value, dateRoles[value.role], value.candidates.map((candidate: string): string => formatCalendarDate(candidate)),
                            previous ? editable(value.id, 'date', dateRoles[value.role], value.candidates.length === 1 ? value.candidates[0] : '') : undefined,
                            previous?.candidates.map((candidate: string): string => formatCalendarDate(candidate)));
                    }),
                    ...section.merchants.map((value: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): FieldView => field(value, 'Merchant', value.candidates)),
                    ...section.references.map((value: { role: "table" | "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): FieldView => field(value, referenceRoles[value.role], value.candidates)),
                    ...section.currencies.map((value: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): FieldView => field(value, currencyRoles[value.role], value.candidates))
                ]
            };
        });
    });
    readonly hasFields: Signal<boolean> = computed((): boolean => this.sections().some((section: { id: string; kind: string; evidence: SourceEvidence[]; pages: (number | "Unknown")[]; missingFields: FieldCorrectionView[]; fields: FieldView[]; }): boolean => section.fields.length > 0));
    private readonly sectionNumbers: Signal<Map<string, number>> = computed((): Map<string, number> => new Map(this.analysis().sections.map((section: DocumentSection, index: number): [string, number] => [section.sectionId, index + 1])));
    pageNumber(pageId: string): number | "Unknown" {
        return this.pageNumbers().get(pageId) ?? 'Unknown';
    }

    issueContext(issue: DocumentIssue): string {
        const section: number | "" | null | undefined = issue.sectionId && this.sectionNumbers().get(issue.sectionId);
        const label: string | undefined = issue.field === 'issue' ? 'Issue date' : issue.field?.replaceAll('-', ' ');
        return [section && `Section ${section}`, label].filter(Boolean).join(' · ');
    }

    toggleDetail(id: string, event: Event): void {
        if (!expanded(event) && this.edit()?.field.target.fieldId === id) {
            this.edit.set(null);
        }
        this.openDetails.update((current: ReadonlySet<string>): Set<string> => {
            const next: Set<string> = new Set(current);
            if (expanded(event)) {
                next.add(id);
            } else {
                for (const key of next) {
                    if (key === id || key.startsWith(id + '/')) {
                        next.delete(key);
                    }
                }
            }
            return next;
        });
    }

    toggleSource(event: Event): void {
        this.sourceOpen.set(expanded(event));
    }

    correctedValue(change: DocumentCorrectionValue): string {
        return change.kind === 'amount' ? formatMoney(change.value) : formatCalendarDate(change.value);
    }

    startCorrection(field: FieldCorrectionView, trigger: WigButtonComponent): void {
        if (this.busy()) {
            return;
        }
        this.correctionError.set(null);
        this.edit.set({ field, trigger: trigger.nativeButton, originalRevision: field.corrected?.revision });
        requestAnimationFrame((): void => {
            if (this.editing()?.key === field.key) {
                document.getElementById(this.editorId() + '-heading')?.focus();
            }
        });
    }

    closeCorrection(): void {
        const edit: { field: FieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined; } | null = this.edit();
        this.edit.set(null);
        edit?.trigger.focus();
    }

    submitFromField(form: HTMLFormElement, event: Event): void {
        if (event instanceof KeyboardEvent && !event.isComposing && event.target instanceof HTMLInputElement) {
            this.applyCorrection(form, event);
        }
    }

    applyCorrection(form: HTMLFormElement, event?: Event): void {
        event?.preventDefault();
        const editing: { inputValue: string; currency: string; applied: boolean; target: DocumentCorrectionTarget; kind: DocumentCorrectionValue["kind"]; role: string; key: string; corrected: DocumentCorrection | undefined; } | null = this.editing();
        if (!editing || this.busy()) {
            return;
        }
        const fields: FormData = new FormData(form);
        const enteredValue: FormDataEntryValue | null = fields.get('value');
        const entered: string = typeof enteredValue === 'string' ? enteredValue.trim() : '';
        let change: DocumentCorrectionValue;
        if (editing.kind === 'date') {
            const date: ZodSafeParseResult<string> = calendarDateSchema.safeParse(entered);
            if (!date.success) {
                this.correctionError.set('Enter a valid date.'); return;
            }
            change = { kind: 'date', value: date.data };
        } else {
            const currencyValue: FormDataEntryValue | null = fields.get('currency');
            const currency: string = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : '';
            if (!/^[A-Z]{3}$/.test(currency)) {
                this.correctionError.set('Enter a three-letter currency code, for example EUR.'); return;
            }
            const amount: { coefficient: string; currency: string; scale: number; } | null = parseAmountEntry(entered, currency);
            if (!amount) {
                this.correctionError.set(`Enter an amount without grouping separators, for example ${this.amountExample}.`); return;
            }
            change = { kind: 'amount', value: amount };
        }
        const previous: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; } | undefined = this.corrections()?.get(editing.key)?.change;
        if ((change.kind === 'date' && previous?.kind === 'date' && change.value === previous.value) ||
            (change.kind === 'amount' && previous?.kind === 'amount' && sameMoneyValue(change.value, previous.value))) {
            this.correctionError.set('Enter a different value to update this correction.'); return;
        }
        this.correctionError.set(null);
        this.correction.emit({ ...editing.target, change });
    }
}

interface DocumentFileRow { file: DocumentFileResult; total: string | null; original: OriginalDocumentFields | null; }
interface ReportCache { workspaceKey: string; requestKey: string; records: Map<string, StoredDocumentImport>; originals: Record<string, OriginalDocumentFields>; }
interface ReceiptAnalysisContext {
    request: ReceiptAiRequest; workspaceKey: string; matchRevision: number; name: string; format: DocumentFormat; trigger: HTMLButtonElement;
}
interface ReceiptAnalysisReview { context: ReceiptAnalysisContext; result: Extract<ReceiptAiPreviewResult, { status: 'ready' }>; }
interface ReceiptAnalysisFeedback { context: ReceiptAnalysisContext; message: string; error: boolean; }

@Component({
    selector: 'app-document-imports', standalone: true,
    imports: [DocumentAnalysis, OriginalPreviewButton, NgTemplateOutlet, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigCheckboxComponent, WigDrawerComponent, WigIconButtonComponent, WigTableComponent, WigTemplateDirective],
    templateUrl: './document-imports.html'
})
export class DocumentImports {
    readonly state: InputSignal<WorkspaceState> = input.required<WorkspaceState>();
    readonly active: InputSignal<boolean> = input(true);
    readonly workspaceCommand: OutputEmitterRef<WorkspaceCommand> = output<WorkspaceCommand>();
    private readonly destroyed: DestroyRef = inject(DestroyRef);
    private readonly aiDialog: Signal<ElementRef<HTMLDialogElement> | undefined> = viewChild<ElementRef<HTMLDialogElement>>('aiDialog');
    private readonly documentsHeading: Signal<ElementRef<HTMLHeadingElement> | undefined> = viewChild<ElementRef<HTMLHeadingElement>>('documentsHeading');
    readonly aiPending: WritableSignal<ReceiptAnalysisContext | null> = signal<ReceiptAnalysisContext | null>(null);
    readonly aiImport: Signal<WorkspaceState['documentImport']> = computed((): WorkspaceState['documentImport'] => {
        const active: WorkspaceState['documentImport'] = this.state().documentImport;
        return active?.localAi ? active : null;
    });
    readonly aiReview: WritableSignal<ReceiptAnalysisReview | null> = signal<ReceiptAnalysisReview | null>(null);
    readonly aiChanges: Signal<ReceiptChangeSummary> = computed((): ReceiptChangeSummary => summarizeReceiptChanges(this.aiReview()?.result.changes ?? []));
    readonly aiFeedback: WritableSignal<ReceiptAnalysisFeedback | null> = signal<ReceiptAnalysisFeedback | null>(null);
    readonly aiApplying: WritableSignal<boolean> = signal(false);
    readonly aiApplyError: WritableSignal<string | null> = signal<string | null>(null);
    readonly aiEvidenceOpen: WritableSignal<boolean> = signal(false);
    readonly acknowledgeAiConflicts: WritableSignal<boolean> = signal(false);
    readonly aiModelNames: Record<LocalOcrModel, string> = { 'pp-ocrv6-medium': 'PP-OCRv6 Medium', 'paddleocr-vl-1.6': 'PaddleOCR-VL 1.6' };
    readonly workspaceKey: Signal<string> = computed((): string => {
        const workspace: WorkspaceView | null = this.state().workspace;
        return workspace ? JSON.stringify([workspace.id, workspace.loadRevision]) : '';
    });
    readonly summaries: Signal<DocumentImportSummary[]> = computed((): DocumentImportSummary[] => this.state().workspace?.documentImports ?? []);
    readonly reportItems: Signal<{ id: string; header: string; template: string; data: DocumentImportSummary; }[]> = computed((): { id: string; header: string; template: string; data: DocumentImportSummary; }[] => this.summaries().map((report: DocumentImportSummary): { id: string; header: string; template: string; data: DocumentImportSummary; } => ({
        id: report.id, header: `${basename(report.folderPath)} · ${report.status === 'cancelled' ? 'Cancelled' : 'Finished'} · ${this.reportCounts(report)}`,
        template: 'report', data: report
    })));
    private readonly retryVersion: WritableSignal<number> = signal(0);
    private readonly cache: WritableSignal<ReportCache | null> = signal<ReportCache | null>(null);
    private readonly failedRequest: WritableSignal<string | null> = signal<string | null>(null);
    private readonly requestKey: Signal<string | null> = computed((): string | null => {
        const summaries: DocumentImportSummary[] = this.summaries();
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
            fields.set(documentCorrectionKey(correction, correction.change.kind), correction);
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
                })));
            }
        }
        return rows;
    });
    private readonly importedHashes: Signal<Set<string>> = computed((): Set<string> => {
        const hashes: Set<string> = new Set();
        for (const report of this.records()?.values() ?? []) {
            for (const file of report.files) {
                if (file.status === 'imported' && file.record.result.input) {
                    hashes.add(file.record.result.input.source.sha256);
                }
            }
        }
        return hashes;
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
            const { workspaceKey, summaries, workspace }: { workspaceKey: string; summaries: DocumentImportSummary[]; workspace: WorkspaceView | null; } = untracked((): { workspaceKey: string; summaries: DocumentImportSummary[]; workspace: WorkspaceView | null; } => ({ workspaceKey: this.workspaceKey(), summaries: this.summaries(), workspace: this.state().workspace }));
            if (!workspace) {
                return;
            }
            const { loadRevision, matchRevision: revision }: WorkspaceView = workspace;
            if (untracked((): boolean => this.cache()?.requestKey === requestKey)) {
                return;
            }
            let current: boolean = true;
            onCleanup((): void => {
                current = false;
            });
            this.failedRequest.set(null);
            const isCurrent: () => boolean = (): boolean => current && requestKey === this.requestKey();
            void window.receiptmatch.documentSnapshot({ loadRevision, revision }).then((snapshot: DocumentSnapshot | null): void => {
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
                this.cache.set({ workspaceKey, requestKey, records: new Map(records.map((record: StoredDocumentImport): [string, StoredDocumentImport] => [record.id, record])), originals: snapshot.originals });
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
        return file.status === 'failed' && file.sha256 && !this.importedHashes().has(file.sha256) ? file.format : null;
    }

    isAiPendingRow(reportId: string, fileIndex: number): boolean {
        const request: ReceiptAiRequest | undefined = this.aiPending()?.request;
        return request?.reportId === reportId && request.fileIndex === fileIndex;
    }

    aiProgressText(): string {
        const active: WorkspaceState['documentImport'] = this.aiImport();
        return active?.cancelling ? 'Cancelling AI analysis…' : 'Analyzing receipt with AI' + (pageProgress(active?.progress?.extraction) || '…');
    }

    async activateAiRow(reportId: string, fileIndex: number, event: MouseEvent): Promise<void> {
        if (this.isAiPendingRow(reportId, fileIndex)) {
            const active: WorkspaceState['documentImport'] = this.aiImport();
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
        const workspace: WorkspaceView | null = this.state().workspace;
        const file: DocumentFileResult | undefined = this.fileRows().get(reportId)?.[fileIndex]?.file;
        const format: DocumentFormat | null = file ? this.reanalysisFormat(file) : null;
        if (!workspace || !file || !format || this.state().busy || this.aiPending() || this.aiReview() || !this.detailsCurrent()) {
            return;
        }
        const context: ReceiptAnalysisContext = {
            request: { reportId, fileIndex, loadRevision: workspace.loadRevision },
            workspaceKey: this.workspaceKey(), matchRevision: workspace.matchRevision, name: basename(this.filePath(file)), format, trigger,
        };
        this.aiPending.set(context);
        this.aiFeedback.set(null);
        try {
            const result: ReceiptAiPreviewResult = await window.receiptmatch.reanalyzeReceipt(context.request);
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

    async applyAiReview(): Promise<void> {
        const review: ReceiptAnalysisReview | null = this.aiReview();
        if (!review || this.aiApplying() || this.state().busy || review.result.blockingConflict || (review.result.conflicts.length > 0 && !this.acknowledgeAiConflicts())) {
            return;
        }
        this.aiApplying.set(true);
        this.aiApplyError.set(null);
        try {
            const result: OriginalAdoptionResult = await window.receiptmatch.acceptReceiptAnalysis({
                token: review.result.token, loadRevision: review.context.request.loadRevision, acknowledgeConflicts: this.acknowledgeAiConflicts(),
            });
            if (!this.currentAiWorkspace(review.context) || this.aiReview() !== review) {
                return;
            }
            if (result.status === 'adopted') {
                this.clearAiReview();
                this.finishAiRequest(review.context, 'AI analysis applied.', false, true);
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
            this.clearAiReview();
            this.finishAiRequest(review.context, 'AI analysis discarded.', false, true);
        }
    }

    private clearAiReview(): void {
        this.aiDialog()?.nativeElement.close();
        this.aiReview.set(null);
        this.aiApplying.set(false);
        this.aiApplyError.set(null);
        this.aiEvidenceOpen.set(false);
        this.acknowledgeAiConflicts.set(false);
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
        const workspace: WorkspaceView | null = this.state().workspace;
        if (workspace && !this.state().busy && this.detailsCurrent()) {
            this.workspaceCommand.emit({ ...value, type: 'correct-document-field', revision: workspace.matchRevision });
        }
    }

    retryDetails(): void {
        this.retryVersion.update((value: number): number => value + 1);
    }

    reportCounts(report: DocumentImportSummary): string {
        const counts: string[] = [`${report.imported} imported`, `${report.skipped} skipped`, `${report.failed} failed`, `${report.unsupported} unsupported`];
        if (report.directoryIssues) {
            counts.push(`${report.directoryIssues} folder ${report.directoryIssues === 1 ? 'issue' : 'issues'}`);
        }
        return counts.join(' · ');
    }

    progressText(): string {
        const current: WorkspaceState['documentImport'] = this.state().documentImport;
        if (!current || current.localAi) {
            return '';
        }
        if (current.cancelling) {
            return 'Cancelling analysis…';
        }
        const progress: DocumentImportProgress | null = current.progress;
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
