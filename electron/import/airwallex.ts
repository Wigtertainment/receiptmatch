import type { ImportIssue } from "../../src/shared/bank-import.js";
import type { ZodSafeParseResult } from 'zod';
import {
    bankImportInputSchema, bankImportResultSchema, calendarDateSchema, emptyImportResult, importIssue, sourceProvenance,
    type BankAdapter, type BankImportInput, type BankImportResult, type ImportPage, type PositionedSpan, type SourceEvidence, type UnresolvedDraft
} from '../../src/shared/bank-import.js';
import { moneySchema, type Money } from '../../src/shared/money.js';

interface Line { spans: PositionedSpan[]; y: number; }
interface Header { line: Line; detailsLeft: number; creditLeft: number; creditRight: number; debitRight: number; }
interface Row { rowId: string; lines: Line[]; }
const metadata: { bankId: string; adapterId: string; version: string; layouts: { layoutId: string; version: string; }[]; } = { bankId: 'airwallex', adapterId: 'airwallex-business', version: '1', layouts: [{ layoutId: 'account-activity-english-eur', version: '1' }] };
const selection: { bankId: string; adapterId: string; version: string; layoutId: string; layoutVersion: string; } = { bankId: metadata.bankId, adapterId: metadata.adapterId, version: metadata.version,
    layoutId: metadata.layouts[0].layoutId, layoutVersion: metadata.layouts[0].version };
const months: string[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const amountPattern: "(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)\\.\\d{2}" = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)\\.\\d{2}';
const transactionTypes: Set<string> = new Set([
    'Card', 'Payout', 'Deposit', 'Conversion', 'Payin', 'Transfer', 'Charge', 'Adjustment', 'Purchase', 'Direct Debit', 'Fee', 'Batch Payout', 'Credit',
    'Prepayment', 'Liquidity', 'Repayment', 'Withholding Tax'
]);

function joined(spans: PositionedSpan[]): string {
    return spans.map((span: PositionedSpan): string => span.text.trim()).filter(Boolean).join(' ');
}

function linesOf(page: ImportPage): Line[] {
    const lines: Line[] = [];
    for (const span of [...page.spans].sort((a: PositionedSpan, b: PositionedSpan): number => a.region.y - b.region.y || a.region.x - b.region.x || a.text.localeCompare(b.text))) {
        const line: Line | undefined = lines.at(-1);
        if (line && Math.abs(line.y - span.region.y) <= Math.min(2.5, span.region.height / 2)) {
            line.spans.push(span);
        } else {
            lines.push({ spans: [span], y: span.region.y });
        }
    }
    for (const line of lines) {
        line.spans.sort((a: PositionedSpan, b: PositionedSpan): number => a.region.x - b.region.x || a.text.localeCompare(b.text));
    }
    return lines;
}

function right(spans: PositionedSpan[]): number {
    return Math.max(...spans.map((span: PositionedSpan): number => span.region.x + span.region.width));
}

function evidence(page: ImportPage, spans: PositionedSpan[]): SourceEvidence[] {
    return (['embedded-text', 'local-ocr'] as const).flatMap((method: "embedded-text" | "local-ocr"): SourceEvidence[] => {
        const selected: PositionedSpan[] = spans.filter((span: PositionedSpan): string | false => span.method === method && span.text.trim());
        if (!selected.length) {
            return [];
        }
        const x: number = Math.min(...selected.map((span: PositionedSpan): number => span.region.x));
        const y: number = Math.min(...selected.map((span: PositionedSpan): number => span.region.y));
        return [{ pageId: page.pageId, method, rawText: joined(selected), region: {
            x, y, width: right(selected) - x, height: Math.max(...selected.map((span: PositionedSpan): number => span.region.y + span.region.height)) - y
        } }];
    });
}

