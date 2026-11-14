import type { ZodSafeParseResult } from 'zod';
import {
    bankImportInputSchema,
    bankImportResultSchema,
    calendarDateSchema,
    emptyImportResult,
    importIssue,
    sourceProvenance,
    type BankAdapter,
    type BankImportInput,
    type BankImportResult,
    type ImportIssue,
    type ImportPage,
    type PositionedSpan,
    type SourceEvidence,
    type UnresolvedDraft
} from '../../src/shared/bank-import.js';
import { moneySchema, type Money } from '../../src/shared/money.js';

interface Line {
    spans: PositionedSpan[];
    y: number;
}
interface Header {
    line: Line;
    descriptionLeft: number;
    outLeft: number;
    outRight: number;
    inRight: number;
}
interface Row {
    rowId: string;
    lines: Line[];
}
const metadata: { bankId: string; adapterId: string; version: string; layouts: { layoutId: string; version: string; }[]; } = { bankId: 'revolut', adapterId: 'revolut-business', version: '1', layouts: [{ layoutId: 'business-english-eur', version: '1' }] };
const selection: { bankId: string; adapterId: string; version: string; layoutId: string; layoutVersion: string; } = {
    bankId: metadata.bankId,
    adapterId: metadata.adapterId,
    version: metadata.version,
    layoutId: metadata.layouts[0].layoutId,
    layoutVersion: metadata.layouts[0].version
};
const months: string[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const fullMonths: string[] = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const amountPattern: "(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+)\\.\\d{2}" = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+)\\.\\d{2}';

function linesOf(page: ImportPage): Line[] {
    const lines: Line[] = [];
    const spans: PositionedSpan[] = [...page.spans].sort((a: PositionedSpan, b: PositionedSpan): number => a.region.y - b.region.y || a.region.x - b.region.x || a.text.localeCompare(b.text));
    for (const span of spans) {
        const line: Line | undefined = lines.at(-1);
        if (line && Math.abs(span.region.y - line.y) <= Math.min(2.5, span.region.height / 2)) {
            line.spans.push(span);
        } else {
            lines.push({ y: span.region.y, spans: [span] });
        }
    }
    for (const line of lines) {
        line.spans.sort((a: PositionedSpan, b: PositionedSpan): number => a.region.x - b.region.x || a.text.localeCompare(b.text));
    }
    return lines;
}

function lineText(line: Line): string {
    return line.spans
        .map((span: PositionedSpan): string => span.text.trim())
        .filter(Boolean)
        .join(' ');
}

function label(line: Line, value: string): PositionedSpan[] | null {
    for (let start: number = 0; start < line.spans.length; start++) {
        for (let end: number = start + 1; end <= Math.min(line.spans.length, start + 3); end++) {
            const spans: PositionedSpan[] = line.spans.slice(start, end);
            if (
                spans
                    .map((span: PositionedSpan): string => span.text.trim())
                    .join(' ')
                    .replace(/\s+/g, ' ') === value
            ) {
                    return spans;
                }
        }
    }
    return null;
}

function right(spans: PositionedSpan[]): number {
    return Math.max(...spans.map((span: PositionedSpan): number => span.region.x + span.region.width));
}

function evidence(page: ImportPage, spans: PositionedSpan[]): SourceEvidence[] {
    // Keep extraction methods separate, including hybrid text/OCR pages; do not invent sub-span coordinates.
    const values: SourceEvidence[] = [];
    for (const method of ['embedded-text', 'local-ocr'] as const) {
        const selected: PositionedSpan[] = spans.filter((span: PositionedSpan): string | false => span.method === method && span.text.trim());
        if (!selected.length) {
            continue;
        }
        const x: number = Math.min(...selected.map((span: PositionedSpan): number => span.region.x));
        const y: number = Math.min(...selected.map((span: PositionedSpan): number => span.region.y));
        values.push({
            pageId: page.pageId,
            region: { x, y, width: right(selected) - x, height: Math.max(...selected.map((span: PositionedSpan): number => span.region.y + span.region.height)) - y },
            rawText: selected.map((span: PositionedSpan): string => span.text).join(' '),
            method
        });
    }
    return values;
}

