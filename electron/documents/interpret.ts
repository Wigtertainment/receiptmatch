import type { ZodSafeParseResult } from 'zod';
import { bankImportInputSchema, calendarDateSchema, type BankImportInput, type ImportPage, type PositionedSpan, type SourceEvidence } from '../../src/shared/bank-import.js';
import { recoveredReceiptTaxPrefix } from '../../src/shared/document-display.js';
import { documentScalarConflicts, supportingDocumentSchema, type DocumentIssue, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';

interface Line { page: ImportPage; spans: PositionedSpan[]; text: string; }
interface PageInterpretation { paymentBlock: SourceEvidence[]; fxPage: boolean; }


type AmountField = DocumentSection['amounts'][number];
type AmountCandidate = AmountField['candidates'][number];
type DateField = DocumentSection['dates'][number];
type ReferenceField = DocumentSection['references'][number];
type CurrencyField = DocumentSection['currencies'][number];
type AmountRole = DocumentSection['amounts'][number]['role'];
type DateRole = DocumentSection['dates'][number]['role'];
type ReferenceRole = DocumentSection['references'][number]['role'];
const code: "(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|PLN|CZK|RON|HUF|INR|BRL|ZAR|AED|ILS|TRY)" = '(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|PLN|CZK|RON|HUF|INR|BRL|ZAR|AED|ILS|TRY)';
const currencyPattern: RegExp = new RegExp(`\\b${code}\\b`, 'g');
const numberPattern: RegExp = /(?<![\p{L}\d])(?:[-−+(]\s*)*(?:[$€£]\s*)?(?:[-−+(]\s*)*\d[\d.,'’]*(?: \d{3}(?!\d)(?:[.,'’]\d+)*)*(?:\s*\))?[\p{L}?+−-]*/gu;
const amountText: "(?:(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|PLN|CZK|RON|HUF|INR|BRL|ZAR|AED|ILS|TRY)\\s*)?[-−+(\\s]*[$€£]?\\s*\\d[\\d.,'’]*(?: \\d{3}(?:[.,'’]\\d+)*)*\\s*\\)?(?:\\s*(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|PLN|CZK|RON|HUF|INR|BRL|ZAR|AED|ILS|TRY))?" = `(?:${code}\\s*)?[-−+(\\s]*[$€£]?\\s*\\d[\\d.,'’]*(?: \\d{3}(?:[.,'’]\\d+)*)*\\s*\\)?(?:\\s*${code})?`;
const explicitRefund: RegExp = new RegExp(`^\\s*(?:amount refunded|refunded amount|refund issued|refund paid|refund completed)\\s*:?\\s*${amountText}\\s*$`, 'i');
const explicitPayment: RegExp = new RegExp(`^\\s*(?:payment(?: received| made| completed)?|paid amount|amount paid|cash (?:amount|payment)|received payment|gezahlter betrag)\\s*:?\\s*${amountText}\\s*$`, 'i');
const appliedTransactions: RegExp = /applied transactions?:?$/i;
const endPaymentBlock: RegExp = /balance due|subtotal|invoice total|grand total/i;
const plannedPayment: RegExp = /^\s*payment\s+(?:scheduled|pending|due|expected|planned)\b/i;
const monthNames: string[][] = [
	['jan', 'january', 'januar'], ['feb', 'february', 'februar'], ['mar', 'march', 'mär', 'märz'], ['apr', 'april'], ['may', 'mai'], ['jun', 'june', 'juni'],
	['jul', 'july', 'juli'], ['aug', 'august'], ['sep', 'sept', 'september'], ['oct', 'october', 'okt', 'oktober'], ['nov', 'november'], ['dec', 'december', 'dez', 'dezember']
];

function order(left: PositionedSpan, right: PositionedSpan): number {
	return left.region.y - right.region.y || left.region.x - right.region.x || left.text.localeCompare(right.text) || left.method.localeCompare(right.method);
}

function sameVisualRow(a: PositionedSpan['region'], b: PositionedSpan['region']): boolean {
	const overlap: number = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return overlap > 0 && overlap >= Math.min(a.height, b.height) / 2;
}

function linesOf(page: ImportPage): Line[] {
	const lines: Line[] = [];
	for (const span of page.spans) {
		if (!span.text.trim()) {
			continue;
		}
		const current: Line | undefined = lines.at(-1);
		if (current && Math.abs(current.spans[0].region.y - span.region.y) <= Math.min(2.5, span.region.height / 2)) {
			current.spans.push(span);
		} else {
			lines.push({ page, spans: [span], text: '' });
		}
	}
	for (const line of lines) {
		line.spans.sort((a: PositionedSpan, b: PositionedSpan): number => a.region.x - b.region.x || order(a, b));
		line.text = line.spans.map((span: PositionedSpan): string => span.text.trim()).join(' ');
	}
	return lines;
}

function source(line: Line): SourceEvidence[] {
	return (['embedded-text', 'local-ocr'] as const).flatMap((method: "embedded-text" | "local-ocr"): SourceEvidence[] => {
		const spans: PositionedSpan[] = line.spans.filter((span: PositionedSpan): boolean => span.method === method);
		if (!spans.length) {
			return [];
		}
		const x: number = Math.min(...spans.map((span: PositionedSpan): number => span.region.x)), y: number = Math.min(...spans.map((span: PositionedSpan): number => span.region.y));
		return [{ pageId: line.page.pageId, method, rawText: spans.map((span: PositionedSpan): string => span.text.trim()).join(' ').slice(0, 16384), region: {
			x, y, width: Math.max(...spans.map((span: PositionedSpan): number => span.region.x + span.region.width)) - x,
			height: Math.max(...spans.map((span: PositionedSpan): number => span.region.y + span.region.height)) - y
		} }];
	});
}

function unique<T>(values: T[]): T[] {
	return values.filter((value: T, index: number): boolean => values.findIndex((other: T): boolean => JSON.stringify(other) === JSON.stringify(value)) === index);
}

function currencies(raw: string): string[] {
	return unique([...raw.matchAll(currencyPattern)].map((match: RegExpExecArray): string => match[0]).concat(raw.includes('€') ? ['EUR'] : []));
}

function issue(code: string, message: string, sectionId: string | null = null, fieldId: string | null = null, field: string | null = null, evidence: SourceEvidence[] = []): DocumentIssue {
	return { code, severity: 'warning', message, sectionId, fieldId, field, evidence };
}

function heading(raw: string): DocumentSection['kind'] | null {
	const value: string = raw.trim().replace(/[:\s]+$/g, '').toLowerCase();
	if (/^(?:billing|bill) summary$/.test(value)) {
		return 'billing-summary';
	}
	if (/^(?:credit note|gutschrift)$/.test(value)) {
		return 'credit-note';
	}
	if (/^(?:tax invoice|invoice|credit invoice|rechnung|auftragsbestätigung\s*\/\s*rechnung)$/.test(value)) {
		return 'invoice';
	}
	if (/^(?:receipt|passenger\s*\/\s*itinerary receipt|restaurant receipt|quittung|kassenbon)$/.test(value)) {
		return 'receipt';
	}
	if (/^(?:payment instructions?|exchange rate|exchange rate information|payment information)$/.test(value)) {
		return 'payment-information';
	}
	return null;
}

function taxRegistration(raw: string): boolean {
	const value: string = raw.trim();
	if (/^(?:(?:VAT|Tax)(?:\s+registration)?\s*(?:ID\b|number\b|no\b|#)|(?:USt[-.]?IdNr|Steuernummer|TIC)\b)/i.test(value)) {
		return true;
	}
	return /^(?:VAT|Tax)(?:\s*[:;]\s*|\s+)(?:(?:[A-Z]{2})?\d{6,}[A-Z]?|\d{1,3}(?:[., ]\d{3})+[A-Z]?)\s*$/i.test(value);
}

function amountRole(raw: string, kind: DocumentSection['kind'], paymentBlock: boolean, informationalFx: boolean): AmountRole | null {
	if (taxRegistration(raw)) {
		return null;
	}
	if (/exchange rate|pricing currency|informational (?:fx|amount)/i.test(raw) || informationalFx) {
		return 'informational-fx';
	}
	if (explicitRefund.test(raw)) {
		return 'refund-payment';
	}
	const totalRole: "billed-total" | "credit-note-component" = kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
	const labels: [AmountRole, RegExp][] = [
		['credit-note-component', /credit note total|gutschriftsbetrag|credit[- ]note component/gi],
		['subtotal', /\bsub[- ]?total\s*\(?including\s*(?:VAT|Tax)\)?/gi],
		['tax', /\b(?:VAT|Tax)\s+Total\b/gi],
		[totalRole, /total amount payable|zu zahlender betrag|invoice total|grand total|total amount|total\s*\(?including\s*(?:vat|tax)?\)?|gesamtsumme|gesamtbetrag|summe rechnungsbetrag|rechnungsbetrag|rechnungssumme|\btotal\b/gi],
		['balance-due', /balance due|amount due|payment due|amount payable|restbetrag|offener betrag|betrag fällig/gi],
		['payment', /applied transactions?|payment received|paid amount|amount paid|cash (?:amount|payment)|received payment|angewandte zahlung|gezahlter betrag|payment\b(?!\s*(?:due|date|method|terms|instructions))/gi],
		['subtotal', /total\s*\(?excluding\s*(?:vat|tax)\)?|subtotal|sub-total|zwischensumme|netto|net amount/gi],
		['tax', /tax amount|\btax\b|\bvat\b|umsatzsteuer|mehrwertsteuer|mwst/gi],
		['line-item', /\b(?:price|amount|credit|charge|discount|adjustment|line item|line-item|unit|preis|betrag)\b/gi]
	];
	const matches: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; end: number; priority: number; }[] = labels.flatMap(([role, pattern]: ["unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item", RegExp], priority: number): { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; end: number; priority: number; }[] => [...raw.matchAll(pattern)].map((match: RegExpExecArray): { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; end: number; priority: number; } => ({ role, end: match.index + match[0].length, priority })));
	return matches.sort((a: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; end: number; priority: number; }, b: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; end: number; priority: number; }): number => b.end - a.end || a.priority - b.priority)[0]?.role ?? (paymentBlock ? 'payment' : null);
}

