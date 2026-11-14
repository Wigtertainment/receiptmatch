import type { ImportPage } from "../../src/shared/bank-import.js";
import type { BankImportInput, PositionedSpan } from '../../src/shared/bank-import.js';
import { emptyPage, span } from './bank-fixtures.js';

// Independently invented values and text; these fixtures contain no user statement data.
export function airwallexHeader(y: number = 200): PositionedSpan[] {
    return [span('Date', 40, y, 25), span('Details', 110, y, 35), span('Credit', 320, y, 35), span('Debit', 410, y, 30), span('Balance', 500, y, 45)];
}

export interface AirwallexFixtureRow {
    y: number;
    date?: string;
    kind?: string;
    details?: string[];
    credit?: string;
    debit?: string;
    balance?: string;
}

export function airwallexRow(options: AirwallexFixtureRow): PositionedSpan[] {
    const { y, date = 'Mar 01 2032', kind = 'Card', details = ['Lantern Supplies, USA,', '(Main Card, **0000): USD 18.07'], credit, debit, balance = '980.50 EUR' }: AirwallexFixtureRow = options;
    return [
        ...(kind ? [span(kind, 110, y, 80)] : []),
        ...details.filter(Boolean).map((text: string, index: number): PositionedSpan => span(text, 110, y + 12 * (index + 1), 195)),
        ...(date ? [span(date, 40, y + 24, 65)] : []),
        ...(credit ? [span(credit, 310, y + 24, 65)] : []),
        ...(debit ? [span(debit, 400, y + 24, 75)] : []),
        ...(balance ? [span(balance, 490, y + 24, 80)] : [])
    ];
}

export function airwallexStatement(): BankImportInput {
    const first: ImportPage = emptyPage(1);
    first.spans = [
        span('Web: airwallex.com', 400, 30, 150),
        span('Account Holder', 40, 70, 90),
        span('Example Lantern Studio', 40, 85, 160),
        span('Account Details', 350, 70, 95),
        span('IBAN: XX00 SYNTHETIC ONLY', 350, 85, 200),
        span('EUR Account Summary', 40, 115, 150),
        span('Starting balance on Mar 01 2032 996.93 EUR', 40, 135, 270),
        span('EUR Account Activity', 40, 170, 150),
        ...airwallexHeader(),
        span('Starting balance', 110, 218, 100), span('996.93 EUR', 490, 218, 80),
        ...airwallexRow({ y: 245, debit: '16.43 EUR', details: ['Lantern Supplies, USA,', '(Main Card, **0000): USD 18.07', '1 EUR = 1.100000 USD'] }),
        ...airwallexRow({ y: 330, date: 'Mar 02 2032', kind: 'Payout', details: ['Pay EUR 13.07 to Silver Birch', 'Workshop'], debit: '13.07 EUR', balance: '967.43 EUR' }),
        span('Page 1 of 3', 500, 790, 70)
    ];
    const second: ImportPage = emptyPage(2);
    second.spans = [
        span('Web: airwallex.com', 400, 30, 150),
        span('EUR Account Activity (Continued)', 40, 130, 230),
        ...airwallexHeader(160),
        ...airwallexRow({
            y: 190, date: 'Mar 03 2032', details: ['Card Refund - Copper Garden, IRL,', '(Main Card, **0000): EUR', '4.19'], credit: '4.19 EUR', balance: '971.62 EUR'
        }),
        ...airwallexRow({
            y: 280, date: 'Mar 04 2032', kind: 'Deposit', details: ['Amber Guild | Ref: SYNTHETIC-REF |', 'GA XX00 SYNTHETIC ONLY'], credit: '27.53 EUR', balance: '999.15 EUR'
        }),
        span('Ending balance', 110, 380, 100), span('999.15 EUR', 490, 380, 80),
        span('Page 2 of 3', 500, 790, 70)
    ];
    const information: ImportPage = emptyPage(3);
    information.spans = [
        span('Web: airwallex.com', 400, 30, 150),
        span('Important information', 40, 80, 150),
        span('Balances and account activities in this report were generated using Central European Time.', 40, 100, 550),
        span('Account Details', 40, 145, 100),
        span('Global Account details do not identify the wallet activity in this report.', 40, 165, 500),
        span('Account Balance', 40, 200, 110),
        span('Transaction Types', 40, 250, 120),
        span('Deposit – Funds received in the Account balance.', 40, 275, 350),
        span('Card – Funds spent via an Airwallex-issued debit card.', 40, 300, 350),
        span('Page 3 of 3', 500, 790, 70)
    ];
    return {
        source: { sourceId: 'synthetic-airwallex-source', sha256: 'b'.repeat(64) },
        extraction: { runId: 'synthetic-airwallex-run', version: 'test-1' },
        pages: [first, second, information],
        issues: []
    };
}