function rowEvidence(page: ImportPage, row: Row): SourceEvidence[] {
    return row.lines.flatMap((line: Line): SourceEvidence[] => evidence(page, line.spans));
}

function headerOf(line: Line): Header | null {
    const date: PositionedSpan[] | null = label(line, 'Date (UTC)');
    const description: PositionedSpan[] | null = label(line, 'Description');
    const out: PositionedSpan[] | null = label(line, 'Money out');
    const incoming: PositionedSpan[] | null = label(line, 'Money in');
    const balance: PositionedSpan[] | null = label(line, 'Balance');
    if (!date || !description || !out || !incoming || !balance) {
        return null;
    }
    const [dateLeft, descriptionLeft, outLeft, inLeft, balanceLeft]: number[] = [date, description, out, incoming, balance].map((spans: PositionedSpan[]): number => spans[0].region.x);
    if (!(dateLeft < descriptionLeft && right(date) < descriptionLeft && right(description) < outLeft && right(out) < inLeft && right(incoming) < balanceLeft)) {
        return null;
    }
    return { line, descriptionLeft, outLeft, outRight: (right(out) + inLeft) / 2, inRight: (right(incoming) + balanceLeft) / 2 };
}

function columns(line: Line, header: Header): { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; } {
    const date: PositionedSpan[] = [];
    const description: PositionedSpan[] = [];
    const out: PositionedSpan[] = [];
    const incoming: PositionedSpan[] = [];
    const balance: PositionedSpan[] = [];
    for (const span of line.spans) {
        const end: number = span.region.x + span.region.width;
        if (span.region.x < header.descriptionLeft - 5) {
            date.push(span);
        } else if (end >= header.outLeft && end <= header.outRight) {
            out.push(span);
        } else if (end > header.outRight && end <= header.inRight) {
            incoming.push(span);
        } else if (end < header.outLeft) {
            description.push(span);
        } else {
            balance.push(span);
        }
    }
    return { date, description, out, incoming, balance };
}

function joined(spans: PositionedSpan[]): string {
    return spans
        .map((span: PositionedSpan): string => span.text.trim())
        .filter(Boolean)
        .join(' ');
}

function metadataField(page: ImportPage, line: Line, pattern: RegExp): { match: RegExpExecArray; evidence: SourceEvidence[]; } | null {
    for (let index: number = 0; index < line.spans.length; index++) {
        const selected: PositionedSpan[] = line.spans.slice(index);
        const match: RegExpExecArray | null = pattern.exec(joined(selected));
        if (match) {
            return { match, evidence: evidence(page, selected) };
        }
    }
    return null;
}

function dateOf(raw: string): string | null {
    // A narrow unlabeled transaction-type column can follow the date in this layout.
    const match: RegExpExecArray | null = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+[A-Z]{3})?$/.exec(raw);
    if (!match) {
        return null;
    }
    const word: string = match[2].toLowerCase();
    let month: number = months.indexOf(word);
    if (month < 0) {
        month = fullMonths.indexOf(word);
    }
    if (month < 0) {
        return null;
    }
    const value: string = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return calendarDateSchema.safeParse(value).success ? value : null;
}

function amountOf(raw: string, currency: string, direction: 'incoming' | 'outgoing'): Money | null {
    const match: RegExpExecArray | null = new RegExp(`^(?:${currency}\\s*|${currency === 'EUR' ? '€' : '\\$'}\\s*)?(${amountPattern})(?:\\s*${currency})?$`).exec(raw);
    if (!match) {
        return null;
    }
    const magnitude: bigint = BigInt(match[1].replace(/[,.\s]/g, ''));
    const coefficient: string = (direction === 'outgoing' ? -magnitude : magnitude).toString();
    const parsed: ZodSafeParseResult<{ coefficient: string; currency: string; scale: number; }> = moneySchema.safeParse({ coefficient, currency, scale: 2 });
    return parsed.success ? parsed.data : null;
}

