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
const metadata = { bankId: 'revolut', adapterId: 'revolut-business', version: '1', layouts: [{ layoutId: 'business-english-eur', version: '1' }] };
const selection = {
    bankId: metadata.bankId,
    adapterId: metadata.adapterId,
    version: metadata.version,
    layoutId: metadata.layouts[0].layoutId,
    layoutVersion: metadata.layouts[0].version
};
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const fullMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const amountPattern = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+)\\.\\d{2}';

function linesOf(page: ImportPage): Line[] {
    const lines: Line[] = [];
    const spans = [...page.spans].sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x || a.text.localeCompare(b.text));
    for (const span of spans) {
        const line = lines.at(-1);
        if (line && Math.abs(span.region.y - line.y) <= Math.min(2.5, span.region.height / 2)) line.spans.push(span);
        else lines.push({ y: span.region.y, spans: [span] });
    }
    for (const line of lines) line.spans.sort((a, b) => a.region.x - b.region.x || a.text.localeCompare(b.text));
    return lines;
}
function lineText(line: Line) {
    return line.spans
        .map((span) => span.text.trim())
        .filter(Boolean)
        .join(' ');
}
function label(line: Line, value: string): PositionedSpan[] | null {
    for (let start = 0; start < line.spans.length; start++) {
        for (let end = start + 1; end <= Math.min(line.spans.length, start + 3); end++) {
            const spans = line.spans.slice(start, end);
            if (
                spans
                    .map((span) => span.text.trim())
                    .join(' ')
                    .replace(/\s+/g, ' ') === value
            )
                return spans;
        }
    }
    return null;
}
function right(spans: PositionedSpan[]) {
    return Math.max(...spans.map((span) => span.region.x + span.region.width));
}
function evidence(page: ImportPage, spans: PositionedSpan[]): SourceEvidence[] {
    // Keep extraction methods separate, including hybrid text/OCR pages; do not invent sub-span coordinates.
    const values: SourceEvidence[] = [];
    for (const method of ['embedded-text', 'local-ocr'] as const) {
        const selected = spans.filter((span) => span.method === method && span.text.trim());
        if (!selected.length) continue;
        const x = Math.min(...selected.map((span) => span.region.x));
        const y = Math.min(...selected.map((span) => span.region.y));
        values.push({
            pageId: page.pageId,
            region: { x, y, width: right(selected) - x, height: Math.max(...selected.map((span) => span.region.y + span.region.height)) - y },
            rawText: selected.map((span) => span.text).join(' '),
            method
        });
    }
    return values;
}
function rowEvidence(page: ImportPage, row: Row) {
    return row.lines.flatMap((line) => evidence(page, line.spans));
}
function headerOf(line: Line): Header | null {
    const date = label(line, 'Date (UTC)');
    const description = label(line, 'Description');
    const out = label(line, 'Money out');
    const incoming = label(line, 'Money in');
    const balance = label(line, 'Balance');
    if (!date || !description || !out || !incoming || !balance) return null;
    const [dateLeft, descriptionLeft, outLeft, inLeft, balanceLeft] = [date, description, out, incoming, balance].map((spans) => spans[0].region.x);
    if (!(dateLeft < descriptionLeft && right(date) < descriptionLeft && right(description) < outLeft && right(out) < inLeft && right(incoming) < balanceLeft)) return null;
    return { line, descriptionLeft, outLeft, outRight: (right(out) + inLeft) / 2, inRight: (right(incoming) + balanceLeft) / 2 };
}
function columns(line: Line, header: Header) {
    const date: PositionedSpan[] = [];
    const description: PositionedSpan[] = [];
    const out: PositionedSpan[] = [];
    const incoming: PositionedSpan[] = [];
    const balance: PositionedSpan[] = [];
    for (const span of line.spans) {
        const end = span.region.x + span.region.width;
        if (span.region.x < header.descriptionLeft - 5) date.push(span);
        else if (end >= header.outLeft && end <= header.outRight) out.push(span);
        else if (end > header.outRight && end <= header.inRight) incoming.push(span);
        else if (end < header.outLeft) description.push(span);
        else balance.push(span);
    }
    return { date, description, out, incoming, balance };
}
function joined(spans: PositionedSpan[]) {
    return spans
        .map((span) => span.text.trim())
        .filter(Boolean)
        .join(' ');
}
function metadataField(page: ImportPage, line: Line, pattern: RegExp) {
    for (let index = 0; index < line.spans.length; index++) {
        const selected = line.spans.slice(index);
        const match = pattern.exec(joined(selected));
        if (match) return { match, evidence: evidence(page, selected) };
    }
    return null;
}
function dateOf(raw: string): string | null {
    // A narrow unlabeled transaction-type column can follow the date in this layout.
    const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+[A-Z]{3})?$/.exec(raw);
    if (!match) return null;
    const word = match[2].toLowerCase();
    let month = months.indexOf(word);
    if (month < 0) month = fullMonths.indexOf(word);
    if (month < 0) return null;
    const value = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return calendarDateSchema.safeParse(value).success ? value : null;
}
function amountOf(raw: string, currency: string, direction: 'incoming' | 'outgoing'): Money | null {
    const match = new RegExp(`^(?:${currency}\\s*|${currency === 'EUR' ? '€' : '\\$'}\\s*)?(${amountPattern})(?:\\s*${currency})?$`).exec(raw);
    if (!match) return null;
    const magnitude = BigInt(match[1].replace(/[,.\s]/g, ''));
    const coefficient = (direction === 'outgoing' ? -magnitude : magnitude).toString();
    const parsed = moneySchema.safeParse({ coefficient, currency, scale: 2 });
    return parsed.success ? parsed.data : null;
}
function interpretRow(page: ImportPage, row: Row, header: Header): { transaction: BankImportResult['transactions'][number] | null; draft: UnresolvedDraft | null } {
    const cells = row.lines.map((line) => columns(line, header));
    const source = rowEvidence(page, row);
    const issues: ImportIssue[] = [];
    const dates = cells.flatMap((cell) => cell.date);
    const out = cells.flatMap((cell) => cell.out);
    const incoming = cells.flatMap((cell) => cell.incoming);
    const descriptions = cells.flatMap((cell) => cell.description);
    const descriptionText = cells
        .map((cell) => joined(cell.description))
        .filter(Boolean)
        .join('\n');
    const date = dateOf(joined(dates));
    const bookingDate = date ? { value: date, basisLabel: 'Date (UTC)', evidence: evidence(page, dates) } : null;
    if (!bookingDate)
        issues.push(
            importIssue(
                'invalid-date',
                'The printed booking date is missing, invalid or ambiguous.',
                evidence(page, dates.length ? dates : row.lines[0].spans),
                row.rowId,
                'bookingDate'
            )
        );
    const direction: UnresolvedDraft['direction'] = out.length && !incoming.length ? 'outgoing' : incoming.length && !out.length ? 'incoming' : null;
    const amountSpans = direction === 'outgoing' ? out : direction === 'incoming' ? incoming : [...out, ...incoming];
    const amount = direction ? amountOf(joined(amountSpans), 'EUR', direction) : null;
    const accountAmount = amount ? { value: amount, evidence: evidence(page, amountSpans) } : null;
    if (!accountAmount)
        issues.push(
            importIssue(
                out.length && incoming.length ? 'conflicting-fields' : 'invalid-amount',
                'Exactly one readable money-out or money-in amount is required.',
                evidence(page, amountSpans.length ? amountSpans : row.lines[0].spans),
                row.rowId,
                'accountAmount'
            )
        );
    const description = descriptionText ? { value: descriptionText, evidence: evidence(page, descriptions) } : null;
    if (!description) issues.push(importIssue('missing-field', 'The transaction description is missing.', source, row.rowId, 'description'));
    const references: BankImportResult['transactions'][number]['references'] = [];
    let counterpartyCandidate: UnresolvedDraft['counterpartyCandidate'] = null;
    let reportedOriginalAmount: UnresolvedDraft['reportedOriginalAmount'] = null;
    for (const cell of cells) {
        const raw = joined(cell.description);
        const fieldSource = evidence(page, cell.description);
        const reference = /^(Reference|Payment reference|Transaction ID):\s*(.+)$/i.exec(raw);
        if (reference) references.push({ label: reference[1], value: reference[2], evidence: fieldSource });
        const counterparty = /^(?:To|From):\s*(.+)$/i.exec(raw);
        if (counterparty) {
            if (counterpartyCandidate)
                issues.push(importIssue('conflicting-fields', 'Multiple labeled counterparties need review.', fieldSource, row.rowId, 'counterpartyCandidate'));
            else counterpartyCandidate = { value: counterparty[1], evidence: fieldSource };
        }
        if (/^Original (?:payment )?amount:/i.test(raw)) {
            const original = new RegExp(`^Original (?:payment )?amount:\\s*(?:([A-Z]{3})\\s+(${amountPattern})|(${amountPattern})\\s+([A-Z]{3}))$`, 'i').exec(raw);
            const originalCurrency = original?.[1] ?? original?.[4];
            const originalValue = original?.[2] ?? original?.[3];
            const parsed = originalCurrency && originalValue && direction ? amountOf(originalValue, originalCurrency, direction) : null;
            if (!parsed || reportedOriginalAmount)
                issues.push(
                    importIssue(
                        'invalid-original-amount',
                        'The explicitly reported original amount is unreadable or conflicting.',
                        fieldSource,
                        row.rowId,
                        'reportedOriginalAmount'
                    )
                );
            else reportedOriginalAmount = { value: parsed, evidence: fieldSource };
        }
    }
    const base = {
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
    if (issues.length || !bookingDate || !accountAmount || !direction || !description) return { transaction: null, draft: { ...base, issues } };
    return { transaction: { ...base, bookingDate, accountAmount, direction, description }, draft: null };
}
function dateLooking(raw: string) {
    return /^(?:\d{1,2}|\?+)\s+[A-Za-z?]+\s+\d{4}\b/.test(raw);
}
function possibleRow(line: Line, header: Header) {
    const cell = columns(line, header);
    if (dateLooking(joined(cell.date))) return true;
    // Financial-column decimals flag damaged row coverage; they do not become a settlement amount here.
    const monetaryHint = (spans: PositionedSpan[]) => /^(?:[A-Z]{3}\s*|[€$]\s*)?-?\d[\d ,\u00a0\u202f]*\.\d+(?:\s*[A-Z]{3})?$/.test(joined(spans));
    const onlyMonetaryText =
        joined(cell.description)
            .replace(/[+-]?\s*(?:[A-Z]{3}\s*|[€$]\s*)?\d[\d ,\u00a0\u202f]*\.\d+(?:\s*[A-Z]{3})?/g, '')
            .trim() === '';
    // Legend totals can fill several columns with amounts. A running balance or descriptive text distinguishes possible rows.
    return cell.description.length > 0 && (monetaryHint(cell.balance) || (!onlyMonetaryText && (monetaryHint(cell.out) || monetaryHint(cell.incoming))));
}
function unresolvedRow(page: ImportPage, row: Row, code: string, message: string): UnresolvedDraft {
    const source = rowEvidence(page, row);
    const issue = importIssue(code, message, source, row.rowId);
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
function parse(input: BankImportInput): BankImportResult {
    const validated = bankImportInputSchema.safeParse(input);
    if (!validated.success) return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    input = validated.data;
    const pages = input.pages.map((page) => ({ page, lines: linesOf(page) }));
    const headers = pages.flatMap(({ page, lines }) =>
        lines.flatMap((line) => {
            const header = headerOf(line);
            return header ? [{ page, header }] : [];
        })
    );
    if (!headers.length)
        return emptyImportResult(
            input,
            input.pages.every((page) => page.status === 'failed') ? 'failed' : 'unsupported',
            importIssue('unsupported-layout', 'The supported Revolut transaction columns were not found.')
        );
    const metadataLines = pages.flatMap(({ page, lines }) => {
        const firstHeader = headers.find((value) => value.page.pageId === page.pageId);
        return firstHeader ? lines.filter((line) => line.y < firstHeader.header.line.y).map((line) => ({ page, line })) : [];
    });
    const currencyLines = metadataLines.flatMap(({ page, line }) => {
        const field = metadataField(page, line, /^Currency\s*:?\s+([A-Z]{3})$/);
        return field ? [{ value: field.match[1], evidence: field.evidence }] : [];
    });
    if (!currencyLines.length || currencyLines.some((field) => field.value !== 'EUR'))
        return emptyImportResult(
            input,
            'unsupported',
            importIssue(
                'unsupported-currency',
                'This Revolut adapter requires an explicit, consistent EUR account currency.',
                currencyLines.flatMap((field) => field.evidence)
            )
        );
    const currencyEvidence = currencyLines.flatMap((field) => field.evidence);
    const accountLines = metadataLines.flatMap(({ page, line }) => {
        const field = metadataField(page, line, /^(IBAN|Account number|Account identifier)\s*:?\s+(.+)$/);
        return field ? [{ label: field.match[1], value: field.match[2], evidence: field.evidence }] : [];
    });
    if (accountLines.length > 1 && accountLines.some((field) => field.label !== accountLines[0].label || field.value !== accountLines[0].value)) {
        return emptyImportResult(
            input,
            'unsupported',
            importIssue(
                'unsupported-account-sections',
                'Multiple account identifiers need a supported section mapping.',
                accountLines.flatMap((field) => field.evidence)
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
    let legendStarted = false;
    for (const { page, lines } of pages) {
        if (page.status === 'failed') {
            result.issues.push({ ...importIssue('failed-page', 'A source page could not be extracted.'), pageId: page.pageId });
            continue;
        }
        const pageHeaders = headers.filter((value) => value.page.pageId === page.pageId).map((value) => value.header);
        if (!pageHeaders.length) {
            const content = lines.map(lineText).join('\n');
            if (
                legendStarted &&
                /Money sent/i.test(content) &&
                /Money received/i.test(content) &&
                /Card payments/i.test(content) &&
                !lines.some((line) => possibleRow(line, headers[0].header))
            )
                continue;
            result.issues.push(importIssue('unclassified-page', 'A page has no supported transaction header and needs review.', evidence(page, lines[0]?.spans ?? [])));
            for (const [index, line] of lines.filter((line) => possibleRow(line, headers[0].header)).entries()) {
                const draft = unresolvedRow(
                    page,
                    { rowId: `p${page.pageNumber}-r${index + 1}`, lines: [line] },
                    'missing-table-header',
                    'A possible transaction row has no supported page header.'
                );
                result.unresolvedDrafts.push(draft);
                result.issues.push(...draft.issues);
            }
            continue;
        }
        let counter = 0;
        for (const [index, header] of pageHeaders.entries()) {
            const nextY = pageHeaders[index + 1]?.line.y ?? page.height;
            const body = lines.filter((line) => line.y > header.line.y + 2 && line.y < nextY);
            let row: Row | null = null;
            let sectionEnded = false;
            const flush = () => {
                if (!row) return;
                const parsed = interpretRow(page, row, header);
                if (parsed.transaction) result.transactions.push(parsed.transaction);
                if (parsed.draft) {
                    result.unresolvedDrafts.push(parsed.draft);
                    result.issues.push(...parsed.draft.issues);
                }
                row = null;
            };
            for (const line of body) {
                const raw = lineText(line);
                const cell = columns(line, header);
                if (/^Transaction types\b/i.test(raw)) {
                    flush();
                    legendStarted = true;
                    sectionEnded = true;
                    continue;
                }
                if (/^(?:Opening balance|Closing balance|Total money|Page \d+\b)/i.test(raw)) {
                    flush();
                    sectionEnded = true;
                    continue;
                }
                const footer = line.y > page.height * 0.85 && /(?:©|revolut(?:\.com|\s+(?:Ltd|Bank|Payments|is))|licensed by|registered office)/i.test(raw);
                if (footer && !dateLooking(joined(cell.date)) && !cell.out.length && !cell.incoming.length && !cell.balance.length) {
                    flush();
                    sectionEnded = true;
                    continue;
                }
                if (sectionEnded) {
                    if (possibleRow(line, header)) {
                        const draft = unresolvedRow(
                            page,
                            { rowId: `p${page.pageNumber}-r${++counter}`, lines: [line] },
                            'outside-table-row',
                            'A possible transaction appears after the table boundary and needs review.'
                        );
                        result.unresolvedDrafts.push(draft);
                        result.issues.push(...draft.issues);
                    }
                    continue;
                }
                // A printed running balance can anchor a damaged row, but never supplies its settlement amount.
                if (cell.date.length || cell.out.length || cell.incoming.length || cell.balance.length) {
                    flush();
                    row = { rowId: `p${page.pageNumber}-r${++counter}`, lines: [line] };
                } else if (row && cell.description.length) row.lines.push(line);
                else if (raw && !/^\s*$/.test(raw)) {
                    result.issues.push(importIssue('unclassified-region', 'Text in the transaction area could not be assigned to a row.', evidence(page, line.spans)));
                }
            }
            flush();
        }
    }
    if (result.issues.length || result.unresolvedDrafts.length) result.status = 'partial';
    const checked = bankImportResultSchema.safeParse(result);
    return checked.success
        ? checked.data
        : emptyImportResult(input, 'failed', importIssue('result-limit-or-contract', 'The interpreted statement exceeds result limits or cannot be represented safely.'));
}

export const revolutAdapter: BankAdapter = {
    metadata,
    identify: (input) => {
        const lines = input.pages.flatMap(linesOf);
        const content = lines.map(lineText).join('\n');
        return /\brevolut\b/i.test(content) && /\bAccount statement\b/i.test(content) && lines.some((line) => headerOf(line) !== null);
    },
    parse
};
