import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { type TableConfig, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigDropdownComponent, WigInputComponent, WigTableComponent,
    WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { InputLength } from './app/input-length.js';
import { OriginalPreviewButton } from './app/original-preview-button.js';
import { amountEntryExample, formatAmountEntry, parseAmountEntry } from './shared/amount-entry.js';
import { applyBankCorrections } from './shared/bank-corrections.js';
import { calendarDateSchema, type ImportIssue, type SourceEvidence, type TransactionCandidate, type UnresolvedDraft } from './shared/bank-import.js';
import { formatCalendarDate, formatMoney } from './shared/display.js';
import { sameMoneyValue, type Money } from './shared/money.js';
import type { WorkspaceCommand, WorkspaceState } from './shared/protocol.js';
import { indexStatementOverlaps, type StatementOverlap } from './shared/statement-overlaps.js';
import { excludedDuplicateIds, type DuplicateDecision } from './shared/transaction-duplicates.js';
import type { StoredBankImport } from './shared/workspace-import.js';

type ImportRow = TransactionCandidate | UnresolvedDraft;
type DuplicateAction = Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>['decision'];
type ExclusionAction = Extract<DuplicateAction, 'keep-first' | 'keep-second'>;
type BookingLocation = Pick<StatementOverlap, 'statementId' | 'filePath' | 'transactionId' | 'transactionNumber'>;
interface DuplicatePairView {
    other: BookingLocation;
    evidence: StatementOverlap | null;
    decision: DuplicateDecision | null;
}
function filename(value: string) { return value.split(/[\\/]/).at(-1) || value; }
function directionLabel(value: ImportRow['direction']) { return value === 'incoming' ? 'Incoming' : value === 'outgoing' ? 'Outgoing' : 'Unknown'; }

@Component({
    selector: 'app-row-source', standalone: true, imports: [WigAccordionComponent, WigTemplateDirective],
    template: `
      <wig-accordion #source class="source-details" [items]="sourceItems" [value]="null">
        <ng-template wigTemplate="source">
        @if (source.value()) {
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
        }
        </ng-template>
      </wig-accordion>
    `
})
class RowSource {
    readonly row = input.required<ImportRow>();
    readonly record = input.required<StoredBankImport>();
    readonly sourceItems = [{ id: 'source', header: 'Source details', template: 'source' }];
    readonly date = formatCalendarDate;
    readonly money = formatMoney;
    readonly direction = directionLabel;
    readonly account = computed(() => this.record().result.accountSections.find(section => section.sectionId === this.row().accountSectionId));
    readonly evidenceFields = computed(() => {
        const row = this.row(); const account = this.account();
        const values = [
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
            ...row.references.map(reference => ({ label: reference.label, evidence: reference.evidence }))
        ];
        return values.filter(field => field.evidence.length);
    });
    pageNumber(pageId: string) { return this.record().result.sourceProvenance?.pages.find(page => page.pageId === pageId)?.pageNumber ?? 'Unknown'; }
    region(evidence: SourceEvidence) {
        const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
        const value = evidence.region;
        return `x ${formatter.format(value.x)}, y ${formatter.format(value.y)}, width ${formatter.format(value.width)}, height ${formatter.format(value.height)}`;
    }
}

@Component({ selector: 'app-statement-imports', standalone: true,
    imports: [RowSource, OriginalPreviewButton, WigAccordionComponent, WigAlertComponent, WigButtonComponent, WigDropdownComponent, WigInputComponent,
        WigTableComponent, WigTemplateDirective, InputLength],
    templateUrl: './app/statement-imports.html' })
export class StatementImports {
    readonly state = input.required<WorkspaceState>();
    readonly workspaceCommand = output<WorkspaceCommand>();
    readonly records = signal<StoredBankImport[]>([]);
    readonly loading = signal(false);
    readonly detailsError = signal<string | null>(null);
    readonly selectedId = signal<string | null>(null);
    readonly selected = computed(() => this.records().find(record => record.id === this.selectedId()) ?? null);
    readonly statementInfo = [{ id: 'statement', header: 'Statement details', template: 'statement' }];
    readonly corrections = computed(() => new Map((this.state().workspace?.bankCorrections ?? []).map(correction => [correction.rowId, correction])));
    readonly statementCounts = computed(() => new Map((this.state().workspace?.imports ?? []).map(record => [record.id, record.transactions])));
    readonly statementOptions = computed(() => this.records().map(record => {
        const status = this.state().workspace?.supersededStatements?.includes(record.id) ? 'Archived analysis' :
            record.result.status === 'partial' ? 'Partial import' : 'Complete import';
        return { id: record.id, label: `${filename(record.filePath)} · ${this.statementCounts().get(record.id) ?? record.result.transactions.length} transactions · ${status}` };
    }));
    private readonly effectiveRecords = computed(() => {
        const records = this.records();
        const allCorrections = this.corrections();
        if (!allCorrections.size || !records.length) return records;
        const ids = new Set(records.flatMap(record => [...record.transactions.map(row => row.transactionId), ...record.drafts.map(row => row.draftId)]));
        const corrections = new Map([...allCorrections].filter(([id]) => ids.has(id)));
        return applyBankCorrections(records, corrections);
    });
    readonly displayed = computed(() => this.effectiveRecords().find(record => record.id === this.selectedId()) ?? null);
    readonly displayedStatements = computed(() => {
        const record = this.displayed();
        return record ? [record] : [];
    });
    private readonly overlapIndex = computed(() => {
        const archived = new Set(this.state().workspace?.supersededStatements);
        return indexStatementOverlaps(this.effectiveRecords().filter(record => !archived.has(record.id)));
    });
    readonly overlaps = computed(() => this.overlapIndex()(this.selectedId() ?? ''));
    private readonly expandedOverlapRows = signal<ReadonlySet<string>>(new Set());
    private readonly duplicateDecisions = computed(() => this.state().workspace?.duplicateDecisions ?? []);
    private readonly decisionsByBooking = computed(() => {
        const decisions = new Map<string, DuplicateDecision[]>();
        for (const decision of this.duplicateDecisions()) for (const id of [decision.firstId, decision.secondId]) {
            const existing = decisions.get(id) ?? [];
            existing.push(decision);
            decisions.set(id, existing);
        }
        return decisions;
    });
    readonly excludedBookings = computed(() => excludedDuplicateIds(this.duplicateDecisions()));
    readonly leadingBookings = computed(() => new Set(this.duplicateDecisions().flatMap(decision => decision.primaryId ? [decision.primaryId] : [])));
    readonly duplicateStatus = computed(() => {
        const excluded = this.excludedBookings();
        const leading = this.leadingBookings();
        return new Map([...this.decisionsByBooking().keys()].map(id => [id,
            excluded.has(id) ? 'Excluded duplicate' : leading.has(id) ? 'Leading booking' : 'Duplicate decisions',
        ]));
    });
    private readonly bookingLocations = computed(() => {
        const locations = new Map<string, BookingLocation>();
        for (const record of this.effectiveRecords()) {
            const ids = new Map(record.transactions.map(row => [row.rowId, row.transactionId]));
            for (const [index, row] of record.result.transactions.entries()) {
                const transactionId = ids.get(row.rowId);
                if (transactionId) locations.set(transactionId, { statementId: record.id, filePath: record.filePath, transactionId, transactionNumber: index + 1 });
            }
        }
        return locations;
    });
    readonly expandedDuplicates = computed(() => {
        const expanded = new Map<string, DuplicatePairView[]>();
        for (const id of this.expandedOverlapRows()) {
            const pairs = new Map<string, DuplicatePairView>();
            for (const evidence of this.overlaps().get(id)) pairs.set(evidence.transactionId, { other: evidence, evidence, decision: null });
            for (const decision of this.decisionsByBooking().get(id) ?? []) {
                const otherId = decision.firstId === id ? decision.secondId : decision.firstId;
                const pair = pairs.get(otherId);
                if (pair) pair.decision = decision;
                else {
                    const other = this.bookingLocations().get(otherId);
                    if (other) pairs.set(otherId, { other, evidence: null, decision });
                }
            }
            expanded.set(id, [...pairs.values()]);
        }
        return expanded;
    });
    private readonly exclusion = signal<{ transactionId: string; otherTransactionId: string; revision: number; action: ExclusionAction } | null>(null);
    readonly pendingExclusion = computed(() => {
        const pending = this.exclusion();
        return pending?.revision === this.state().workspace?.matchRevision ? pending : null;
    });
    readonly originalRows = computed(() => {
        const result = this.selected()?.result;
        return new Map<ImportRow['rowId'], ImportRow>([...(result?.transactions ?? []), ...(result?.unresolvedDrafts ?? [])].map(row => [row.rowId, row]));
    });
    readonly rowIds = computed(() => {
        const record = this.selected();
        return new Map([...(record?.transactions ?? []).map(row => [row.rowId, row.transactionId] as const),
            ...(record?.drafts ?? []).map(row => [row.rowId, row.draftId] as const)]);
    });
    readonly hasOriginalTransactions = computed(() => this.displayed()?.result.transactions.some(row => row.reportedOriginalAmount !== null) ?? false);
    readonly hasOriginalDrafts = computed(() => this.displayed()?.result.unresolvedDrafts.some(row => row.reportedOriginalAmount !== null) ?? false);
    readonly transactionColumns = computed(() => this.bookingColumns('Description', this.hasOriginalTransactions()));
    readonly draftColumns = computed(() => this.bookingColumns('Description and issues', this.hasOriginalDrafts()));
    private bookingColumns(description: string, originalAmount: boolean): TableConfig<ImportRow> {
        const columns: TableConfig<ImportRow>['columns'] = [
            { field: 'bookingDate', text: 'Booking date', type: 'custom', template: 'booking-date' },
            { field: 'description', text: description, type: 'custom', template: 'description' },
            { field: 'accountAmount', text: 'Account amount', type: 'custom', template: 'account-amount' },
            { field: 'direction', text: 'Direction', type: 'custom', template: 'direction' }
        ];
        if (originalAmount) columns.push({ field: 'reportedOriginalAmount', text: 'Reported original amount', type: 'custom', template: 'original-amount' });
        return { columns };
    }
    private readonly edit = signal<{ loadRevision: number; recordId: string; rowId: string; originalRevision: number } | null>(null);
    readonly editing = computed(() => {
        const edit = this.edit();
        const record = this.displayed();
        if (!edit || !record || record.id !== edit.recordId || this.state().workspace?.loadRevision !== edit.loadRevision) return null;
        const row = record.result.transactions.find(row => row.rowId === edit.rowId) ?? record.result.unresolvedDrafts.find(row => row.rowId === edit.rowId);
        const original = this.originalRows().get(edit.rowId);
        const id = this.rowIds().get(edit.rowId);
        const currency = record.result.accountSections.find(section => section.sectionId === row?.accountSectionId)?.currency.value;
        return row && original && id && currency ? { ...edit, row, original, id, currency } : null;
    });
    readonly correctionEditor = computed(() => {
        const editing = this.editing();
        return editing ? [editing] : [];
    });
    readonly correctionApplied = computed(() => {
        const editing = this.editing();
        return editing !== null && (this.corrections().get(editing.id)?.revision ?? 0) !== editing.originalRevision;
    });
    readonly correctionError = signal<string | null>(null);
    readonly decimalExample = amountEntryExample;
    readonly amountInput = formatAmountEntry;
    readonly generalIssues = computed(() => {
        const result = this.selected()?.result;
        const shownInDrafts = new Set(result?.unresolvedDrafts.flatMap(row => row.issues).map(issue => JSON.stringify(issue)) ?? []);
        return result?.issues.filter(issue => !shownInDrafts.has(JSON.stringify(issue))) ?? [];
    });
    readonly money = formatMoney;
    readonly date = formatCalendarDate;
    readonly filename = filename;
    readonly direction = directionLabel;
    private recordsKey = '';
    private recordsSnapshot: { workspaceId: string; loadRevision: number; ids: string[] } | null = null;
    private generation = 0;
    private disposed = false;

    constructor() {
        effect(() => {
            const value = this.state();
            const key = this.key(value);
            untracked(() => {
                if (key !== this.recordsKey) this.loadRecords(value, key);
            });
        });
        inject(DestroyRef).onDestroy(() => { this.disposed = true; this.generation++; });
    }
    private key(value: WorkspaceState) { return JSON.stringify([value.workspace?.id ?? null, value.workspace?.loadRevision ?? null, value.workspace?.imports.map(record => record.id) ?? []]); }
    private loadRecords(value: WorkspaceState, key: string) {
        const generation = ++this.generation; const previousSelection = this.selectedId();
        this.recordsKey = key; this.records.set([]); this.detailsError.set(null); this.expandedOverlapRows.set(new Set()); this.exclusion.set(null);
        const ids = value.workspace?.imports.map(record => record.id) ?? [];
        const previous = this.recordsSnapshot; const workspace = value.workspace;
        const appended = previous && workspace && previous.workspaceId === workspace.id && previous.loadRevision === workspace.loadRevision &&
            ids.length > previous.ids.length && previous.ids.every((id, index) => id === ids[index]);
        const outcomeId = value.importOutcome?.status === 'imported' ? value.importOutcome.importId : null;
        const justImported = appended && outcomeId && !previous.ids.includes(outcomeId) && ids.includes(outcomeId) ? outcomeId : null;
        this.recordsSnapshot = workspace ? { workspaceId: workspace.id, loadRevision: workspace.loadRevision, ids } : null;
        if (justImported) this.selectedId.set(justImported);
        this.loading.set(ids.length > 0);
        if (!ids.length) { this.selectedId.set(null); return; }
        void window.receiptmatch.bankImports().then(records => {
            if (this.disposed || generation !== this.generation || key !== this.recordsKey || key !== this.key(this.state())) return;
            if (!Array.isArray(records) || records.length !== ids.length || records.some((record, index) => record.id !== ids[index])) throw new Error('The import report does not match the current workspace.');
            this.records.set(records);
            this.selectedId.set(ids.includes(justImported ?? '') ? justImported : ids.includes(previousSelection ?? '') ? previousSelection : ids[0]);
            this.loading.set(false);
        }).catch(() => {
            if (this.disposed || generation !== this.generation || key !== this.recordsKey || key !== this.key(this.state())) return;
            this.loading.set(false); this.detailsError.set('Statement details could not be loaded. Retry to read the current workspace.');
        });
    }
    retryDetails() { this.loadRecords(this.state(), this.key(this.state())); }
    select(id: string | null) {
        if (this.records().some(record => record.id === id)) {
            this.edit.set(null); this.expandedOverlapRows.set(new Set()); this.exclusion.set(null); this.selectedId.set(id);
        }
    }
    toggleOverlap(id: string, event: Event) {
        const { open } = event.currentTarget as HTMLDetailsElement;
        if (!open && this.exclusion()?.transactionId === id) this.exclusion.set(null);
        this.expandedOverlapRows.update(previous => {
            if (previous.has(id) === open) return previous;
            const next = new Set(previous);
            if (open) next.add(id);
            else next.delete(id);
            return next;
        });
    }
    openOverlap(overlap: BookingLocation) {
        if (this.state().busy || !this.records().some(record => record.id === overlap.statementId)) return;
        this.edit.set(null);
        this.expandedOverlapRows.set(new Set());
        this.exclusion.set(null);
        this.selectedId.set(overlap.statementId);
        requestAnimationFrame(() => {
            if (this.selectedId() === overlap.statementId) document.getElementById('bank-description-' + overlap.transactionId)?.focus();
        });
    }
    chooseDuplicate(transactionId: string, otherTransactionId: string, decision: DuplicateAction) {
        const { workspace, busy } = this.state();
        if (!workspace || busy) return;
        if (decision === 'keep-first' || decision === 'keep-second') {
            this.exclusion.set({ transactionId, otherTransactionId, revision: workspace.matchRevision, action: decision });
            requestAnimationFrame(() => document.getElementById('duplicate-exclusion')?.focus());
            return;
        }
        this.exclusion.set(null);
        this.workspaceCommand.emit({ type: 'set-duplicate-decision', revision: workspace.matchRevision, transactionId, otherTransactionId, decision });
    }
    confirmExclusion() {
        const pending = this.pendingExclusion();
        if (!pending || this.state().busy) return;
        this.exclusion.set(null);
        this.workspaceCommand.emit({ type: 'set-duplicate-decision', revision: pending.revision, transactionId: pending.transactionId,
            otherTransactionId: pending.otherTransactionId, decision: pending.action });
    }
    cancelExclusion() {
        const pending = this.pendingExclusion();
        this.exclusion.set(null);
        if (pending) requestAnimationFrame(() => document.getElementById('duplicate-' + pending.transactionId + '-' + pending.otherTransactionId + '-' + pending.action)?.querySelector('button')?.focus());
    }
    startCorrection(rowId: string) {
        const record = this.selected();
        const workspace = this.state().workspace;
        const id = this.rowIds().get(rowId);
        if (!record || !workspace || !id || this.state().busy) return;
        this.correctionError.set(null);
        this.edit.set({ loadRevision: workspace.loadRevision, recordId: record.id, rowId, originalRevision: this.corrections().get(id)?.revision ?? 0 });
        requestAnimationFrame(() => {
            if (this.editing()?.id === id) document.getElementById('bank-correction-heading')?.focus();
        });
    }
    closeCorrection() {
        const id = this.editing()?.id;
        this.edit.set(null);
        if (id) document.getElementById('bank-correction-' + id)?.querySelector('button')?.focus();
    }
    submitFromField(form: HTMLFormElement, event: Event) {
        if (event instanceof KeyboardEvent && !event.isComposing && event.target instanceof HTMLInputElement) this.applyCorrection(form, event);
    }
    applyCorrection(form: HTMLFormElement, event?: Event) {
        event?.preventDefault();
        const editing = this.editing();
        const workspace = this.state().workspace;
        if (!editing || !workspace || this.state().busy) return;
        const fields = new FormData(form);
        const dateText = String(fields.get('booking-date') ?? '');
        const amountText = String(fields.get('account-amount') ?? '').trim();
        const date = dateText ? calendarDateSchema.safeParse(dateText) : null;
        if (date && !date.success) { this.correctionError.set('Enter a valid booking date.'); return; }
        const amount = amountText ? parseAmountEntry(amountText, editing.currency) : null;
        if (amountText && !amount) {
            this.correctionError.set('Enter an amount without grouping separators, for example ' + this.decimalExample + '.');
            return;
        }
        const bookingDate = date?.data;
        const previousAmount = editing.row.accountAmount?.value;
        if ((!bookingDate && editing.row.bookingDate) || (!amount && previousAmount)) {
            this.correctionError.set('Keep the current value or enter a corrected value.');
            return;
        }
        if (amount && ((editing.original.direction === 'outgoing' && BigInt(amount.coefficient) > 0n) ||
            (editing.original.direction === 'incoming' && BigInt(amount.coefficient) < 0n))) {
            this.correctionError.set(editing.original.direction === 'outgoing' ? 'Use a negative amount for an outgoing payment.' : 'Use a positive amount for an incoming payment.');
            return;
        }
        const changes: { bookingDate?: string; accountAmount?: Money } = {};
        if (bookingDate && bookingDate !== editing.row.bookingDate?.value) changes.bookingDate = bookingDate;
        if (amount && (!previousAmount || !sameMoneyValue(amount, previousAmount))) changes.accountAmount = amount;
        if (!changes.bookingDate && !changes.accountAmount) { this.correctionError.set('Change the booking date or the account amount.'); return; }
        this.correctionError.set(null);
        this.workspaceCommand.emit({ type: 'correct-bank-row', revision: workspace.matchRevision, rowId: editing.id, changes });
    }
    pageNumber(record: StoredBankImport, pageId: string | null) { return record.result.sourceProvenance?.pages.find(page => page.pageId === pageId)?.pageNumber ?? null; }
    issueContext(record: StoredBankImport, issue: ImportIssue) {
        const values: string[] = []; const page = this.pageNumber(record, issue.pageId);
        if (page !== null) values.push(`Page ${page}`);
        const transaction = record.result.transactions.findIndex(row => row.rowId === issue.rowId);
        const draft = record.result.unresolvedDrafts.findIndex(row => row.rowId === issue.rowId);
        if (transaction >= 0) values.push(`Transaction ${transaction + 1}`);
        else if (draft >= 0) values.push(`Draft ${draft + 1}`);
        if (issue.field) values.push(issue.field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' '));
        return values.join(' · ');
    }
    unresolvedIssues(row: UnresolvedDraft) {
        const id = this.rowIds().get(row.rowId);
        const correction = id && this.corrections().get(id);
        if (!correction) return row.issues;
        return row.issues.filter(issue => !(issue.field === 'bookingDate' && correction.bookingDate) && !(issue.field === 'accountAmount' && correction.accountAmount));
    }
    progressText() {
        const current = this.state().statementImport;
        if (!current) return '';
        if (current.cancelling) return 'Cancelling import…';
        const progress = current.progress;
        if (!progress) return 'Choose a PDF statement in the file dialog.';
        const phases = { loading: 'Opening PDF', text: 'Reading PDF text', rendering: 'Preparing page image', ocr: 'Reading page with local English OCR', 'page-complete': 'Page read' };
        const page = progress.pageNumber && progress.pageCount ? ` · Page ${progress.pageNumber} of ${progress.pageCount}` : '';
        return phases[progress.phase] + page;
    }
}