type RowDetails = Pick<UnresolvedDraft, 'references' | 'counterpartyCandidate' | 'reportedOriginalAmount'>;

function readOriginalAmount(raw: string, direction: UnresolvedDraft['direction'], reportedOriginalAmount: UnresolvedDraft['reportedOriginalAmount'],
    fieldSource: SourceEvidence[], rowId: string, issues: ImportIssue[]): UnresolvedDraft['reportedOriginalAmount'] {
        const original: RegExpExecArray | null = new RegExp(`^Original (?:payment )?amount:\\s*(?:([A-Z]{3})\\s+(${amountPattern})|(${amountPattern})\\s+([A-Z]{3}))$`, 'i').exec(raw);
        const originalCurrency: string | undefined = original?.[1] ?? original?.[4];
        const originalValue: string | undefined = original?.[2] ?? original?.[3];
        const parsed: { coefficient: string; currency: string; scale: number; } | null = originalCurrency && originalValue && direction ? amountOf(originalValue, originalCurrency, direction) : null;
        if (!parsed || reportedOriginalAmount) {
                issues.push(
                importIssue(
                    'invalid-original-amount',
                    'The explicitly reported original amount is unreadable or conflicting.',
                    fieldSource,
                    rowId,
                    'reportedOriginalAmount'
                )
            );
            } else {
            return { value: parsed, evidence: fieldSource };
        }
    return reportedOriginalAmount;
}

function readRowDetails(page: ImportPage, rowId: string, cells: ReturnType<typeof columns>[], direction: UnresolvedDraft['direction'], issues: ImportIssue[]): RowDetails {
    const references: BankImportResult['transactions'][number]['references'] = [];
    let counterpartyCandidate: UnresolvedDraft['counterpartyCandidate'] = null;
    let reportedOriginalAmount: UnresolvedDraft['reportedOriginalAmount'] = null;
    for (const cell of cells) {
        const raw: string = joined(cell.description);
        const fieldSource: SourceEvidence[] = evidence(page, cell.description);
        const reference: RegExpExecArray | null = /^(Reference|Payment reference|Transaction ID):\s*(.+)$/i.exec(raw);
        if (reference) {
            references.push({ label: reference[1], value: reference[2], evidence: fieldSource });
        }
        const counterparty: RegExpExecArray | null = /^(?:To|From):\s*(.+)$/i.exec(raw);
        if (counterparty) {
            if (counterpartyCandidate) {
                    issues.push(importIssue('conflicting-fields', 'Multiple labeled counterparties need review.', fieldSource, rowId, 'counterpartyCandidate'));
                } else {
                counterpartyCandidate = { value: counterparty[1], evidence: fieldSource };
            }
        }
        if (/^Original (?:payment )?amount:/i.test(raw)) {
            reportedOriginalAmount = readOriginalAmount(raw, direction, reportedOriginalAmount, fieldSource, rowId, issues);
        }
    }
    return { references, counterpartyCandidate, reportedOriginalAmount };
}

type Settlement = Pick<UnresolvedDraft, 'direction' | 'accountAmount'>;

function readSettlement(page: ImportPage, row: Row, out: PositionedSpan[], incoming: PositionedSpan[], issues: ImportIssue[]): Settlement {
    const direction: UnresolvedDraft['direction'] = Boolean(out.length) === Boolean(incoming.length) ? null : out.length ? 'outgoing' : 'incoming';
    const amountSpans: PositionedSpan[] = direction === 'outgoing' ? out : direction === 'incoming' ? incoming : [...out, ...incoming];
    const amount: { coefficient: string; currency: string; scale: number; } | null = direction ? amountOf(joined(amountSpans), 'EUR', direction) : null;
    const accountAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null = amount ? { value: amount, evidence: evidence(page, amountSpans) } : null;
    if (!accountAmount) {
            issues.push(
            importIssue(
                out.length && incoming.length ? 'conflicting-fields' : 'invalid-amount',
                'Exactly one readable money-out or money-in amount is required.',
                evidence(page, amountSpans.length ? amountSpans : row.lines[0].spans),
                row.rowId,
                'accountAmount'
            )
        );
        }
    return { direction, accountAmount };
}

