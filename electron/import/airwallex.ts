import {
    bankImportInputSchema, bankImportResultSchema, calendarDateSchema, emptyImportResult, importIssue, sourceProvenance,
    type BankAdapter, type BankImportInput, type BankImportResult, type ImportPage, type PositionedSpan, type SourceEvidence, type UnresolvedDraft
} from '../../src/shared/bank-import.js';
import { moneySchema, type Money } from '../../src/shared/money.js';

interface Line { spans: PositionedSpan[]; y: number; }
interface Header { line: Line; detailsLeft: number; creditLeft: number; creditRight: number; debitRight: number; }
interface Row { rowId: string; lines: Line[]; }
const metadata = { bankId: 'airwallex', adapterId: 'airwallex-business', version: '1', layouts: [{ layoutId: 'account-activity-english-eur', version: '1' }] };
const selection = { bankId: metadata.bankId, adapterId: metadata.adapterId, version: metadata.version,
    layoutId: metadata.layouts[0].layoutId, layoutVersion: metadata.layouts[0].version };
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const amountPattern = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)\\.\\d{2}';
const transactionTypes = new Set([
    'Card', 'Payout', 'Deposit', 'Conversion', 'Payin', 'Transfer', 'Charge', 'Adjustment', 'Purchase', 'Direct Debit', 'Fee', 'Batch Payout', 'Credit',
    'Prepayment', 'Liquidity', 'Repayment', 'Withholding Tax'
]);

