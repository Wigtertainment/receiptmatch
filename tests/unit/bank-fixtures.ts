import type { BankImportInput, ImportPage, PositionedSpan } from '../../src/shared/bank-import.js';

// Independently invented data: no user documents, paths, references or source hashes.
export function span(text: string, x: number, y: number, width = 45, method: PositionedSpan['method'] = 'embedded-text'): PositionedSpan {
    return { text, region: { x, y, width, height: 9 }, method };
}
export function header(y = 200, tokenized = false): PositionedSpan[] {
    if (tokenized)
        return [
            span('Date', 40, y, 20),
            span('(UTC)', 62, y, 25),
            span('Description', 170, y, 60),
            span('Money', 350, y, 27),
            span('out', 380, y, 18),
            span('Money', 435, y, 27),
            span('in', 465, y, 15),
            span('Balance', 520, y, 40)
        ];
    return [span('Date (UTC)', 40, y, 50), span('Description', 170, y, 60), span('Money out', 350, y, 48), span('Money in', 435, y, 45), span('Balance', 520, y, 40)];
}
export function row(y: number, date: string, description: string, outgoing: string | null, incoming: string | null, tokenized = false): PositionedSpan[] {
    const dates = tokenized ? date.split(' ').map((part, index) => span(part, 40 + index * 24, y, 22)) : [span(date, 40, y, 80)];
    return [
        ...dates,
        span(description, 170, y, 150),
        ...(outgoing === null ? [] : [span(outgoing, 355, y, 43)]),
        ...(incoming === null ? [] : [span(incoming, 437, y, 43)]),
        span('987,654.32', 510, y, 50)
    ];
}
export function statement(): BankImportInput {
    return {
        source: { sourceId: 'synthetic-source', sha256: 'a'.repeat(64) },
        extraction: { runId: 'synthetic-run', version: 'test-1' },
        issues: [],
        pages: [
            {
                pageId: 'page-1',
                pageNumber: 1,
                width: 600,
                height: 840,
                status: 'complete',
                spans: [
                    span('Account statement', 350, 40, 170),
                    span('Currency EUR', 350, 95, 120),
                    span('IBAN: XX00 SYNTHETIC ONLY', 350, 115, 200),
                    span('Opening balance', 40, 160, 100),
                    span('999.99', 350, 160),
                    ...header(),
                    ...row(230, '28 Feb 2032', 'To: Orchard Workshop', '1,234.56', null),
                    span('Reference: SYNTHETIC-A', 170, 243, 150),
                    span('Original amount: USD 1,500.01', 170, 256, 170),
                    ...row(285, '27 Feb 2032', 'From: River Studio', null, '25.07'),
                    span('Continued payment description', 170, 298, 170),
                    span('Revolut Bank synthetic footer', 40, 790, 200)
                ]
            }
        ]
    };
}
export function emptyPage(pageNumber = 2): ImportPage {
    return { pageId: `page-${pageNumber}`, pageNumber, width: 600, height: 840, status: 'complete', spans: [] };
}