function rowDescription(page: ImportPage, descriptions: PositionedSpan[], text: string): UnresolvedDraft['description'] {
    return text ? { value: text, evidence: evidence(page, descriptions) } : null;
}

function interpretRow(page: ImportPage, row: Row, header: Header): { transaction: BankImportResult['transactions'][number] | null; draft: UnresolvedDraft | null } {
    const cells: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }[] = row.lines.map((line: Line): { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; } => columns(line, header));
    const source: SourceEvidence[] = rowEvidence(page, row);
    const issues: ImportIssue[] = [];
    const dates: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.date);
    const out: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.out);
    const incoming: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.incoming);
    const descriptions: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.description);
    const descriptionText: string = cells
        .map((cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; }): string => joined(cell.description))
        .filter(Boolean)
        .join('\n');
    const date: string | null = dateOf(joined(dates));
    const bookingDate: { value: string; basisLabel: string; evidence: SourceEvidence[]; } | null = date ? { value: date, basisLabel: 'Date (UTC)', evidence: evidence(page, dates) } : null;
    if (!bookingDate) {
            issues.push(
            importIssue(
                'invalid-date',
                'The printed booking date is missing, invalid or ambiguous.',
                evidence(page, dates.length ? dates : row.lines[0].spans),
                row.rowId,
                'bookingDate'
            )
        );
        }
    const { direction, accountAmount }: Settlement = readSettlement(page, row, out, incoming, issues);
    const description: UnresolvedDraft['description'] = rowDescription(page, descriptions, descriptionText);
    if (!description) {
        issues.push(importIssue('missing-field', 'The transaction description is missing.', source, row.rowId, 'description'));
    }
    const { references, counterpartyCandidate, reportedOriginalAmount }: RowDetails = readRowDetails(page, row.rowId, cells, direction, issues);
    const base: { rowId: string; accountSectionId: string; bookingDate: { value: string; basisLabel: string; evidence: SourceEvidence[]; } | null; valueDate: null; accountAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null; direction: "incoming" | "outgoing" | null; reportedOriginalAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null; description: { value: string; evidence: SourceEvidence[]; } | null; counterpartyCandidate: { value: string; evidence: SourceEvidence[]; } | null; references: { label: string; value: string; evidence: SourceEvidence[]; }[]; evidence: SourceEvidence[]; } = {
        rowId: row.rowId,
        accountSectionId: 'account-1',
        bookingDate,
        valueDate: null,
        accountAmount,
        direction,
        reportedOriginalAmount,
        description,
        counterpartyCandidate,
        references,
        evidence: source
    };
    if (issues.length) {
        return { transaction: null, draft: { ...base, issues } };
    }
    if (!bookingDate || !accountAmount || !direction || !description) {
        return { transaction: null, draft: { ...base, issues } };
    }
    return { transaction: { ...base, bookingDate, accountAmount, direction, description }, draft: null };
}

function dateLooking(raw: string): boolean {
    return /^(?:\d{1,2}|\?+)\s+[A-Za-z?]+\s+\d{4}\b/.test(raw);
}