function headerOf(line: Line): Header | null {
    const names: string[] = ['Date', 'Details', 'Credit', 'Debit', 'Balance'];
    const fields: (PositionedSpan | undefined)[] = names.map((name: string): PositionedSpan | undefined => line.spans.find((span: PositionedSpan): boolean => span.text.trim() === name));
    if (fields.some((field: PositionedSpan | undefined): field is undefined => !field)) {
        return null;
    }
    const [date, details, credit, debit, balance]: PositionedSpan[] = fields as PositionedSpan[];
    if (!(right([date]) < details.region.x && right([details]) < credit.region.x && right([credit]) < debit.region.x && right([debit]) < balance.region.x)) {
        return null;
    }
    return { line, detailsLeft: details.region.x, creditLeft: credit.region.x, creditRight: debit.region.x, debitRight: balance.region.x };
}

function columns(line: Line, header: Header): { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; } {
    const date: PositionedSpan[] = [], details: PositionedSpan[] = [], credit: PositionedSpan[] = [], debit: PositionedSpan[] = [], balance: PositionedSpan[] = [];
    for (const span of line.spans) {
        const end: number = span.region.x + span.region.width;
        if (span.region.x < header.detailsLeft - 5) {
            date.push(span);
        } else if (end < header.creditLeft) {
            details.push(span);
        } else if (end <= header.creditRight) {
            credit.push(span);
        } else if (end <= header.debitRight) {
            debit.push(span);
        } else {
            balance.push(span);
        }
    }
    return { date, details, credit, debit, balance };
}

function dateOf(raw: string): string | null {
    const match: RegExpExecArray | null = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(raw);
    if (!match) {
        return null;
    }
    const month: number = months.indexOf(match[1].toLowerCase());
    const value: string = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    return month >= 0 && calendarDateSchema.safeParse(value).success ? value : null;
}

function amountOf(raw: string, currency: string, direction: 'incoming' | 'outgoing'): Money | null {
    const match: RegExpExecArray | null = new RegExp(`^(${amountPattern})(?:\\s+${currency})?$`).exec(raw);
    if (!match) {
        return null;
    }
    const magnitude: bigint = BigInt(match[1].replace(/[,.]/g, ''));
    const parsed: ZodSafeParseResult<{ coefficient: string; currency: string; scale: number; }> = moneySchema.safeParse({ coefficient: (direction === 'outgoing' ? -magnitude : magnitude).toString(), currency, scale: 2 });
    return parsed.success ? parsed.data : null;
}

function possibleRow(line: Line, header: Header): boolean {
    const cells: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; } = columns(line, header);
    return /^[A-Za-z?]{3}\s+(?:\d{1,2}|\?+)\s+\d{4}\b/.test(joined(cells.date)) ||
        [...cells.credit, ...cells.debit, ...cells.balance].some((span: PositionedSpan): boolean => /\d[\d,]*\.\d/.test(span.text)) ||
        transactionTypes.has(joined(cells.details));
}

function summary(line: Line): boolean {
    return new RegExp(`^(?:Starting|Ending) balance\\s+${amountPattern}\\s+EUR$`).test(joined(line.spans));
}

function footer(line: Line, header: Header): boolean {
    return line.spans[0].region.x >= header.creditLeft && /^Page \d+ of \d+$/.test(joined(line.spans));
}

function unresolved(page: ImportPage, row: Row, code: string, message: string): UnresolvedDraft {
    const source: SourceEvidence[] = row.lines.flatMap((line: Line): SourceEvidence[] => evidence(page, line.spans));
    return { rowId: row.rowId, accountSectionId: 'wallet-eur', bookingDate: null, valueDate: null, accountAmount: null, direction: null,
        reportedOriginalAmount: null, description: null, counterpartyCandidate: null, references: [], evidence: source,
        issues: [importIssue(code, message, source, row.rowId)] };
}