function columnAmounts(line: Line, next: Line | undefined, kind: DocumentSection['kind'], previous: Line | undefined): { label: string; role: AmountRole; value: string; evidence: SourceEvidence[]; }[] {
	if (next?.page.pageId !== line.page.pageId || next.spans[0].region.y - line.spans[0].region.y > 24) {
		return [];
	}
	if (previous?.page.pageId === line.page.pageId && line.spans[0].region.y - previous.spans[0].region.y <= 24 &&
		(/^(?:phone|telephone|tel\.?|fax|telefon|account|customer|invoice number|receipt number|order|table|reference|date)\b/i.test(previous.text) || /^[^\d]{1,80}:\s*$/.test(previous.text))) {
			return [];
		}
	const cells: { label: string; role: AmountRole; value: string; evidence: SourceEvidence[] }[] = [];
	const used: Set<PositionedSpan> = new Set<PositionedSpan>();
	for (const label of next.spans) {
		const role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item" | null = amountRole(label.text, kind, false, false);
		if (!role || !['billed-total', 'balance-due', 'credit-note-component', 'subtotal', 'tax', 'payment'].includes(role)) {
			continue;
		}
		const values: PositionedSpan[] = line.spans.filter((span: PositionedSpan): boolean => Math.abs(span.region.x - label.region.x) <= 4 && /\d/.test(span.text));
		if (values.length !== 1 || used.has(values[0])) {
			continue;
		}
		const value: PositionedSpan = values[0];
		const numeric: string = value.text.replace(currencyPattern, '').trim();
		const tokens: RegExpExecArray[] = [...numeric.matchAll(numberPattern)];
		if (tokens.length !== 1 || tokens[0][0].trim() !== numeric) {
			continue;
		}
		used.add(value);
		cells.push({ label: label.text, role, value: value.text, evidence: [...source({ ...line, spans: [value] }), ...source({ ...next, spans: [label] })] });
	}
	return cells;
}