function joined(spans: PositionedSpan[]) { return spans.map((span) => span.text.trim()).filter(Boolean).join(' '); }
function linesOf(page: ImportPage): Line[] {
    const lines: Line[] = [];
    for (const span of [...page.spans].sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x || a.text.localeCompare(b.text))) {
        const line = lines.at(-1);
        if (line && Math.abs(line.y - span.region.y) <= Math.min(2.5, span.region.height / 2)) line.spans.push(span);
        else lines.push({ spans: [span], y: span.region.y });
    }
    for (const line of lines) line.spans.sort((a, b) => a.region.x - b.region.x || a.text.localeCompare(b.text));
    return lines;
}
function right(spans: PositionedSpan[]) { return Math.max(...spans.map((span) => span.region.x + span.region.width)); }
function evidence(page: ImportPage, spans: PositionedSpan[]): SourceEvidence[] {
    return (['embedded-text', 'local-ocr'] as const).flatMap((method) => {
        const selected = spans.filter((span) => span.method === method && span.text.trim());
        if (!selected.length) return [];
        const x = Math.min(...selected.map((span) => span.region.x));
        const y = Math.min(...selected.map((span) => span.region.y));
        return [{ pageId: page.pageId, method, rawText: joined(selected), region: {
            x, y, width: right(selected) - x, height: Math.max(...selected.map((span) => span.region.y + span.region.height)) - y
        } }];
    });
}
function headerOf(line: Line): Header | null {
    const names = ['Date', 'Details', 'Credit', 'Debit', 'Balance'];
    const fields = names.map((name) => line.spans.find((span) => span.text.trim() === name));
    if (fields.some((field) => !field)) return null;
    const [date, details, credit, debit, balance] = fields as PositionedSpan[];
    if (!(right([date]) < details.region.x && right([details]) < credit.region.x && right([credit]) < debit.region.x && right([debit]) < balance.region.x)) return null;
    return { line, detailsLeft: details.region.x, creditLeft: credit.region.x, creditRight: debit.region.x, debitRight: balance.region.x };
}
function columns(line: Line, header: Header) {
    const date: PositionedSpan[] = [], details: PositionedSpan[] = [], credit: PositionedSpan[] = [], debit: PositionedSpan[] = [], balance: PositionedSpan[] = [];
    for (const span of line.spans) {
        const end = span.region.x + span.region.width;
        if (span.region.x < header.detailsLeft - 5) date.push(span);
        else if (end < header.creditLeft) details.push(span);
        else if (end <= header.creditRight) credit.push(span);
        else if (end <= header.debitRight) debit.push(span);
        else balance.push(span);
    }
    return { date, details, credit, debit, balance };
}
function dateOf(raw: string) {
    const match = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(raw);
    if (!match) return null;
    const month = months.indexOf(match[1].toLowerCase());
    const value = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    return month >= 0 && calendarDateSchema.safeParse(value).success ? value : null;
}
function amountOf(raw: string, currency: string, direction: 'incoming' | 'outgoing'): Money | null {
    const match = new RegExp(`^(${amountPattern})(?:\\s+${currency})?$`).exec(raw);
    if (!match) return null;
    const magnitude = BigInt(match[1].replace(/[,.]/g, ''));
    const parsed = moneySchema.safeParse({ coefficient: (direction === 'outgoing' ? -magnitude : magnitude).toString(), currency, scale: 2 });
    return parsed.success ? parsed.data : null;
}
function possibleRow(line: Line, header: Header) {
    const cells = columns(line, header);
    return /^[A-Za-z?]{3}\s+(?:\d{1,2}|\?+)\s+\d{4}\b/.test(joined(cells.date)) ||
        [...cells.credit, ...cells.debit, ...cells.balance].some((span) => /\d[\d,]*\.\d/.test(span.text)) ||
        transactionTypes.has(joined(cells.details));
}
function summary(line: Line) { return new RegExp(`^(?:Starting|Ending) balance\\s+${amountPattern}\\s+EUR$`).test(joined(line.spans)); }
function footer(line: Line, header: Header) { return line.spans[0].region.x >= header.creditLeft && /^Page \d+ of \d+$/.test(joined(line.spans)); }
function unresolved(page: ImportPage, row: Row, code: string, message: string): UnresolvedDraft {
    const source = row.lines.flatMap((line) => evidence(page, line.spans));
    return { rowId: row.rowId, accountSectionId: 'wallet-eur', bookingDate: null, valueDate: null, accountAmount: null, direction: null,
        reportedOriginalAmount: null, description: null, counterpartyCandidate: null, references: [], evidence: source,
        issues: [importIssue(code, message, source, row.rowId)] };
}
function interpret(page: ImportPage, row: Row, header: Header, dateBasis: string, basisEvidence: SourceEvidence[]) {
    const cells = row.lines.map((line) => columns(line, header));
    const source = row.lines.flatMap((line) => evidence(page, line.spans));
    const issues: BankImportResult['issues'] = [];
    const dates = cells.flatMap((cell) => cell.date), credits = cells.flatMap((cell) => cell.credit), debits = cells.flatMap((cell) => cell.debit);
    const details = cells.flatMap((cell) => cell.details);
    const descriptionText = cells.map((cell) => joined(cell.details)).filter(Boolean).join('\n');
    const description = descriptionText ? { value: descriptionText, evidence: evidence(page, details) } : null;
    const date = dateOf(joined(dates));
    const bookingDate = date ? { value: date, basisLabel: dateBasis, evidence: [...evidence(page, dates), ...basisEvidence] } : null;
    if (!bookingDate) issues.push(importIssue('invalid-date', 'The printed booking date is missing, invalid or ambiguous.', source, row.rowId, 'bookingDate'));
    const direction: UnresolvedDraft['direction'] = credits.length && !debits.length ? 'incoming' : debits.length && !credits.length ? 'outgoing' : null;
    const amountSpans = direction === 'incoming' ? credits : debits;
    const amount = direction ? amountOf(joined(amountSpans), 'EUR', direction) : null;
    const accountAmount = amount ? { value: amount, evidence: evidence(page, amountSpans) } : null;
    if (!accountAmount) issues.push(importIssue(credits.length && debits.length ? 'conflicting-fields' : 'invalid-amount',
        'Exactly one readable credit or debit amount is required.', source, row.rowId, 'accountAmount'));
    const kind = joined(cells[0].details);
    if (!transactionTypes.has(kind)) issues.push(importIssue('unknown-transaction-type', 'The transaction type or its row boundary needs review.', source, row.rowId));
    if (!description) issues.push(importIssue('missing-field', 'The transaction description is missing.', source, row.rowId, 'description'));
    let reportedOriginalAmount: UnresolvedDraft['reportedOriginalAmount'] = null;
    let counterpartyCandidate: UnresolvedDraft['counterpartyCandidate'] = null;
    const references: UnresolvedDraft['references'] = [];
    const text = descriptionText.replace(/\s+/g, ' ').trim();
    const detailEvidence = evidence(page, details);
    if (kind === 'Card') {
        const markers = [...text.matchAll(/\):/g)];
        if (markers.length) {
            const field = new RegExp(`^([A-Z]{3})\\s+(${amountPattern})(?:\\s+1\\s+EUR\\s*=\\s*\\d+(?:\\.\\d+)?\\s+[A-Z]{3})?$`).exec(text.slice(markers[0].index! + 2).trim());
            const original = field && markers.length === 1 && direction ? amountOf(field[2], field[1], direction) : null;
            if (original) reportedOriginalAmount = { value: original, evidence: detailEvidence };
            else issues.push(importIssue('invalid-original-amount', 'The explicitly reported original amount is unreadable or conflicting.',
                detailEvidence, row.rowId, 'reportedOriginalAmount'));
        }
        const party = /^Card (?:Card Refund - )?([^,]+),/.exec(text);
        if (party) counterpartyCandidate = { value: party[1], evidence: detailEvidence };
    } else if (kind === 'Payout') {
        const party = new RegExp(`^Payout Pay EUR ${amountPattern} to (.+)$`).exec(text);
        if (party) counterpartyCandidate = { value: party[1], evidence: detailEvidence };
    } else if (kind === 'Deposit') {
        const party = /^Deposit ([^|]+)\s*\|/.exec(text);
        if (party) counterpartyCandidate = { value: party[1].trim(), evidence: detailEvidence };
    }
    for (const match of text.matchAll(/\b(Ref|Reference|Payment reference|Transaction ID):\s*([^|]*)(?=\||$)/g)) {
        if (match[2].trim()) references.push({ label: match[1], value: match[2].trim(), evidence: detailEvidence });
    }
    const base = { rowId: row.rowId, accountSectionId: 'wallet-eur', bookingDate, valueDate: null, accountAmount, direction,
        reportedOriginalAmount, description, counterpartyCandidate, references, evidence: source };
    if (issues.length || !bookingDate || !accountAmount || !direction || !description) return { draft: { ...base, issues }, transaction: null };
    return { transaction: { ...base, bookingDate, accountAmount, direction, description }, draft: null };
}
function parse(input: BankImportInput): BankImportResult {
    const checkedInput = bankImportInputSchema.safeParse(input);
    if (!checkedInput.success) return emptyImportResult(null, 'failed', importIssue('invalid-input', 'The extracted statement data does not satisfy the import contract.'));
    input = checkedInput.data;
    const pages = input.pages.map((page) => ({ page, lines: linesOf(page) }));
    const content = pages.flatMap(({ lines }) => lines.map((line) => joined(line.spans))).join('\n');
    const headers = pages.flatMap(({ page, lines }) => lines.flatMap((line) => { const header = headerOf(line); return header ? [{ page, header }] : []; }));
    if (!/\bairwallex\b/i.test(content) || !headers.length) return emptyImportResult(input, input.pages.every((page) => page.status === 'failed') ? 'failed' : 'unsupported',
        importIssue('unsupported-layout', 'The supported Airwallex transaction columns were not found.'));
    const titles = pages.flatMap(({ page, lines }) => lines.flatMap((line) => {
        const match = /^([A-Z]{3}) Account Activity(?: \(Continued\))?(?:\s+.*)?$/.exec(joined(line.spans));
        return match && line.spans[0].region.x < headers[0].header.detailsLeft - 5 ? [{ page, line, currency: match[1] }] : [];
    }));
    if (!titles.length || titles.some((title) => title.currency !== 'EUR')) return emptyImportResult(input, 'unsupported',
        importIssue('unsupported-currency', 'This Airwallex adapter requires explicit, consistent EUR wallet activity.',
            titles.flatMap(({ page, line }) => evidence(page, line.spans))));
    const currencyEvidence = titles.flatMap(({ page, line }) => evidence(page, line.spans));
    const informationPages = pages.filter(({ page, lines }) => !headers.some((value) => value.page.pageId === page.pageId) &&
        /Important information/.test(lines.map((line) => joined(line.spans)).join(' ')));
    const informationText = informationPages.flatMap(({ lines }) => lines.map((line) => joined(line.spans))).join(' ');
    const basisEvidence = informationPages.flatMap(({ page, lines }) =>
        lines.filter((line) => /Central European Time/.test(joined(line.spans))).flatMap((line) => evidence(page, line.spans)));
    const printedBasis = /Balances and account activities in this report were generated using Central European Time\./.test(informationText.replace(/\s+/g, ' '));
    const dateBasis = printedBasis && basisEvidence.length ? 'Date (Central European Time)' : 'Date';
    // Printed Global Account details do not identify the wallet whose activity is reported.
    const result: BankImportResult = { contractVersion: '1', status: 'complete', adapter: selection,
        sourceProvenance: sourceProvenance(input), accountSections: [{ sectionId: 'wallet-eur', currency: { value: 'EUR', evidence: currencyEvidence },
        accountReference: null, evidence: currencyEvidence }], transactions: [], unresolvedDrafts: [], issues: [...input.issues] };
    for (const { page, lines } of pages) {
        if (page.pageNumber !== input.pages.indexOf(page) + 1) result.issues.push({
            ...importIssue('missing-page', 'The extraction does not cover consecutive source pages.'), pageId: page.pageId
        });
        for (const line of lines) {
            const count = footer(line, headers[0].header) ? /^Page (\d+) of (\d+)$/.exec(joined(line.spans)) : null;
            if (count && (Number(count[1]) !== page.pageNumber || Number(count[2]) !== pages.length))
                result.issues.push(importIssue('incomplete-page-coverage', 'The printed page count does not match the extracted source coverage.', evidence(page, line.spans)));
        }
        if (page.status === 'failed') { result.issues.push({ ...importIssue('failed-page', 'A source page could not be extracted.'), pageId: page.pageId }); continue; }
        const pageHeaders = headers.filter((value) => value.page.pageId === page.pageId).map((value) => value.header);
        const fallback = headers[0].header;
        if (!pageHeaders.length) {
            const possible = lines.some((line) => !summary(line) && !footer(line, fallback) && possibleRow(line, fallback));
            const pageContent = lines.map((line) => joined(line.spans)).join('\n');
            const information = /Important information/.test(pageContent) && /Account Details/.test(pageContent) &&
                /Account Balance/.test(pageContent) && /Transaction Types/.test(pageContent);
            const closing = lines.length > 0 && lines.every((line) => footer(line, fallback) || (summary(line) && /^Ending/.test(joined(line.spans))));
            if (!possible && (information || closing)) continue;
            result.issues.push({ ...importIssue('unclassified-page', 'A page has no supported transaction header and needs review.'), pageId: page.pageId });
        }
        let counter = 0;
        const sections = pageHeaders.map((header, index) => ({ header, start: header.line.y + 2, end: pageHeaders[index + 1]?.line.y ?? page.height,
            inTable: titles.some((title) => title.page.pageId === page.pageId && title.line.y < header.line.y) }));
        const firstTitle = titles.find((title) => title.page.pageId === page.pageId && title.line.y < pageHeaders[0]?.line.y);
        if (firstTitle) {
            const leading = lines.filter((line) => line.y > firstTitle.line.y + 2 && line.y < pageHeaders[0].line.y && !summary(line) && !footer(line, fallback));
            if (leading.length) {
                result.issues.push(importIssue('missing-table-header', 'Content before the first supported transaction header needs review.',
                    leading.flatMap((line) => evidence(page, line.spans))));
                sections.unshift({ header: fallback, start: firstTitle.line.y + 2, end: pageHeaders[0].line.y, inTable: false });
            }
        }
        if (!sections.length) sections.push({ header: fallback, start: -1, end: page.height, inTable: false });
        for (const { header, start, end, inTable } of sections) {
            const body = lines.filter((line) => line.y > start && line.y < end);
            let row: Row | null = null;
            let ended = false;
            let anchored = false;
            const flush = (uncertainBoundary = false) => {
                if (!row) return;
                const parsed = inTable && !ended && !uncertainBoundary ? interpret(page, row, header, dateBasis, basisEvidence) : { transaction: null,
                    draft: unresolved(page, row, uncertainBoundary ? 'ambiguous-row-boundary' : inTable ? 'outside-table-row' : 'missing-table-header',
                        'A possible transaction has no unambiguous supported table context.') };
                if (parsed.transaction) result.transactions.push(parsed.transaction);
                if (parsed.draft) { result.unresolvedDrafts.push(parsed.draft); result.issues.push(...parsed.draft.issues); }
                row = null; anchored = false;
            };
            for (const line of body) {
                if (footer(line, header)) { flush(); ended = true; continue; }
                if (summary(line)) { flush(); if (/^Ending/.test(joined(line.spans))) ended = true; continue; }
                const cell = columns(line, header);
                const financial = cell.date.length > 0 || cell.credit.length > 0 || cell.debit.length > 0 || cell.balance.length > 0;
                const category = transactionTypes.has(joined(cell.details)) && !financial;
                if (!inTable && !row && !possibleRow(line, header)) continue;
                const previous = row?.lines.at(-1);
                // A separated, unlabeled block must not contaminate the preceding transaction's details.
                const separated = anchored && previous && line.y - previous.y > 2 * Math.max(...row!.lines.flatMap((value) => value.spans.map((span) => span.region.height)));
                if (category || (financial && anchored) || separated) flush(Boolean(financial && anchored && !category && !separated));
                if (!row) row = { rowId: `p${page.pageNumber}-r${++counter}`, lines: [] };
                row.lines.push(line);
                anchored ||= financial;
            }
            flush();
        }
    }
    if (result.issues.length || result.unresolvedDrafts.length) result.status = 'partial';
    const validated = bankImportResultSchema.safeParse(result);
    return validated.success ? validated.data : emptyImportResult(input, 'failed',
        importIssue('result-limit-or-contract', 'The interpreted statement exceeds result limits or cannot be represented safely.'));
}

export const airwallexAdapter: BankAdapter = { metadata, parse, identify: (input) => {
    const lines = input.pages.flatMap(linesOf);
    return /\bairwallex\b/i.test(lines.map((line) => joined(line.spans)).join('\n')) &&
        lines.some((line) => /^[A-Z]{3} Account Activity\b/.test(joined(line.spans))) && lines.some((line) => headerOf(line) !== null);
} };