type RowDetails = Pick<UnresolvedDraft, 'reportedOriginalAmount' | 'counterpartyCandidate' | 'references'>;
interface ParsedRow { transaction: BankImportResult['transactions'][number] | null; draft: UnresolvedDraft | null }
interface PageTitle { page: ImportPage; line: Line; currency: string }
interface PageHeader { page: ImportPage; header: Header }
interface TableSection { header: Header; start: number; end: number; inTable: boolean }

function readOriginalAmount(text: string, direction: UnresolvedDraft['direction'], detailEvidence: SourceEvidence[], rowId: string,
    issues: ImportIssue[]): UnresolvedDraft['reportedOriginalAmount'] {
    const markers: RegExpExecArray[] = [...text.matchAll(/\):/g)];
    if (markers.length) {
        const field: RegExpExecArray | null = new RegExp(`^([A-Z]{3})\\s+(${amountPattern})(?:\\s+1\\s+EUR\\s*=\\s*\\d+(?:\\.\\d+)?\\s+[A-Z]{3})?$`).exec(text.slice(markers[0].index + 2).trim());
        const original: { coefficient: string; currency: string; scale: number; } | null = field && markers.length === 1 && direction ? amountOf(field[2], field[1], direction) : null;
        if (original) {
            return { value: original, evidence: detailEvidence };
        }
        issues.push(importIssue('invalid-original-amount', 'The explicitly reported original amount is unreadable or conflicting.',
            detailEvidence, rowId, 'reportedOriginalAmount'));
    }
    return null;
}

function readRowDetails(kind: string, descriptionText: string, direction: UnresolvedDraft['direction'], detailEvidence: SourceEvidence[],
    rowId: string, issues: ImportIssue[]): RowDetails {
    let reportedOriginalAmount: UnresolvedDraft['reportedOriginalAmount'] = null;
    let counterpartyCandidate: UnresolvedDraft['counterpartyCandidate'] = null;
    const references: UnresolvedDraft['references'] = [];
    const text: string = descriptionText.replace(/\s+/g, ' ').trim();
    if (kind === 'Card') {
        reportedOriginalAmount = readOriginalAmount(text, direction, detailEvidence, rowId, issues);
        const party: RegExpExecArray | null = /^Card (?:Card Refund - )?([^,]+),/.exec(text);
        if (party) {
            counterpartyCandidate = { value: party[1], evidence: detailEvidence };
        }
    } else if (kind === 'Payout') {
        const party: RegExpExecArray | null = new RegExp(`^Payout Pay EUR ${amountPattern} to (.+)$`).exec(text);
        if (party) {
            counterpartyCandidate = { value: party[1], evidence: detailEvidence };
        }
    } else if (kind === 'Deposit') {
        const party: RegExpExecArray | null = /^Deposit ([^|]+)\s*\|/.exec(text);
        if (party) {
            counterpartyCandidate = { value: party[1].trim(), evidence: detailEvidence };
        }
    }
    for (const match of text.matchAll(/\b(Ref|Reference|Payment reference|Transaction ID):\s*([^|]*)(?=\||$)/g)) {
        if (match[2].trim()) {
            references.push({ label: match[1], value: match[2].trim(), evidence: detailEvidence });
        }
    }
    return { reportedOriginalAmount, counterpartyCandidate, references };
}

type Settlement = Pick<UnresolvedDraft, 'direction' | 'accountAmount'>;

function readSettlement(page: ImportPage, rowId: string, credits: PositionedSpan[], debits: PositionedSpan[], source: SourceEvidence[], issues: ImportIssue[]): Settlement {
    const direction: UnresolvedDraft['direction'] = credits.length && !debits.length ? 'incoming' : debits.length && !credits.length ? 'outgoing' : null;
    const amountSpans: PositionedSpan[] = direction === 'incoming' ? credits : debits;
    const amount: { coefficient: string; currency: string; scale: number; } | null = direction ? amountOf(joined(amountSpans), 'EUR', direction) : null;
    const accountAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null = amount ? { value: amount, evidence: evidence(page, amountSpans) } : null;
    if (!accountAmount) {
        issues.push(importIssue(credits.length && debits.length ? 'conflicting-fields' : 'invalid-amount',
        'Exactly one readable credit or debit amount is required.', source, rowId, 'accountAmount'));
    }
    return { direction, accountAmount };
}