function possibleRow(line: Line, header: Header): boolean {
    const cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; } = columns(line, header);
    if (dateLooking(joined(cell.date))) {
        return true;
    }
    // Financial-column decimals flag damaged row coverage; they do not become a settlement amount here.
    const monetaryHint: (spans: PositionedSpan[]) => boolean = (spans: PositionedSpan[]): boolean => /^(?:[A-Z]{3}\s*|[€$]\s*)?-?\d[\d ,\u00a0\u202f]*\.\d+(?:\s*[A-Z]{3})?$/.test(joined(spans));
    const onlyMonetaryText: boolean =
        joined(cell.description)
            .replace(/[+-]?\s*(?:[A-Z]{3}\s*|[€$]\s*)?\d[\d ,\u00a0\u202f]*\.\d+(?:\s*[A-Z]{3})?/g, '')
            .trim() === '';
    // Legend totals can fill several columns with amounts. A running balance or descriptive text distinguishes possible rows.
    return cell.description.length > 0 && (monetaryHint(cell.balance) || (!onlyMonetaryText && (monetaryHint(cell.out) || monetaryHint(cell.incoming))));
}

function unresolvedRow(page: ImportPage, row: Row, code: string, message: string): UnresolvedDraft {
    const source: SourceEvidence[] = rowEvidence(page, row);
    const issue: ImportIssue = importIssue(code, message, source, row.rowId);
    return {
        rowId: row.rowId,
        accountSectionId: 'account-1',
        bookingDate: null,
        valueDate: null,
        accountAmount: null,
        direction: null,
        reportedOriginalAmount: null,
        description: null,
        counterpartyCandidate: null,
        references: [],
        evidence: source,
        issues: [issue]
    };
}

function isTableBoundary(page: ImportPage, line: Line, raw: string, cell: ReturnType<typeof columns>): boolean {
    if (/^(?:Opening balance|Closing balance|Total money|Page \d+\b)/i.test(raw)) {
        return true;
    }

    const footer: boolean = line.y > page.height * 0.85 && /(?:©|revolut(?:\.com|\s+(?:Ltd|Bank|Payments|is))|licensed by|registered office)/i.test(raw);
    return footer && !dateLooking(joined(cell.date)) && !cell.out.length && !cell.incoming.length && !cell.balance.length;
}

function reportOutsideTableRow(page: ImportPage, line: Line, counter: number, result: BankImportResult): void {
    const draft: UnresolvedDraft = unresolvedRow(
        page,
        { rowId: `p${page.pageNumber}-r${counter}`, lines: [line] },
        'outside-table-row',
        'A possible transaction appears after the table boundary and needs review.'
    );
    result.unresolvedDrafts.push(draft);
    result.issues.push(...draft.issues);
}

function parseTable(page: ImportPage, lines: Line[], header: Header, nextY: number, counter: number, result: BankImportResult): { counter: number; sawLegend: boolean } {
    const body: Line[] = lines.filter((line: Line): boolean => line.y > header.line.y + 2 && line.y < nextY);
    let sawLegend: boolean = false;
    let row: Row | null = null;
    let sectionEnded: boolean = false;
    const flush: () => void = (): void => {
        if (!row) {
            return;
        }
        const parsed: { transaction: BankImportResult["transactions"][number] | null; draft: UnresolvedDraft | null; } = interpretRow(page, row, header);
        if (parsed.transaction) {
            result.transactions.push(parsed.transaction);
        }
        if (parsed.draft) {
            result.unresolvedDrafts.push(parsed.draft);
            result.issues.push(...parsed.draft.issues);
        }
        row = null;
    };
    for (const line of body) {
        const raw: string = lineText(line);
        const cell: { date: PositionedSpan[]; description: PositionedSpan[]; out: PositionedSpan[]; incoming: PositionedSpan[]; balance: PositionedSpan[]; } = columns(line, header);
        const legend: boolean = /^Transaction types\b/i.test(raw);
        if (legend || isTableBoundary(page, line, raw, cell)) {
            flush();
            sawLegend ||= legend;
            sectionEnded = true;
            continue;
        }
        if (sectionEnded) {
            if (possibleRow(line, header)) {
                reportOutsideTableRow(page, line, ++counter, result);
            }
            continue;
        }
        // A printed running balance can anchor a damaged row, but never supplies its settlement amount.
        if (cell.date.length || cell.out.length || cell.incoming.length || cell.balance.length) {
            flush();
            row = { rowId: `p${page.pageNumber}-r${++counter}`, lines: [line] };
        } else if (row && cell.description.length) {
            row.lines.push(line);
        } else if (raw && !/^\s*$/.test(raw)) {
            result.issues.push(importIssue('unclassified-region', 'Text in the transaction area could not be assigned to a row.', evidence(page, line.spans)));
        }
    }
    flush();
    return { counter, sawLegend };
}

