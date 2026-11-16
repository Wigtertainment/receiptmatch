import type { BankImportInput, BankImportResult, ImportIssue, ImportPage, PositionedSpan, SourceEvidence, TransactionCandidate, UnresolvedDraft } from '../../src/shared/bank-import.js';
import type { Money } from '../../src/shared/money.js';
import { BANK_IMPORT_LIMITS, bankImportResultSchema, calendarDateSchema, emptyImportResult, importIssue, sourceProvenance } from '../../src/shared/bank-import.js';
import { moneySchema } from '../../src/shared/money.js';

type ColumnRole = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'currency';
type Columns = Partial<Record<ColumnRole, number>>;
type Table = readonly (readonly string[])[];
interface Line { center: number; height: number; spans: PositionedSpan[] }
interface Header { line: Line; index: number; cells: PositionedSpan[][]; columns: Columns }
interface SourceRow { cells: PositionedSpan[][]; values: string[]; crossesColumn: boolean }
interface StatementPage { page: ImportPage; lines: Line[]; table: Table | undefined; header: Header | null }
type Currency = BankImportResult['accountSections'][number]['currency'];
type Proposal = Pick<BankImportResult, 'transactions' | 'unresolvedDrafts' | 'issues'>;

const labels: Record<ColumnRole, readonly string[]> = {
    date: ['date', 'booking date', 'posting date', 'booked on', 'posted date', 'posted', 'buchungstag', 'buchungsdatum', 'datum'],
    description: ['description', 'details', 'transaction description', 'memo', 'narrative', 'verwendungszweck', 'beschreibung', 'buchungstext'],
    amount: ['amount', 'transaction amount', 'signed amount', 'betrag', 'buchungsbetrag'],
    debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'soll', 'belastung', 'ausgang'],
    credit: ['credit', 'deposit', 'deposits', 'money in', 'paid in', 'haben', 'gutschrift', 'eingang'],
    balance: ['balance', 'running balance', 'account balance', 'saldo', 'kontostand'],
    currency: ['currency', 'transaction currency', 'account currency', 'ccy', 'währung', 'buchungswährung']
};
const roles: ColumnRole[] = ['date', 'description', 'amount', 'debit', 'credit', 'balance', 'currency'];
const currencyCode: RegExp = /(?:^|[/|]\s*)(?:(?:account )?currency|kontow(?:ä|ae)hrung|w(?:ä|ae)hrung)(?:\s*:\s*|\s+)([A-Z]{3})(?=\s*(?:$|[/|]))/giu;
const accountLabel: RegExp = /(?:^|[/|]\s*)(iban|account (?:number|no\.?)|kontonummer)\s*:\s*([\dA-Z][\dA-Z -]{2,41})(?=\s*(?:$|[/|]))/giu;
const balanceSummary: RegExp = /^(?:(?:opening|closing|starting|ending) balance|balance (?:brought|carried) forward|anfangssaldo|endsaldo|saldovortrag)$/iu;
const acceptedCurrencies: Set<string> = new Set(Intl.supportedValuesOf('currency'));
const months: readonly string[][] = [['jan'], ['feb'], ['mar', 'mär', 'mrz'], ['apr'], ['may', 'mai'], ['jun'], ['jul'], ['aug'], ['sep'], ['oct', 'okt'], ['nov'], ['dec', 'dez']];
const dateLike: RegExp = /^(?:[\d?]{1,4}[./-]|\d{1,2} [\p{L}]{3}\b|[\p{L}]{3} \d{1,2}\b)/u;

function comparable(text: string): string {
    return text.normalize('NFC').replace(/\s+/gu, ' ').replaceAll('−', '-').trim();
}

function textOf(spans: readonly PositionedSpan[]): string {
    return comparable(spans.map((span: PositionedSpan): string => span.text).join(' '));
}

function evidence(page: ImportPage, spans: readonly PositionedSpan[]): SourceEvidence[] {
    return spans.slice(0, BANK_IMPORT_LIMITS.evidence).map((span: PositionedSpan): SourceEvidence => ({ pageId: page.pageId, rawText: span.text, method: span.method, region: span.region }));
}