function interpret(page: ImportPage, row: Row, header: Header, dateBasis: string, basisEvidence: SourceEvidence[]): ParsedRow {
    const cells: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }[] = row.lines.map((line: Line): { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; } => columns(line, header));
    const source: SourceEvidence[] = row.lines.flatMap((line: Line): SourceEvidence[] => evidence(page, line.spans));
    const issues: BankImportResult['issues'] = [];
    const dates: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.date), credits: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.credit), debits: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.debit);
    const details: PositionedSpan[] = cells.flatMap((cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }): PositionedSpan[] => cell.details);
    const descriptionText: string = cells.map((cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; }): string => joined(cell.details)).filter(Boolean).join('\n');
    const description: { value: string; evidence: SourceEvidence[]; } | null = descriptionText ? { value: descriptionText, evidence: evidence(page, details) } : null;
    const date: string | null = dateOf(joined(dates));
    const bookingDate: { value: string; basisLabel: string; evidence: SourceEvidence[]; } | null = date ? { value: date, basisLabel: dateBasis, evidence: [...evidence(page, dates), ...basisEvidence] } : null;
    if (!bookingDate) {
        issues.push(importIssue('invalid-date', 'The printed booking date is missing, invalid or ambiguous.', source, row.rowId, 'bookingDate'));
    }
    const { direction, accountAmount }: Settlement = readSettlement(page, row.rowId, credits, debits, source, issues);
    const kind: string = joined(cells[0].details);
    if (!transactionTypes.has(kind)) {
        issues.push(importIssue('unknown-transaction-type', 'The transaction type or its row boundary needs review.', source, row.rowId));
    }
    if (!description) {
        issues.push(importIssue('missing-field', 'The transaction description is missing.', source, row.rowId, 'description'));
    }
    const { reportedOriginalAmount, counterpartyCandidate, references }: RowDetails =
        readRowDetails(kind, descriptionText, direction, evidence(page, details), row.rowId, issues);
    const base: { rowId: string; accountSectionId: string; bookingDate: { value: string; basisLabel: string; evidence: SourceEvidence[]; } | null; valueDate: null; accountAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null; direction: "incoming" | "outgoing" | null; reportedOriginalAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null; description: { value: string; evidence: SourceEvidence[]; } | null; counterpartyCandidate: { value: string; evidence: SourceEvidence[]; } | null; references: { label: string; value: string; evidence: SourceEvidence[]; }[]; evidence: SourceEvidence[]; } = { rowId: row.rowId, accountSectionId: 'wallet-eur', bookingDate, valueDate: null, accountAmount, direction,
        reportedOriginalAmount, description, counterpartyCandidate, references, evidence: source };
    if (issues.length || !bookingDate || !accountAmount || !direction || !description) {
        return { draft: { ...base, issues }, transaction: null };
    }
    return { transaction: { ...base, bookingDate, accountAmount, direction, description }, draft: null };
}

function checkPageCoverage(page: ImportPage, lines: Line[], pageIndex: number, pageCount: number, firstHeader: Header, result: BankImportResult): void {
    if (page.pageNumber !== pageIndex + 1) {
        result.issues.push({
        ...importIssue('missing-page', 'The extraction does not cover consecutive source pages.'), pageId: page.pageId
    });
    }
    for (const line of lines) {
        const count: RegExpExecArray | null = footer(line, firstHeader) ? /^Page (\d+) of (\d+)$/.exec(joined(line.spans)) : null;
        if (count && (Number(count[1]) !== page.pageNumber || Number(count[2]) !== pageCount)) {
                result.issues.push(importIssue('incomplete-page-coverage', 'The printed page count does not match the extracted source coverage.', evidence(page, line.spans)));
            }
    }
}