function parseHeaderlessPage(page: ImportPage, lines: Line[], fallback: Header, legendStarted: boolean, result: BankImportResult): void {
    const content: string = lines.map(lineText).join('\n');
    if (
        legendStarted &&
        /Money sent/i.test(content) &&
        /Money received/i.test(content) &&
        /Card payments/i.test(content) &&
        !lines.some((line: Line): boolean => possibleRow(line, fallback))
    ) {
        return;
    }
    result.issues.push(importIssue('unclassified-page', 'A page has no supported transaction header and needs review.', evidence(page, lines[0]?.spans ?? [])));
    for (const [index, line] of lines.filter((line: Line): boolean => possibleRow(line, fallback)).entries()) {
        const draft: UnresolvedDraft = unresolvedRow(
            page,
            { rowId: `p${page.pageNumber}-r${index + 1}`, lines: [line] },
            'missing-table-header',
            'A possible transaction row has no supported page header.'
        );
        result.unresolvedDrafts.push(draft);
        result.issues.push(...draft.issues);
    }
}

function parsePage(page: ImportPage, lines: Line[], headers: { page: ImportPage; header: Header }[], legendStarted: boolean, result: BankImportResult): boolean {
    if (page.status === 'failed') {
        result.issues.push({ ...importIssue('failed-page', 'A source page could not be extracted.'), pageId: page.pageId });
        return legendStarted;
    }
    const pageHeaders: Header[] = headers.filter((value: { page: ImportPage; header: Header; }): boolean => value.page.pageId === page.pageId).map((value: { page: ImportPage; header: Header; }): Header => value.header);
    if (!pageHeaders.length) {
        parseHeaderlessPage(page, lines, headers[0].header, legendStarted, result);
        return legendStarted;
    }
    let counter: number = 0;
    for (const [index, header] of pageHeaders.entries()) {
        const section: { counter: number; sawLegend: boolean } = parseTable(page, lines, header, pageHeaders[index + 1]?.line.y ?? page.height, counter, result);
        counter = section.counter;
        legendStarted ||= section.sawLegend;
    }
    return legendStarted;
}