function linesOf(page: ImportPage): Line[] {
    const lines: Line[] = [];
    const centerY: (span: PositionedSpan) => number = (span: PositionedSpan): number => span.region.y + span.region.height / 2;
    for (const span of [...page.spans].sort((left: PositionedSpan, right: PositionedSpan): number => centerY(left) - centerY(right))) {
        const center: number = centerY(span);
        const line: Line | undefined = lines.at(-1);
        if (line && center - line.center <= Math.min(line.height, span.region.height) * 0.45) {
            line.spans.push(span);
        } else {
            lines.push({ center, height: span.region.height, spans: [span] });
        }
    }
    for (const line of lines) {
        line.spans.sort((left: PositionedSpan, right: PositionedSpan): number => left.region.x - right.region.x);
    }
    return lines;
}

function classifyHeader(row: readonly string[]): Columns | null {
    const columns: Columns = {};
    for (const [index, value] of row.entries()) {
        const role: ColumnRole | undefined = roles.find((candidate: ColumnRole): boolean => labels[candidate].includes(comparable(value).toLowerCase()));
        if (role) {
            if (columns[role] !== undefined) {
                return null;
            }
            columns[role] = index;
        }
    }
    const signed: boolean = columns.amount !== undefined && columns.debit === undefined && columns.credit === undefined;
    const split: boolean = columns.amount === undefined && columns.debit !== undefined && columns.credit !== undefined;
    return columns.date !== undefined && columns.description !== undefined && (signed || split) ? columns : null;
}

function headerCells(row: readonly string[], spans: PositionedSpan[]): PositionedSpan[][] | null {
    let start: number = 0;
    const cells: PositionedSpan[][] = [];
    for (const label of row) {
        let end: number = start + 1;
        const name: string = comparable(label).toLowerCase();
        while (end < spans.length && name.startsWith(`${textOf(spans.slice(start, end)).toLowerCase()} `)) {
            end++;
        }
        const field: PositionedSpan[] = spans.slice(start, end);
        if (!name || textOf(field).toLowerCase() !== name) {
            return null;
        }
        cells.push(field);
        start = end;
    }
    return start === spans.length ? cells : null;
}

function headerOf(table: Table, lines: Line[]): Header | null {
    let header: Header | null = null;
    for (const [index, row] of table.entries()) {
        const columns: Columns | null = classifyHeader(row);
        if (!columns) {
            continue;
        }
        for (const line of lines) {
            const cells: PositionedSpan[][] | null = headerCells(row, line.spans);
            if (!cells) {
                continue;
            }
            if (header) {
                return null;
            }
            header = { index, line, cells, columns };
        }
    }
    return header;
}

function cellCenter(spans: PositionedSpan[]): number {
    const first: PositionedSpan = spans[0];
    const last: PositionedSpan = spans[spans.length - 1];
    return (first.region.x + last.region.x + last.region.width) / 2;
}

function sourceRows(lines: Line[], header: Header): SourceRow[] {
    const centers: number[] = header.cells.map(cellCenter);
    const boundaries: number[] = centers.slice(1).map((center: number, index: number): number => (center + centers[index]) / 2);
    return lines.slice(lines.indexOf(header.line) + 1).map((line: Line): SourceRow => {
        const cells: PositionedSpan[][] = centers.map((): PositionedSpan[] => []);
        let crossesColumn: boolean = false;
        for (const span of line.spans) {
            const { x, width }: PositionedSpan['region'] = span.region;
            const next: number = boundaries.findIndex((edge: number): boolean => x + width / 2 < edge);
            cells[next < 0 ? cells.length - 1 : next].push(span);
            crossesColumn ||= boundaries.some((edge: number): boolean => x < edge && x + width > edge);
        }
        return { cells, values: cells.map(textOf), crossesColumn };
    });
}

function columnValue(row: readonly string[], columns: Columns, role: ColumnRole): string {
    const index: number | undefined = columns[role];
    return index === undefined ? '' : comparable(row[index] ?? '');
}