function reviewHeaderlessPage(page: ImportPage, lines: Line[], fallback: Header, result: BankImportResult): boolean {
    const possible: boolean = lines.some((line: Line): boolean => !summary(line) && !footer(line, fallback) && possibleRow(line, fallback));
    const pageContent: string = lines.map((line: Line): string => joined(line.spans)).join('\n');
    const information: boolean = pageContent.includes('Important information') && pageContent.includes('Account Details') &&
        pageContent.includes('Account Balance') && pageContent.includes('Transaction Types');
    const closing: boolean = lines.length > 0 && lines.every((line: Line): boolean => footer(line, fallback) || (summary(line) && joined(line.spans).startsWith("Ending")));
    if (!possible && (information || closing)) {
        return false;
    }
    result.issues.push({ ...importIssue('unclassified-page', 'A page has no supported transaction header and needs review.'), pageId: page.pageId });
    return true;
}

function tableSections(page: ImportPage, lines: Line[], pageHeaders: Header[], fallback: Header, titles: PageTitle[], result: BankImportResult): TableSection[] {
    const sections: TableSection[] = pageHeaders.map((header: Header, index: number): { header: Header; start: number; end: number; inTable: boolean; } => ({ header, start: header.line.y + 2, end: pageHeaders[index + 1]?.line.y ?? page.height,
        inTable: titles.some((title: { page: ImportPage; line: Line; currency: string; }): boolean => title.page.pageId === page.pageId && title.line.y < header.line.y) }));
    const firstTitle: { page: ImportPage; line: Line; currency: string; } | undefined = titles.find((title: { page: ImportPage; line: Line; currency: string; }): boolean => title.page.pageId === page.pageId && title.line.y < pageHeaders[0]?.line.y);
    if (firstTitle) {
        const leading: Line[] = lines.filter((line: Line): boolean => line.y > firstTitle.line.y + 2 && line.y < pageHeaders[0].line.y && !summary(line) && !footer(line, fallback));
        if (leading.length) {
            result.issues.push(importIssue('missing-table-header', 'Content before the first supported transaction header needs review.',
                leading.flatMap((line: Line): SourceEvidence[] => evidence(page, line.spans))));
            sections.unshift({ header: fallback, start: firstTitle.line.y + 2, end: pageHeaders[0].line.y, inTable: false });
        }
    }
    if (!sections.length) {
        sections.push({ header: fallback, start: -1, end: page.height, inTable: false });
    }
    return sections;
}

function rowMarkers(line: Line, header: Header): { financial: boolean; category: boolean } {
    const cell: { date: PositionedSpan[]; details: PositionedSpan[]; credit: PositionedSpan[]; debit: PositionedSpan[]; balance: PositionedSpan[]; } = columns(line, header);
    const financial: boolean = cell.date.length > 0 || cell.credit.length > 0 || cell.debit.length > 0 || cell.balance.length > 0;
    const category: boolean = transactionTypes.has(joined(cell.details)) && !financial;
    return { financial, category };
}

