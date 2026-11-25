import { Component, computed, input, type InputSignal, type Signal } from '@angular/core';
import type { SourceEvidence } from '../../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../../shared/display.js';
import type { Money } from '../../shared/money.js';
import type { StoredBankImport } from '../../shared/workspace-import.js';
import { directionLabel, type ImportRow } from './statement-row.js';

type RowSourceRecord = Pick<StoredBankImport, 'filePath' | 'result'>;

@Component({
    selector: 'app-row-source', standalone: true,
    templateUrl: './row-source.component.html'
})
export class RowSource {
    readonly row: InputSignal<ImportRow> = input.required<ImportRow>();
    readonly record: InputSignal<RowSourceRecord> = input.required<RowSourceRecord>();
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
