import { Component, input, type InputSignal } from '@angular/core';
import type { BankImportResult } from '../../shared/bank-import.js';
import { formatCalendarDate, formatMoney } from '../../shared/display.js';
import type { IStatementAiRow } from '../../shared/statement-ai.js';

@Component({ selector: 'app-analysis-booking', standalone: true, templateUrl: './analysis-booking.component.html' })
export class AnalysisBooking {
    readonly item: InputSignal<IStatementAiRow | null> = input.required<IStatementAiRow | null>();
    readonly result: InputSignal<BankImportResult> = input.required<BankImportResult>();
    readonly date: typeof formatCalendarDate = formatCalendarDate;
    readonly money: typeof formatMoney = formatMoney;

    pageNumber(id: string): number | string {
        return this.result().sourceProvenance?.pages.find((page: NonNullable<BankImportResult['sourceProvenance']>['pages'][number]): boolean => page.pageId === id)?.pageNumber ?? 'Unknown';
    }
}
