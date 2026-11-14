import type { MatchApprovalSelection } from "./shared/match-approvals.js";
import type { BankCorrection } from "./shared/bank-corrections.js";
import type { BankImportResult } from "./shared/bank-import.js";
import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked, type WritableSignal, type OutputEmitterRef, type Signal, type InputSignal } from '@angular/core';
import { type TableConfig, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigDrawerComponent, WigDropdownComponent, WigInputComponent, WigTableComponent,
    WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { InputLength } from './app/input-length.js';
import { OriginalPreviewButton } from './app/original-preview-button.js';
import { amountEntryExample, formatAmountEntry, parseAmountEntry } from './shared/amount-entry.js';
import { applyBankCorrections } from './shared/bank-corrections.js';
import { calendarDateSchema, type ImportIssue, type SourceEvidence, type TransactionCandidate, type UnresolvedDraft } from './shared/bank-import.js';
import { formatCalendarDate, formatMoney } from './shared/display.js';
import { sameMoneyValue, type Money } from './shared/money.js';
import type { WorkspaceCommand, WorkspaceState, WorkspaceView } from './shared/protocol.js';
import { indexStatementOverlaps, type StatementOverlap, type StatementOverlaps } from './shared/statement-overlaps.js';
import { excludedDuplicateIds, type DuplicateDecision } from './shared/transaction-duplicates.js';
import type { BankImportSummary, StoredBankImport } from './shared/workspace-import.js';
import type { ExtractionProgress } from './shared/pdf-extraction.js';
import type { ZodSafeParseResult } from 'zod';

type ImportRow = TransactionCandidate | UnresolvedDraft;
type BookingAction = 'correction' | 'source';
type DuplicateAction = Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>['decision'];
type ExclusionAction = Extract<DuplicateAction, 'keep-first' | 'keep-second'>;
type BookingLocation = Pick<StatementOverlap, 'statementId' | 'filePath' | 'transactionId' | 'transactionNumber'>;
interface DuplicatePairView {
    other: BookingLocation;
    evidence: StatementOverlap | null;
    decision: DuplicateDecision | null;
}
function filename(value: string): string {
    const name: string | undefined = value.split(/[\\/]/).at(-1); return name?.length ? name : value;
}

function directionLabel(value: ImportRow['direction']): "Unknown" | "Incoming" | "Outgoing" {
    return value === 'incoming' ? 'Incoming' : value === 'outgoing' ? 'Outgoing' : 'Unknown';
}

@Component({
    selector: 'app-row-source', standalone: true,
    template: `
      <div class="source-detail-body">
        <dl class="source-facts">
          <div><dt>Full description</dt><dd class="raw-text">{{ row().description?.value || 'Unknown' }}</dd></div>
          <div><dt>Booking date</dt><dd>{{ date(row().bookingDate?.value ?? null) }}</dd></div>
          <div><dt>Printed date basis</dt><dd>{{ row().bookingDate?.basisLabel || 'Unknown' }}</dd></div>
          <div><dt>Value date</dt><dd>{{ date(row().valueDate?.value ?? null) }}</dd></div>
          <div><dt>Account amount</dt><dd>{{ money(row().accountAmount?.value ?? null) }}</dd></div>
          <div><dt>Direction</dt><dd>{{ direction(row().direction) }}</dd></div>
          <div><dt>Reported original amount</dt><dd>{{ money(row().reportedOriginalAmount?.value ?? null) }}</dd></div>
          <div><dt>Counterparty candidate</dt><dd>{{ row().counterpartyCandidate?.value || 'Unknown' }}</dd></div>
          <div><dt>Account reference</dt><dd>{{ account()?.accountReference?.value || 'Unknown' }}</dd></div>
          <div><dt>Account currency</dt><dd>{{ account()?.currency?.value || 'Unknown' }}</dd></div>
          <div><dt>Source file</dt><dd class="file-location">{{ record().filePath }}</dd></div>
        </dl>
        <h4>Labeled references</h4>
        @if (row().references.length) {
          <dl class="source-facts">@for (reference of row().references; track $index) { <div><dt>{{ reference.label }}</dt><dd>{{ reference.value }}</dd></div> }</dl>
        } @else { <p class="muted">No labeled references reported.</p> }
        <h4>Source evidence</h4>
        @for (field of evidenceFields(); track $index) {
          <section class="evidence-group" [attr.aria-label]="field.label">
            <h5>{{ field.label }}</h5>
            <ul class="evidence-list">@for (evidence of field.evidence; track $index) {
              <li>
                <p class="evidence-origin">Page {{ pageNumber(evidence.pageId) }} · {{ evidence.method === 'embedded-text' ? 'Embedded text' : 'Local English OCR' }}</p>
                <p class="raw-text">{{ evidence.rawText }}</p>
                <p class="evidence-region">Region in PDF points: {{ region(evidence) }}</p>
              </li>
            }</ul>
          </section>
        }
      </div>
    `
})
class RowSource {
    readonly row: InputSignal<ImportRow> = input.required<ImportRow>();
    readonly record: InputSignal<StoredBankImport> = input.required<StoredBankImport>();
    readonly date: (value: string | null, locale?: string | string[]) => string = formatCalendarDate;
    readonly money: (value: (Omit<Money, "currency"> & { currency: string | null; }) | null, locale?: string | string[]) => string = formatMoney;
    readonly direction: (value: ImportRow["direction"]) => "Unknown" | "Incoming" | "Outgoing" = directionLabel;
    readonly account: Signal<{ sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } | undefined> = computed((): { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } | undefined => this.record().result.accountSections.find((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): boolean => section.sectionId === this.row().accountSectionId));
    readonly evidenceFields: Signal<{ label: string; evidence: SourceEvidence[]  ; }[]> = computed((): { label: string; evidence: SourceEvidence[]  ; }[] => {
        const row: ImportRow = this.row(); const account: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } | undefined = this.account();
        const values: { label: string; evidence: SourceEvidence[]  ; }[] = [
            { label: 'Full row', evidence: row.evidence },
            { label: 'Booking date', evidence: row.bookingDate?.evidence ?? [] },
            { label: 'Value date', evidence: row.valueDate?.evidence ?? [] },
            { label: 'Description', evidence: row.description?.evidence ?? [] },
            { label: 'Account amount', evidence: row.accountAmount?.evidence ?? [] },
            { label: 'Reported original amount', evidence: row.reportedOriginalAmount?.evidence ?? [] },
            { label: 'Counterparty candidate', evidence: row.counterpartyCandidate?.evidence ?? [] },
            { label: 'Account reference', evidence: account?.accountReference?.evidence ?? [] },
            { label: 'Account currency', evidence: account?.currency.evidence ?? [] },
            { label: 'Account section', evidence: account?.evidence ?? [] },
            ...row.references.map((reference: { label: string; value: string; evidence: SourceEvidence[]; }): { label: string; evidence: SourceEvidence[]; } => ({ label: reference.label, evidence: reference.evidence }))
        ];
        return values.filter((field: { label: string; evidence: SourceEvidence[]  ; }): number => field.evidence.length);
    });
    pageNumber(pageId: string): number | "Unknown" {
        return this.record().result.sourceProvenance?.pages.find((page: { pageId: string; pageNumber: number; width: number; height: number; }): boolean => page.pageId === pageId)?.pageNumber ?? 'Unknown';
    }

    region(evidence: SourceEvidence): string {
        const formatter: Intl.NumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
        const value: { x: number; y: number; width: number; height: number; } = evidence.region;
        return `x ${formatter.format(value.x)}, y ${formatter.format(value.y)}, width ${formatter.format(value.width)}, height ${formatter.format(value.height)}`;
    }
}