function numericAmount(raw: string): string | null {
	let numeric: string = raw.trim().replace(/[€$£\s]/g, '').replace(/−/g, '-').replace(/^[-+(]/, '').replace(/\)$/, '');
	if (/['’]/.test(numeric)) {
		if (!/^\d{1,3}(['’])\d{3}(?:\1\d{3})*(?:[.,]\d{1,18})?$/.test(numeric)) {
			return null;
		}
		numeric = numeric.replace(/['’]/g, '');
	}
	if (!/^\d+(?:[.,]\d+)*$/.test(numeric)) {
		return null;
	}
	return numeric;
}

function numberCandidates(raw: string): { coefficient: string; scale: number }[] {
	const negative: boolean = /^\s*[-(−]/.test(raw.replace(/[€$£\s]/g, ''));
	const value: string | null = numericAmount(raw);
	if (value === null) {
		return [];
	}
	const comma: number = value.lastIndexOf(','), dot: number = value.lastIndexOf('.');
	const result: { coefficient: string; scale: number }[] = [];
	const append: (integer: string, fraction?: string) => void = (integer: string, fraction: string = ''): void => {
		if (fraction.length > 18 || integer.length + fraction.length > 127) {
			return;
		}
		const magnitude: bigint = BigInt(integer + fraction);
		result.push({ coefficient: (negative ? -magnitude : magnitude).toString(), scale: fraction.length });
	};
	if (comma >= 0 && dot >= 0) {
		appendMixedSeparators(value, comma > dot ? ',' : '.', append);
	} else if (comma >= 0 || dot >= 0) {
		const separator: "." | "," = comma >= 0 ? ',' : '.', parts: string[] = value.split(separator);
		if (parts.length === 2) {
			append(parts[0], parts[1]);
		}
		if (/^\d{1,3}([.,]\d{3})+$/.test(value)) {
			append(parts.join(''));
		}
	} else {
		append(value);
	}
	return unique(result);
}

function appendMixedSeparators(value: string, separator: '.' | ',', append: (integer: string, fraction?: string) => void): void {
	const grouping: '.' | ',' = separator === ',' ? '.' : ',';
	const [integer, fraction, extra]: string[] = value.split(separator);
	if (extra === undefined && new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integer)) {
		append(integer.split(grouping).join(''), fraction);
	}
}

function invoiceSummaryTotal(lines: Line[], currency: string | null): Omit<DocumentSection['amounts'][number], 'id'> | null {
	const headings: { index: number; span: PositionedSpan; }[] = lines.flatMap((line: Line, index: number): { index: number; span: PositionedSpan; }[] => line.spans.filter((span: PositionedSpan): boolean => /^invoicesummary:?$/i.test(span.text.replace(/\s/g, ''))).map((span: PositionedSpan): { index: number; span: PositionedSpan; } => ({ index, span })));
	if (headings.length !== 1) {
		return null;
	}
	const { index, span }: { index: number; span: PositionedSpan; } = headings[0];
	const [title, headers, net, tax, total]: Line[] = lines.slice(index, index + 5);
	if (!total || [headers, net, tax, total].some((line: Line, offset: number): boolean => line.page !== title.page || line.spans[0].region.y - lines[index + offset].spans[0].region.y > 24)) {
		return null;
	}
	const netHeader: PositionedSpan = headers.spans.at(-1)!;
	if (!/^net amount$/i.test(netHeader.text.trim()) || netHeader.region.x < span.region.x || total.spans.length !== 1) {
		return null;
	}
	const rightCell: (line: Line) => PositionedSpan | undefined = (line: Line): PositionedSpan | undefined => {
		const cells: PositionedSpan[] = line.spans.filter((cell: PositionedSpan): boolean => cell.region.x >= netHeader.region.x);
		return cells.length === 1 ? cells[0] : undefined;
	};
	const netValue: PositionedSpan | undefined = rightCell(net), taxValue: PositionedSpan | undefined = rightCell(tax), printedTotal: PositionedSpan | undefined = rightCell(total);
	if (!netValue || !taxValue || !printedTotal || !/^(?:vat|tax) (?:amount|total)\s*:?$/i.test(tax.spans.filter((cell: PositionedSpan): boolean => cell !== taxValue).map((cell: PositionedSpan): string => cell.text.trim()).join(' '))) {
		return null;
	}
	const values: PositionedSpan[] = [netValue, taxValue, printedTotal];
	const rightEdges: number[] = values.map(({ region }: PositionedSpan): number => region.x + region.width);
	if (Math.max(...rightEdges) - Math.min(...rightEdges) > 3) {
		return null;
	}
	const printedCurrencies: string[] = unique(values.flatMap((value: PositionedSpan): string[] => currencies(value.text)));
	if (printedCurrencies.length > 1 || (currency && printedCurrencies.some((value: string): boolean => value !== currency))) {
		return null;
	}
	const established: string = printedCurrencies[0] ?? currency;
	if (!established) {
		return null;
	}
	const amounts: { coefficient: string; scale: number; }[][] = values.map((value: PositionedSpan): { coefficient: string; scale: number; }[] => numberCandidates(value.text.replace(currencyPattern, '')));
	if (amounts.some((candidates: { coefficient: string; scale: number; }[]): boolean => candidates.length !== 1)) {
		return null;
	}
	const [netAmount, taxAmount, totalAmount]: { coefficient: string; scale: number; }[] = amounts.map((candidates: { coefficient: string; scale: number; }[]): { coefficient: string; scale: number; } => candidates[0]);
	const scale: number = Math.max(netAmount.scale, taxAmount.scale, totalAmount.scale);
	const scaled: (value: { coefficient: string; scale: number; }) => bigint = (value: typeof totalAmount): bigint => BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
	if (scaled(netAmount) + scaled(taxAmount) !== scaled(totalAmount)) {
		return null;
	}
	return { role: 'billed-total', label: 'Invoice summary total', candidates: [{ ...totalAmount, currency: established }],
		evidence: [...source({ ...title, spans: [span] }), ...source({ ...headers, spans: [netHeader] }), ...source({ ...net, spans: [netValue] }), ...source(tax), ...source(total)] };
}

interface VatLayout {
	line: Line;
	total: PositionedSpan;
	vatRow: PositionedSpan;
	breakdown: PositionedSpan[];
	totalRow: PositionedSpan[];
	printed: PositionedSpan[];
	net: PositionedSpan;
	tax: PositionedSpan;
	rate: RegExpExecArray;
}

function receiptVatLayout(lines: Line[]): VatLayout | null {
	const totals: { line: Line; span: PositionedSpan; }[] = lines.flatMap((line: Line): { line: Line; span: PositionedSpan; }[] => line.spans.filter((span: PositionedSpan): boolean => /^total\s*:?$/i.test(span.text.trim())).map((span: PositionedSpan): { line: Line; span: PositionedSpan; } => ({ line, span })));
	if (totals.length !== 1) {
		return null;
	}
	const { line, span: total }: { line: Line; span: PositionedSpan; } = totals[0];
	const spans: PositionedSpan[] = lines.filter((other: Line): boolean => other.page === line.page).flatMap((other: Line): PositionedSpan[] => other.spans);
	const columns: PositionedSpan[] = spans.filter((span: PositionedSpan): boolean => /^base$/i.test(span.text.trim()) && span.region.y > total.region.y && span.region.y - total.region.y <= total.region.height * 4);
	if (columns.length !== 1) {
		return null;
	}
	const [base]: PositionedSpan[] = columns;
	const visualRow: (span: PositionedSpan) => PositionedSpan[] = (span: PositionedSpan): PositionedSpan[] => spans.filter((other: PositionedSpan): boolean => other.method === span.method && sameVisualRow(other.region, span.region))
		.sort((a: PositionedSpan, b: PositionedSpan): number => a.region.x - b.region.x);
	const headers: PositionedSpan[] = visualRow(base);
	const left: PositionedSpan[] = headers.filter((span: PositionedSpan): boolean => span.region.x < base.region.x);
	const taxColumn: PositionedSpan | undefined = headers.find((span: PositionedSpan): boolean => span.region.x > base.region.x && /^tax$/i.test(span.text.trim()));
	if (!taxColumn || !/^(?:tax|vat)\s+included$/i.test(left.map((span: PositionedSpan): string => span.text.trim()).join(' '))) {
		return null;
	}
	const vatRows: PositionedSpan[] = spans.filter((span: PositionedSpan): boolean => /^vat(?:\s|$)/i.test(span.text.trim()) && span.region.y > base.region.y && span.region.y - base.region.y <= base.region.height * 4);
	if (vatRows.length !== 1) {
		return null;
	}
	const [vatRow]: PositionedSpan[] = vatRows;
	const breakdown: PositionedSpan[] = visualRow(vatRow);
	const rate: RegExpExecArray | null = /^vat\s+(\d{1,2})\s*%/i.exec(breakdown.map((span: PositionedSpan): string => span.text.trim()).join(' '));
	const decimal: RegExp = /^\d{1,18}[.,]\d{2}$/;
	const values: PositionedSpan[] = breakdown.filter((span: PositionedSpan): boolean => decimal.test(span.text.trim()));
	if (!rate || values.length !== 2) {
		return null;
	}
	const [net, tax]: PositionedSpan[] = values;
	const boundary: number = (base.region.x + base.region.width / 2 + taxColumn.region.x + taxColumn.region.width / 2) / 2;
	if (net.region.x <= left.at(-1)!.region.x + left.at(-1)!.region.width || net.region.x + net.region.width >= boundary || tax.region.x <= boundary) {
		return null;
	}
	const totalRow: PositionedSpan[] = visualRow(total).filter((span: PositionedSpan): boolean => span.region.x > total.region.x + total.region.width);
	const printed: PositionedSpan[] = totalRow.filter((span: PositionedSpan): boolean => decimal.test(span.text.trim()));
	if (printed.length !== 1 || printed[0].region.x <= boundary) {
		return null;
	}
	return { line, total, vatRow, breakdown, totalRow, printed, net, tax, rate };
}

interface VatValues { currency: string; netValue: bigint; taxValue: bigint; sum: bigint; reconstructed: boolean; }

function receiptVatValues(layout: VatLayout, declared: string | null): VatValues | null {
	const { total, breakdown, totalRow, printed, net, tax, rate }: VatLayout = layout;
	const cellText: string = [...breakdown, ...totalRow].map((span: PositionedSpan): string => span.text.trim()).join(' ');
	const codes: string[] = currencies(cellText);
	if (codes.length > 1 || (declared && codes.some((code: string): boolean => code !== declared)) || /[$£¥]/.test(cellText)) {
		return null;
	}
	const currency: string = codes[0] ?? declared;
	if (!currency) {
		return null;
	}
	const coefficient: (span: PositionedSpan) => bigint = (span: PositionedSpan): bigint => BigInt(span.text.trim().replace(/[.,]/, ''));
	const netValue: bigint = coefficient(net), taxValue: bigint = coefficient(tax);
	if ((netValue * BigInt(rate[1]) + 50n) / 100n !== taxValue) {
		return null;
	}
	const sum: bigint = netValue + taxValue, shown: bigint = coefficient(printed[0]);
	const reconstructed: boolean = shown !== sum;
	const cents: string = sum.toString().padStart(3, '0');
	const digits: string = printed[0].text.trim().replace(/[.,]/, '');
	// A damaged leading digit can be recovered only when the remaining printed digits agree.
	if (reconstructed && (total.method !== 'local-ocr' || cents.length !== digits.length + 1 || !cents.endsWith(digits))) {
		return null;
	}
	return { currency, netValue, taxValue, sum, reconstructed };
}

function receiptVatTotal(section: DocumentSection, lines: Line[], declared: string | null): { originalFields: AmountField[]; amounts: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; reconstructed: boolean; totalEvidence: SourceEvidence[]; } | null {
	const taxFields: AmountField[] = section.amounts.filter((field: AmountField): boolean => field.role === 'tax');
	if ((section.kind !== 'receipt' && section.kind !== 'unknown') || taxFields.length < 2 || section.amounts.some((field: AmountField): boolean => field.role === 'billed-total')) {
		return null;
	}
	const layout: VatLayout | null = receiptVatLayout(lines);
	if (!layout) {
		return null;
	}
	const { line, total, vatRow, breakdown, totalRow }: VatLayout = layout;
	const values: VatValues | null = receiptVatValues(layout, declared);
	if (!values) {
		return null;
	}
	const { currency, netValue, taxValue, sum, reconstructed }: VatValues = values;
	const originalFields: AmountField[] = taxFields.filter((field: AmountField): boolean => field.evidence.some((evidence: SourceEvidence): boolean =>
		evidence.pageId === line.page.pageId && /^vat\s+\d+\s*%/i.test(evidence.rawText) && sameVisualRow(evidence.region, vatRow.region)));
	if (originalFields.length !== 2 || !originalFields.every((field: AmountField, index: number): boolean => field.candidates.length === 1 && field.candidates[0].scale === 2 &&
		field.candidates[0].coefficient === (index === 0 ? netValue : taxValue).toString() && (!field.candidates[0].currency || field.candidates[0].currency === currency))) {
			return null;
		}
	const amounts: { coefficient: string; scale: number; currency: string; }[] = [netValue, taxValue, sum].map((value: bigint): { coefficient: string; scale: number; currency: string; } => ({ coefficient: value.toString(), scale: 2, currency }));
	const evidence: SourceEvidence[] = source({ ...line, spans: breakdown });
	return { originalFields, amounts, evidence, reconstructed, totalEvidence: [...source({ ...line, spans: [total, ...totalRow] }), ...evidence] };
}

interface ReceiptItemAmounts { cents: string; items: PositionedSpan[][]; }

function collectReceiptItems(spans: PositionedSpan[], label: PositionedSpan, amount: PositionedSpan, visualRow: (span: PositionedSpan) => PositionedSpan[],
	established: string, suffix: string, totalRow: PositionedSpan[]): ReceiptItemAmounts | null {
	const decimal: RegExp = /^\d{1,18}[.,]\d{2}$/;
	const rightEdge: number = amount.region.x + amount.region.width;
	const itemAmounts: PositionedSpan[] = spans.filter((span: PositionedSpan): boolean => span.method === 'local-ocr' && span.region.y < label.region.y &&
		decimal.test(span.text.trim()) && Math.abs(span.region.x + span.region.width - rightEdge) <= label.region.height)
		.sort(order);
	const items: PositionedSpan[][] = [];
	let sum: bigint = 0n;
	let previous: PositionedSpan = label;
	for (const price of itemAmounts.reverse()) {
		if (previous.region.y - price.region.y > Math.max(previous.region.height, price.region.height) * 4) {
			break;
		}
		const item: PositionedSpan[] = visualRow(price);
		if (item.filter((span: PositionedSpan): boolean => /\d+[.,]\d/.test(span.text)).length !== 1 || item.some((span: PositionedSpan): boolean => /[$£¥%]|^[-−+(]$/.test(span.text.trim()))) {
			return null;
		}
		const description: string = item.filter((span: PositionedSpan): boolean => span.region.x < price.region.x).map((span: PositionedSpan): string => span.text.trim()).join(' ');
		if (!/^\d{1,3}\s+\p{L}/u.test(description) || /\b(?:subtotal|total|tax|vat|tip|discount|service charge|change|refund)\b/i.test(description)) {
			return null;
		}
		const itemCurrency: string[] = currencies(item.map((span: PositionedSpan): string => span.text).join(' '));
		if (itemCurrency.some((code: string): boolean => code !== established)) {
			return null;
		}
		sum += BigInt(price.text.trim().replace(/[.,]/, ''));
		items.push(item);
		previous = price;
	}
	const cents: string = sum.toString();
	if (items.length < 2 || items.length > 120 || cents.length !== suffix.length + 1 || !cents.endsWith(suffix)) {
		return null;
	}
	// Reject extra meaningful text between the counted rows and the total.
	const counted: Set<PositionedSpan> = new Set([...items.flat(), ...totalRow]);
	if (spans.some((span: PositionedSpan): boolean => span.region.y >= previous.region.y && span.region.y < label.region.y &&
		/[\p{L}\d]/u.test(span.text) && !counted.has(span))) {
			return null;
		}
	return { cents, items };
}

function receiptItemTotal(section: DocumentSection, lines: Line[], currency: string | null): { existing: AmountField; amount: { coefficient: string; scale: number; currency: string; }; evidence: SourceEvidence[]; } | null {
	if (section.kind !== 'receipt' && section.kind !== 'unknown') {
		return null;
	}
	const totals: AmountField[] = section.amounts.filter((field: AmountField): boolean => field.role === 'billed-total');
	if (totals.length > 1 || section.amounts.some((field: AmountField): boolean => ['subtotal', 'payment', 'balance-due', 'refund-payment'].includes(field.role))) {
		return null;
	}
	const printed: Line[] = lines.filter((line: Line): boolean => /^(?:\d{1,2}:\d{2}\s+)?(?:grand\s+)?total\b/i.test(line.text));
	if (printed.length !== 1) {
		return null;
	}
	const [line]: Line[] = printed;
	const spans: PositionedSpan[] = lines.filter((other: Line): boolean => other.page === line.page).flatMap((other: Line): PositionedSpan[] => other.spans);
	const label: PositionedSpan | undefined = line.spans.find((span: PositionedSpan): boolean => /^(?:grand\s+)?total:?$/i.test(span.text.trim()));
	if (label?.method !== 'local-ocr') {
		return null;
	}
	const visualRow: (anchor: PositionedSpan) => PositionedSpan[] = (anchor: PositionedSpan): PositionedSpan[] => spans.filter((span: PositionedSpan): boolean => span.method === 'local-ocr' && sameVisualRow(span.region, anchor.region))
		.sort((a: PositionedSpan, b: PositionedSpan): number => a.region.x - b.region.x);
	const decimal: RegExp = /^\d{1,18}[.,]\d{2}$/;
	const totalRow: PositionedSpan[] = visualRow(label);
	const totalAmounts: PositionedSpan[] = totalRow.filter((span: PositionedSpan): boolean => decimal.test(span.text.trim()) && span.region.x > label.region.x + label.region.width);
	if (totalAmounts.length !== 1) {
		return null;
	}
	const [amount]: PositionedSpan[] = totalAmounts;
	const suffix: string = amount.text.trim().replace(/[.,]/, '');
	const rowText: string = totalRow.map((span: PositionedSpan): string => span.text.trim()).join(' ');
	const codes: string[] = currencies(rowText);
	if (/[$£¥−-]/.test(rowText) || codes.length > 1 || (codes[0] && currency && codes[0] !== currency)) {
		return null;
	}
	const established: string = codes[0] ?? currency;
	if (!established) {
		return null;
	}
	const existing: AmountField = totals[0];
	if (existing && (existing.candidates.length !== 1 || existing.candidates[0].coefficient !== BigInt(suffix).toString() ||
		existing.candidates[0].scale !== 2 || (existing.candidates[0].currency !== null && existing.candidates[0].currency !== established) ||
		!existing.evidence.some((item: SourceEvidence): boolean => item.pageId === line.page.pageId && sameVisualRow(item.region, amount.region)))) {
			return null;
		}

	const recovered: ReceiptItemAmounts | null = collectReceiptItems(spans, label, amount, visualRow, established, suffix, totalRow);
	if (!recovered) {
		return null;
	}
	const { cents, items }: ReceiptItemAmounts = recovered;
	return { existing, amount: { coefficient: cents, scale: 2, currency: established },
		evidence: [...source({ ...line, spans: totalRow }), ...items.reverse().flatMap((item: PositionedSpan[]): SourceEvidence[] => source({ ...line, spans: item }))] };
}

function defaultDocumentCurrency(lines: Line[]): "EUR" | null {
	return lines.some(({ text }: Line): boolean => currencies(text).length > 0 || /\p{Sc}|\b(?:currency|währung)\s*[:=]\s*\p{L}/iu.test(text)) ? null : 'EUR';
}

function recoverStoredReceipt(result: SupportingDocument, section: DocumentSection): { lines: Line[]; total: { label: string; candidates: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; id: string; }; } | undefined {
	const total: AmountField | undefined = section.amounts.find((field: AmountField): boolean => field.role === 'billed-total');
	if (result.sections.length !== 1 || !result.input || total?.candidates.length !== 1 || total.candidates[0].currency !== null ||
		!total.evidence.some((item: SourceEvidence): boolean => item.method === 'local-ocr')) {
			return undefined;
		}
	const pages: ImportPage[] = result.input.pages.filter((page: ImportPage): boolean => section.pageIds.includes(page.pageId));
	const lines: Line[] = pages.flatMap((page: ImportPage): Line[] => linesOf({ ...page, spans: [...page.spans].sort(order) }));
	const declared: Set<string> = new Set(section.currencies.filter((field: CurrencyField): boolean => field.role === 'settlement').flatMap((field: CurrencyField): string[] => field.candidates));
	if (declared.size > 1) {
		return undefined;
	}
	const recovered: ReturnType<typeof receiptItemTotal> = receiptItemTotal(section, lines, [...declared][0] ?? defaultDocumentCurrency(lines));
	if (!recovered) {
		return undefined;
	}
	return { lines, total: { ...total, label: 'Total reconstructed from receipt items', candidates: [recovered.amount], evidence: recovered.evidence } };
}


export function evaluateStoredReceipt(result: SupportingDocument): SupportingDocument {
	const section: DocumentSection = result.sections[0];
	if (!section) {
		return result;
	}
	const recovered: { lines: Line[]; total: { label: string; candidates: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; id: string; }; } | undefined = recoverStoredReceipt(result, section);
	if (!recovered) {
		return result;
	}
	const { lines, total }: { lines: Line[]; total: { label: string; candidates: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; id: string; }; } = recovered;
	const falseTaxes: Set<string> = new Set(section.amounts.filter((field: AmountField): boolean | 0 => field.role === 'tax' &&
		field.evidence.length && field.evidence.every((item: SourceEvidence): boolean => taxRegistration(item.rawText))).map((field: AmountField): string => field.id));
	const amounts: AmountField[] = section.amounts.filter((field: AmountField): boolean => !falseTaxes.has(field.id)).map((field: AmountField): AmountField => field.id === total.id ? total : field);
	const fieldIds: Set<string> = new Set([section.sectionId, ...[...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies]
		.map((field: AmountField | CurrencyField | DateField | { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | ReferenceField): string => field.id)]);
	let taxNumber: number = 0;
	for (const tax of receiptCategoryTaxes(section, lines, total.candidates[0].currency)) {
		if (amounts.some((field: AmountField): boolean => field.role === 'tax' && field.label === tax.label)) {
			continue;
		}
		let id: string;
		do {
			id = recoveredReceiptTaxPrefix + ++taxNumber;
		} while (fieldIds.has(id));
		amounts.push({ ...tax, id });
	}
	const issues: DocumentIssue[] = result.issues.filter((item: DocumentIssue): boolean => !item.fieldId || (!falseTaxes.has(item.fieldId) && (item.fieldId !== total.id || item.code !== 'missing-currency')));
	issues.push(issue('reconstructed-total', 'The total was reconstructed from the printed item amounts because the OCR missed a leading digit.',
		section.sectionId, total.id, total.role, total.evidence));
	return { ...result, sections: [{ ...section, amounts }], issues };
}

function receiptCategoryTax(line: Line, next: Line | undefined, kind: DocumentSection['kind'], currency: string | null): Omit<AmountField, 'id'> | null {
	const separate: boolean = !!next && sameVisualRow(line.spans[0].region, next.spans[0].region) &&
		next.spans[0].region.x > line.spans.at(-1)!.region.x + line.spans.at(-1)!.region.width;
	const split: boolean = separate && /%\s*$/.test(line.text);
	const text: string = split ? line.text + ' ' + next!.text : line.text;
	const match: RegExpExecArray | null = /^([\p{L}][\p{L} ./&-]{0,39}\s*\d{1,2}(?:[.,]\d{1,2})?\s*%)\s*(?:([A-Z]{3}|€)\s*)?(\d+[.,]\d{2})(?:\s*([A-Z]{3}|€))?$/u.exec(text);
	if (!match || amountRole(match[1], kind, false, false)) {
		return null;
	}
	const codes: string[] = currencies(text);
	if ((match[2] || match[4]) && codes.length !== 1) {
		return null;
	}
	const evidence: SourceEvidence[] = [...source(line), ...(split ? source(next!) : [])];
	return { role: 'tax', label: match[1], candidates: numberCandidates(match[3]).map((value: { coefficient: string; scale: number; }): { currency: string; coefficient: string; scale: number; } => ({ ...value, currency: codes[0] ?? currency })), evidence };
}

function receiptCategoryTaxes(section: DocumentSection, lines: Line[], currency: string | null): Omit<DocumentSection['amounts'][number], 'id'>[] {
	if (section.kind !== 'receipt' && section.kind !== 'unknown') {
		return [];
	}
	const totals: Line[] = lines.filter((line: Line): boolean => /^(?:\d{1,2}:\d{2}\s+)?(?:grand\s+)?total\s*:?\s*(?=[\d€$£]|[A-Z]{3}\s+\d|$)/i.test(line.text));
	if (totals.length !== 1) {
		return [];
	}
	const [total]: Line[] = totals;
	const samePage: Line[] = lines.filter((line: Line): boolean => line.page === total.page);
	const below: Line[] = samePage.slice(samePage.indexOf(total) + 1);
	if (!below.some((line: Line): boolean => /\b(?:tax(?:es)?|vat)\s+(?:are\s+)?included\b/i.test(line.text))) {
		return [];
	}
	const candidates: Omit<DocumentSection['amounts'][number], 'id'>[] = [];
	for (const [index, line] of below.entries()) {
		if (line.spans[0].region.y - total.spans[0].region.y > total.spans[0].region.height * 6) {
			break;
		}
		const candidate: Omit<AmountField, 'id'> | null = receiptCategoryTax(line, below[index + 1], section.kind, currency);
		if (candidate) {
			candidates.push(candidate);
		}
	}
	return candidates;
}

function dateCandidates(raw: string): string[] {
	const values: string[] = [];
	const append: (year: string, month: string | number, day: string | number) => void = (year: string, month: string | number, day: string | number): void => {
		const value: string = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		if (calendarDateSchema.safeParse(value).success) {
			values.push(value);
		}
	};
	let match: RegExpExecArray | null = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (match) {
		append(match[1], match[2], match[3]);
	}
	match = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(raw);
	if (match) {
		append(match[4], match[3], match[1]); append(match[4], match[1], match[3]);
	}
	match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw);
	if (match) {
		const month: number = monthNames.findIndex((names: string[]): boolean => names.includes(match![1].toLowerCase())); if (month >= 0) {
			append(match[3], month + 1, match[2]);
		}
	}
	match = /^(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]+)\.?\s+(\d{4})$/.exec(raw);
	if (match) {
		const month: number = monthNames.findIndex((names: string[]): boolean => names.includes(match[2].toLowerCase()));
		if (month >= 0) {
			append(match[3], month + 1, match[1]);
		}
	}
	return unique(values);
}
const datePattern: RegExp = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\.?\s+[A-Za-zÄÖÜäöü]+\.?\s+\d{4})\b/g;
function dateRole(raw: string): DateRole {
	const labels: [DateRole, RegExp][] = [
		['due', /date due|due date|due on|due\b|payable by|fällig|zahlbar bis/gi],
		['issue', /date of issue|issue date|invoice date|document date|tax invoice date|credit note date|rechnungsdatum|ausstellungsdatum|belegdatum/gi],
		['payment', /payment date|paid on|zahlung(?:sdatum)?/gi],
		['service-period', /billing period|service period|service date|charge start|leistungsdatum|leistungszeitraum|abrechnungszeitraum/gi]
	];
	const matches: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; index: number; }[] = labels.flatMap(([role, pattern]: ["unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end", RegExp]): { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; index: number; }[] => [...raw.matchAll(pattern)].map((match: RegExpExecArray): { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; index: number; } => ({ role, index: match.index })));
	return matches.sort((a: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; index: number; }, b: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; index: number; }): number => b.index - a.index)[0]?.role ?? 'unknown';
}
const genericDateLabel: RegExp = /^date\s*:?$/i;

function receiptDateContext(section: DocumentSection, page: ImportPage, evidence: SourceEvidence): SourceEvidence | null {
	if (section.kind !== 'receipt' && section.kind !== 'unknown') {
		return null;
	}
	const value: { x: number; y: number; width: number; height: number; } = evidence.region;
	const nearby: PositionedSpan[] = page.spans.filter((span: PositionedSpan): boolean => span.method === evidence.method && span.region.y < value.y && value.y - span.region.y <= value.height * 4 &&
		Math.abs(span.region.x - value.x) <= value.height * 2);
	const original: PositionedSpan[] = nearby.filter((span: PositionedSpan): boolean => /^\(?\s*original\s*\)?$/i.test(span.text.trim()));
	if (original.length !== 1 || !nearby.some((span: PositionedSpan): boolean => /^subtotal$/i.test(span.text.trim()) && span.region.y < original[0].region.y)) {
		return null;
	}
	if (!/\s\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(evidence.rawText) && !page.spans.some((span: PositionedSpan): boolean => span.method === evidence.method && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(span.text.trim()) &&
		span.region.x >= value.x + value.width && span.region.x - (value.x + value.width) <= value.height * 4 && sameVisualRow(span.region, value))) {
			return null;
		}
	return { pageId: page.pageId, method: original[0].method, rawText: original[0].text.trim(), region: original[0].region };
}

type DateContext = { labelled: true; evidence: SourceEvidence | null } | { labelled: false; evidence: SourceEvidence };

function genericDateContext(section: DocumentSection, field: DateField, pages: readonly ImportPage[]): DateContext | undefined {
	let receiptDate: SourceEvidence | undefined;
	for (const evidence of field.evidence) {
		const prefixes: string[] = [...evidence.rawText.matchAll(datePattern)].filter((match: RegExpExecArray): number => dateCandidates(match[0]).length)
			.map((match: RegExpExecArray): string => evidence.rawText.slice(0, match.index).trim()).filter((prefix: string): boolean => dateRole(prefix) === 'unknown');
		if (prefixes.length !== 1) {
			continue;
		}
		const [prefix]: string[] = prefixes;
		if (genericDateLabel.test(prefix)) {
			return { labelled: true, evidence: null };
		}
		if (prefix) {
			continue;
		}
		const page: ImportPage | undefined = pages.find((page: ImportPage): boolean => page.pageId === evidence.pageId);
		const value: { x: number; y: number; width: number; height: number; } = evidence.region;
		// OCR can put words from the same printed row on separate lines because their top edges differ.
		const before: PositionedSpan[] | undefined = page?.spans.filter(({ method, text, region }: PositionedSpan): boolean | "" =>
			method === evidence.method && text.trim() && region.x + region.width <= value.x && sameVisualRow(region, value));
		if (before?.length === 1 && genericDateLabel.test(before[0].text.trim())) {
			const { text, region, method }: PositionedSpan = before[0];
			return { labelled: true, evidence: { pageId: evidence.pageId, rawText: text.trim(), region, method } };
		}
		const context: SourceEvidence | null | undefined = page && receiptDateContext(section, page, evidence);
		if (context) {
			receiptDate = context;
		}
	}
	return receiptDate ? { labelled: false, evidence: receiptDate } : undefined;
}

export function withGenericIssueDate(section: DocumentSection, pages: readonly ImportPage[]): DocumentSection['dates'] {
	if (section.kind === 'payment-information' || section.dates.some((field: DateField): number | false => field.role === 'issue' && field.candidates.length)) {
		return section.dates;
	}
	const labelled: Map<string, SourceEvidence | null> = new Map<string, SourceEvidence | null>();
	const receiptDates: Map<string, SourceEvidence> = new Map<string, SourceEvidence>();
	for (const field of section.dates) {
		if (field.role !== 'unknown' || !field.candidates.length) {
			continue;
		}
		const context: DateContext | undefined = genericDateContext(section, field, pages);
		if (context?.labelled) {
			labelled.set(field.id, context.evidence);
		} else if (context) {
			receiptDates.set(field.id, context.evidence);
		}
	}
	const resolved: Map<string, SourceEvidence | null> = labelled.size ? labelled : receiptDates;
	const dates: DateField[] = section.dates.filter((field: DateField): boolean => resolved.has(field.id));
	if (new Set(dates.flatMap((field: DateField): string[] => field.candidates)).size !== 1) {
		return section.dates;
	}
	return section.dates.map((field: DateField): DateField => {
		if (!resolved.has(field.id)) {
			return field;
		}
		const context: SourceEvidence | null | undefined = resolved.get(field.id);
		const label: string = context && labelled.has(field.id) ? context.rawText : field.label;
		return { ...field, role: 'issue', label, evidence: context ? [context, ...field.evidence] : field.evidence };
	});
}

const referencePattern: RegExp = /\b(tax invoice number|credit note number|invoice (?:number|no\.?|#)|invoice\s*#|receipt (?:number|no\.?|#)|document no\.?|billing number|bill no\.?|order (?:number|no\.?|#)|customer (?:number|no\.?|#)|account (?:number|no\.?|#)|table (?:number|no\.?|#)|payment (?:reference|id)|reference|rechnungsnummer|rechnungsnr\.?|kundennummer|mandantennummer|auftragsnr\.?|bestellnummer|transaktions-id)\s*[:#]?\s*/ig;
const referenceValue: RegExp = /^[\p{L}\d][\p{L}\d_\-/.]*(?:[ \t]+[\p{L}\d][\p{L}\d_\-/.]*)*$/u;
function referencesOnLine(line: string): { label: string; value: string; }[] {
	const matches: RegExpExecArray[] = [...line.matchAll(referencePattern)];
	return matches.map((match: RegExpExecArray, index: number): { label: string; value: string; } => ({ label: match[1], value: line.slice(match.index + match[0].length, matches[index + 1]?.index).trim() }));
}

export function hasFullDocumentReference(field: DocumentSection['references'][number], value: string): boolean {
	const lines: { label: string; value: string; }[] = field.evidence.flatMap((item: SourceEvidence): { label: string; value: string; }[] => referencesOnLine(item.rawText));
	const labelled: { label: string; value: string; }[] = lines.filter((line: { label: string; value: string; }): boolean => line.label.toLowerCase() === field.label.toLowerCase());
	return labelled.some((line: { label: string; value: string; }): boolean => line.value === value) ||
		(labelled.some((line: { label: string; value: string; }): boolean => !line.value) && field.evidence.some((item: SourceEvidence): boolean => item.rawText.trim() === value));
}

function paymentEvidenceKey(item: SourceEvidence): string {
	return JSON.stringify([item.pageId, item.region.x, item.region.y, item.rawText]);
}

function collectPagePayments(page: ImportPage, unclassified: Map<string, string[]>, recorded: Set<string>): void {
	let inPaymentBlock: boolean = false;
	for (const line of linesOf({ ...page, spans: [...page.spans].sort(order) })) {
		if (appliedTransactions.test(line.text)) {
			inPaymentBlock = true;
		} else if (heading(line.text) || endPaymentBlock.test(line.text)) {
			inPaymentBlock = false;
		}
		if (inPaymentBlock) {
			for (const item of source(line)) {
			for (const fieldId of unclassified.get(paymentEvidenceKey(item)) ?? []) {
				recorded.add(fieldId);
			}
		}
		}
	}
}

export function recordedDocumentPayments(result: SupportingDocument): Set<string> {
	const recorded: Set<string> = new Set<string>();
	const unclassified: Map<string, string[]> = new Map<string, string[]>();
	for (const field of result.sections.flatMap((section: DocumentSection): AmountField[] => section.amounts)) {
		if (field.role !== 'payment' || plannedPayment.test(field.label)) {
			continue;
		}
		if (explicitPayment.test(field.label) || field.evidence.some((item: SourceEvidence): boolean => appliedTransactions.test(item.rawText))) {
			recorded.add(field.id);
		} else {
			for (const item of field.evidence) {
			const key: string = paymentEvidenceKey(item);
			const fields: string[] = unclassified.get(key) ?? [];
			fields.push(field.id);
			unclassified.set(key, fields);
		}
		}
	}
	if (!unclassified.size) {
		return recorded;
	}
	// Older imports retain the payment row but may omit its table heading from the field evidence.
	for (const page of result.input?.pages ?? []) {
		collectPagePayments(page, unclassified, recorded);
	}
	return recorded;
}

export function mergedLegacySections(result: SupportingDocument): Set<string> {
	const merged: Set<string> = new Set<string>();
	if (result.parserVersion !== '1' || !result.input) {
		return merged;
	}
	const pageHeadings: Map<string, ("unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" | null)[]> = new Map(result.input.pages.map((page: ImportPage): [string, ("unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" | null)[]] => [page.pageId, linesOf(page).map((line: Line): "unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" | null => heading(line.text))]));
	const possiblyMerged: DocumentSection[] = result.sections.filter((section: DocumentSection): boolean => (section.kind === 'invoice' || section.kind === 'receipt') &&
		section.pageIds.flatMap((pageId: string): ("unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" | null)[] => pageHeadings.get(pageId) ?? []).filter((kind: "unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information" | null): boolean => kind === section.kind).length > 1);
	if (!possiblyMerged.length) {
		return merged;
	}
	const updated: SupportingDocument = interpretSupportingDocument(result.input);
	const locatedFields: (section: DocumentSection) => string[] = (section: DocumentSection): string[] => [...section.amounts, ...section.references].flatMap((field: AmountField | ReferenceField): string[] => field.evidence.map((item: SourceEvidence): string =>
		JSON.stringify([item.pageId, item.region.x, item.region.y, item.rawText])));
	const updatedSections: Set<string>[] = updated.sections.map((section: DocumentSection): Set<string> => new Set(locatedFields(section)));
	for (const section of possiblyMerged) {
		const fields: string[] = locatedFields(section);
		if (updated.status === 'failed' || updatedSections.filter((locations: Set<string>): boolean => fields.some((field: string): boolean => locations.has(field))).length > 1) {
			merged.add(section.sectionId);
		}
	}
	return merged;
}

function referenceRole(label: string, section: DocumentSection): ReferenceRole {
	if (/customer|kunden|mandanten/i.test(label)) {
		return 'customer';
	}
	if (/account/i.test(label)) {
		return 'account';
	}
	if (/table/i.test(label)) {
		return 'table';
	}
	if (/order|auftrag|bestell/i.test(label)) {
		return 'order';
	}
	if (/payment|transaktions/i.test(label)) {
		return 'payment';
	}
	if (/receipt/i.test(label)) {
		return 'receipt';
	}
	if (/invoice|rechnung|document no|billing number|bill no|credit note/i.test(label)) {
		return section.kind === 'credit-note' && /^invoice/i.test(label) ? 'related-invoice' : 'invoice';
	}
	return 'unknown';
}

function startsNewSection(current: DocumentSection, kind: DocumentSection['kind'], page: ImportPage, pageStartHeading: boolean, sameDocument: boolean, changedReference: boolean): boolean {
	if (kind !== current.kind || changedReference) {
		return true;
	}
	if (sameDocument) {
		return false;
	}
	const seenPage: boolean = current.pageIds.includes(page.pageId);
	return pageStartHeading && !seenPage || (kind === 'invoice' || kind === 'receipt') && seenPage;
}

function periodDateRole(base: DateRole, count: number, first: boolean): DateRole {
	if (base !== 'service-period' || count !== 2) {
		return base;
	}
	return first ? 'service-start' : 'service-end';
}

function soleCurrency(values: string[], matchCount: number): string[] {
	return values.length === 1 && matchCount === 1 ? values : [];
}

export function interpretSupportingDocument(rawInput: unknown): SupportingDocument {
	const checked: ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(rawInput);
	if (!checked.success) {
		return supportingDocumentSchema.parse({ contractVersion: '1', parserVersion: '2', status: 'failed', input: null, sections: [],
		issues: [issue('invalid-input', 'The extracted document does not satisfy the positioned-text contract.')] });
	}
	const input: BankImportInput = checked.data;
	for (const page of input.pages) {
		page.spans.sort(order);
	}
	const sections: DocumentSection[] = [], issues: DocumentIssue[] = [];
	let current: DocumentSection | undefined, fieldNumber: number = 0, issueOverflow: boolean = false;
	const sectionLines: Map<string, Line[]> = new Map<string, Line[]>();
	const nextId: () => string = (): string => `field-${++fieldNumber}`;

	const addIssue: (code: string, message: string, section?: DocumentSection, fieldId?: string | null, field?: string | null, evidence?: SourceEvidence[]) => void = (code: string, message: string, section?: DocumentSection, fieldId: string | null = null, field: string | null = null, evidence: SourceEvidence[] = []): void => {
		if (issues.length >= 9999) {
			issueOverflow = true;
		} else {
			issues.push(issue(code, message, section?.sectionId ?? null, fieldId, field, evidence));
		}
	};

	const createSection: (page: ImportPage, kind: DocumentSection["kind"], line?: Line) => DocumentSection = (page: ImportPage, kind: DocumentSection['kind'], line?: Line): DocumentSection => {
		const section: DocumentSection = { sectionId: `section-${sections.length + 1}`, kind, pageIds: [page.pageId], evidence: line ? source(line) : [],
			amounts: [], dates: [], merchants: [], references: [], currencies: [] };
		sections.push(section); return section;
	};

	function fieldLimitReached(): boolean {
		if (fieldNumber < 9000) {
			return false;
		}
		addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.');
		return true;
	}

	function referencesAfterHeading(lines: Line[], index: number): string[] {
		const nextHeading: number = lines.findIndex((next: Line, nextIndex: number): boolean => nextIndex > index && heading(next.text) !== null);
		return lines.slice(index + 1, nextHeading < 0 ? undefined : nextHeading).flatMap((next: Line): string[] => referencesOnLine(next.text).flatMap(({ label, value }: { label: string; value: string; }): string[] => {
				if (!/^(?:tax invoice|credit note|invoice|rechnungsnummer|rechnungsnr|document no|billing number)/i.test(label)) {
					return [];
				}
				return referenceValue.test(value) ? [value] : [];
			}));
	}

	function selectSection(page: ImportPage, lines: Line[], index: number, pageState: PageInterpretation): DocumentSection {
		const line: Line = lines[index];
		const kind: DocumentSection['kind'] | null = heading(line.text);
		const pageStartHeading: boolean = index < 4 && kind !== null;
		const followingReferences: string[] = kind ? referencesAfterHeading(lines, index) : [];
		const knownReferences: string[] = current?.references.filter((field: ReferenceField): boolean => field.role === 'invoice').flatMap((field: ReferenceField): string[] => field.candidates) ?? [];
		const sameDocument: boolean = kind === current?.kind && followingReferences.length > 0 && knownReferences.length > 0 && followingReferences.every((value: string): boolean => knownReferences.includes(value));
		const changedReference: boolean = followingReferences.length > 0 && knownReferences.length > 0 && followingReferences.some((value: string): boolean => !knownReferences.includes(value));
		if (!current) {
			return createSection(page, kind ?? 'unknown', line);
		}
		if (kind && current.kind === 'unknown' && current.pageIds.length === 1 && current.pageIds[0] === page.pageId) {
			current.kind = kind; current.evidence = source(line);
			return current;
		}
		if (!kind || !startsNewSection(current, kind, page, pageStartHeading, sameDocument, changedReference)) {
			return current;
		}
		pageState.paymentBlock = [];
		return kind !== 'payment-information' || pageStartHeading ? createSection(page, kind, line) : current;
	}

	function appendReferences(current: DocumentSection, line: Line, next: Line | undefined, evidence: SourceEvidence[]): boolean {
		for (const { label, value } of referencesOnLine(line.text)) {
			if (fieldLimitReached()) {
				return false;
			}
			const continuation: Line | null = !value && next && /^[\p{L}\d][\p{L}\d_\-/.]+$/u.test(next.text.trim()) ? next : null;
			current.references.push({ id: nextId(), role: referenceRole(label, current), label, candidates: referenceValue.test(value) ? [value] : continuation ? [continuation.text.trim()] : [],
				evidence: continuation ? [...evidence, ...source(continuation)] : evidence });
		}
		return true;
	}

	function appendContinuationDate(current: DocumentSection, line: Line, next: Line | undefined, dateMatches: RegExpExecArray[], evidence: SourceEvidence[]): void {
		if (dateMatches.length || !next || !/^(?:issue date|invoice date|date of issue|date due|due date)\s*:?$/i.test(line.text)) {
			return;
		}
		const values: string[] = dateCandidates(next.text.trim());
		if (values.length) {
			current.dates.push({ id: nextId(), role: dateRole(line.text), label: line.text, candidates: values, evidence: [...evidence, ...source(next)] });
		}
	}

	function appendDates(current: DocumentSection, lines: Line[], index: number, evidence: SourceEvidence[], hasPaymentBlock: boolean, informationalFx: boolean): RegExpExecArray[] | false {
		const line: Line = lines[index];
		const dateMatches: RegExpExecArray[] = [...line.text.matchAll(datePattern)].filter((match: RegExpExecArray): boolean => dateRole(line.text.slice(0, match.index)) !== 'unknown' || dateCandidates(match[0]).length > 0 || !amountRole(line.text, current.kind, hasPaymentBlock, informationalFx));
		const periodDates: RegExpExecArray[] = dateMatches.filter((match: RegExpExecArray): boolean => dateRole(line.text.slice(0, match.index)) === 'service-period');
		for (const [dateIndex, match] of dateMatches.entries()) {
			if (fieldLimitReached()) {
				return false;
			}
			const baseRole: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end" = dateRole(line.text.slice(0, match.index));
			const role: DateRole = periodDateRole(baseRole, periodDates.length, dateIndex === dateMatches.indexOf(periodDates[0]));
			current.dates.push({ id: nextId(), role, label: line.text.slice(0, 16384), candidates: dateCandidates(match[0]), evidence });
		}
		appendContinuationDate(current, line, lines[index + 1], dateMatches, evidence);
		return dateMatches;
	}

	function appendColumnAmounts(current: DocumentSection, line: Line, next: Line | undefined, previous: Line | undefined): void {
		for (const cell of columnAmounts(line, next, current.kind, previous)) {
			const numeric: string = cell.value.replace(currencyPattern, '').trim(), own: string[] = currencies(cell.value);
			const candidates: { currency: string | null; coefficient: string; scale: number; }[] = numberCandidates(numeric).map((value: { coefficient: string; scale: number; }): { currency: string | null; coefficient: string; scale: number; } => ({ ...value, currency: own.length === 1 ? own[0] : null }));
			const field: { id: string; role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; label: string; candidates: { currency: string | null; coefficient: string; scale: number; }[]; evidence: SourceEvidence[]; } = { id: nextId(), role: cell.role, label: cell.label, candidates, evidence: cell.evidence };
			current.amounts.push(field);
			addIssue('unconfirmed-field-association', 'The amount is positioned above this label; confirm their association from the source.', current, field.id, field.role, field.evidence);
		}
	}

	function appendAmount(current: DocumentSection, line: Line, match: RegExpExecArray, matchCount: number, amountKind: AmountRole,
		ownCurrencies: string[], paymentBlock: SourceEvidence[], informationalFx: boolean, evidence: SourceEvidence[]): void {
		if (line.text.slice(match.index + match[0].length).trimStart().startsWith('%')) {
			return;
		}
		const before: string = line.text.slice(0, match.index).trimEnd(), after: string = line.text.slice(match.index + match[0].length).trimStart();
		const nearby: string[] = currencies(`${before.split(/\s+/).slice(-1).join(' ')} ${match[0]} ${after.split(/\s+/).slice(0, 1).join(' ')}`);
		if (!nearby.length && /^(?:miles|points|units|qty|quantity|meilen)\b/i.test(after)) {
			return;
		}
		if (!nearby.length && !/[.,]\d|[$€£]/.test(match[0]) && matchCount > 1) {
			return;
		}
		const explicit: string[] = nearby.length ? nearby : soleCurrency(ownCurrencies, matchCount);
		const prefixSign: string = new RegExp(`([-−+(]+)\\s*${code}$`).exec(before)?.[1] ?? '';
		const token: string = match[0].endsWith(',') && /^\s/.test(line.text.slice(match.index + match[0].length)) ? match[0].slice(0, -1) : match[0];
		const values: { coefficient: string; scale: number; }[] = numberCandidates(`${prefixSign}${token}`);
		const candidates: AmountCandidate[] = values.flatMap<DocumentSection['amounts'][number]['candidates'][number]>((value: { coefficient: string; scale: number; }): { currency: string; coefficient: string; scale: number; }[] | { currency: null; coefficient: string; scale: number; }[] => explicit.length ? explicit.map((currency: string): { currency: string; coefficient: string; scale: number; } => ({ ...value, currency })) : [{ ...value, currency: null }]);
		const role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item" = amountKind === 'refund-payment' ? amountKind : amountRole(before, current.kind, paymentBlock.length > 0, informationalFx) ?? amountKind;
		const amountEvidence: SourceEvidence[] = role === 'payment' ? [...paymentBlock, ...evidence] : evidence;
		current.amounts.push({ id: nextId(), role, label: line.text.slice(0, 16384), candidates, evidence: amountEvidence });
	}

	function appendAmounts(current: DocumentSection, line: Line, dateMatches: RegExpExecArray[], amountKind: AmountRole,
		ownCurrencies: string[], paymentBlock: SourceEvidence[], informationalFx: boolean, evidence: SourceEvidence[]): boolean {
		const withoutDates: string[] = line.text.split('');
		for (const match of dateMatches) {
			withoutDates.fill(' ', match.index, match.index + match[0].length);
		}
		const matches: RegExpExecArray[] = [...withoutDates.join('').matchAll(numberPattern)];
		for (const match of matches) {
			if (fieldLimitReached()) {
				return false;
			}
			appendAmount(current, line, match, matches.length, amountKind, ownCurrencies, paymentBlock, informationalFx, evidence);
		}
		return true;
	}

	function appendCurrency(current: DocumentSection, line: Line, fxPage: boolean, ownCurrencies: string[], evidence: SourceEvidence[]): void {
	if (ownCurrencies.length && (/\bcurrency\b|betrag in|\(EUR\)|\(USD\)|\(GBP\)/i.test(line.text) || current.kind === 'payment-information' && fxPage)) {
		current.currencies.push({ id: nextId(), role: current.kind === 'payment-information' && fxPage || /pricing currency|exchange rate/i.test(line.text) ? 'informational-fx' : 'settlement',
			label: line.text.slice(0, 16384), candidates: ownCurrencies, evidence });
	}
	}

	function scanLine(page: ImportPage, lines: Line[], index: number, pageState: PageInterpretation): boolean {
		if (fieldLimitReached()) {
			return false;
		}
		if (sections.length >= 9000 || issues.length >= 9000) {
			addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.');
			return false;
		}
		const line: Line = lines[index];
		current = selectSection(page, lines, index, pageState);
		if (!current.pageIds.includes(page.pageId)) {
			current.pageIds.push(page.pageId);
		}
		const recordedLines: Line[] = sectionLines.get(current.sectionId) ?? [];
		recordedLines.push(line); sectionLines.set(current.sectionId, recordedLines);
		const evidence: SourceEvidence[] = source(line);
		if (/\0|\(cid:\d+\)|�/.test(line.text)) {
			addIssue('uncertain-text', 'Source text contains unreadable glyphs; retain the printed evidence for correction.', current, null, null, evidence);
		}
		if (appliedTransactions.test(line.text)) {
			pageState.paymentBlock = evidence;
		} else if (endPaymentBlock.test(line.text)) {
			pageState.paymentBlock = [];
		}
		if (taxRegistration(line.text)) {
			return true;
		}
		const fxPage: boolean = pageState.fxPage;
		const ownCurrencies: string[] = currencies(line.text);
		appendCurrency(current, line, fxPage, ownCurrencies, evidence);
		if (!appendReferences(current, line, lines[index + 1], evidence)) {
			return false;
		}
		const merchant: RegExpExecArray | null = /\b(?:merchant|seller|supplier|issued by|aussteller|lieferant)\s*:\s*(.+)$/i.exec(line.text);
		if (merchant && !/received by/i.test(merchant[1])) {
			current.merchants.push({ id: nextId(), role: 'merchant', label: merchant[0], candidates: [merchant[1].trim()], evidence });
		}
		const hasPaymentBlock: boolean = pageState.paymentBlock.length > 0;
		const informationalFx: boolean = current.kind === 'payment-information' && fxPage;
		const dates: RegExpExecArray[] | false = appendDates(current, lines, index, evidence, hasPaymentBlock, informationalFx);
		if (dates === false) {
			return false;
		}
		const amountKind: AmountRole | null = amountRole(line.text, current.kind, hasPaymentBlock, informationalFx);
		if (!amountKind) {
			appendColumnAmounts(current, line, lines[index + 1], lines[index - 1]);
			return true;
		}
		return appendLineAmounts(current, line, dates, amountKind, ownCurrencies, pageState.paymentBlock, informationalFx, evidence);
	}

	function appendLineAmounts(current: DocumentSection, line: Line, dateMatches: RegExpExecArray[], amountKind: AmountRole,
		ownCurrencies: string[], paymentBlock: SourceEvidence[], informationalFx: boolean, evidence: SourceEvidence[]): boolean {
		if (/^(?:.*\b(?:invoice|receipt|customer|account|table|order)\s*(?:number|no\.?|#)|rechnungsnummer)/i.test(line.text) || dateMatches.length && !/[$€£]|\b(?:EUR|USD|GBP)\b/.test(line.text)) {
			return true;
		}
		return appendAmounts(current, line, dateMatches, amountKind, ownCurrencies, paymentBlock, informationalFx, evidence);
	}

	function appendMerchantCandidate(section: DocumentSection, lines: Line[]): void {
		if (section.merchants.length || section.kind === 'payment-information') {
			return;
		}
		const candidates: { text: string; evidence: SourceEvidence[] }[] = [];
		for (const line of lines) {
			if (/\bbill to\b|\bsold to\b|rechnungsempfänger/i.test(line.text)) {
				break;
			}
			if (line.spans[0].region.y > line.page.height * 0.3) {
				continue;
			}
			for (const span of line.spans) {
				if (/\b(?:Inc\.?|Ltd\.?|Limited|GmbH|LLC|AG)\b/i.test(span.text) && !/\bmerchant\b|\bbill to\b|\bsold to\b/i.test(span.text)) {
				candidates.push({ text: span.text.trim().slice(0, 16384), evidence: source({ ...line, spans: [span] }) });
			}
			}
			if (candidates.length >= 8) {
				break;
			}
		}
		if (candidates.length) {
			const field: { id: string; role: "merchant"; label: string; candidates: string[]; evidence: SourceEvidence[]; } = { id: nextId(), role: 'merchant' as const, label: 'Unconfirmed supplier name', candidates: unique(candidates.slice(0, 8).map((value: { text: string; evidence: SourceEvidence[]; }): string => value.text)), evidence: candidates.slice(0, 8).flatMap((value: { text: string; evidence: SourceEvidence[]; }): SourceEvidence[] => value.evidence) };
			section.merchants.push(field);
			addIssue('unconfirmed-merchant', 'A company name is retained as an unconfirmed supplier candidate; review its source context.', section, field.id, 'merchant', field.evidence);
		}
	}

	function assignSectionCurrency(section: DocumentSection, defaultCurrency: string | null): { declared: string[]; currency: string | null; } {
		const declared: string[] = unique(section.currencies.filter((field: CurrencyField): boolean => field.role === 'settlement').flatMap((field: CurrencyField): string[] => field.candidates));
		const currency: string | null = declared.length === 1 ? declared[0] : defaultCurrency;
		if (!currency) {
			return { declared, currency };
		}
		for (const amount of section.amounts) {
			if (amount.role !== 'informational-fx') {
				for (const value of amount.candidates) {
					value.currency ??= currency;
				}
			}
		}
		return { declared, currency };
	}

	function appendInvoiceTotal(section: DocumentSection, lines: Line[], currency: string | null, declaredCount: number): void {
		if (section.kind === 'invoice' && declaredCount <= 1 && !section.amounts.some((field: AmountField): boolean => field.role === 'billed-total')) {
			const summary: Omit<AmountField, "id"> | null = invoiceSummaryTotal(lines, currency);
			if (summary) {
				section.amounts.push({ ...summary, id: nextId() });
			}
		}
	}

	function restoreReceiptTotal(section: DocumentSection, lines: Line[], currency: string | null, declaredCount: number): void {
		const breakdown: { originalFields: AmountField[]; amounts: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; reconstructed: boolean; totalEvidence: SourceEvidence[]; } | null = declaredCount <= 1 ? receiptVatTotal(section, lines, currency) : null;
		if (breakdown) {
			const { originalFields: [net, tax], amounts: [netAmount, taxAmount, totalAmount], evidence, reconstructed, totalEvidence }: { originalFields: AmountField[]; amounts: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; reconstructed: boolean; totalEvidence: SourceEvidence[]; } = breakdown;
			Object.assign(net, { role: 'subtotal', label: 'VAT base', candidates: [netAmount], evidence });
			Object.assign(tax, { label: 'VAT amount', candidates: [taxAmount], evidence });
			const total: { id: string; role: "billed-total"; label: string; candidates: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; } = { id: nextId(), role: 'billed-total' as const, label: reconstructed ? 'Total reconstructed from VAT breakdown' : 'Total', candidates: [totalAmount], evidence: totalEvidence };
			section.amounts.push(total);
			if (reconstructed) {
				addIssue('reconstructed-total', 'The total was reconstructed from the printed net amount and VAT because the OCR missed a leading digit.',
				section, total.id, total.role, totalEvidence);
			}
		}
		const itemTotal: { existing: AmountField; amount: { coefficient: string; scale: number; currency: string; }; evidence: SourceEvidence[]; } | null = !breakdown && declaredCount <= 1 ? receiptItemTotal(section, lines, currency) : null;
		if (itemTotal) {
			const { existing, amount, evidence }: { existing: AmountField; amount: { coefficient: string; scale: number; currency: string; }; evidence: SourceEvidence[]; } = itemTotal;
			const total: { id: string; role: "billed-total"; label: string; candidates: { coefficient: string; scale: number; currency: string; }[]; evidence: SourceEvidence[]; } = { id: existing?.id ?? nextId(), role: 'billed-total' as const, label: 'Total reconstructed from receipt items', candidates: [amount], evidence };
			if (existing) {
				Object.assign(existing, total);
			} else {
				section.amounts.push(total);
			}
			addIssue('reconstructed-total', 'The total was reconstructed from the printed item amounts because the OCR missed a leading digit.', section, total.id, total.role, evidence);
		}
	}

	function appendCategoryTaxes(section: DocumentSection, lines: Line[], currency: string | null): void {
		const totalCurrencies: string[] = unique(section.amounts.filter((field: AmountField): boolean => field.role === 'billed-total').flatMap((field: AmountField): (string | null)[] => field.candidates.map((value: AmountCandidate): string | null => value.currency)).filter((value: string | null): value is string => value !== null));
		const taxCurrency: string | null = currency ?? (totalCurrencies.length === 1 ? totalCurrencies[0] : null);
		for (const tax of receiptCategoryTaxes(section, lines, taxCurrency)) {
			section.amounts.push({ ...tax, id: nextId() });
		}
	}

	function reportFieldIssues(section: DocumentSection): void {
		for (const field of [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies]) {
			if (field.candidates.length !== 1) {
				addIssue(field.candidates.length ? 'ambiguous-field' : 'unresolved-field', 'The printed field has no single established interpretation.', section, field.id, field.role, field.evidence);
			}
		}
		for (const amount of section.amounts) {
			if (amount.candidates.some((value: AmountCandidate): boolean => value.currency === null)) {
				addIssue('missing-currency', 'This amount has no established ISO currency; symbols alone may be ambiguous.', section, amount.id, amount.role, amount.evidence);
			}
		}
		const conflicting: Set<string> = documentScalarConflicts(section);
		for (const field of [...section.amounts, ...section.dates, ...section.references, ...section.currencies]) {
			if (conflicting.has(field.id)) {
			addIssue('conflicting-field', 'Distinct candidates for this section field require review.', section, field.id, field.role, field.evidence);
		}
		}
		if (section.kind === 'unknown') {
			addIssue('unknown-document', 'No supported document heading establishes the document kind; raw source text is retained.', section);
		}
	}

	function reportMissingFields(section: DocumentSection): void {
		if (section.kind !== 'payment-information') {
			const required: readonly [readonly [boolean, "billed-total"], readonly [boolean, "issue"], readonly [boolean, "merchant"], readonly [boolean, "document-reference"]] = [
				[section.amounts.some((field: AmountField): boolean => field.role === (section.kind === 'credit-note' ? 'credit-note-component' : 'billed-total')), 'billed-total'],
				[section.dates.some((field: DateField): boolean => field.role === 'issue'), 'issue'], [section.merchants.length > 0, 'merchant'],
				[section.references.some((field: ReferenceField): boolean => ['invoice', 'receipt'].includes(field.role)), 'document-reference']
			] as const;
			for (const [present, role] of required) {
				if (!present) {
					addIssue('missing-field', 'A required document field has not been established.', section, null, role);
				}
			}
		}
	}

	function scanPage(page: ImportPage): boolean {
		const lines: Line[] = linesOf(page);
		if (page.status === 'failed' || !lines.length) {
			addIssue(page.status === 'failed' ? 'page-failed' : 'missing-text', 'This source page could not provide readable document text.');
			return true;
		}
		const pageState: PageInterpretation = { paymentBlock: [], fxPage: lines.some((line: Line): boolean => /^(?:exchange rate|pricing currency)\b/i.test(line.text)) };
		for (const index of lines.keys()) {
			if (!scanLine(page, lines, index, pageState)) {
				return false;
			}
		}
		return true;
	}

	for (const page of input.pages) {
		if (!scanPage(page)) {
			break;
		}
	}
	const defaultCurrency: string | null = defaultDocumentCurrency([...sectionLines.values()].flat());
	for (const section of sections) {
		const lines: Line[] = sectionLines.get(section.sectionId) ?? [];
		section.dates = withGenericIssueDate(section, input.pages);
		appendMerchantCandidate(section, lines);
		const { declared, currency }: { declared: string[]; currency: string | null; } = assignSectionCurrency(section, defaultCurrency);
		appendInvoiceTotal(section, lines, currency, declared.length);
		restoreReceiptTotal(section, lines, currency, declared.length);
		appendCategoryTaxes(section, lines, currency);
		reportFieldIssues(section);
		reportMissingFields(section);
	}
	for (const item of input.issues) {
		addIssue(item.code, item.message, undefined, null, item.field, item.evidence);
	}
	if (!sections.length) {
		addIssue('no-readable-document', 'No readable document sections were established.');
	}
	const result: ZodSafeParseResult<SupportingDocument> | null = issueOverflow ? null : supportingDocumentSchema.safeParse({ contractVersion: '1', parserVersion: '2', status: sections.length ? issues.length ? 'partial' : 'complete' : 'failed', input, sections, issues });
	if (result?.success) {
		return result.data;
	}
	return supportingDocumentSchema.parse({ contractVersion: '1', parserVersion: '2', status: 'failed', input, sections: [],
		issues: [issue('interpretation-limit', 'The interpreted fields exceed the validated local contract; full extracted source text is retained.')] });
}