function parse(input: BankImportInput): BankImportResult {
    const validated: ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(input);
    if (!validated.success) {
        return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    }
    input = validated.data;
    const pages: { page: ImportPage; lines: Line[]; }[] = input.pages.map((page: ImportPage): { page: ImportPage; lines: Line[]; } => ({ page, lines: linesOf(page) }));
    const headers: { page: ImportPage; header: Header; }[] = pages.flatMap(({ page, lines }: { page: ImportPage; lines: Line[]; }): { page: ImportPage; header: Header; }[] =>
        lines.flatMap((line: Line): { page: ImportPage; header: Header; }[] => {
            const header: Header | null = headerOf(line);
            return header ? [{ page, header }] : [];
        })
    );
    if (!headers.length) {
            return emptyImportResult(
            input,
            input.pages.every((page: ImportPage): boolean => page.status === 'failed') ? 'failed' : 'unsupported',
            importIssue('unsupported-layout', 'The supported Revolut transaction columns were not found.')
        );
        }
    const metadataLines: { page: ImportPage; line: Line; }[] = pages.flatMap(({ page, lines }: { page: ImportPage; lines: Line[]; }): { page: ImportPage; line: Line; }[] => {
        const firstHeader: { page: ImportPage; header: Header; } | undefined = headers.find((value: { page: ImportPage; header: Header; }): boolean => value.page.pageId === page.pageId);
        return firstHeader ? lines.filter((line: Line): boolean => line.y < firstHeader.header.line.y).map((line: Line): { page: ImportPage; line: Line; } => ({ page, line })) : [];
    });
    const currencyLines: { value: string; evidence: SourceEvidence[]; }[] = metadataLines.flatMap(({ page, line }: { page: ImportPage; line: Line; }): { value: string; evidence: SourceEvidence[]; }[] => {
        const field: { match: RegExpExecArray; evidence: SourceEvidence[]; } | null = metadataField(page, line, /^Currency\s*:?\s+([A-Z]{3})$/);
        return field ? [{ value: field.match[1], evidence: field.evidence }] : [];
    });
    if (!currencyLines.length || currencyLines.some((field: { value: string; evidence: SourceEvidence[]; }): boolean => field.value !== 'EUR')) {
            return emptyImportResult(
            input,
            'unsupported',
            importIssue(
                'unsupported-currency',
                'This Revolut adapter requires an explicit, consistent EUR account currency.',
                currencyLines.flatMap((field: { value: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence)
            )
        );
        }
    const currencyEvidence: SourceEvidence[] = currencyLines.flatMap((field: { value: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence);
    const accountLines: { label: string; value: string; evidence: SourceEvidence[]; }[] = metadataLines.flatMap(({ page, line }: { page: ImportPage; line: Line; }): { label: string; value: string; evidence: SourceEvidence[]; }[] => {
        const field: { match: RegExpExecArray; evidence: SourceEvidence[]; } | null = metadataField(page, line, /^(IBAN|Account number|Account identifier)\s*:?\s+(.+)$/);
        return field ? [{ label: field.match[1], value: field.match[2], evidence: field.evidence }] : [];
    });
    if (accountLines.length > 1 && accountLines.some((field: { label: string; value: string; evidence: SourceEvidence[]; }): boolean => field.label !== accountLines[0].label || field.value !== accountLines[0].value)) {
        return emptyImportResult(
            input,
            'unsupported',
            importIssue(
                'unsupported-account-sections',
                'Multiple account identifiers need a supported section mapping.',
                accountLines.flatMap((field: { label: string; value: string; evidence: SourceEvidence[]; }): SourceEvidence[] => field.evidence)
            )
        );
    }
    const result: BankImportResult = {
        contractVersion: '1',
        status: 'complete',
        adapter: selection,
        sourceProvenance: sourceProvenance(input),
        accountSections: [
            { sectionId: 'account-1', currency: { value: 'EUR', evidence: currencyEvidence }, accountReference: accountLines[0] ?? null, evidence: currencyEvidence }
        ],
        transactions: [],
        unresolvedDrafts: [],
        issues: [...input.issues]
    };
    let legendStarted: boolean = false;
    for (const { page, lines } of pages) {
        legendStarted = parsePage(page, lines, headers, legendStarted, result);
    }
    if (result.issues.length || result.unresolvedDrafts.length) {
        result.status = 'partial';
    }
    const checked: ZodSafeParseResult<BankImportResult> = bankImportResultSchema.safeParse(result);
    return checked.success
        ? checked.data
        : emptyImportResult(input, 'failed', importIssue('result-limit-or-contract', 'The interpreted statement exceeds result limits or cannot be represented safely.'));
}

export const revolutAdapter: BankAdapter = {
    metadata,
    identify: (input: BankImportInput): boolean => {
        const lines: Line[] = input.pages.flatMap(linesOf);
        const content: string = lines.map(lineText).join('\n');
        return /\brevolut\b/i.test(content) && /\bAccount statement\b/i.test(content) && lines.some((line: Line): boolean => headerOf(line) !== null);
    },
    parse
};