@Component({ selector: 'app-statement-imports', standalone: true,
    imports: [RowSource, OriginalPreviewButton, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigDrawerComponent, WigDropdownComponent, WigInputComponent,
        WigTableComponent, WigTemplateDirective, InputLength, NgTemplateOutlet],
    templateUrl: './app/statement-imports.html' })
export class StatementImports {
    readonly state: InputSignal<WorkspaceState> = input.required<WorkspaceState>();
    readonly workspaceCommand: OutputEmitterRef<{ type: "get-state"; } | { type: "new"; } | { type: "open"; } | { type: "save"; } | { type: "import-statement"; } | { type: "import-documents"; } | { type: "cancel-import"; } | { type: "rename"; name: string; } | { type: "set-transaction-ignored"; revision: number; transactionId: string; ignored: boolean; remember?: true | undefined; } | { type: "review-match"; revision: number; transactionId: string; review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; }; } | { type: "set-duplicate-decision"; revision: number; transactionId: string; otherTransactionId: string; decision: "separate" | "keep-first" | "keep-second" | "clear"; } | { type: "correct-bank-row"; revision: number; rowId: string; changes: { bookingDate?: string | undefined; accountAmount?: { coefficient: string; currency: string; scale: number; } | undefined; }; } | { change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; fieldId: string | null; type: "correct-document-field"; revision: number; } | { type: "approve-matches"; loadRevision: number; selections: MatchApprovalSelection[]; }> = output<WorkspaceCommand>();
    readonly records: WritableSignal<StoredBankImport[]> = signal<StoredBankImport[]>([]);
    readonly loading: WritableSignal<boolean> = signal(false);
    readonly detailsError: WritableSignal<string | null> = signal<string | null>(null);
    readonly selectedId: WritableSignal<string | null> = signal<string | null>(null);
    readonly selected: Signal<StoredBankImport | null> = computed((): StoredBankImport | null => this.records().find((record: StoredBankImport): boolean => record.id === this.selectedId()) ?? null);
    readonly statementInfo: { id: string; header: string; template: string; }[] = [{ id: 'statement', header: 'Statement details', template: 'statement' }];
    readonly corrections: Signal<Map<string, BankCorrection>> = computed((): Map<string, BankCorrection> => new Map((this.state().workspace?.bankCorrections ?? []).map((correction: BankCorrection): [string, BankCorrection] => [correction.rowId, correction])));
    readonly statementCounts: Signal<Map<string, number>> = computed((): Map<string, number> => new Map((this.state().workspace?.imports ?? []).map((record: BankImportSummary): [string, number] => [record.id, record.transactions])));
    readonly statementOptions: Signal<{ id: string; label: string; }[]> = computed((): { id: string; label: string; }[] => this.records().map((record: StoredBankImport): { id: string; label: string; } => {
        const status: "Archived analysis" | "Partial import" | "Complete import" = this.state().workspace?.supersededStatements?.includes(record.id) ? 'Archived analysis' :
            record.result.status === 'partial' ? 'Partial import' : 'Complete import';
        return { id: record.id, label: `${filename(record.filePath)} · ${this.statementCounts().get(record.id) ?? record.result.transactions.length} transactions · ${status}` };
    }));
    private readonly effectiveRecords: Signal<StoredBankImport[]> = computed((): StoredBankImport[] => {
        const records: StoredBankImport[] = this.records();
        const allCorrections: Map<string, BankCorrection> = this.corrections();
        if (!allCorrections.size || !records.length) {
            return records;
        }
        const ids: Set<string> = new Set(records.flatMap((record: StoredBankImport): string[] => [...record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId), ...record.drafts.map((row: { rowId: string; draftId: string; }): string => row.draftId)]));
        const corrections: Map<string, BankCorrection> = new Map([...allCorrections].filter(([id]: [string, BankCorrection]): boolean => ids.has(id)));
        return applyBankCorrections(records, corrections);
    });
    readonly displayed: Signal<StoredBankImport | null> = computed((): StoredBankImport | null => this.effectiveRecords().find((record: StoredBankImport): boolean => record.id === this.selectedId()) ?? null);
    readonly displayedStatements: Signal<StoredBankImport[]> = computed((): StoredBankImport[] => {
        const record: StoredBankImport | null = this.displayed();
        return record ? [record] : [];
    });
    private readonly overlapIndex: Signal<(statementId: string) => StatementOverlaps> = computed((): (statementId: string) => StatementOverlaps => {
        const archived: Set<string> = new Set(this.state().workspace?.supersededStatements);
        return indexStatementOverlaps(this.effectiveRecords().filter((record: StoredBankImport): boolean => !archived.has(record.id)));
    });
    readonly overlaps: Signal<StatementOverlaps> = computed((): StatementOverlaps => this.overlapIndex()(this.selectedId() ?? ''));
    private readonly expandedOverlapRows: WritableSignal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
    private readonly duplicateDecisions: Signal<DuplicateDecision[]> = computed((): DuplicateDecision[] => this.state().workspace?.duplicateDecisions ?? []);
    private readonly decisionsByBooking: Signal<Map<string, DuplicateDecision[]>> = computed((): Map<string, DuplicateDecision[]> => {
        const decisions: Map<string, DuplicateDecision[]> = new Map<string, DuplicateDecision[]>();
        for (const decision of this.duplicateDecisions()) {
            for (const id of [decision.firstId, decision.secondId]) {
            const existing: DuplicateDecision[] = decisions.get(id) ?? [];
            existing.push(decision);
            decisions.set(id, existing);
        }
        }
        return decisions;
    });
    readonly excludedBookings: Signal<Set<string>> = computed((): Set<string> => excludedDuplicateIds(this.duplicateDecisions()));
    readonly leadingBookings: Signal<Set<string>> = computed((): Set<string> => new Set(this.duplicateDecisions().flatMap((decision: DuplicateDecision): string[] => decision.primaryId ? [decision.primaryId] : [])));
    readonly duplicateStatus: Signal<Map<string, string>> = computed((): Map<string, string> => {
        const excluded: Set<string> = this.excludedBookings();
        const leading: Set<string> = this.leadingBookings();
        return new Map([...this.decisionsByBooking().keys()].map((id: string): [string, string] => [id,
            excluded.has(id) ? 'Excluded duplicate' : leading.has(id) ? 'Leading booking' : 'Duplicate decisions',
        ]));
    });
    private readonly bookingLocations: Signal<Map<string, BookingLocation>> = computed((): Map<string, BookingLocation> => {
        const locations: Map<string, BookingLocation> = new Map<string, BookingLocation>();
        for (const record of this.effectiveRecords()) {
            const ids: Map<string, string> = new Map(record.transactions.map((row: { rowId: string; transactionId: string; }): [string, string] => [row.rowId, row.transactionId]));
            for (const [index, row] of record.result.transactions.entries()) {
                const transactionId: string | undefined = ids.get(row.rowId);
                if (transactionId) {
                    locations.set(transactionId, { statementId: record.id, filePath: record.filePath, transactionId, transactionNumber: index + 1 });
                }
            }
        }
        return locations;
    });
    readonly expandedDuplicates: Signal<Map<string, DuplicatePairView[]>> = computed((): Map<string, DuplicatePairView[]> => {
        const expanded: Map<string, DuplicatePairView[]> = new Map<string, DuplicatePairView[]>();
        for (const id of this.expandedOverlapRows()) {
            expanded.set(id, this.duplicatePairs(id));
        }
        return expanded;
    });

    private duplicatePairs(id: string): DuplicatePairView[] {
        const pairs: Map<string, DuplicatePairView> = new Map<string, DuplicatePairView>();
        for (const evidence of this.overlaps().get(id)) {
            pairs.set(evidence.transactionId, { other: evidence, evidence, decision: null });
        }
        for (const decision of this.decisionsByBooking().get(id) ?? []) {
            const otherId: string = decision.firstId === id ? decision.secondId : decision.firstId;
            const pair: DuplicatePairView | undefined = pairs.get(otherId);
            if (pair) {
                pair.decision = decision;
            } else {
                const other: BookingLocation | undefined = this.bookingLocations().get(otherId);
                if (other) {
                    pairs.set(otherId, { other, evidence: null, decision });
                }
            }
        }
        return [...pairs.values()];
    }

    private readonly exclusion: WritableSignal<{ transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null> = signal<{ transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction } | null>(null);
    readonly pendingExclusion: Signal<{ transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null> = computed((): { transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null => {
        const pending: { transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null = this.exclusion();
        return pending?.revision === this.state().workspace?.matchRevision ? pending : null;
    });
    readonly originalRows: Signal<Map<string, ImportRow>> = computed((): Map<string, ImportRow> => {
        const result: BankImportResult | undefined = this.selected()?.result;
        return new Map<ImportRow['rowId'], ImportRow>([...(result?.transactions ?? []), ...(result?.unresolvedDrafts ?? [])].map((row: TransactionCandidate | UnresolvedDraft): [string, TransactionCandidate | UnresolvedDraft] => [row.rowId, row]));
    });
    readonly rowIds: Signal<Map<string, string>> = computed((): Map<string, string> => {
        const record: StoredBankImport | null = this.selected();
        return new Map([...(record?.transactions ?? []).map((row: { rowId: string; transactionId: string; }): readonly [string, string] => [row.rowId, row.transactionId] as const),
            ...(record?.drafts ?? []).map((row: { rowId: string; draftId: string; }): readonly [string, string] => [row.rowId, row.draftId] as const)]);
    });
    readonly hasOriginalTransactions: Signal<boolean> = computed((): boolean => this.displayed()?.result.transactions.some((row: TransactionCandidate): boolean => row.reportedOriginalAmount !== null) ?? false);
    readonly hasOriginalDrafts: Signal<boolean> = computed((): boolean => this.displayed()?.result.unresolvedDrafts.some((row: UnresolvedDraft): boolean => row.reportedOriginalAmount !== null) ?? false);
    readonly transactionColumns: Signal<TableConfig<ImportRow>> = computed((): TableConfig<ImportRow> => this.bookingColumns('Description', this.hasOriginalTransactions()));
    readonly draftColumns: Signal<TableConfig<ImportRow>> = computed((): TableConfig<ImportRow> => this.bookingColumns('Description and issues', this.hasOriginalDrafts()));
    private bookingColumns(description: string, originalAmount: boolean): TableConfig<ImportRow> {
        const columns: TableConfig<ImportRow>['columns'] = [
            { field: 'bookingDate', text: 'Booking date', type: 'custom', template: 'booking-date' },
            { field: 'description', text: description, type: 'custom', template: 'description' },
            { field: 'accountAmount', text: 'Account amount', type: 'custom', template: 'account-amount' },
            { field: 'direction', text: 'Direction', type: 'custom', template: 'direction' }
        ];
        if (originalAmount) {
            columns.push({ field: 'reportedOriginalAmount', text: 'Reported original amount', type: 'custom', template: 'original-amount' });
        }
        columns.push({ field: 'rowId', text: 'Actions', type: 'custom', template: 'actions' });
        return { columns };
    }
    private readonly bookingAction: WritableSignal<{ mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null> = signal<{ mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number } | null>(null);
    readonly activeBookingAction: Signal<{ mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null> = computed((): { mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null => {
        const action: { mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.bookingAction();
        return this.selectedId() === action?.recordId && this.state().workspace?.loadRevision === action.loadRevision ? action : null;
    });
    readonly sourceRow: Signal<ImportRow | undefined> = computed((): ImportRow | undefined => {
        const action: { mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.activeBookingAction();
        return action?.mode === 'source' ? this.originalRows().get(action.rowId) : undefined;
    });
    readonly editing: Signal<{ row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null> = computed((): { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null => {
        const edit: { mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.activeBookingAction();
        const record: StoredBankImport | null = this.displayed();
        if (edit?.mode !== 'correction' || !record) {
            return null;
        }
        const row: TransactionCandidate | UnresolvedDraft | undefined = record.result.transactions.find((row: TransactionCandidate): boolean => row.rowId === edit.rowId) ?? record.result.unresolvedDrafts.find((row: UnresolvedDraft): boolean => row.rowId === edit.rowId);
        const original: ImportRow | undefined = this.originalRows().get(edit.rowId);
        const id: string | undefined = this.rowIds().get(edit.rowId);
        const currency: string | undefined = record.result.accountSections.find((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): boolean => section.sectionId === row?.accountSectionId)?.currency.value;
        return row && original && id && currency ? { ...edit, row, original, id, currency } : null;
    });
    readonly correctionEditor: Signal<{ row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; }[]> = computed((): { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; }[] => {
        const editing: { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.editing();
        return editing ? [editing] : [];
    });
    readonly correctionApplied: Signal<boolean> = computed((): boolean => {
        const editing: { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.editing();
        return editing !== null && (this.corrections().get(editing.id)?.revision ?? 0) !== editing.originalRevision;
    });
    readonly correctionError: WritableSignal<string | null> = signal<string | null>(null);
    readonly decimalExample: string = amountEntryExample;
    readonly amountInput: (value: Pick<Money, "coefficient" | "scale"> | undefined, separator?: string) => string = formatAmountEntry;
    readonly generalIssues: Signal<ImportIssue[]> = computed((): ImportIssue[] => {
        const result: BankImportResult | undefined = this.selected()?.result;
        const shownInDrafts: Set<string> = new Set(result?.unresolvedDrafts.flatMap((row: UnresolvedDraft): ImportIssue[] => row.issues).map((issue: ImportIssue): string => JSON.stringify(issue)) ?? []);
        return result?.issues.filter((issue: ImportIssue): boolean => !shownInDrafts.has(JSON.stringify(issue))) ?? [];
    });
    readonly money: (value: (Omit<Money, "currency"> & { currency: string | null; }) | null, locale?: string | string[]) => string = formatMoney;
    readonly date: (value: string | null, locale?: string | string[]) => string = formatCalendarDate;
    readonly filename: (value: string) => string = filename;
    readonly direction: (value: ImportRow["direction"]) => "Unknown" | "Incoming" | "Outgoing" = directionLabel;
    private recordsKey: string = '';
    private recordsSnapshot: { workspaceId: string; loadRevision: number; ids: string[] } | null = null;
    private generation: number = 0;
    private disposed: boolean = false;

    constructor() {
        effect((): void => {
            const value: WorkspaceState = this.state();
            const key: string = this.key(value);
            untracked((): void => {
                if (key !== this.recordsKey) {
                    this.loadRecords(value, key);
                }
            });
        });

        inject(DestroyRef).onDestroy((): void => {
            this.disposed = true; this.generation++;
        });
    }

    private key(value: WorkspaceState): string {
        return JSON.stringify([value.workspace?.id ?? null, value.workspace?.loadRevision ?? null, value.workspace?.imports.map((record: BankImportSummary): string => record.id) ?? []]);
    }

    private loadRecords(value: WorkspaceState, key: string): void {
        const generation: number = ++this.generation; const previousSelection: string | null = this.selectedId();
        this.recordsKey = key; this.records.set([]); this.detailsError.set(null); this.expandedOverlapRows.set(new Set()); this.exclusion.set(null);
        const ids: string[] = value.workspace?.imports.map((record: BankImportSummary): string => record.id) ?? [];
        const previous: { workspaceId: string; loadRevision: number; ids: string[]; } | null = this.recordsSnapshot; const workspace: WorkspaceView | null = value.workspace;
        const appended: boolean | null = previous && previous.workspaceId === workspace?.id && previous.loadRevision === workspace.loadRevision &&
            ids.length > previous.ids.length && previous.ids.every((id: string, index: number): boolean => id === ids[index]);
        const outcomeId: string | null = value.importOutcome?.status === 'imported' ? value.importOutcome.importId : null;
        const justImported: string | null = appended && previous && outcomeId && !previous.ids.includes(outcomeId) && ids.includes(outcomeId) ? outcomeId : null;
        this.recordsSnapshot = workspace ? { workspaceId: workspace.id, loadRevision: workspace.loadRevision, ids } : null;
        if (justImported) {
            this.selectedId.set(justImported);
        }
        this.loading.set(ids.length > 0);
        if (!ids.length) {
            this.selectedId.set(null); return;
        }
        void window.receiptmatch.bankImports().then((records: StoredBankImport[]): void => {
            if (this.disposed || generation !== this.generation || key !== this.recordsKey || key !== this.key(this.state())) {
                return;
            }
            if (!Array.isArray(records) || records.length !== ids.length || records.some((record: StoredBankImport, index: number): boolean => record.id !== ids[index])) {
                throw new Error('The import report does not match the current workspace.');
            }
            this.records.set(records);
            this.selectedId.set(ids.includes(justImported ?? '') ? justImported : ids.includes(previousSelection ?? '') ? previousSelection : ids[0]);
            this.loading.set(false);
        }).catch((): void => {
            if (this.disposed || generation !== this.generation || key !== this.recordsKey || key !== this.key(this.state())) {
                return;
            }
            this.loading.set(false); this.detailsError.set('Statement details could not be loaded. Retry to read the current workspace.');
        });
    }

    retryDetails(): void {
        this.loadRecords(this.state(), this.key(this.state()));
    }

    select(id: string | null): void {
        if (this.records().some((record: StoredBankImport): boolean => record.id === id)) {
            this.bookingAction.set(null); this.expandedOverlapRows.set(new Set()); this.exclusion.set(null); this.selectedId.set(id);
        }
    }

    toggleOverlap(id: string, event: Event): void {
        const { open }: HTMLDetailsElement = event.currentTarget as HTMLDetailsElement;
        if (!open && this.exclusion()?.transactionId === id) {
            this.exclusion.set(null);
        }
        this.expandedOverlapRows.update((previous: ReadonlySet<string>): ReadonlySet<string> => {
            if (previous.has(id) === open) {
                return previous;
            }
            const next: Set<string> = new Set(previous);
            if (open) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }

    openOverlap(overlap: BookingLocation): void {
        if (this.state().busy || !this.records().some((record: StoredBankImport): boolean => record.id === overlap.statementId)) {
            return;
        }
        this.bookingAction.set(null);
        this.expandedOverlapRows.set(new Set());
        this.exclusion.set(null);
        this.selectedId.set(overlap.statementId);
        requestAnimationFrame((): void => {
            if (this.selectedId() === overlap.statementId) {
                document.getElementById('bank-description-' + overlap.transactionId)?.focus();
            }
        });
    }

    chooseDuplicate(transactionId: string, otherTransactionId: string, decision: DuplicateAction): void {
        const { workspace, busy }: WorkspaceState = this.state();
        if (!workspace || busy) {
            return;
        }
        if (decision === 'keep-first' || decision === 'keep-second') {
            this.exclusion.set({ transactionId, otherTransactionId, revision: workspace.matchRevision, action: decision });
            requestAnimationFrame((): void | undefined => document.getElementById('duplicate-exclusion')?.focus());
            return;
        }
        this.exclusion.set(null);
        this.workspaceCommand.emit({ type: 'set-duplicate-decision', revision: workspace.matchRevision, transactionId, otherTransactionId, decision });
    }

    confirmExclusion(): void {
        const pending: { transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null = this.pendingExclusion();
        if (!pending || this.state().busy) {
            return;
        }
        this.exclusion.set(null);
        this.workspaceCommand.emit({ type: 'set-duplicate-decision', revision: pending.revision, transactionId: pending.transactionId,
            otherTransactionId: pending.otherTransactionId, decision: pending.action });
    }

    cancelExclusion(): void {
        const pending: { transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction; } | null = this.pendingExclusion();
        this.exclusion.set(null);
        if (pending) {
            requestAnimationFrame((): void | undefined => document.getElementById('duplicate-' + pending.transactionId + '-' + pending.otherTransactionId + '-' + pending.action)?.querySelector('button')?.focus());
        }
    }

    openBookingAction(mode: BookingAction, rowId: string): void {
        const record: StoredBankImport | null = this.selected();
        const workspace: WorkspaceView | null = this.state().workspace;
        const id: string | undefined = this.rowIds().get(rowId);
        if (!record || !workspace || !id || (mode === 'correction' && this.state().busy)) {
            return;
        }
        this.correctionError.set(null);
        this.bookingAction.set({ mode, loadRevision: workspace.loadRevision, recordId: record.id, rowId, originalRevision: this.corrections().get(id)?.revision ?? 0 });
    }

    closeBookingAction(): void {
        const editing: { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.editing();
        this.bookingAction.set(null);
        if (editing && this.corrections().get(editing.id)?.revision !== editing.originalRevision) {
            requestAnimationFrame((): void => {
                if (document.activeElement === document.body) {
                    document.getElementById('bank-correction-' + editing.id)?.querySelector('button')?.focus();
                }
            });
        }
    }

    submitFromField(form: HTMLFormElement, event: Event): void {
        if (event instanceof KeyboardEvent && !event.isComposing && event.target instanceof HTMLInputElement) {
            this.applyCorrection(form, event);
        }
    }

    applyCorrection(form: HTMLFormElement, event?: Event): void {
        event?.preventDefault();
        const editing: { row: TransactionCandidate | UnresolvedDraft; original: ImportRow; id: string; currency: string; mode: BookingAction; loadRevision: number; recordId: string; rowId: string; originalRevision: number; } | null = this.editing();
        const workspace: WorkspaceView | null = this.state().workspace;
        if (!editing || !workspace || this.state().busy) {
            return;
        }
        const values: { bookingDate: string | undefined; amount: Money | null; previousAmount: Money | undefined } | null =
            this.readCorrectionValues(form, editing.row, editing.original.direction, editing.currency);
        if (!values) {
            return;
        }
        const { bookingDate, amount, previousAmount }: { bookingDate: string | undefined; amount: Money | null; previousAmount: Money | undefined } = values;
        const changes: { bookingDate?: string; accountAmount?: Money } = {};
        if (bookingDate && bookingDate !== editing.row.bookingDate?.value) {
            changes.bookingDate = bookingDate;
        }
        if (amount && (!previousAmount || !sameMoneyValue(amount, previousAmount))) {
            changes.accountAmount = amount;
        }
        if (!changes.bookingDate && !changes.accountAmount) {
            this.correctionError.set('Change the booking date or the account amount.'); return;
        }
        this.correctionError.set(null);
        this.workspaceCommand.emit({ type: 'correct-bank-row', revision: workspace.matchRevision, rowId: editing.id, changes });
    }

    private validateCorrectionDirection(amount: Money, direction: ImportRow['direction']): boolean {
        if (((direction === 'outgoing' && BigInt(amount.coefficient) > 0n) ||
            (direction === 'incoming' && BigInt(amount.coefficient) < 0n))) {
            this.correctionError.set(direction === 'outgoing' ? 'Use a negative amount for an outgoing payment.' : 'Use a positive amount for an incoming payment.');
            return false;
        }
        return true;
    }

    private readCorrectionValues(form: HTMLFormElement, row: ImportRow, direction: ImportRow['direction'], currency: string):
        { bookingDate: string | undefined; amount: Money | null; previousAmount: Money | undefined } | null {
        const fields: FormData = new FormData(form);
        const dateValue: FormDataEntryValue | null = fields.get('booking-date');
        const dateText: string = typeof dateValue === 'string' ? dateValue : '';
        const amountValue: FormDataEntryValue | null = fields.get('account-amount');
        const amountText: string = typeof amountValue === 'string' ? amountValue.trim() : '';
        const date: ZodSafeParseResult<string> | null = dateText ? calendarDateSchema.safeParse(dateText) : null;
        if (date && !date.success) {
            this.correctionError.set('Enter a valid booking date.'); return null;
        }
        const amount: { coefficient: string; currency: string; scale: number; } | null = amountText ? parseAmountEntry(amountText, currency) : null;
        if (amountText && !amount) {
            this.correctionError.set('Enter an amount without grouping separators, for example ' + this.decimalExample + '.');
            return null;
        }
        const bookingDate: string | undefined = date?.data;
        const previousAmount: { coefficient: string; currency: string; scale: number; }   | undefined = row.accountAmount?.value;
        if ((!bookingDate && row.bookingDate) || (!amount && previousAmount)) {
            this.correctionError.set('Keep the current value or enter a corrected value.');
            return null;
        }
        if (amount && !this.validateCorrectionDirection(amount, direction)) {
            return null;
        }
        return { bookingDate, amount, previousAmount };
    }

    pageNumber(record: StoredBankImport, pageId: string | null): number | null {
        return record.result.sourceProvenance?.pages.find((page: { pageId: string; pageNumber: number; width: number; height: number; }): boolean => page.pageId === pageId)?.pageNumber ?? null;
    }

    issueContext(record: StoredBankImport, issue: ImportIssue): string {
        const values: string[] = []; const page: number | null = this.pageNumber(record, issue.pageId);
        if (page !== null) {
            values.push(`Page ${page}`);
        }
        const transaction: number = record.result.transactions.findIndex((row: TransactionCandidate): boolean => row.rowId === issue.rowId);
        const draft: number = record.result.unresolvedDrafts.findIndex((row: UnresolvedDraft): boolean => row.rowId === issue.rowId);
        if (transaction >= 0) {
            values.push(`Transaction ${transaction + 1}`);
        } else if (draft >= 0) {
            values.push(`Draft ${draft + 1}`);
        }
        if (issue.field) {
            values.push(issue.field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' '));
        }
        return values.join(' · ');
    }

    unresolvedIssues(row: UnresolvedDraft): ImportIssue[] {
        const id: string | undefined = this.rowIds().get(row.rowId);
        const correction: "" | BankCorrection | undefined = id && this.corrections().get(id);
        if (!correction) {
            return row.issues;
        }
        return row.issues.filter((issue: ImportIssue): boolean => !(issue.field === 'bookingDate' && correction.bookingDate) && !(issue.field === 'accountAmount' && correction.accountAmount));
    }

    progressText(): string {
        const current: { cancelling: boolean; progress: ExtractionProgress | null; } | null = this.state().statementImport;
        if (!current) {
            return '';
        }
        if (current.cancelling) {
            return 'Cancelling import…';
        }
        const progress: ExtractionProgress | null = current.progress;
        if (!progress) {
            return 'Choose a PDF statement in the file dialog.';
        }
        const phases: { loading: string; text: string; rendering: string; ocr: string; 'page-complete': string; } = { loading: 'Opening PDF', text: 'Reading PDF text', rendering: 'Preparing page image', ocr: 'Reading page with local English OCR', 'page-complete': 'Page read' };
        const page: string = progress.pageNumber && progress.pageCount ? ` · Page ${progress.pageNumber} of ${progress.pageCount}` : '';
        return phases[progress.phase] + page;
    }
}