function parseTable(page: ImportPage, lines: Line[], { header, start, end, inTable }: TableSection, counter: number, dateBasis: string,
    basisEvidence: SourceEvidence[], result: BankImportResult): number {
    const body: Line[] = lines.filter((line: Line): boolean => line.y > start && line.y < end);
    let row: Row | null = null;
    let ended: boolean = false;
    let anchored: boolean = false;
    const flush: (uncertainBoundary?: boolean) => void = (uncertainBoundary: boolean = false): void => {
        if (!row) {
            return;
        }
        const parsed: ParsedRow = inTable && !ended && !uncertainBoundary ? interpret(page, row, header, dateBasis, basisEvidence) : { transaction: null,
            draft: unresolved(page, row, uncertainBoundary ? 'ambiguous-row-boundary' : inTable ? 'outside-table-row' : 'missing-table-header',
                'A possible transaction has no unambiguous supported table context.') };
        if (parsed.transaction) {
            result.transactions.push(parsed.transaction);
        }
        if (parsed.draft) {
            result.unresolvedDrafts.push(parsed.draft); result.issues.push(...parsed.draft.issues);
        }
        row = null; anchored = false;
    };
    for (const line of body) {
        if (footer(line, header) || summary(line)) {
            flush();
            ended ||= footer(line, header) || joined(line.spans).startsWith("Ending");
            continue;
        }
        const { financial, category }: { financial: boolean; category: boolean } = rowMarkers(line, header);
        if (!inTable && !row && !possibleRow(line, header)) {
            continue;
        }
        const previous: Line | undefined = row?.lines.at(-1);
        // A separated, unlabeled block must not contaminate the preceding transaction's details.
        const separated: boolean | undefined = anchored && previous && line.y - previous.y > 2 * Math.max(...row!.lines.flatMap((value: Line): number[] => value.spans.map((span: PositionedSpan): number => span.region.height)));
        if (category || (financial && anchored) || separated) {
            flush(Boolean(financial && anchored && !category && !separated));
        }
        row ??= { rowId: `p${page.pageNumber}-r${++counter}`, lines: [] };
        row.lines.push(line);
        anchored ||= financial;
    }
    flush();
    return counter;
}

function parsePage(page: ImportPage, lines: Line[], pageIndex: number, pageCount: number, headers: PageHeader[], titles: PageTitle[],
    dateBasis: string, basisEvidence: SourceEvidence[], result: BankImportResult): void {
    checkPageCoverage(page, lines, pageIndex, pageCount, headers[0].header, result);
    if (page.status === 'failed') {
        result.issues.push({ ...importIssue('failed-page', 'A source page could not be extracted.'), pageId: page.pageId }); return;
    }
    const pageHeaders: Header[] = headers.filter((value: { page: ImportPage; header: Header; }): boolean => value.page.pageId === page.pageId).map((value: { page: ImportPage; header: Header; }): Header => value.header);
    const fallback: Header = headers[0].header;
    if (!pageHeaders.length && !reviewHeaderlessPage(page, lines, fallback, result)) {
        return;
    }
    const sections: TableSection[] = tableSections(page, lines, pageHeaders, fallback, titles, result);
    let counter: number = 0;
    for (const section of sections) {
        counter = parseTable(page, lines, section, counter, dateBasis, basisEvidence, result);
    }
}