function looksLikeBooking(row: readonly string[], columns: Columns): boolean {
    const financial: ColumnRole[] = ['amount', 'debit', 'credit'];
    const details: string = columnValue(row, columns, 'description');
    if (balanceSummary.test(details)) {
        return false;
    }
    return dateLike.test(columnValue(row, columns, 'date')) || financial.some((role: ColumnRole): boolean => /\d/u.test(columnValue(row, columns, role))) ||
        (!!details && /\d/u.test(columnValue(row, columns, 'balance')));
}

function key(row: readonly string[], columns: Columns): string {
    return JSON.stringify(roles.map((role: ColumnRole): string => columnValue(row, columns, role)));
}

function rowCounts(rows: readonly (readonly string[])[], columns: Columns): Map<string, number> {
    const counts: Map<string, number> = new Map();
    for (const row of rows) {
        const fingerprint: string = key(row, columns);
        counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    }
    return counts;
}

function calendarDay(year: string, month: string, day: string): string | null {
    const parsed: ReturnType<typeof calendarDateSchema.safeParse> = calendarDateSchema.safeParse(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    return parsed.success ? parsed.data : null;
}

function bookingDate(raw: string): string | null {
    const iso: RegExpExecArray | null = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
    const dotted: RegExpExecArray | null = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(raw);
    if (iso) {
        return calendarDay(iso[1], iso[2], iso[3]);
    }
    if (dotted) {
        return calendarDay(dotted[3], dotted[2], dotted[1]);
    }
    const named: RegExpExecArray | null = /^(\d{1,2}) ([\p{L}]{3}) (\d{4})$/u.exec(raw);
    if (!named) {
        return null;
    }
    const month: number = months.findIndex((names: string[]): boolean => names.includes(named[2].toLowerCase())) + 1;
    return calendarDay(named[3], String(month), named[1]);
}

function magnitude(raw: string, currency: string, direction: TransactionCandidate['direction']): Money | null {
    const unsigned: string = raw.replace(/^[+-]/u, '');
    const parts: RegExpExecArray | null = /^(\d{1,3}(?:,\d{3})+)\.(\d+)$/u.exec(unsigned) ?? /^(\d{1,3}(?:\.\d{3})+),(\d+)$/u.exec(unsigned) ??
        /^(\d{1,3}(?: \d{3})+)(?:[.,](\d+))?$/u.exec(unsigned) ?? /^(\d+)(?:[.,](\d+))?$/u.exec(unsigned);
    if (!parts || (/^\d{1,3}$/u.test(parts[1]) && parts[2]?.length === 3)) {
        return null;
    }
    const fraction: string = parts[2] ?? '';
    const digits: string = `${parts[1].replace(/\D/gu, '')}${fraction}`.replace(/^0+/u, '') || '0';
    const parsed: ReturnType<typeof moneySchema.safeParse> = moneySchema.safeParse({ coefficient: direction === 'outgoing' && digits !== '0' ? `-${digits}` : digits, currency, scale: fraction.length });
    return parsed.success ? parsed.data : null;
}

function splitMovement(debit: string, credit: string, currency: string): { role: 'debit' | 'credit'; value: Money; direction: TransactionCandidate['direction'] } | null {
    const outgoing: Money | null = debit ? magnitude(debit, currency, 'outgoing') : null;
    const incoming: Money | null = credit ? magnitude(credit, currency, 'incoming') : null;
    if (debit.startsWith('+') || credit.startsWith('-') || (debit && !outgoing) || (credit && !incoming)) {
        return null;
    }
    if (outgoing && outgoing.coefficient !== '0') {
        return incoming && incoming.coefficient !== '0' ? null : { role: 'debit', value: outgoing, direction: 'outgoing' };
    }
    return incoming && incoming.coefficient !== '0' ? { role: 'credit', value: incoming, direction: 'incoming' } : null;
}

function amountOf(page: ImportPage, row: SourceRow, header: Header, currency: string): Pick<TransactionCandidate, 'accountAmount' | 'direction'> | null {
    const { columns }: Header = header;
    if (columns.amount !== undefined) {
        const raw: string = columnValue(row.values, columns, 'amount');
        const direction: TransactionCandidate['direction'] = raw.startsWith('-') ? 'outgoing' : 'incoming';
        const value: Money | null = /^[+-]/u.test(raw) ? magnitude(raw, currency, direction) : null;
        return value && value.coefficient !== '0' ? { direction, accountAmount: { value, evidence: evidence(page, [...row.cells[columns.amount], ...header.cells[columns.amount]]) } } : null;
    }
    const movement: ReturnType<typeof splitMovement> = splitMovement(columnValue(row.values, columns, 'debit'), columnValue(row.values, columns, 'credit'), currency);
    if (!movement) {
        return null;
    }
    const index: number = columns[movement.role]!;
    return { direction: movement.direction, accountAmount: { value: movement.value, evidence: evidence(page, [...row.cells[index], ...header.cells[index]]) } };
}

function metadataLines({ header, lines }: StatementPage): Line[] {
    return header ? lines.slice(0, lines.indexOf(header.line)) : [];
}

function hasConflictingAccounts(pages: StatementPage[]): boolean {
    const ibans: Set<string> = new Set();
    const numbers: Set<string> = new Set();
    for (const page of pages) {
        for (const line of metadataLines(page)) {
            for (const match of textOf(line.spans).matchAll(accountLabel)) {
                const value: string = match[2].toUpperCase().replace(/[ -]/gu, '');
                if (/\d/u.test(value)) {
                    (match[1].toLowerCase() === 'iban' ? ibans : numbers).add(value);
                }
            }
        }
    }
    return ibans.size > 1 || numbers.size > 1;
}

function currencyOf(pages: StatementPage[]): Currency | null {
    const currencies: Map<string, SourceEvidence[]> = new Map();
    for (const page of pages) {
        for (const line of metadataLines(page)) {
            for (const match of textOf(line.spans).matchAll(currencyCode)) {
                const code: string = match[1];
                if (code !== code.toUpperCase()) {
                    continue;
                }
                currencies.set(code, currencies.get(code) ?? evidence(page.page, line.spans));
            }
        }
    }
    if (currencies.size !== 1) {
        return null;
    }
    const [value, source]: [string, SourceEvidence[]] = [...currencies][0];
    return acceptedCurrencies.has(value) ? { value, evidence: source } : null;
}

function pageIssue(page: ImportPage, code: string, message: string): ImportIssue {
    return { ...importIssue(code, message), pageId: page.pageId };
}

function appendRow(result: Proposal, page: ImportPage, row: SourceRow, header: Header, currency: Currency, rowId: string, corroborated: boolean): void {
    const dateIndex: number = header.columns.date!;
    const descriptionIndex: number = header.columns.description!;
    const date: string | null = bookingDate(row.values[dateIndex]);
    const description: string = row.values[descriptionIndex];
    const agreesOnCurrency: boolean = header.columns.currency === undefined || columnValue(row.values, header.columns, 'currency') === currency.value;
    const settlement: Pick<TransactionCandidate, 'accountAmount' | 'direction'> | null = corroborated && agreesOnCurrency && !row.crossesColumn ? amountOf(page, row, header, currency.value) : null;
    const source: SourceEvidence[] = evidence(page, row.cells.flat());
    const candidate: Omit<UnresolvedDraft, 'issues'> = {
        rowId, accountSectionId: 'statement', bookingDate: date ? { value: date, basisLabel: textOf(header.cells[dateIndex]), evidence: evidence(page, row.cells[dateIndex]) } : null,
        valueDate: null, description: description ? { value: description, evidence: evidence(page, row.cells[descriptionIndex]) } : null,
        accountAmount: settlement?.accountAmount ?? null, direction: settlement?.direction ?? null, reportedOriginalAmount: null, counterpartyCandidate: null, references: [], evidence: source
    };
    if (candidate.bookingDate && candidate.description && settlement) {
        result.transactions.push({ ...candidate, bookingDate: candidate.bookingDate, description: candidate.description, ...settlement });
    } else {
        const issue: ImportIssue = corroborated
            ? importIssue('unresolved-table-row', 'The booking date, description, currency or signed amount could not be established.', source, rowId)
            : importIssue('table-source-mismatch', 'The local table recognition could not confirm this source row in its original columns.', source, rowId);
        result.unresolvedDrafts.push({ ...candidate, issues: [issue] });
    }
}

function appendPage(result: Proposal, { page, lines, table, header }: StatementPage, currency: Currency): void {
    if (!table || !header) {
        result.issues.push(pageIssue(page, 'unverified-table-page', 'No transaction table could be verified against the original page.'));
        return;
    }
    const rows: SourceRow[] = sourceRows(lines, header).filter((row: SourceRow): boolean => looksLikeBooking(row.values, header.columns));
    const modelRows: (readonly string[])[] = table.slice(header.index + 1).filter((row: readonly string[]): boolean => looksLikeBooking(row, header.columns));
    const modelCounts: Map<string, number> = rowCounts(modelRows.filter((row: readonly string[]): boolean => row.length === header.cells.length), header.columns);
    const sourceCounts: Map<string, number> = rowCounts(rows.map((row: SourceRow): string[] => row.values), header.columns);
    let matched: number = 0;
    for (const [index, row] of rows.entries()) {
        const fingerprint: string = key(row.values, header.columns);
        const corroborated: boolean = sourceCounts.get(fingerprint) === modelCounts.get(fingerprint);
        matched += Number(corroborated);
        appendRow(result, page, row, header, currency, `p${page.pageNumber}-r${index + 1}`, corroborated);
    }
    if (matched < modelRows.length || !rows.length) {
        result.issues.push(pageIssue(page, 'unverified-table-coverage', 'The recognized table could not be fully reconciled with booking rows on the original page.'));
    }
}

export function proposeStatementTransactions(input: BankImportInput, tables: ReadonlyMap<number, Table>, recognitionIssues: readonly ImportIssue[] = []): BankImportResult {
    const pages: StatementPage[] = input.pages.map((page: ImportPage): StatementPage => {
        const lines: Line[] = linesOf(page);
        const table: Table | undefined = tables.get(page.pageNumber);
        return { page, lines, table, header: table && page.status === 'complete' ? headerOf(table, lines) : null };
    });
    const rows: Proposal = { transactions: [], unresolvedDrafts: [], issues: [...input.issues, ...recognitionIssues] };
    if (!pages.some((page: StatementPage): boolean => !!page.header)) {
        return emptyImportResult({ ...input, issues: rows.issues }, 'failed', importIssue('no-verified-table-pages', 'No transaction table could be verified against the original statement.'));
    }
    if (hasConflictingAccounts(pages)) {
        return emptyImportResult({ ...input, issues: rows.issues }, 'failed', importIssue('multiple-statement-accounts', 'The original statement identifies multiple accounts.'));
    }
    const currency: Currency | null = currencyOf(pages);
    if (!currency) {
        return emptyImportResult({ ...input, issues: rows.issues }, 'failed', importIssue('unverified-account-currency', 'The original statement must establish one account currency before bookings can be proposed.'));
    }
    for (const page of pages) {
        appendPage(rows, page, currency);
    }
    if (!rows.transactions.length && !rows.unresolvedDrafts.length) {
        return emptyImportResult({ ...input, issues: rows.issues }, 'failed', importIssue('no-verified-table-rows', 'No booking rows could be verified against the original statement.'));
    }
    if (rows.unresolvedDrafts.length) {
        rows.issues.push(importIssue('unresolved-table-rows', 'Some original booking rows need review.'));
    }
    const checked: ReturnType<typeof bankImportResultSchema.safeParse> = bankImportResultSchema.safeParse({
        contractVersion: '1', status: rows.issues.length ? 'partial' : 'complete', adapter: null, localRecognition: { model: 'nuextract3', parserVersion: '1' },
        sourceProvenance: sourceProvenance(input), accountSections: [{ sectionId: 'statement', currency, accountReference: null, evidence: currency.evidence }], ...rows
    });
    return checked.success ? checked.data : emptyImportResult(input, 'failed', importIssue('invalid-table-proposal', 'The proposed bookings could not satisfy the bank import contract.'));
}
