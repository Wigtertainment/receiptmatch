import { bankImportInputSchema, calendarDateSchema, type BankImportInput, type ImportPage, type PositionedSpan, type SourceEvidence } from '../../src/shared/bank-import.js';
import { documentScalarConflicts, supportingDocumentSchema, type DocumentIssue, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';

interface Line { page: ImportPage; spans: PositionedSpan[]; text: string; }
type AmountRole = DocumentSection['amounts'][number]['role'];
type DateRole = DocumentSection['dates'][number]['role'];
type ReferenceRole = DocumentSection['references'][number]['role'];
const code = '(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|JPY|CNY|HKD|SGD|SEK|NOK|DKK|PLN|CZK|RON|HUF|INR|BRL|ZAR|AED|ILS|TRY)';
const currencyPattern = new RegExp(`\\b${code}\\b`, 'g');
const numberPattern = /(?<![\p{L}\d])(?:[-−+(]\s*)*(?:[$€£]\s*)?(?:[-−+(]\s*)*\d[\d.,'’]*(?: \d{3}(?!\d)(?:[.,'’]\d+)*)*(?:\s*\))?[\p{L}?+−-]*/gu;
const amountText = `(?:${code}\\s*)?[-−+(\\s]*[$€£]?\\s*\\d[\\d.,'’]*(?: \\d{3}(?:[.,'’]\\d+)*)*\\s*\\)?(?:\\s*${code})?`;
const explicitRefund = new RegExp(`^\\s*(?:amount refunded|refunded amount|refund issued|refund paid|refund completed)\\s*:?\\s*${amountText}\\s*$`, 'i');
const explicitPayment = new RegExp(`^\\s*(?:payment(?: received| made| completed)?|paid amount|amount paid|cash (?:amount|payment)|received payment|gezahlter betrag)\\s*:?\\s*${amountText}\\s*$`, 'i');
const appliedTransactions = /applied transactions?:?$/i;
const endPaymentBlock = /balance due|subtotal|invoice total|grand total/i;
const plannedPayment = /^\s*payment\s+(?:scheduled|pending|due|expected|planned)\b/i;
const monthNames = [
	['jan', 'january', 'januar'], ['feb', 'february', 'februar'], ['mar', 'march', 'mär', 'märz'], ['apr', 'april'], ['may', 'mai'], ['jun', 'june', 'juni'],
	['jul', 'july', 'juli'], ['aug', 'august'], ['sep', 'sept', 'september'], ['oct', 'october', 'okt', 'oktober'], ['nov', 'november'], ['dec', 'december', 'dez', 'dezember']
];

function order(left: PositionedSpan, right: PositionedSpan) {
	return left.region.y - right.region.y || left.region.x - right.region.x || left.text.localeCompare(right.text) || left.method.localeCompare(right.method);
}
function linesOf(page: ImportPage): Line[] {
	const lines: Line[] = [];
	for (const span of page.spans) {
		if (!span.text.trim()) continue;
		const current = lines.at(-1);
		if (current && Math.abs(current.spans[0].region.y - span.region.y) <= Math.min(2.5, span.region.height / 2)) current.spans.push(span);
		else lines.push({ page, spans: [span], text: '' });
	}
	for (const line of lines) {
		line.spans.sort((a, b) => a.region.x - b.region.x || order(a, b));
		line.text = line.spans.map(span => span.text.trim()).join(' ');
	}
	return lines;
}
function source(line: Line): SourceEvidence[] {
	return (['embedded-text', 'local-ocr'] as const).flatMap(method => {
		const spans = line.spans.filter(span => span.method === method);
		if (!spans.length) return [];
		const x = Math.min(...spans.map(span => span.region.x)), y = Math.min(...spans.map(span => span.region.y));
		return [{ pageId: line.page.pageId, method, rawText: spans.map(span => span.text.trim()).join(' ').slice(0, 16384), region: {
			x, y, width: Math.max(...spans.map(span => span.region.x + span.region.width)) - x,
			height: Math.max(...spans.map(span => span.region.y + span.region.height)) - y
		} }];
	});
}
function unique<T>(values: T[]): T[] { return values.filter((value, index) => values.findIndex(other => JSON.stringify(other) === JSON.stringify(value)) === index); }
function currencies(raw: string) {
	return unique([...raw.matchAll(currencyPattern)].map(match => match[0]).concat(raw.includes('€') ? ['EUR'] : []));
}
function issue(code: string, message: string, sectionId: string | null = null, fieldId: string | null = null, field: string | null = null, evidence: SourceEvidence[] = []): DocumentIssue {
	return { code, severity: 'warning', message, sectionId, fieldId, field, evidence };
}
function heading(raw: string): DocumentSection['kind'] | null {
	const value = raw.trim().replace(/[:\s]+$/g, '').toLowerCase();
	if (/^(?:billing|bill) summary$/.test(value)) return 'billing-summary';
	if (/^(?:credit note|gutschrift)$/.test(value)) return 'credit-note';
	if (/^(?:tax invoice|invoice|credit invoice|rechnung|auftragsbestätigung\s*\/\s*rechnung)$/.test(value)) return 'invoice';
	if (/^(?:receipt|passenger\s*\/\s*itinerary receipt|restaurant receipt|quittung|kassenbon)$/.test(value)) return 'receipt';
	if (/^(?:payment instructions?|exchange rate|exchange rate information|payment information)$/.test(value)) return 'payment-information';
	return null;
}
function amountRole(raw: string, kind: DocumentSection['kind'], paymentBlock: boolean, informationalFx: boolean): AmountRole | null {
	if (/exchange rate|pricing currency|informational (?:fx|amount)/i.test(raw) || informationalFx) return 'informational-fx';
	if (explicitRefund.test(raw)) return 'refund-payment';
	const totalRole = kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
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
	const matches = labels.flatMap(([role, pattern], priority) => [...raw.matchAll(pattern)].map(match => ({ role, end: match.index! + match[0].length, priority })));
	return matches.sort((a, b) => b.end - a.end || a.priority - b.priority)[0]?.role ?? (paymentBlock ? 'payment' : null);
}