function parse(input: BankImportInput): BankImportResult {
    const checkedInput: ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(input);
    if (!checkedInput.success) {
        return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    }
    input = checkedInput.data;
    const pages: { page: ImportPage; lines: Line[]; }[] = input.pages.map((page: ImportPage): { page: ImportPage; lines: Line[]; } => ({ page, lines: linesOf(page) }));
    const content: string = pages.flatMap(({ lines }: { page: ImportPage; lines: Line[]; }): string[] => lines.map((line: Line): string => joined(line.spans))).join('\n');
    const headers: { page: ImportPage; header: Header; }[] = pages.flatMap(({ page, lines }: { page: ImportPage; lines: Line[]; }): { page: ImportPage; header: Header; }[] => lines.flatMap((line: Line): { page: ImportPage; header: Header; }[] => {
        const header: Header | null = headerOf(line); return header ? [{ page, header }] : [];
    }));
    if (!/\bairwallex\b/i.test(content) || !headers.length) {
        return emptyImportResult(input, input.pages.every((page: ImportPage): boolean => page.status === 'failed') ? 'failed' : 'unsupported',
        importIssue('unsupported-layout', 'The supported Airwallex transaction columns were not found.'));
    }
    const titles: { page: ImportPage; line: Line; currency: string; }[] = pages.flatMap(({ page, lines }: { page: ImportPage; lines: Line[]; }): { page: ImportPage; line: Line; currency: string; }[] => lines.flatMap((line: Line): { page: ImportPage; line: Line; currency: string; }[] => {
        const match: RegExpExecArray | null = /^([A-Z]{3}) Account Activity(?: \(Continued\))?(?:\s+.*)?$/.exec(joined(line.spans));
        return match && line.spans[0].region.x < headers[0].header.detailsLeft - 5 ? [{ page, line, currency: match[1] }] : [];
    }));
    if (!titles.length || titles.some((title: { page: ImportPage; line: Line; currency: string; }): boolean => title.currency !== 'EUR')) {
        return emptyImportResult(input, 'unsupported',
        importIssue('unsupported-currency', 'This Airwallex adapter requires explicit, consistent EUR wallet activity.',
            titles.flatMap(({ page, line }: { page: ImportPage; line: Line; currency: string; }): SourceEvidence[] => evidence(page, line.spans))));
    }
    const currencyEvidence: SourceEvidence[] = titles.flatMap(({ page, line }: { page: ImportPage; line: Line; currency: string; }): SourceEvidence[] => evidence(page, line.spans));
    const informationPages: { page: ImportPage; lines: Line[]; }[] = pages.filter(({ page, lines }: { page: ImportPage; lines: Line[]; }): boolean => !headers.some((value: { page: ImportPage; header: Header; }): boolean => value.page.pageId === page.pageId) &&
        lines.map((line: Line): string => joined(line.spans)).join(' ').includes('Important information'));
    const informationText: string = informationPages.flatMap(({ lines }: { page: ImportPage; lines: Line[]; }): string[] => lines.map((line: Line): string => joined(line.spans))).join(' ');
    const basisEvidence: SourceEvidence[] = informationPages.flatMap(({ page, lines }: { page: ImportPage; lines: Line[]; }): SourceEvidence[] =>
        lines.filter((line: Line): boolean => joined(line.spans).includes('Central European Time')).flatMap((line: Line): SourceEvidence[] => evidence(page, line.spans)));
    const printedBasis: boolean = informationText.replace(/\s+/g, ' ').includes('Balances and account activities in this report were generated using Central European Time.');
    const dateBasis: "Date" | "Date (Central European Time)" = printedBasis && basisEvidence.length ? 'Date (Central European Time)' : 'Date';
    // Printed Global Account details do not identify the wallet whose activity is reported.
    const result: BankImportResult = { contractVersion: '1', status: 'complete', adapter: selection,
        sourceProvenance: sourceProvenance(input), accountSections: [{ sectionId: 'wallet-eur', currency: { value: 'EUR', evidence: currencyEvidence },
        accountReference: null, evidence: currencyEvidence }], transactions: [], unresolvedDrafts: [], issues: [...input.issues] };
    for (const [index, { page, lines }] of pages.entries()) {
        parsePage(page, lines, index, pages.length, headers, titles, dateBasis, basisEvidence, result);
    }
    if (result.issues.length || result.unresolvedDrafts.length) {
        result.status = 'partial';
    }
    const validated: ZodSafeParseResult<BankImportResult> = bankImportResultSchema.safeParse(result);
    return validated.success ? validated.data : emptyImportResult(input, 'failed',
        importIssue('result-limit-or-contract', 'The interpreted statement exceeds result limits or cannot be represented safely.'));
}

export const airwallexAdapter: BankAdapter = { metadata, parse, identify: (input: BankImportInput): boolean => {
    const lines: Line[] = input.pages.flatMap(linesOf);
    return /\bairwallex\b/i.test(lines.map((line: Line): string => joined(line.spans)).join('\n')) &&
        lines.some((line: Line): boolean => /^[A-Z]{3} Account Activity\b/.test(joined(line.spans))) && lines.some((line: Line): boolean => headerOf(line) !== null);
} };
