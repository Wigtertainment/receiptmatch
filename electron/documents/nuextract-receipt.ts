import { createHash, randomUUID } from 'node:crypto';
import { calendarDateSchema, type BankImportInput, type SourceEvidence } from '../../src/shared/bank-import.js';
import { originalSourceExtensions } from '../../src/shared/original-preview.js';
import { NUEXTRACT_RECEIPT_VERSION, type ReceiptAiChange, type ReceiptAiField, type ReceiptAiProposal, type ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import { supportingDocumentSchema, type DocumentSection, type SupportingDocument } from '../../src/shared/supporting-document.js';
import type { DocumentFormat } from '../../src/shared/workspace-documents.js';
import type { DocumentImagesResult, ExtractionOptions } from '../extraction/host.js';
import { NuExtractRuntime, type NuExtractRequest, type NuExtractRuntimeFiles } from '../extraction/nuextract-runtime.js';
import { assertSourceNotCancelled, readSourceSnapshot, SourceReadError } from '../import/source.js';
import { normalizeReference } from '../matching.js';
import { compareDocuments } from '../source-comparison.js';
import { dateCandidates, hasFullDocumentReference, numberCandidates, positionedLineEvidence, positionedLines, printedCurrencies } from './interpret.js';

export interface ReceiptAiSource {
    filePath: string;
    format: DocumentFormat;
    sha256: string;
    sourceId?: string;
    previous: SupportingDocument | null;
}

interface ReceiptRuntime {
    extract(input: NuExtractRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
    close(): Promise<void>;
}

export interface NuExtractReceiptDependencies {
    runtimeFiles(): Promise<NuExtractRuntimeFiles | undefined>;
    render(bytes: Uint8Array, sourceId: string, format: DocumentFormat, options?: ExtractionOptions): Promise<DocumentImagesResult>;
    start?: (files: NuExtractRuntimeFiles, signal?: AbortSignal) => Promise<ReceiptRuntime>;
}

const template: Record<string, string> = {
    invoice_or_receipt_number: 'verbatim-string',
    issue_date: 'date',
    gross_total: 'number'
};
const instructions: string = "Extract only values printed on the invoice or receipt. Use the document's own invoice number or receipt/check number. " +
    'Exclude order, customer, account and tax numbers. Issue date means the date the document was issued, excluding due dates and billing periods. ' +
    'Gross total means the final total inclusive of tax, excluding subtotal, tax alone, discounts, or balance after payment. Return null when a value cannot be read.';

type Line = ReturnType<typeof positionedLines>[number];
type ReferenceField = DocumentSection['references'][number];
type DateField = DocumentSection['dates'][number];
type AmountField = DocumentSection['amounts'][number];
type CurrencyField = DocumentSection['currencies'][number];
type CandidateAmount = AmountField['candidates'][number];
type DecimalAmount = Pick<CandidateAmount, 'coefficient' | 'scale'>;
type FieldState = 'verified' | 'unverified' | 'absent';
interface AnchoredValue<T> { label: string; value: T; evidence: SourceEvidence[] }
interface EvidencedField<T> { id: string; candidates: T[]; evidence: SourceEvidence[] }

const referenceLine: RegExp = /^(invoice\s*(?:number|no\.?|#)|rechnung(?:snummer|snr\.?)|receipt\s*(?:number|no\.?|#)|belegnummer|check\s*(?:number|no\.?|#)|chk)(?:\s*[:#]\s*|\s+|$)(\S.*)?$/i;
const issueLine: RegExp = /^(invoice date|issued on|issue date|date of issue|receipt date|document date|rechnungsdatum|ausstellungsdatum|belegdatum)(?:\s*:\s*|\s+|$)(\S.*)?$/i;
const germanIssueDateLine: RegExp = /^(?:rechnungsdatum|ausstellungsdatum|belegdatum)\s*:?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/i;
const totalLine: RegExp = /^(grand total|gross total|invoice total|total(?:\s+incl\.?\s*(?:vat|tax))?|gesamtbetrag|rechnungsbetrag|bruttobetrag)(?:\s*:\s*|\s+|$)(\S.*)?$/i;

function primarySection(analysis: SupportingDocument): DocumentSection | undefined {
    const identified: DocumentSection[] = analysis.sections.filter((section: DocumentSection): boolean => section.kind === 'invoice' || section.kind === 'receipt');
    if (identified.length) {
        return identified.length === 1 ? identified[0] : undefined;
    }
    return analysis.sections.length === 1 && analysis.sections[0].kind === 'unknown' ? analysis.sections[0] : undefined;
}

function sectionLines(input: BankImportInput, analysis: SupportingDocument, section: DocumentSection): Line[] {
    const sharedPages: Set<string> = new Set(analysis.sections.filter((item: DocumentSection): boolean => item !== section)
        .flatMap((item: DocumentSection): string[] => item.pageIds));
    return input.pages.filter((page: BankImportInput['pages'][number]): boolean => section.pageIds.includes(page.pageId) && !sharedPages.has(page.pageId))
        .flatMap(positionedLines);
}

function verifyCurrent<T>(analysis: SupportingDocument, fields: EvidencedField<T>[], match: (value: T) => boolean,
    resolve?: (field: EvidencedField<T>) => boolean): FieldState {
    if (!fields.length) {
        return 'absent';
    }
    if (fields.every((field: { candidates: T[] }): boolean => field.candidates.length === 1 && match(field.candidates[0]))) {
        return 'verified';
    }
    if (fields.length !== 1 || !resolve?.(fields[0])) {
        return 'unverified';
    }
    const selected: T[] = fields[0].candidates.filter(match);
    if (selected.length !== 1) {
        return 'unverified';
    }
    fields[0].candidates = selected;
    analysis.issues = analysis.issues.filter((issue: SupportingDocument['issues'][number]): boolean => issue.fieldId !== fields[0].id || issue.code !== 'ambiguous-field');
    return 'verified';
}

function labelContinuation(label: Line, next: Line | undefined): Line | undefined {
    if (next?.page !== label.page) {
        return undefined;
    }
    const first: SourceEvidence['region'] = label.spans[0].region, second: SourceEvidence['region'] = next.spans[0].region;
    const distance: number = second.y - first.y;
    return distance >= first.height / 2 && distance <= first.height * 2.5 && Math.abs(first.x - second.x) <= 10 ? next : undefined;
}

function anchoredValue<T>(lines: Line[], pattern: RegExp, convert: (printed: string) => T | undefined): AnchoredValue<T> | undefined {
    let found: AnchoredValue<T> | undefined;
    for (const [index, line] of lines.entries()) {
        const match: RegExpExecArray | null = pattern.exec(line.text);
        if (!match) {
            continue;
        }
        const continuation: Line | undefined = match[2] ? undefined : labelContinuation(line, lines[index + 1]);
        const printed: string | undefined = match[2] ?? continuation?.text;
        const value: T | undefined = printed === undefined ? undefined : convert(printed.trim());
        if (value === undefined) {
            continue;
        }
        if (found) {
            return undefined;
        }
        found = { label: match[1], value, evidence: [...positionedLineEvidence(line), ...(continuation ? positionedLineEvidence(continuation) : [])] };
    }
    return found?.evidence.length ? found : undefined;
}

function removeMissing(analysis: SupportingDocument, section: DocumentSection, role: 'document-reference' | 'issue' | 'billed-total'): void {
    analysis.issues = analysis.issues.filter((issue: SupportingDocument['issues'][number]): boolean =>
        issue.code !== 'missing-field' || issue.sectionId !== section.sectionId || issue.field !== role);
}

function sharedReferenceLocation(field: ReferenceField, evidence: SourceEvidence[]): boolean {
    return field.evidence.some((before: SourceEvidence): boolean => evidence.some((after: SourceEvidence): boolean =>
        before.pageId === after.pageId && before.region.x === after.region.x && before.region.y === after.region.y));
}

function verifyReference(analysis: SupportingDocument, section: DocumentSection, lines: Line[], value: unknown): boolean {
    if (typeof value !== 'string' || !value.trim() || value.length > 160) {
        return false;
    }
    const matches: (printed: string) => boolean = (printed: string): boolean => normalizeReference(printed) === normalizeReference(value);
    const fields: ReferenceField[] = section.references.filter((field: ReferenceField): boolean => field.role === 'invoice' || field.role === 'receipt');
    if (verifyCurrent(analysis, fields, matches) === 'verified') {
        return true;
    }
    if (fields.length > 1 || section.references.some((field: ReferenceField): boolean =>
        ['account', 'customer', 'order', 'table', 'payment', 'related-invoice'].includes(field.role) && field.candidates.some(matches))) {
        return false;
    }
    const anchor: AnchoredValue<string> | undefined = anchoredValue(lines, referenceLine, (printed: string): string | undefined => matches(printed) ? printed : undefined);
    if (!anchor) {
        return false;
    }
    const role: 'receipt' | 'invoice' = /^(receipt|beleg|check|chk)/i.test(anchor.label) ? 'receipt' : 'invoice';
    const current: ReferenceField | undefined = fields[0];
    if (current) {
        if (current.role !== role || !sharedReferenceLocation(current, anchor.evidence) ||
            current.candidates.some((candidate: string): boolean => hasFullDocumentReference(current, candidate))) {
            return false;
        }
        Object.assign(current, { label: anchor.label, candidates: [anchor.value], evidence: anchor.evidence });
        analysis.issues = analysis.issues.filter((issue: SupportingDocument['issues'][number]): boolean =>
            issue.fieldId !== current.id || !['ambiguous-field', 'unresolved-field'].includes(issue.code));
    } else {
        section.references.push({ id: randomUUID(), role, label: anchor.label, candidates: [anchor.value], evidence: anchor.evidence });
    }
    removeMissing(analysis, section, 'document-reference');
    return true;
}

function matchesGermanIssueDate(field: EvidencedField<string>, date: string): boolean {
    const printedDates: Set<string> = new Set(field.evidence.flatMap((evidence: SourceEvidence): string[] => {
        const printed: RegExpExecArray | null = germanIssueDateLine.exec(evidence.rawText.trim());
        return printed ? [[printed[3], printed[2].padStart(2, '0'), printed[1].padStart(2, '0')].join('-')] : [];
    }));
    return printedDates.size === 1 && printedDates.has(date);
}

function verifyDate(analysis: SupportingDocument, section: DocumentSection, lines: Line[], value: unknown): boolean {
    const parsed: ReturnType<typeof calendarDateSchema.safeParse> = calendarDateSchema.safeParse(value);
    if (!parsed.success) {
        return false;
    }
    const state: FieldState = verifyCurrent(analysis, section.dates.filter((field: DocumentSection['dates'][number]): boolean => field.role === 'issue'),
        (candidate: string): boolean => candidate === parsed.data, (field: EvidencedField<string>): boolean => matchesGermanIssueDate(field, parsed.data));
    if (state !== 'absent') {
        return state === 'verified';
    }
    const anchor: AnchoredValue<string> | undefined = anchoredValue(lines, issueLine, (printed: string): string | undefined => {
        const options: string[] = dateCandidates(printed);
        return options.length === 1 && options[0] === parsed.data ? options[0] : undefined;
    });
    if (!anchor) {
        return false;
    }
    section.dates.push({ id: randomUUID(), role: 'issue', label: anchor.label, candidates: [anchor.value], evidence: anchor.evidence });
    removeMissing(analysis, section, 'issue');
    return true;
}

function decimalAmount(value: unknown): DecimalAmount | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') {
        return undefined;
    }
    const raw: string = String(value).trim();
    return /^-?\d{1,18}(?:\.\d{1,18})?$/.test(raw) ? numberCandidates(raw).find((item: DecimalAmount): boolean => item.scale === (raw.split('.')[1]?.length ?? 0)) : undefined;
}

function sameAmount(left: DecimalAmount, right: DecimalAmount): boolean {
    return BigInt(left.coefficient) * 10n ** BigInt(right.scale) === BigInt(right.coefficient) * 10n ** BigInt(left.scale);
}

function printedAmount(raw: string, section: DocumentSection, expected: DecimalAmount): CandidateAmount | undefined {
    const own: string[] = printedCurrencies(raw);
    const settlement: Set<string> = new Set(section.currencies.filter((field: DocumentSection['currencies'][number]): boolean => field.role === 'settlement')
        .flatMap((field: DocumentSection['currencies'][number]): string[] => field.candidates));
    if (own.length > 1 || (own.length && settlement.size && !settlement.has(own[0]))) {
        return undefined;
    }
    const currency: string | undefined = own[0] ?? (settlement.size === 1 ? [...settlement][0] : undefined);
    if (!currency) {
        return undefined;
    }
    const candidates: DecimalAmount[] = numberCandidates(raw.replace(new RegExp('\\b' + currency + '\\b', 'g'), '').trim());
    return candidates.length === 1 && sameAmount(candidates[0], expected) ? { ...candidates[0], currency } : undefined;
}

function verifyTotal(analysis: SupportingDocument, section: DocumentSection, lines: Line[], value: unknown): boolean {
    const amount: DecimalAmount | undefined = decimalAmount(value);
    if (!amount) {
        return false;
    }
    const state: FieldState = verifyCurrent(analysis, section.amounts.filter((field: DocumentSection['amounts'][number]): boolean => field.role === 'billed-total'),
        (candidate: CandidateAmount): boolean => sameAmount(candidate, amount));
    if (state !== 'absent') {
        return state === 'verified';
    }
    const anchor: AnchoredValue<CandidateAmount> | undefined = anchoredValue(lines, totalLine, (printed: string): CandidateAmount | undefined => printedAmount(printed, section, amount));
    if (!anchor) {
        return false;
    }
    section.amounts.push({ id: randomUUID(), role: 'billed-total', label: anchor.label, candidates: [anchor.value], evidence: anchor.evidence });
    removeMissing(analysis, section, 'billed-total');
    return true;
}

function unrecognized(label: string, value: unknown): ReceiptAiChange[] {
    if (value === null || value === undefined) {
        return [];
    }
    const display: string = typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 160) : 'Invalid model value';
    return [{ label, before: null, after: display || 'Invalid model value', unrecognized: true }];
}

const modelFields: readonly { field: ReceiptAiField; label: string; key: string }[] = [
    { field: 'reference', label: 'Invoice or receipt number', key: 'invoice_or_receipt_number' },
    { field: 'issue-date', label: 'Issue date', key: 'issue_date' },
    { field: 'billed-total', label: 'Billed total', key: 'gross_total' }
];

function isDocumentReference(field: ReferenceField): boolean {
    return field.role === 'invoice' || field.role === 'receipt';
}

function amountText({ coefficient, scale, currency }: CandidateAmount): string {
    const sign: string = coefficient.startsWith('-') ? '-' : '';
    const digits: string = coefficient.slice(sign.length).padStart(scale + 1, '0');
    const value: string = scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits;
    return sign + value + (currency ? ' ' + currency : '');
}

function currentField(section: DocumentSection | undefined, field: ReceiptAiField): string | null {
    if (!section) {
        return null;
    }
    const values: string[] = field === 'reference' ? section.references.filter(isDocumentReference).flatMap((item: ReferenceField): string[] => item.candidates)
        : field === 'issue-date' ? section.dates.filter((item: DateField): boolean => item.role === 'issue').flatMap((item: DateField): string[] => item.candidates)
            : section.amounts.filter((item: AmountField): boolean => item.role === 'billed-total').flatMap((item: AmountField): string[] => item.candidates.map(amountText));
    return [...new Set(values)].join(' / ') || null;
}

function currencyForTotal(section: DocumentSection): string | undefined {
    const values: Set<string> = new Set(section.currencies.filter((item: CurrencyField): boolean => item.role === 'settlement').flatMap((item: CurrencyField): string[] => item.candidates));
    for (const amount of section.amounts.filter((item: AmountField): boolean => item.role === 'billed-total').flatMap((item: AmountField): CandidateAmount[] => item.candidates)) {
        if (amount.currency) {
            values.add(amount.currency);
        }
    }
    return values.size === 1 ? [...values][0] : undefined;
}

function proposalValue(field: ReceiptAiField, raw: unknown): string | undefined {
    if (field === 'billed-total') {
        return decimalAmount(raw) ? String(raw).trim() : undefined;
    }
    if (field === 'issue-date') {
        return calendarDateSchema.safeParse(raw).data;
    }
    return typeof raw === 'string' && raw.trim() && raw.length <= 160 ? raw.trim() : undefined;
}

function verifyField(analysis: SupportingDocument, section: DocumentSection, lines: Line[], field: ReceiptAiField, value: unknown): boolean {
    switch (field) {
        case 'reference': return verifyReference(analysis, section, lines, value);
        case 'issue-date': return verifyDate(analysis, section, lines, value);
        case 'billed-total': return verifyTotal(analysis, section, lines, value) &&
            !section.amounts.some((item: AmountField): boolean => item.role === 'billed-total' &&
                item.candidates.some((amount: CandidateAmount): boolean => amount.currency === null));
    }
}

function reviewFields(analysis: SupportingDocument, input: BankImportInput, result: Record<string, unknown>): {
    pending: ReceiptAiChange[];
    proposals: ReceiptAiProposal[];
} {
    const section: DocumentSection | undefined = primarySection(analysis);
    const lines: Line[] = section ? sectionLines(input, analysis, section) : [];
    const pending: ReceiptAiChange[] = [];
    const proposals: ReceiptAiProposal[] = [];
    for (const { field, label, key } of modelFields) {
        const raw: unknown = result[key];
        const before: string | null = currentField(section, field);
        const verified: boolean = section ? verifyField(analysis, section, lines, field, raw) : false;
        if (!verified) {
            pending.push(...unrecognized(label, raw));
        }
        const value: string | undefined = proposalValue(field, raw);
        if (value === undefined || (verified && currentField(section, field) === before)) {
            continue;
        }
        const proposal: ReceiptAiProposal = { field, label, before, value, verified, sectionId: section?.sectionId };
        if (!section) {
            proposal.unavailable = 'No single invoice or receipt section could be identified.';
        } else if (field === 'billed-total') {
            proposal.currency = currencyForTotal(section);
            proposal.needsCurrency = !proposal.currency;
        }
        proposals.push(proposal);
    }
    return { pending, proposals };
}

function replaceConfirmed<T extends { id: string }>(analysis: SupportingDocument, fields: T[], matches: (field: T) => boolean, replacement: T): T[] {
    const replaced: Set<string> = new Set(fields.filter(matches).map((field: T): string => field.id));
    analysis.issues = analysis.issues.filter((issue: SupportingDocument['issues'][number]): boolean => issue.fieldId === null || !replaced.has(issue.fieldId));
    return replaced.size ? fields.flatMap((field: T): T[] => field.id === replacement.id ? [replacement] : replaced.has(field.id) ? [] : [field])
        : [...fields, replacement];
}

function confirmField(analysis: SupportingDocument, section: DocumentSection, proposal: ReceiptAiProposal, currency?: string): void {
    const { field, label, value }: ReceiptAiProposal = proposal;
    switch (field) {
        case 'reference': {
            const existing: ReferenceField | undefined = section.references.find(isDocumentReference);
            section.references = replaceConfirmed(analysis, section.references, isDocumentReference, { id: existing?.id ?? randomUUID(),
                role: existing?.role ?? (section.kind === 'receipt' ? 'receipt' : 'invoice'), label: existing?.label ?? label,
                candidates: [value], evidence: [], confirmedByUser: true });
            removeMissing(analysis, section, 'document-reference');
            break;
        }
        case 'issue-date': {
            const existing: DateField | undefined = section.dates.find((item: DateField): boolean => item.role === 'issue');
            section.dates = replaceConfirmed(analysis, section.dates, (item: DateField): boolean => item.role === 'issue', { id: existing?.id ?? randomUUID(),
                role: 'issue', label: existing?.label ?? label, candidates: [value], evidence: [], confirmedByUser: true });
            removeMissing(analysis, section, 'issue');
            break;
        }
        case 'billed-total': {
            const existing: AmountField | undefined = section.amounts.find((item: AmountField): boolean => item.role === 'billed-total');
            const amount: DecimalAmount | undefined = decimalAmount(value);
            const confirmedCurrency: string | undefined = proposal.currency ?? currency;
            if (!amount || !confirmedCurrency || !/^[A-Z]{3}$/.test(confirmedCurrency)) {
                throw new Error('Enter the three-letter currency printed on the receipt before applying the total.');
            }
            section.amounts = replaceConfirmed(analysis, section.amounts, (item: AmountField): boolean => item.role === 'billed-total', { id: existing?.id ?? randomUUID(),
                role: 'billed-total', label: existing?.label ?? label, candidates: [{ ...amount, currency: confirmedCurrency }], evidence: [], confirmedByUser: true });
            removeMissing(analysis, section, 'billed-total');
            break;
        }
    }
}

function finalizeAnalysis(analysis: SupportingDocument, input: BankImportInput): SupportingDocument {
    if (!analysis.issues.length && !input.issues.length && analysis.sections.length) {
        analysis.status = 'complete';
    }
    input.extraction = { runId: randomUUID(), version: NUEXTRACT_RECEIPT_VERSION };
    return supportingDocumentSchema.parse(analysis);
}

export function applySelectedReceiptAi(previous: SupportingDocument, proposals: ReceiptAiProposal[], selection: readonly ReceiptAiField[],
    currency?: string): SupportingDocument {
    const analysis: SupportingDocument = structuredClone(previous);
    const input: BankImportInput | null = analysis.input;
    const section: DocumentSection | undefined = primarySection(analysis);
    if (!input || !section || !selection.length) {
        throw new Error('Select at least one suggestion for an identified receipt.');
    }
    const lines: Line[] = sectionLines(input, analysis, section);
    for (const field of selection) {
        const proposal: ReceiptAiProposal | undefined = proposals.find((item: ReceiptAiProposal): boolean => item.field === field);
        if (!proposal || proposal.unavailable) {
            throw new Error('A selected suggestion is no longer available. Analyze the receipt again.');
        }
        if (!proposal.verified) {
            confirmField(analysis, section, proposal, currency);
        } else if (!verifyField(analysis, section, lines, field, proposal.value)) {
            throw new Error('A selected suggestion could no longer be verified. Analyze the receipt again.');
        }
    }
    return finalizeAnalysis(analysis, input);
}

export function reviewNuExtractResult(previous: SupportingDocument, result: Record<string, unknown>): Extract<ReceiptAiResult, { status: 'ready' }> {
    const analysis: SupportingDocument = structuredClone(previous);
    const input: BankImportInput | null = analysis.input;
    if (!input || analysis.status === 'failed') {
        throw new Error('NuExtract3 needs the original receipt analysis for source verification.');
    }
    const { pending, proposals }: ReturnType<typeof reviewFields> = reviewFields(analysis, input, result);
    const verified: SupportingDocument = finalizeAnalysis(analysis, input);
    const { changes, conflicts }: ReturnType<typeof compareDocuments> = compareDocuments({ result: previous }, { result: verified });
    return { status: 'ready', model: 'nuextract3', analysis: verified, proposals, changes: [...changes, ...pending], conflicts };
}

function planSource(source: ReceiptAiSource): BankImportInput | undefined {
    const input: BankImportInput | null | undefined = source.previous?.input;
    return input && source.previous?.status !== 'failed' && input.source.sha256 === source.sha256 &&
        (source.sourceId === undefined || input.source.sourceId === source.sourceId) ? input : undefined;
}

async function extractModelResult(files: NuExtractRuntimeFiles, images: Uint8Array[], signal: AbortSignal | undefined,
    start: NonNullable<NuExtractReceiptDependencies['start']>): Promise<Record<string, unknown>> {
    const runtime: ReceiptRuntime = await start(files, signal);
    try {
        return await runtime.extract({ images, template, instructions }, signal);
    } finally {
        await runtime.close();
    }
}

export async function reanalyzeNuExtractReceipt(source: ReceiptAiSource, dependencies: NuExtractReceiptDependencies, options: ExtractionOptions = {}): Promise<ReceiptAiResult> {
    try {
        assertSourceNotCancelled(options.signal);
        const input: BankImportInput | undefined = planSource(source);
        if (!input || !source.previous) {
            return { status: 'failed', error: 'Run standard recognition successfully before comparing this receipt with NuExtract3.' };
        }
        const files: NuExtractRuntimeFiles | undefined = await dependencies.runtimeFiles();
        if (!files) {
            return { status: 'failed', error: 'Download NuExtract3 and select a compatible device under Settings → Document recognition.' };
        }
        const bytes: Uint8Array = await readSourceSnapshot(source.filePath, originalSourceExtensions[source.format], options.signal);
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
            throw new SourceReadError('source-changed', 'The original receipt changed. Restore or relink it and try again.');
        }
        const rasters: DocumentImagesResult = await dependencies.render(bytes, input.source.sourceId, source.format, options);
        assertSourceNotCancelled(options.signal);
        if (rasters.status === 'cancelled') {
            return { status: 'cancelled' };
        }
        if (rasters.status !== 'complete') {
            return { status: 'failed', error: rasters.issues[0]?.message ?? 'The original receipt could not be rendered.' };
        }
        if (rasters.images.length !== input.pages.length) {
            return { status: 'failed', error: 'The rendered pages do not match the original receipt analysis.' };
        }
        options.onProgress?.({ phase: 'ocr', pageNumber: null, pageCount: rasters.images.length, completedPages: 0 });
        const start: NonNullable<NuExtractReceiptDependencies['start']> = dependencies.start ??
            ((model: NuExtractRuntimeFiles, signal?: AbortSignal): Promise<NuExtractRuntime> => NuExtractRuntime.start(model, signal));
        const result: Record<string, unknown> = await extractModelResult(files, rasters.images, options.signal, start);
        assertSourceNotCancelled(options.signal);
        return reviewNuExtractResult(source.previous, result);
    } catch (error: unknown) {
        if (options.signal?.aborted || (error instanceof SourceReadError && error.code === 'cancelled')) {
            return { status: 'cancelled' };
        }
        return { status: 'failed', error: error instanceof SourceReadError ? error.message : 'NuExtract3 could not complete the analysis. Check the original receipt and device settings, then try again.' };
    }
}
