import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { ImportIssue, SourceEvidence, TransactionCandidate, UnresolvedDraft } from './shared/bank-import.js';
import { formatCalendarDate, formatMoney } from './shared/display.js';
import type { WorkspaceCommand, WorkspaceState } from './shared/protocol.js';
import type { StoredBankImport } from './shared/workspace-import.js';

type ImportRow = TransactionCandidate | UnresolvedDraft;
function filename(value: string) { return value.split(/[\\/]/).at(-1) || value; }
function directionLabel(value: ImportRow['direction']) { return value === 'incoming' ? 'Incoming' : value === 'outgoing' ? 'Outgoing' : 'Unknown'; }

@Component({
    selector: 'app-row-source', standalone: true,
    template: `
      <details class="source-details" (toggle)="toggle($event)">
        <summary>Source details</summary>
        @if (opened()) {
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
      </details>
    `
})
class RowSource {
    readonly row = input.required<ImportRow>();
    readonly record = input.required<StoredBankImport>();
    readonly opened = signal(false);
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
    toggle(event: Event) { this.opened.set((event.target as HTMLDetailsElement).open); }
    pageNumber(pageId: string) { return this.record().result.sourceProvenance?.pages.find(page => page.pageId === pageId)?.pageNumber ?? 'Unknown'; }
    region(evidence: SourceEvidence) {
        const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
        const value = evidence.region;
        return `x ${formatter.format(value.x)}, y ${formatter.format(value.y)}, width ${formatter.format(value.width)}, height ${formatter.format(value.height)}`;
    }
}

@Component({ selector: 'app-statement-imports', standalone: true, imports: [RowSource], templateUrl: './app/statement-imports.html' })
export class StatementImports {
    readonly state = input.required<WorkspaceState>();
    readonly workspaceCommand = output<WorkspaceCommand>();
    readonly records = signal<StoredBankImport[]>([]);
    readonly loading = signal(false);
    readonly detailsError = signal<string | null>(null);
    readonly selectedId = signal<string | null>(null);
    readonly selected = computed(() => this.records().find(record => record.id === this.selectedId()) ?? null);
    readonly hasOriginalTransactions = computed(() => this.selected()?.result.transactions.some(row => row.reportedOriginalAmount !== null) ?? false);
    readonly hasOriginalDrafts = computed(() => this.selected()?.result.unresolvedDrafts.some(row => row.reportedOriginalAmount !== null) ?? false);
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
        this.recordsKey = key; this.records.set([]); this.detailsError.set(null);
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
    select(event: Event) {
        const id = (event.target as HTMLSelectElement).value;
        if (this.records().some(record => record.id === id)) this.selectedId.set(id);
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
