import { NgTemplateOutlet } from '@angular/common';
import { Component, afterRenderEffect, computed, input, output, signal, type InputSignal, type OutputEmitterRef, type Signal, type WritableSignal } from '@angular/core';
import { WigAlertComponent, WigButtonComponent, WigInputComponent } from '@wigtertainment-ltd/comp-lib';
import type { ZodSafeParseResult } from 'zod';
import { InputLength } from '../shared/input-length.directive.js';
import { OriginalPreviewButton } from '../shared/original-preview-button.component.js';
import { amountEntryExample, formatAmountEntry, parseAmountEntry } from '../../shared/amount-entry.js';
import { calendarDateSchema, type ImportIssue, type ImportPage, type PositionedSpan, type SourceEvidence } from '../../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../../shared/display.js';
import { documentCorrectionKey, documentCorrectionValueSchema, missingDocumentCorrectionFields, type DocumentCorrection, type DocumentCorrectionTarget,
    type DocumentCorrectionValue } from '../../shared/document-corrections.js';
import { activeDocumentFieldDisposition, documentFieldConfirmationIssue, isDocumentFieldConfirmed, type DocumentFieldDisposition, type DocumentFieldReview,
    type DocumentFieldReviewTarget } from '../../shared/document-field-reviews.js';
import { documentIssueNeedsReview } from '../../shared/document-review-presentation.js';
import { sameMoneyValue, type Money } from '../../shared/money.js';
import type { OriginalDocumentFields } from '../../shared/protocol.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../../shared/supporting-document.js';
import type { DocumentFormat } from '../../shared/workspace-documents.js';
import { extractionLabels, regionText } from './document-evidence.js';
import { DocumentSourcePage } from './document-source-page.component.js';

