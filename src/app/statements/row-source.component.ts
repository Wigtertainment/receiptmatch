import { Component, computed, input, type InputSignal, type Signal } from '@angular/core';
import type { SourceEvidence } from '../../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../../shared/display.js';
import type { StoredBankImport } from '../../shared/workspace-import.js';
import { directionLabel, type ImportRow } from './statement-row.js';

type RowSourceRecord = Pick<StoredBankImport, 'filePath' | 'result'>;
type AccountSection = RowSourceRecord['result']['accountSections'][number];
type SourcePage = NonNullable<RowSourceRecord['result']['sourceProvenance']>['pages'][number];
interface IEvidenceField { label: string; evidence: SourceEvidence[] }

@Component({
    selector: 'app-row-source', standalone: true,
    templateUrl: './row-source.component.html'
})
export class RowSource {
    readonly row: InputSignal<ImportRow> = input.required<ImportRow>();
    readonly record: InputSignal<RowSourceRecord> = input.required<RowSourceRecord>();
    readonly date: (value: string | null, locale?: string | string[]) => string = formatCalendarDate;
    readonly money: typeof formatMoney = formatMoney;
    readonly direction: (value: ImportRow["direction"]) => "Unknown" | "Incoming" | "Outgoing" = directionLabel;
    readonly account: Signal<AccountSection | undefined> = computed((): AccountSection | undefined =>
        this.record().result.accountSections.find((section: AccountSection): boolean => section.sectionId === this.row().accountSectionId));
    readonly evidenceFields: Signal<IEvidenceField[]> = computed((): IEvidenceField[] => {
        const row: ImportRow = this.row(); const account: AccountSection | undefined = this.account();
        const values: IEvidenceField[] = [
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
            ...row.references.map((reference: ImportRow['references'][number]): IEvidenceField => ({ label: reference.label, evidence: reference.evidence }))
        ];
        return values.filter((field: IEvidenceField): number => field.evidence.length);
    });
    pageNumber(pageId: string): number | "Unknown" {
        return this.record().result.sourceProvenance?.pages.find((page: SourcePage): boolean => page.pageId === pageId)?.pageNumber ?? 'Unknown';
    }

    region(evidence: SourceEvidence): string {
        const formatter: Intl.NumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
        const value: SourceEvidence['region'] = evidence.region;
        return `x ${formatter.format(value.x)}, y ${formatter.format(value.y)}, width ${formatter.format(value.width)}, height ${formatter.format(value.height)}`;
    }
}