function columnAmounts(line: Line, next: Line | undefined, kind: DocumentSection['kind'], previous: Line | undefined) {
	if (!next || next.page.pageId !== line.page.pageId || next.spans[0].region.y - line.spans[0].region.y > 24) return [];
	if (previous && previous.page.pageId === line.page.pageId && line.spans[0].region.y - previous.spans[0].region.y <= 24 &&
		(/^(?:phone|telephone|tel\.?|fax|telefon|account|customer|invoice number|receipt number|order|table|reference|date)\b/i.test(previous.text) || /^[^\d]{1,80}:\s*$/.test(previous.text))) return [];
	const cells: { label: string; role: AmountRole; value: string; evidence: SourceEvidence[] }[] = [];
	const used = new Set<PositionedSpan>();
	for (const label of next.spans) {
		const role = amountRole(label.text, kind, false, false);
		if (!role || !['billed-total', 'balance-due', 'credit-note-component', 'subtotal', 'tax', 'payment'].includes(role)) continue;
		const values = line.spans.filter(span => Math.abs(span.region.x - label.region.x) <= 4 && /\d/.test(span.text));
		if (values.length !== 1 || used.has(values[0])) continue;
		const value = values[0];
		const numeric = value.text.replace(currencyPattern, '').trim();
		const tokens = [...numeric.matchAll(numberPattern)];
		if (tokens.length !== 1 || tokens[0][0].trim() !== numeric) continue;
		used.add(value);
		cells.push({ label: label.text, role, value: value.text, evidence: [...source({ ...line, spans: [value] }), ...source({ ...next, spans: [label] })] });
	}
	return cells;
}
function numberCandidates(raw: string): { coefficient: string; scale: number }[] {
	let value = raw.trim().replace(/[€$£\s]/g, '').replace(/−/g, '-');
	const negative = value.startsWith('-') || value.startsWith('(');
	value = value.replace(/^[-+(]/, '').replace(/\)$/, '');
	if (/['’]/.test(value)) {
		if (!/^\d{1,3}(['’])\d{3}(?:\1\d{3})*(?:[.,]\d{1,18})?$/.test(value)) return [];
		value = value.replace(/['’]/g, '');
	}
	if (!/^\d+(?:[.,]\d+)*$/.test(value)) return [];
	const comma = value.lastIndexOf(','), dot = value.lastIndexOf('.');
	const result: { coefficient: string; scale: number }[] = [];
	const append = (integer: string, fraction = '') => {
		if (fraction.length > 18 || integer.length + fraction.length > 127) return;
		const magnitude = BigInt(integer + fraction);
		result.push({ coefficient: (negative ? -magnitude : magnitude).toString(), scale: fraction.length });
	};
	if (comma >= 0 && dot >= 0) {
		const separator = comma > dot ? ',' : '.', grouping = separator === ',' ? '.' : ',';
		const [integer, fraction, extra] = value.split(separator);
		if (extra === undefined && new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integer)) append(integer.split(grouping).join(''), fraction);
	} else if (comma >= 0 || dot >= 0) {
		const separator = comma >= 0 ? ',' : '.', parts = value.split(separator);
		if (parts.length === 2) append(parts[0], parts[1]);
		if (/^\d{1,3}([.,]\d{3})+$/.test(value)) append(parts.join(''));
	} else append(value);
	return unique(result);
}

function invoiceSummaryTotal(lines: Line[], currency: string | null): Omit<DocumentSection['amounts'][number], 'id'> | null {
	const headings = lines.flatMap((line, index) => line.spans.filter(span => /^invoicesummary:?$/i.test(span.text.replace(/\s/g, ''))).map(span => ({ index, span })));
	if (headings.length !== 1) return null;
	const { index, span } = headings[0];
	const [title, headers, net, tax, total] = lines.slice(index, index + 5);
	if (!total || [headers, net, tax, total].some((line, offset) => line.page !== title.page || line.spans[0].region.y - lines[index + offset].spans[0].region.y > 24)) return null;
	const netHeader = headers.spans.at(-1)!;
	if (!/^net amount$/i.test(netHeader.text.trim()) || netHeader.region.x < span.region.x || total.spans.length !== 1) return null;
	const rightCell = (line: Line) => {
		const cells = line.spans.filter(cell => cell.region.x >= netHeader.region.x);
		return cells.length === 1 ? cells[0] : undefined;
	};
	const netValue = rightCell(net), taxValue = rightCell(tax), printedTotal = rightCell(total);
	if (!netValue || !taxValue || !printedTotal || !/^(?:vat|tax) (?:amount|total)\s*:?$/i.test(tax.spans.filter(cell => cell !== taxValue).map(cell => cell.text.trim()).join(' '))) return null;
	const values = [netValue, taxValue, printedTotal];
	const rightEdges = values.map(({ region }) => region.x + region.width);
	if (Math.max(...rightEdges) - Math.min(...rightEdges) > 3) return null;
	const printedCurrencies = unique(values.flatMap(value => currencies(value.text)));
	if (printedCurrencies.length > 1 || (currency && printedCurrencies.some(value => value !== currency))) return null;
	const established = printedCurrencies[0] ?? currency;
	if (!established) return null;
	const amounts = values.map(value => numberCandidates(value.text.replace(currencyPattern, '')));
	if (amounts.some(candidates => candidates.length !== 1)) return null;
	const [netAmount, taxAmount, totalAmount] = amounts.map(candidates => candidates[0]);
	const scale = Math.max(netAmount.scale, taxAmount.scale, totalAmount.scale);
	const scaled = (value: typeof totalAmount) => BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
	if (scaled(netAmount) + scaled(taxAmount) !== scaled(totalAmount)) return null;
	return { role: 'billed-total', label: 'Invoice summary total', candidates: [{ ...totalAmount, currency: established }],
		evidence: [...source({ ...title, spans: [span] }), ...source({ ...headers, spans: [netHeader] }), ...source({ ...net, spans: [netValue] }), ...source(tax), ...source(total)] };
}

function dateCandidates(raw: string): string[] {
	const values: string[] = [];
	const append = (year: string, month: string | number, day: string | number) => {
		const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		if (calendarDateSchema.safeParse(value).success) values.push(value);
	};
	let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (match) append(match[1], match[2], match[3]);
	match = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(raw);
	if (match) { append(match[4], match[3], match[1]); append(match[4], match[1], match[3]); }
	match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw);
	if (match) { const month = monthNames.findIndex(names => names.includes(match![1].toLowerCase())); if (month >= 0) append(match[3], month + 1, match[2]); }
	match = /^(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]+)\.?\s+(\d{4})$/.exec(raw);
	if (match) {
		const month = monthNames.findIndex(names => names.includes(match![2].toLowerCase()));
		if (month >= 0) append(match[3], month + 1, match[1]);
	}
	return unique(values);
}
const datePattern = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\.?\s+[A-Za-zÄÖÜäöü]+\.?\s+\d{4})\b/g;
function dateRole(raw: string): DateRole {
	const labels: [DateRole, RegExp][] = [
		['due', /date due|due date|due on|due\b|payable by|fällig|zahlbar bis/gi],
		['issue', /date of issue|issue date|invoice date|document date|tax invoice date|credit note date|rechnungsdatum|ausstellungsdatum|belegdatum/gi],
		['payment', /payment date|paid on|zahlung(?:sdatum)?/gi],
		['service-period', /billing period|service period|service date|charge start|leistungsdatum|leistungszeitraum|abrechnungszeitraum/gi]
	];
	const matches = labels.flatMap(([role, pattern]) => [...raw.matchAll(pattern)].map(match => ({ role, index: match.index! })));
	return matches.sort((a, b) => b.index - a.index)[0]?.role ?? 'unknown';
}
const genericDateLabel = /^date\s*:?$/i;

export function withGenericIssueDate(section: DocumentSection, pages: readonly ImportPage[]): DocumentSection['dates'] {
	if (section.kind === 'payment-information' || section.dates.some(field => field.role === 'issue' && field.candidates.length)) return section.dates;
	const labelled = new Map<string, SourceEvidence | null>();
	for (const field of section.dates) {
		if (field.role !== 'unknown' || !field.candidates.length) continue;
		for (const evidence of field.evidence) {
			const prefixes = [...evidence.rawText.matchAll(datePattern)].filter(match => dateCandidates(match[0]).length)
				.map(match => evidence.rawText.slice(0, match.index).trim()).filter(prefix => dateRole(prefix) === 'unknown');
			if (prefixes.length !== 1) continue;
			const [prefix] = prefixes;
			if (genericDateLabel.test(prefix)) { labelled.set(field.id, null); break; }
			if (prefix) continue;
			const page = pages.find(page => page.pageId === evidence.pageId);
			const value = evidence.region;
			// OCR can put words from the same printed row on separate lines because their top edges differ.
			const before = page?.spans.filter(({ method, text, region }) => {
				const overlap = Math.min(region.y + region.height, value.y + value.height) - Math.max(region.y, value.y);
				return method === evidence.method && text.trim() && region.x + region.width <= value.x &&
					overlap > 0 && overlap >= Math.min(region.height, value.height) / 2;
			});
			if (before?.length === 1 && genericDateLabel.test(before[0].text.trim())) {
				const { text, region, method } = before[0];
				labelled.set(field.id, { pageId: evidence.pageId, rawText: text.trim(), region, method });
				break;
			}
		}
	}
	const dates = section.dates.filter(field => labelled.has(field.id));
	if (new Set(dates.flatMap(field => field.candidates)).size !== 1) return section.dates;
	return section.dates.map(field => {
		if (!labelled.has(field.id)) return field;
		const label = labelled.get(field.id);
		return { ...field, role: 'issue', label: label ? label.rawText : field.label, evidence: label ? [label, ...field.evidence] : field.evidence };
	});
}

const referencePattern = /\b(tax invoice number|credit note number|invoice (?:number|no\.?|#)|invoice\s*#|receipt (?:number|no\.?|#)|document no\.?|billing number|bill no\.?|order (?:number|no\.?|#)|customer (?:number|no\.?|#)|account (?:number|no\.?|#)|table (?:number|no\.?|#)|payment (?:reference|id)|reference|rechnungsnummer|rechnungsnr\.?|kundennummer|mandantennummer|auftragsnr\.?|bestellnummer|transaktions-id)\s*[:#]?\s*/ig;
const referenceValue = /^[\p{L}\d][\p{L}\d_\-/.]*(?:[ \t]+[\p{L}\d][\p{L}\d_\-/.]*)*$/u;
function referencesOnLine(line: string) {
	const matches = [...line.matchAll(referencePattern)];
	return matches.map((match, index) => ({ label: match[1], value: line.slice(match.index! + match[0].length, matches[index + 1]?.index).trim() }));
}
export function hasFullDocumentReference(field: DocumentSection['references'][number], value: string): boolean {
	const lines = field.evidence.flatMap(item => referencesOnLine(item.rawText));
	const labelled = lines.filter(line => line.label.toLowerCase() === field.label.toLowerCase());
	return labelled.some(line => line.value === value) ||
		(labelled.some(line => !line.value) && field.evidence.some(item => item.rawText.trim() === value));
}
export function recordedDocumentPayments(result: SupportingDocument): Set<string> {
	const recorded = new Set<string>();
	const unclassified = new Map<string, string[]>();
	const evidenceKey = (item: SourceEvidence) => JSON.stringify([item.pageId, item.region.x, item.region.y, item.rawText]);
	for (const section of result.sections) for (const field of section.amounts) {
		if (field.role !== 'payment' || plannedPayment.test(field.label)) continue;
		if (explicitPayment.test(field.label) || field.evidence.some(item => appliedTransactions.test(item.rawText))) recorded.add(field.id);
		else for (const item of field.evidence) {
			const key = evidenceKey(item);
			const fields = unclassified.get(key) ?? [];
			fields.push(field.id);
			unclassified.set(key, fields);
		}
	}
	if (!unclassified.size) return recorded;
	// Older imports retain the payment row but may omit its table heading from the field evidence.
	for (const page of result.input?.pages ?? []) {
		let inPaymentBlock = false;
		for (const line of linesOf({ ...page, spans: [...page.spans].sort(order) })) {
			if (appliedTransactions.test(line.text)) inPaymentBlock = true;
			else if (heading(line.text) || endPaymentBlock.test(line.text)) inPaymentBlock = false;
			if (inPaymentBlock) for (const item of source(line)) {
				for (const fieldId of unclassified.get(evidenceKey(item)) ?? []) recorded.add(fieldId);
			}
		}
	}
	return recorded;
}

export function mergedLegacySections(result: SupportingDocument): Set<string> {
	const merged = new Set<string>();
	if (result.parserVersion !== '1' || !result.input) return merged;
	const pageHeadings = new Map(result.input.pages.map(page => [page.pageId, linesOf(page).map(line => heading(line.text))]));
	const possiblyMerged = result.sections.filter(section => (section.kind === 'invoice' || section.kind === 'receipt') &&
		section.pageIds.flatMap(pageId => pageHeadings.get(pageId) ?? []).filter(kind => kind === section.kind).length > 1);
	if (!possiblyMerged.length) return merged;
	const updated = interpretSupportingDocument(result.input);
	const locatedFields = (section: DocumentSection) => [...section.amounts, ...section.references].flatMap(field => field.evidence.map(item =>
		JSON.stringify([item.pageId, item.region.x, item.region.y, item.rawText])));
	const updatedSections = updated.sections.map(section => new Set(locatedFields(section)));
	for (const section of possiblyMerged) {
		const fields = locatedFields(section);
		if (updated.status === 'failed' || updatedSections.filter(locations => fields.some(field => locations.has(field))).length > 1) merged.add(section.sectionId);
	}
	return merged;
}
function referenceRole(label: string, section: DocumentSection): ReferenceRole {
	if (/customer|kunden|mandanten/i.test(label)) return 'customer';
	if (/account/i.test(label)) return 'account';
	if (/table/i.test(label)) return 'table';
	if (/order|auftrag|bestell/i.test(label)) return 'order';
	if (/payment|transaktions/i.test(label)) return 'payment';
	if (/receipt/i.test(label)) return 'receipt';
	if (/invoice|rechnung|document no|billing number|bill no|credit note/i.test(label)) return section.kind === 'credit-note' && /^invoice/i.test(label) ? 'related-invoice' : 'invoice';
	return 'unknown';
}

export function interpretSupportingDocument(rawInput: unknown): SupportingDocument {
	const checked = bankImportInputSchema.safeParse(rawInput);
	if (!checked.success) return supportingDocumentSchema.parse({ contractVersion: '1', parserVersion: '2', status: 'failed', input: null, sections: [],
		issues: [issue('invalid-input', 'The extracted document does not satisfy the positioned-text contract.')] });
	const input: BankImportInput = checked.data;
	for (const page of input.pages) page.spans.sort(order);
	const sections: DocumentSection[] = [], issues: DocumentIssue[] = [];
	let current: DocumentSection | undefined, fieldNumber = 0, issueOverflow = false;
	const sectionLines = new Map<string, Line[]>();
	const nextId = () => `field-${++fieldNumber}`;
	const addIssue = (code: string, message: string, section?: DocumentSection, fieldId: string | null = null, field: string | null = null, evidence: SourceEvidence[] = []) => {
		if (issues.length >= 9999) issueOverflow = true;
		else issues.push(issue(code, message, section?.sectionId ?? null, fieldId, field, evidence));
	};
	const createSection = (page: ImportPage, kind: DocumentSection['kind'], line?: Line) => {
		const section: DocumentSection = { sectionId: `section-${sections.length + 1}`, kind, pageIds: [page.pageId], evidence: line ? source(line) : [],
			amounts: [], dates: [], merchants: [], references: [], currencies: [] };
		sections.push(section); return section;
	};
	pages: for (const page of input.pages) {
		const lines = linesOf(page);
		if (page.status === 'failed' || !lines.length) {
			addIssue(page.status === 'failed' ? 'page-failed' : 'missing-text', 'This source page could not provide readable document text.');
			continue;
		}
		let paymentBlock: SourceEvidence[] = [];
		const fxPage = lines.some(line => /^(?:exchange rate|pricing currency)\b/i.test(line.text));
		for (const [index, line] of lines.entries()) {
			if (fieldNumber >= 9000 || sections.length >= 9000 || issues.length >= 9000) { addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.'); break pages; }
			const kind = heading(line.text);
			const pageStartHeading = index < 4 && kind !== null;
			const followingReferences = kind ? lines.slice(index + 1, lines.findIndex((next, nextIndex) => nextIndex > index && heading(next.text)) < 0 ? undefined :
				lines.findIndex((next, nextIndex) => nextIndex > index && heading(next.text))).flatMap(next => referencesOnLine(next.text).flatMap(({ label, value }) => {
					if (!/^(?:tax invoice|credit note|invoice|rechnungsnummer|rechnungsnr|document no|billing number)/i.test(label)) return [];
					return referenceValue.test(value) ? [value] : [];
				})) : [];
			const knownReferences = current?.references.filter(field => field.role === 'invoice').flatMap(field => field.candidates) ?? [];
			const sameDocument = kind === current?.kind && followingReferences.length > 0 && knownReferences.length > 0 && followingReferences.every(value => knownReferences.includes(value));
			const changedReference = followingReferences.length > 0 && knownReferences.length > 0 && followingReferences.some(value => !knownReferences.includes(value));
			if (!current) current = createSection(page, kind ?? 'unknown', line);
			else if (kind && current.kind === 'unknown' && current.pageIds.length === 1 && current.pageIds[0] === page.pageId) {
				current.kind = kind; current.evidence = source(line);
			} else if (kind && (kind !== current.kind || changedReference || (pageStartHeading && !current.pageIds.includes(page.pageId) && !sameDocument) ||
				(!sameDocument && (kind === 'invoice' || kind === 'receipt') && current.pageIds.includes(page.pageId)))) {
				paymentBlock = [];
				if (kind !== 'payment-information' || pageStartHeading) current = createSection(page, kind, line);
			}
			if (!current.pageIds.includes(page.pageId)) current.pageIds.push(page.pageId);
			const recordedLines = sectionLines.get(current.sectionId) ?? [];
			recordedLines.push(line); sectionLines.set(current.sectionId, recordedLines);
			const evidence = source(line);
			if (/\0|\(cid:\d+\)|�/.test(line.text)) addIssue('uncertain-text', 'Source text contains unreadable glyphs; retain the printed evidence for correction.', current, null, null, evidence);
			if (appliedTransactions.test(line.text)) paymentBlock = evidence;
			else if (endPaymentBlock.test(line.text)) paymentBlock = [];
			const ownCurrencies = currencies(line.text);
			if (ownCurrencies.length && (/\bcurrency\b|betrag in|\(EUR\)|\(USD\)|\(GBP\)/i.test(line.text) || current.kind === 'payment-information' && fxPage)) {
				current.currencies.push({ id: nextId(), role: current.kind === 'payment-information' && fxPage || /pricing currency|exchange rate/i.test(line.text) ? 'informational-fx' : 'settlement',
					label: line.text.slice(0, 16384), candidates: ownCurrencies, evidence });
			}
			for (const { label, value } of referencesOnLine(line.text)) {
				if (fieldNumber >= 9000) { addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.'); break pages; }
				const next = lines[index + 1];
				const continuation = !value && next && /^[\p{L}\d][\p{L}\d_\-/.]+$/u.test(next.text.trim()) ? next : null;
				current.references.push({ id: nextId(), role: referenceRole(label, current), label, candidates: referenceValue.test(value) ? [value] : continuation ? [continuation.text.trim()] : [],
					evidence: continuation ? [...evidence, ...source(continuation)] : evidence });
			}
			const merchant = /\b(?:merchant|seller|supplier|issued by|aussteller|lieferant)\s*:\s*(.+)$/i.exec(line.text);
			if (merchant && !/received by/i.test(merchant[1])) current.merchants.push({ id: nextId(), role: 'merchant', label: merchant[0], candidates: [merchant[1].trim()], evidence });
			const dateMatches = [...line.text.matchAll(datePattern)].filter(match => dateRole(line.text.slice(0, match.index)) !== 'unknown' || dateCandidates(match[0]).length > 0 || !amountRole(line.text, current!.kind, paymentBlock.length > 0, current!.kind === 'payment-information' && fxPage));
			const periodDates = dateMatches.filter(match => dateRole(line.text.slice(0, match.index)) === 'service-period');
			for (const [dateIndex, match] of dateMatches.entries()) {
				if (fieldNumber >= 9000) { addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.'); break pages; }
				const baseRole = dateRole(line.text.slice(0, match.index));
				const role = baseRole === 'service-period' && periodDates.length === 2 ? dateIndex === dateMatches.indexOf(periodDates[0]) ? 'service-start' : 'service-end' : baseRole;
				current.dates.push({ id: nextId(), role, label: line.text.slice(0, 16384), candidates: dateCandidates(match[0]), evidence });
			}
			if (!dateMatches.length && /^(?:issue date|invoice date|date of issue|date due|due date)\s*:?$/i.test(line.text) && lines[index + 1]) {
				const next = lines[index + 1], values = dateCandidates(next.text.trim());
				if (values.length) current.dates.push({ id: nextId(), role: dateRole(line.text), label: line.text, candidates: values, evidence: [...evidence, ...source(next)] });
			}
			const amountKind = amountRole(line.text, current.kind, paymentBlock.length > 0, current.kind === 'payment-information' && fxPage);
			if (!amountKind) for (const cell of columnAmounts(line, lines[index + 1], current.kind, lines[index - 1])) {
				const numeric = cell.value.replace(currencyPattern, '').trim(), own = currencies(cell.value);
				const candidates = numberCandidates(numeric).map(value => ({ ...value, currency: own.length === 1 ? own[0] : null }));
				const field = { id: nextId(), role: cell.role, label: cell.label, candidates, evidence: cell.evidence };
				current.amounts.push(field);
				addIssue('unconfirmed-field-association', 'The amount is positioned above this label; confirm their association from the source.', current, field.id, field.role, field.evidence);
			}
			if (!amountKind || /^(?:.*\b(?:invoice|receipt|customer|account|table|order)\s*(?:number|no\.?|#)|rechnungsnummer)/i.test(line.text) || dateMatches.length && !/[$€£]|\b(?:EUR|USD|GBP)\b/.test(line.text)) continue;
			const withoutDates = line.text.split('');
			for (const match of dateMatches) withoutDates.fill(' ', match.index, match.index! + match[0].length);
			const matches = [...withoutDates.join('').matchAll(numberPattern)];
			for (const match of matches) {
				if (fieldNumber >= 9000) { addIssue('interpretation-limit', 'Further field interpretation exceeded the local limit; full source text is retained.'); break pages; }
				if (line.text.slice(match.index! + match[0].length).trimStart().startsWith('%')) continue;
				const before = line.text.slice(0, match.index).trimEnd(), after = line.text.slice(match.index! + match[0].length).trimStart();
				const nearby = currencies(`${before.split(/\s+/).slice(-1).join(' ')} ${match[0]} ${after.split(/\s+/).slice(0, 1).join(' ')}`);
				if (!nearby.length && /^(?:miles|points|units|qty|quantity|meilen)\b/i.test(after)) continue;
				if (!nearby.length && !/[.,]\d|[$€£]/.test(match[0]) && matches.length > 1) continue;
				const explicit = nearby.length ? nearby : ownCurrencies.length === 1 && matches.length === 1 ? ownCurrencies : [];
				const prefixSign = new RegExp(`([-−+(]+)\\s*${code}$`).exec(before)?.[1] ?? '';
				const token = match[0].endsWith(',') && /^\s/.test(line.text.slice(match.index! + match[0].length)) ? match[0].slice(0, -1) : match[0];
				const values = numberCandidates(`${prefixSign}${token}`);
				const candidates = values.flatMap<DocumentSection['amounts'][number]['candidates'][number]>(value => explicit.length ? explicit.map(currency => ({ ...value, currency })) : [{ ...value, currency: null }]);
				const role = amountKind === 'refund-payment' ? amountKind : amountRole(before, current.kind, paymentBlock.length > 0, current.kind === 'payment-information' && fxPage) ?? amountKind;
				const amountEvidence = role === 'payment' ? [...paymentBlock, ...evidence] : evidence;
				current.amounts.push({ id: nextId(), role, label: line.text.slice(0, 16384), candidates, evidence: amountEvidence });
			}
		}
	}
	const defaultCurrency = [...sectionLines.values()].some(lines => lines.some(({ text }) =>
		currencies(text).length > 0 || /\p{Sc}|\b(?:currency|währung)\s*[:=]\s*\p{L}/iu.test(text))) ? null : 'EUR';
	for (const section of sections) {
		const lines = sectionLines.get(section.sectionId) ?? [];
		section.dates = withGenericIssueDate(section, input.pages);
		if (!section.merchants.length && section.kind !== 'payment-information') {
			const candidates: { text: string; evidence: SourceEvidence[] }[] = [];
			for (const line of lines) {
				if (/\bbill to\b|\bsold to\b|rechnungsempfänger/i.test(line.text)) break;
				if (line.spans[0].region.y > line.page.height * 0.3) continue;
				for (const span of line.spans) if (/\b(?:Inc\.?|Ltd\.?|Limited|GmbH|LLC|AG)\b/i.test(span.text) && !/\bmerchant\b|\bbill to\b|\bsold to\b/i.test(span.text)) {
					candidates.push({ text: span.text.trim().slice(0, 16384), evidence: source({ ...line, spans: [span] }) });
				}
				if (candidates.length >= 8) break;
			}
			if (candidates.length) {
				const field = { id: nextId(), role: 'merchant' as const, label: 'Unconfirmed supplier name', candidates: unique(candidates.slice(0, 8).map(value => value.text)), evidence: candidates.slice(0, 8).flatMap(value => value.evidence) };
				section.merchants.push(field);
				addIssue('unconfirmed-merchant', 'A company name is retained as an unconfirmed supplier candidate; review its source context.', section, field.id, 'merchant', field.evidence);
			}
		}
		const declared = unique(section.currencies.filter(field => field.role === 'settlement').flatMap(field => field.candidates));
		const currency = declared.length === 1 ? declared[0] : defaultCurrency;
		if (currency) for (const amount of section.amounts) if (amount.role !== 'informational-fx') for (const value of amount.candidates) value.currency ??= currency;
		if (section.kind === 'invoice' && declared.length <= 1 && !section.amounts.some(field => field.role === 'billed-total')) {
			const summary = invoiceSummaryTotal(lines, currency);
			if (summary) section.amounts.push({ ...summary, id: nextId() });
		}
		for (const field of [...section.amounts, ...section.dates, ...section.merchants, ...section.references, ...section.currencies]) {
			if (field.candidates.length !== 1) addIssue(field.candidates.length ? 'ambiguous-field' : 'unresolved-field', 'The printed field has no single established interpretation.', section, field.id, field.role, field.evidence);
		}
		for (const amount of section.amounts) if (amount.candidates.some(value => value.currency === null)) addIssue('missing-currency', 'This amount has no established ISO currency; symbols alone may be ambiguous.', section, amount.id, amount.role, amount.evidence);
		const conflicting = documentScalarConflicts(section);
		for (const field of [...section.amounts, ...section.dates, ...section.references, ...section.currencies]) if (conflicting.has(field.id)) {
			addIssue('conflicting-field', 'Distinct candidates for this section field require review.', section, field.id, field.role, field.evidence);
		}
		if (section.kind === 'unknown') addIssue('unknown-document', 'No supported document heading establishes the document kind; raw source text is retained.', section);
		if (section.kind !== 'payment-information') {
			const required = [
				[section.amounts.some(field => field.role === (section.kind === 'credit-note' ? 'credit-note-component' : 'billed-total')), 'billed-total'],
				[section.dates.some(field => field.role === 'issue'), 'issue'], [section.merchants.length > 0, 'merchant'],
				[section.references.some(field => ['invoice', 'receipt'].includes(field.role)), 'document-reference']
			] as const;
			for (const [present, role] of required) if (!present) addIssue('missing-field', 'A required document field has not been established.', section, null, role);
		}
	}
	for (const item of input.issues) addIssue(item.code, item.message, undefined, null, item.field, item.evidence);
	if (!sections.length) addIssue('no-readable-document', 'No readable document sections were established.');
	const result = issueOverflow ? null : supportingDocumentSchema.safeParse({ contractVersion: '1', parserVersion: '2', status: sections.length ? issues.length ? 'partial' : 'complete' : 'failed', input, sections, issues });
	if (result?.success) return result.data;
	return supportingDocumentSchema.parse({ contractVersion: '1', parserVersion: '2', status: 'failed', input, sections: [],
		issues: [issue('interpretation-limit', 'The interpreted fields exceed the validated local contract; full extracted source text is retained.')] });
}