function expanded(event: Event): boolean {
    return (event.target as HTMLDetailsElement).open;
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
interface IFieldCorrectionView {
    target: DocumentCorrectionTarget;
    kind: DocumentCorrectionValue['kind'];
    role: string;
    fieldRole?: string;
    inputValue: string;
    currency: string;
    key: string;
    corrected: DocumentCorrection | undefined;
}
interface IFieldCorrectionEditor extends IFieldCorrectionView { applied: boolean; }
interface IFieldView {
    id: string; role: string; label: string; values: string[]; evidence: SourceEvidence[]; issues: DocumentIssue[];
    reviewNeeded: boolean; originalValues?: string[]; correction?: IFieldCorrectionView; confirmedByUser?: true;
}
interface IFieldConfirmationView { confirmed: boolean; issue: string | null; disposition: DocumentFieldDisposition | null; }
interface IFieldEdit { field: IFieldCorrectionView; trigger: HTMLElement; originalRevision: number | undefined; }
interface ISectionView {
    id: string; kind: string; evidence: SourceEvidence[]; pages: (number | 'Unknown')[]; missingFields: IFieldCorrectionView[]; fields: IFieldView[];
}

type ContextualIssue<T extends DocumentIssue | ImportIssue> = T & Record<'context', string>;
type AmountField = DocumentSection['amounts'][number];
type AmountCandidate = AmountField['candidates'][number];
type DateField = DocumentSection['dates'][number];
type CurrencyField = DocumentSection['currencies'][number];
type RequestedConfirmation = Pick<FieldConfirmationChange, 'documentId' | 'fieldId' | 'confirmed'>;
export type FieldConfirmationChange = DocumentFieldReviewTarget & Record<'confirmed', boolean>;
export type FieldCorrectionChange = DocumentCorrectionTarget & Record<'change', DocumentCorrectionValue>;
export type FieldDispositionChange = DocumentFieldReviewTarget & Record<'disposition', DocumentFieldDisposition | null>;

@Component({
    selector: 'app-document-analysis', standalone: true,
    imports: [DocumentSourcePage, OriginalPreviewButton, NgTemplateOutlet, WigButtonComponent, WigAlertComponent, WigInputComponent, InputLength],
    templateUrl: './document-analysis.component.html'
})
export class DocumentAnalysis {
    constructor() {
        afterRenderEffect((): void => {
            const trigger: HTMLElement | null = this.confirmationTrigger();
            if (!trigger || this.busy() || (!this.confirmationFeedback() && !this.workspaceError())) {
                return;
            }
            this.confirmationTrigger.set(null);
            if (trigger.isConnected && (document.activeElement === document.body || document.activeElement === trigger)) {
                trigger.focus();
            }
        });

        afterRenderEffect((): void => {
            const trigger: HTMLElement | null = this.dispositionTrigger();
            const requested: FieldDispositionChange | null = this.requestedDisposition();
            if (!trigger || requested?.documentId !== this.documentId() || this.busy() || (!this.dispositionFeedback() && !this.workspaceError())) {
                return;
            }
            this.dispositionTrigger.set(null);
            if (document.activeElement === document.body || document.activeElement === trigger) {
                const next: HTMLElement | null = trigger.isConnected ? trigger : document.getElementById(this.decisionActionsId(requested.fieldId))?.querySelector('button') ?? null;
                next?.focus();
            }
        });
    }

    readonly analysis: InputSignal<SupportingDocument> = input.required<SupportingDocument>();
    readonly fieldHeading: InputSignal<string> = input('Extracted fields');
    readonly format: InputSignal<"png" | "pdf" | "jpeg" | null> = input<DocumentFormat | null>(null);
    readonly documentId: InputSignal<string | null> = input<string | null>(null);
    readonly documentName: InputSignal<string> = input('Document');
    readonly loadRevision: InputSignal<number | undefined> = input<number>();
    readonly fieldReviews: InputSignal<readonly DocumentFieldReview[]> = input<readonly DocumentFieldReview[]>([]);
    readonly reviewBase: InputSignal<OriginalDocumentFields | null> = input<OriginalDocumentFields | null>(null);
    private readonly preReviewAnalysis: Signal<SupportingDocument> = computed((): SupportingDocument => ({ ...this.analysis(), ...this.reviewBase() }));
    readonly valuesBeforeDecision: Signal<ReadonlyMap<string, string[]>> = computed((): ReadonlyMap<string, string[]> => {
        const values: Map<string, string[]> = new Map<string, string[]>();
        for (const section of this.preReviewAnalysis().sections) {
            for (const field of section.amounts) {
                values.set(field.id, field.candidates.map((value: DocumentSection['amounts'][number]['candidates'][number]): string => formatMoney(value)));
            }
            for (const field of section.dates) {
                values.set(field.id, field.candidates.map((value: string): string => formatCalendarDate(value)));
            }
            for (const field of [...section.merchants, ...section.references, ...section.currencies]) {
                values.set(field.id, field.candidates);
            }
        }
        return values;
    });
    readonly confirmation: OutputEmitterRef<FieldConfirmationChange> = output<FieldConfirmationChange>();
    readonly disposition: OutputEmitterRef<FieldDispositionChange> = output<FieldDispositionChange>();
    private readonly requestedDisposition: WritableSignal<FieldDispositionChange | null> = signal<FieldDispositionChange | null>(null);
    private readonly dispositionTrigger: WritableSignal<HTMLElement | null> = signal<HTMLElement | null>(null);
    readonly dispositionFeedback: Signal<string> = computed((): string => {
        const requested: FieldDispositionChange | null = this.requestedDisposition();
        if (requested?.documentId !== this.documentId() || this.busy() || this.workspaceError() ||
            this.confirmationStates().get(requested.fieldId)?.disposition !== requested.disposition) {
            return '';
        }
        return requested.disposition === null ? 'Field decision reset.' : requested.disposition === 'rejected' ? 'Recognition excluded from matching.' : 'Field marked as not determinable and excluded from matching.';
    });
    private readonly requestedConfirmation: WritableSignal<RequestedConfirmation | null> = signal<RequestedConfirmation | null>(null);
    private readonly confirmationTrigger: WritableSignal<HTMLElement | null> = signal<HTMLElement | null>(null);
    readonly confirmationFeedback: Signal<string> = computed((): string => {
        const requested: RequestedConfirmation | null = this.requestedConfirmation();
        if (requested?.documentId !== this.documentId() || this.busy() || this.confirmationStates().get(requested.fieldId)?.confirmed !== requested.confirmed) {
            return '';
        }
        return requested.confirmed ? 'Field value confirmed.' : 'Field confirmation withdrawn.';
    });
    readonly confirmationStates: Signal<ReadonlyMap<string, IFieldConfirmationView>> = computed((): ReadonlyMap<string, IFieldConfirmationView> => {
        const analysis: SupportingDocument = this.analysis();
        const documentId: string | null = this.documentId();
        const states: Map<string, IFieldConfirmationView> = new Map<string, IFieldConfirmationView>();
        if (documentId) {
            for (const section of analysis.sections) {
                for (const field of [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies]) {
                    const target: DocumentFieldReviewTarget = { documentId, sectionId: section.sectionId, fieldId: field.id };
                    const confirmed: boolean = isDocumentFieldConfirmed(this.preReviewAnalysis(), target, this.fieldReviews(), analysis);
                    const issue: string | null = documentFieldConfirmationIssue(analysis, section.sectionId, field.id);
                    const disposition: DocumentFieldDisposition | null = activeDocumentFieldDisposition(this.preReviewAnalysis(), target, this.fieldReviews());
                    states.set(field.id, { confirmed, issue, disposition });
                }
            }
        }
        return states;
    });
    readonly busy: InputSignal<boolean> = input(false);
    readonly workspaceError: InputSignal<string | null> = input<string | null>(null);
    readonly original: InputSignal<OriginalDocumentFields | null> = input<OriginalDocumentFields | null>(null);
    readonly corrections: InputSignal<ReadonlyMap<string, DocumentCorrection> | null> = input<ReadonlyMap<string, DocumentCorrection> | null>(null);
    readonly correctionsEnabled: InputSignal<boolean> = input(true);
    readonly correction: OutputEmitterRef<FieldCorrectionChange> = output<FieldCorrectionChange>();
    readonly sourceOpen: WritableSignal<boolean> = signal(false);
    readonly openDetails: WritableSignal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
    private readonly edit: WritableSignal<IFieldEdit | null> = signal<IFieldEdit | null>(null);
    readonly editing: Signal<IFieldCorrectionEditor | null> = computed((): IFieldCorrectionEditor | null => {
        const edit: IFieldEdit | null = this.edit();
        if (edit?.field.target.documentId !== this.documentId()) {
            return null;
        }
        const saved: DocumentCorrection | undefined = this.corrections()?.get(edit.field.key);
        const change: DocumentCorrectionValue | undefined = saved?.change;
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
    readonly regionText: ({ x, y, width, height }: PositionedSpan["region"]) => string = regionText;
    readonly generalIssues: Signal<ContextualIssue<DocumentIssue | ImportIssue>[]> = computed((): ContextualIssue<DocumentIssue | ImportIssue>[] => {
        const analysis: SupportingDocument = this.analysis();
        const extractionIssues: ImportIssue[] = analysis.input?.issues ?? [];
        const signature: ({ code, message, field, evidence }: Pick<ImportIssue, "code" | "message" | "field" | "evidence">) => string = ({ code, message, field, evidence }: Pick<ImportIssue, 'code' | 'message' | 'field' | 'evidence'>): string =>
            JSON.stringify([code, message, field, evidence]);
        const extractionSignatures: Set<string> = new Set(extractionIssues.map(signature));
        return [
            ...analysis.issues.filter((issue: DocumentIssue): boolean => issue.fieldId === null && (issue.sectionId !== null || !extractionSignatures.has(signature(issue))))
                .map((issue: DocumentIssue): ContextualIssue<DocumentIssue> => ({ ...issue, context: this.issueContext(issue) })),
            ...extractionIssues.map((issue: ImportIssue): ContextualIssue<ImportIssue> => ({
                ...issue, context: [issue.severity === 'error' ? 'Error' : 'Warning', issue.pageId && `Page ${this.pageNumber(issue.pageId)}`,
                    issue.field?.replaceAll('-', ' ')].filter(Boolean).join(' · ')
            }))
        ];
    });
    readonly sections: Signal<ISectionView[]> = computed((): ISectionView[] => {
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
        type SourceField = Pick<IFieldView, 'id' | 'label' | 'evidence' | 'confirmedByUser'>;
        const field: (source: SourceField, role: string, values: string[], correction?: IFieldCorrectionView, originalValues?: string[]) => IFieldView =
            (source: SourceField, role: string, values: string[], correction?: IFieldCorrectionView, originalValues?: string[]): IFieldView => {
            const issues: DocumentIssue[] = fieldIssues.get(source.id) ?? [];
            return { ...source, role, values, issues, reviewNeeded: issues.some((issue: DocumentIssue): boolean => documentIssueNeedsReview(issue, analysis)), correction, originalValues };
        };
        const documentId: string | null = this.documentId();
        const corrections: ReadonlyMap<string, DocumentCorrection> | null = this.corrections();
        const canEdit: boolean = documentId !== null && this.correctionsEnabled();
        const originalSections: Map<string, DocumentSection> = new Map((this.original()?.sections ?? analysis.sections).map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]));
        return analysis.sections.map((section: DocumentSection): ISectionView => {
            const original: DocumentSection = originalSections.get(section.sectionId)!;
            const originalAmounts: Map<string, AmountField> = new Map(original.amounts.map((value: AmountField): [string, AmountField] => [value.id, value]));
            const originalDates: Map<string, DateField> = new Map(original.dates.map((value: DateField): [string, DateField] => [value.id, value]));
            const declared: string[] = [...new Set(section.currencies.filter((value: CurrencyField): boolean => value.role === 'settlement')
                .flatMap((value: CurrencyField): string[] => value.candidates))];
            const editable: (
                fieldId: string | null, kind: DocumentCorrectionValue['kind'], role: string, inputValue?: string, currency?: string, fieldRole?: string
            ) => IFieldCorrectionView | undefined = (
                fieldId: string | null, kind: DocumentCorrectionValue['kind'], role: string, inputValue: string = '', currency: string = '', fieldRole?: string
            ): IFieldCorrectionView | undefined => {
                if (!documentId || !this.correctionsEnabled()) {
                    return undefined;
                }
                const target: DocumentCorrectionTarget = { documentId, sectionId: section.sectionId, fieldId };
                const key: string = documentCorrectionKey(target, kind, fieldRole);
                return { target, kind, role, fieldRole, inputValue, currency, key, corrected: corrections?.get(key) };
            };
            const missingFields: IFieldCorrectionView[] = [];
            const missing: Set<string> | undefined = missingBySection.get(section.sectionId);
            if (documentId && this.correctionsEnabled() && missing && section.kind !== 'unknown') {
                const totalRole: "billed-total" | "credit-note-component" = section.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
                if (missing.has('billed-total') && !original.amounts.some((value: AmountField): boolean => value.role === totalRole)) {
                    missingFields.push(editable(null, 'amount', amountRoles[totalRole], '', declared.length === 1 ? declared[0] : '')!);
                }
                if (missing.has('issue') && !original.dates.some((value: DateField): boolean => value.role === 'issue')) {
                    missingFields.push(editable(null, 'date', 'Issue date')!);
                }
            }
            const additional: IFieldCorrectionView[] = canEdit ? missingDocumentCorrectionFields(original).map(
                (slot: ReturnType<typeof missingDocumentCorrectionFields>[number]): IFieldCorrectionView => editable(null, slot.kind, slot.label, '', '', slot.role)!) : [];
            missingFields.push(...additional);
            return {
                id: section.sectionId, kind: kinds[section.kind], evidence: section.evidence, pages: section.pageIds.map((pageId: string): number | "Unknown" => this.pageNumber(pageId)), missingFields,
                fields: [
                    ...section.amounts.filter((value: AmountField): boolean => !documentId || originalAmounts.has(value.id) || value.evidence.length > 0)
                        .map((value: AmountField): IFieldView => {
                            const previous: AmountField | undefined = originalAmounts.get(value.id);
                            const currencies: string[] = [...new Set(value.candidates.flatMap((candidate: AmountCandidate): string[] => candidate.currency ? [candidate.currency] : []))];
                            const currency: string = currencies.length === 1 ? currencies[0] : !currencies.length && declared.length === 1 ? declared[0] : '';
                            const initial: string = value.candidates.length === 1 ? formatAmountEntry(value.candidates[0]) : '';
                            return field(value, amountRoles[value.role], value.candidates.map((candidate: AmountCandidate): string => formatMoney(candidate)),
                                previous ? editable(value.id, 'amount', amountRoles[value.role], initial, currency) : undefined,
                                previous?.candidates.map((candidate: AmountCandidate): string => formatMoney(candidate)));
                        }),
                    ...section.dates.filter((value: DateField): boolean => !documentId || originalDates.has(value.id) || value.evidence.length > 0)
                        .map((value: DateField): IFieldView => {
                            const previous: DateField | undefined = originalDates.get(value.id);
                            return field(value, dateRoles[value.role], value.candidates.map((candidate: string): string => formatCalendarDate(candidate)),
                                previous ? editable(value.id, 'date', dateRoles[value.role], value.candidates.length === 1 ? value.candidates[0] : '') : undefined,
                                previous?.candidates.map((candidate: string): string => formatCalendarDate(candidate)));
                        }),
                    ...section.merchants.filter((value: DocumentSection['merchants'][number]): boolean => !documentId || original.merchants.some((item: DocumentSection['merchants'][number]): boolean => item.id === value.id) || value.evidence.length > 0)
                        .map((value: DocumentSection['merchants'][number]): IFieldView => field(value, 'Merchant', value.candidates,
                            editable(value.id, 'merchant', 'Merchant', value.candidates.length === 1 ? value.candidates[0] : ''),
                            original.merchants.find((item: DocumentSection['merchants'][number]): boolean => item.id === value.id)?.candidates)),
                    ...section.references.filter((value: DocumentSection['references'][number]): boolean => !documentId || original.references.some((item: DocumentSection['references'][number]): boolean => item.id === value.id) || value.evidence.length > 0)
                        .map((value: DocumentSection['references'][number]): IFieldView => field(value, referenceRoles[value.role], value.candidates,
                            editable(value.id, 'reference', referenceRoles[value.role], value.candidates.length === 1 ? value.candidates[0] : '', '', value.role),
                            original.references.find((item: DocumentSection['references'][number]): boolean => item.id === value.id)?.candidates)),
                    ...section.currencies.filter((value: DocumentSection['currencies'][number]): boolean => !documentId || original.currencies.some((item: DocumentSection['currencies'][number]): boolean => item.id === value.id) || value.evidence.length > 0)
                        .map((value: DocumentSection['currencies'][number]): IFieldView => field(value, currencyRoles[value.role], value.candidates,
                            editable(value.id, 'currency', currencyRoles[value.role], value.candidates.length === 1 ? value.candidates[0] : '', '', value.role),
                            original.currencies.find((item: DocumentSection['currencies'][number]): boolean => item.id === value.id)?.candidates))
                ]
            };
        });
    });
    readonly hasFields: Signal<boolean> = computed((): boolean => this.sections().some((section: ISectionView): boolean => section.fields.length > 0));
    private readonly sectionNumbers: Signal<Map<string, number>> = computed((): Map<string, number> => new Map(this.analysis().sections.map((section: DocumentSection, index: number): [string, number] => [section.sectionId, index + 1])));

    readonly extractionLabel: (method: SourceEvidence["method"]) => string = (method: SourceEvidence['method']): string => extractionLabels[method];

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

    decisionActionsId(fieldId: string): string {
        return `field-decision-${this.documentId()}-${fieldId}`;
    }

    setDisposition(sectionId: string, fieldId: string, disposition: DocumentFieldDisposition | null, trigger: WigButtonComponent): void {
        const documentId: string | null = this.documentId();
        if (documentId && !this.busy() && this.confirmationStates().has(fieldId)) {
            const change: FieldDispositionChange = { documentId, sectionId, fieldId, disposition };
            this.edit.set(null);
            this.requestedConfirmation.set(null);
            this.requestedDisposition.set(change);
            this.dispositionTrigger.set(trigger.nativeButton);
            this.disposition.emit(change);
        }
    }

    confirmField(sectionId: string, fieldId: string, confirmed: boolean, trigger: WigButtonComponent): void {
        const documentId: string | null = this.documentId();
        const state: IFieldConfirmationView | undefined = this.confirmationStates().get(fieldId);
        if (documentId && !this.busy() && state && (!confirmed || !state.issue)) {
            this.requestedDisposition.set(null);
            this.requestedConfirmation.set({ documentId, fieldId, confirmed });
            this.confirmationTrigger.set(trigger.nativeButton);
            this.confirmation.emit({ documentId, sectionId, fieldId, confirmed });
        }
    }

    correctedValue(change: DocumentCorrectionValue): string {
        return change.kind === 'amount' ? formatMoney(change.value) : change.kind === 'date' ? formatCalendarDate(change.value) : change.value;
    }

    startCorrection(field: IFieldCorrectionView, trigger: WigButtonComponent): void {
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
        const edit: IFieldEdit | null = this.edit();
        this.edit.set(null);
        edit?.trigger.focus();
    }

    submitFromField(form: HTMLFormElement, event: Event): void {
        if (event instanceof KeyboardEvent && !event.isComposing && event.target instanceof HTMLInputElement) {
            this.applyCorrection(form, event);
        }
    }

    private parseCorrectionValue(editing: IFieldCorrectionEditor, fields: FormData): DocumentCorrectionValue | null {
        const enteredValue: FormDataEntryValue | null = fields.get('value');
        const entered: string = typeof enteredValue === 'string' ? enteredValue.trim() : '';
        if (editing.kind === 'date') {
            const date: ZodSafeParseResult<string> = calendarDateSchema.safeParse(entered);
            if (!date.success) {
                this.correctionError.set('Enter a valid date.'); return null;
            }
            return { kind: 'date', value: date.data };
        }
        if (editing.kind === 'amount') {
            return this.parseAmountCorrection(entered, fields);
        }
        const value: string = editing.kind === 'currency' ? entered.toUpperCase() : entered;
        const parsed: ZodSafeParseResult<DocumentCorrectionValue> = documentCorrectionValueSchema.safeParse({ kind: editing.kind, value,
            ...(editing.kind === 'merchant' ? {} : { role: editing.fieldRole }) });
        if (!parsed.success) {
            this.correctionError.set(editing.kind === 'currency' ? 'Enter a three-letter currency code, for example EUR.' : 'Enter a value for this field.');
            return null;
        }
        return parsed.data;
    }

    private parseAmountCorrection(entered: string, fields: FormData): DocumentCorrectionValue | null {
        const currencyValue: FormDataEntryValue | null = fields.get('currency');
        const currency: string = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : '';
        if (!/^[A-Z]{3}$/.test(currency)) {
            this.correctionError.set('Enter a three-letter currency code, for example EUR.'); return null;
        }
        const amount: Money | null = parseAmountEntry(entered, currency);
        if (!amount) {
            this.correctionError.set(`Enter an amount without grouping separators, for example ${this.amountExample}.`); return null;
        }
        return { kind: 'amount', value: amount };
    }

    applyCorrection(form: HTMLFormElement, event?: Event): void {
        event?.preventDefault();
        const editing: IFieldCorrectionEditor | null = this.editing();
        if (!editing || this.busy()) {
            return;
        }
        const change: DocumentCorrectionValue | null = this.parseCorrectionValue(editing, new FormData(form));
        if (!change) {
            return;
        }
        const previous: DocumentCorrectionValue | undefined = this.corrections()?.get(editing.key)?.change;
        if ((change.kind !== 'amount' && previous?.kind === change.kind && change.value === previous.value) ||
            (change.kind === 'amount' && previous?.kind === 'amount' && sameMoneyValue(change.value, previous.value))) {
            this.correctionError.set('Enter a different value to update this correction.'); return;
        }
        this.correctionError.set(null);
        this.correction.emit({ ...editing.target, change });
    }
}
