import { z } from 'zod';
import { moneySchema } from './money.js';

interface IBankImportLimits {
    readonly pages: 200;
    readonly spansPerPage: 10000;
    readonly spans: 100000;
    readonly text: 2000000;
    readonly spanText: 4096;
    readonly fieldText: 16384;
    readonly rows: 10000;
    readonly evidence: 256;
}

// Transport safety bounds, not a claim about supported document sizes or OCR quality.
export const BANK_IMPORT_LIMITS: IBankImportLimits =
    { pages: 200, spansPerPage: 10000, spans: 100000, text: 2000000, spanText: 4096, fieldText: 16384, rows: 10000, evidence: 256 } as const;
const id: z.ZodString = z.string().min(1).max(128);
const text: z.ZodString = z.string().min(1).max(BANK_IMPORT_LIMITS.fieldText);
const currency: z.ZodString = z.string().regex(/^[A-Z]{3}$/);
const method: z.ZodEnum<z.core.util.ToEnum<'embedded-text' | 'local-ocr'>> = z.enum(['embedded-text', 'local-ocr']);
interface IRegionShape { x: z.ZodNumber; y: z.ZodNumber; width: z.ZodNumber; height: z.ZodNumber }
export const regionSchema: z.ZodObject<z.core.util.Flatten<IRegionShape>, z.core.$strict> = z.strictObject({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
});
export const calendarDateSchema: z.ZodISODate = z.iso.date().refine((value: string): boolean => !value.startsWith('0000-'), 'Use a calendar year from 0001.');
interface IEvidenceShape {
	pageId: z.ZodString;
	region: typeof regionSchema;
	rawText: z.ZodString;
	method: typeof method;
}
export const evidenceSchema: z.ZodObject<z.core.util.Flatten<IEvidenceShape>, z.core.$strict> = z.strictObject({ pageId: id, region: regionSchema, rawText: text, method });
const evidenceList: z.ZodArray<typeof evidenceSchema> = z.array(evidenceSchema).max(BANK_IMPORT_LIMITS.evidence);
const fieldEvidence: typeof evidenceList = evidenceList.min(1);
interface IImportIssueShape {
	code: z.ZodString;
	severity: z.ZodEnum<z.core.util.ToEnum<'error' | 'warning'>>;
	message: z.ZodString;
	pageId: z.ZodNullable<z.ZodString>;
	rowId: z.ZodNullable<z.ZodString>;
	field: z.ZodNullable<z.ZodString>;
	evidence: typeof evidenceList;
}
export const importIssueSchema: z.ZodObject<z.core.util.Flatten<IImportIssueShape>, z.core.$strict> = z.strictObject({
    code: z.string().min(1).max(80),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(512),
    pageId: id.nullable(),
    rowId: id.nullable(),
    field: z.string().min(1).max(80).nullable(),
    evidence: evidenceList
});
const issues: z.ZodArray<typeof importIssueSchema> = z.array(importIssueSchema).max(1000);
interface ISourceShape { sourceId: z.ZodString; sha256: z.ZodString }
const sourceSchema: z.ZodObject<z.core.util.Flatten<ISourceShape>, z.core.$strict> = z.strictObject({ sourceId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
interface IPageMetadataShape { pageId: z.ZodString; pageNumber: z.ZodNumber; width: z.ZodNumber; height: z.ZodNumber }
const pageMetadata: z.ZodObject<z.core.util.Flatten<IPageMetadataShape>, z.core.$strict> = z.strictObject({
    pageId: id,
    pageNumber: z.number().int().min(1).max(100000),
    width: z.number().finite().positive().max(20000),
    height: z.number().finite().positive().max(20000)
});
interface IPositionedSpanShape { text: z.ZodString; region: typeof regionSchema; method: typeof method }
const spanSchema: z.ZodObject<z.core.util.Flatten<IPositionedSpanShape>, z.core.$strict> =
    z.strictObject({ text: z.string().min(1).max(BANK_IMPORT_LIMITS.spanText), region: regionSchema, method });
interface IImportPageShape extends IPageMetadataShape {
	status: z.ZodEnum<z.core.util.ToEnum<'complete' | 'failed'>>;
	spans: z.ZodArray<typeof spanSchema>;
}
const pageSchema: z.ZodObject<z.core.util.Flatten<IImportPageShape>, z.core.$strict> =
    pageMetadata.extend({ status: z.enum(['complete', 'failed']), spans: z.array(spanSchema).max(BANK_IMPORT_LIMITS.spansPerPage) });
type PageMetadata = z.infer<typeof pageMetadata>;
type Evidence = z.infer<typeof evidenceSchema>;
type AccountSection = BankImportResult['accountSections'][number];

function withinPage(region: z.infer<typeof regionSchema>, page: PageMetadata): boolean {
    return region.x + region.width <= page.width && region.y + region.height <= page.height;
}

function checkPages(pages: PageMetadata[], ctx: z.RefinementCtx): void {
    const ids: Set<string> = new Set<string>();
    let previous: number = 0;
    for (const [index, page] of pages.entries()) {
        if (ids.has(page.pageId) || page.pageNumber <= previous) {
                ctx.addIssue({ code: 'custom', message: 'Pages need unique IDs and increasing source page numbers.', path: ['pages', index] });
            }
        ids.add(page.pageId);
        previous = page.pageNumber;
    }
}

function checkEvidence(values: Evidence[], pages: PageMetadata[], ctx: z.RefinementCtx): void {
    for (const value of values) {
        const page: PageMetadata | undefined = pages.find((page: PageMetadata): boolean => page.pageId === value.pageId);
        if (!page || !withinPage(value.region, page)) {
            ctx.addIssue({ code: 'custom', message: 'Evidence must reference a region within a source page.' });
        }
    }
}
interface IExtractionRunShape { runId: z.ZodString; version: z.ZodString }
interface IBankImportInputShape {
	source: typeof sourceSchema;
	extraction: z.ZodObject<z.core.util.Flatten<IExtractionRunShape>, z.core.$strict>;
	pages: z.ZodArray<typeof pageSchema>;
	issues: typeof issues;
}
type BankImportInputSchemaType = z.ZodObject<z.core.util.Flatten<IBankImportInputShape>, z.core.$strict>;
export const bankImportInputSchema: BankImportInputSchemaType = z
    .strictObject({
        source: sourceSchema,
        extraction: z.strictObject({ runId: id, version: id }),
        pages: z.array(pageSchema).min(1).max(BANK_IMPORT_LIMITS.pages),
        issues
    })
    .superRefine((value: z.output<BankImportInputSchemaType>, ctx: z.RefinementCtx): void => {
        checkPages(value.pages, ctx);
        checkSpans(value.pages, ctx);
        for (const issue of value.issues) {
            if (issue.rowId !== null) {
                ctx.addIssue({ code: 'custom', message: 'Extraction issues cannot claim parser-local row IDs.' });
            }
            if (issue.pageId !== null && !value.pages.some((page: ImportPage): boolean => page.pageId === issue.pageId)) {
                ctx.addIssue({ code: 'custom', message: 'Issue references an unknown page.' });
            }
            checkEvidence(issue.evidence, value.pages, ctx);
        }
    });
function checkSpans(pages: ImportPage[], ctx: z.RefinementCtx): void {
    let spanCount: number = 0;
    let textCount: number = 0;
    for (const [index, page] of pages.entries()) {
        spanCount += page.spans.length;
        for (const span of page.spans) {
            textCount += span.text.length;
            if (!withinPage(span.region, page)) {
                ctx.addIssue({ code: 'custom', message: 'Text spans must stay within the page.', path: ['pages', index, 'spans'] });
            }
        }
        if (page.status === 'failed' && page.spans.length) {
            ctx.addIssue({ code: 'custom', message: 'Failed pages cannot claim extracted spans.', path: ['pages', index] });
        }
    }
    if (spanCount > BANK_IMPORT_LIMITS.spans || textCount > BANK_IMPORT_LIMITS.text) {
        ctx.addIssue({ code: 'custom', message: 'The extraction exceeds transport limits.' });
    }
}

interface IDateFieldShape { value: z.ZodISODate; basisLabel: z.ZodString; evidence: typeof evidenceList }
const dateField: z.ZodObject<z.core.util.Flatten<IDateFieldShape>, z.core.$strict> =
    z.strictObject({ value: calendarDateSchema, basisLabel: z.string().min(1).max(80), evidence: fieldEvidence });
interface IMoneyFieldShape { value: typeof moneySchema; evidence: typeof evidenceList }
const moneyField: z.ZodObject<z.core.util.Flatten<IMoneyFieldShape>, z.core.$strict> = z.strictObject({ value: moneySchema, evidence: fieldEvidence });
interface ITextFieldShape { value: z.ZodString; evidence: typeof evidenceList }
const textField: z.ZodObject<z.core.util.Flatten<ITextFieldShape>, z.core.$strict> = z.strictObject({ value: text, evidence: fieldEvidence });
interface IReferenceShape extends ITextFieldShape { label: z.ZodString }
const referenceSchema: z.ZodObject<z.core.util.Flatten<IReferenceShape>, z.core.$strict> =
    z.strictObject({ label: z.string().min(1).max(80), value: text, evidence: fieldEvidence });
type DirectionSchema = z.ZodEnum<z.core.util.ToEnum<'incoming' | 'outgoing'>>;
interface IRowShape {
    rowId: z.ZodString;
    accountSectionId: z.ZodString;
    bookingDate: z.ZodNullable<typeof dateField>;
    valueDate: z.ZodNullable<typeof dateField>;
    accountAmount: z.ZodNullable<typeof moneyField>;
    direction: z.ZodNullable<DirectionSchema>;
    reportedOriginalAmount: z.ZodNullable<typeof moneyField>;
    description: z.ZodNullable<typeof textField>;
    counterpartyCandidate: z.ZodNullable<typeof textField>;
    references: z.ZodArray<typeof referenceSchema>;
    evidence: typeof evidenceList;
}
const rowShape: IRowShape = {
    rowId: id,
    accountSectionId: id,
    bookingDate: dateField.nullable(),
    valueDate: dateField.nullable(),
    accountAmount: moneyField.nullable(),
    direction: z.enum(['incoming', 'outgoing']).nullable(),
    reportedOriginalAmount: moneyField.nullable(),
    description: textField.nullable(),
    counterpartyCandidate: textField.nullable(),
    references: z.array(referenceSchema).max(32),
    evidence: fieldEvidence
};
interface ITransactionShape extends Omit<IRowShape, 'bookingDate' | 'accountAmount' | 'direction' | 'description'> {
	bookingDate: typeof dateField;
	accountAmount: typeof moneyField;
	direction: DirectionSchema;
	description: typeof textField;
}
const transactionSchema: z.ZodObject<z.core.util.Flatten<ITransactionShape>, z.core.$strict> = z.strictObject({
    ...rowShape, bookingDate: dateField, accountAmount: moneyField, direction: z.enum(['incoming', 'outgoing']), description: textField
});
interface IDraftShape extends IRowShape {
	issues: typeof issues;
}
const draftSchema: z.ZodObject<z.core.util.Flatten<IDraftShape>, z.core.$strict> = z.strictObject({ ...rowShape, issues: issues.min(1) });
interface IAccountSectionShape {
    sectionId: z.ZodString;
    currency: typeof textField;
    accountReference: z.ZodNullable<typeof referenceSchema>;
    evidence: typeof evidenceList;
}
const accountSectionSchema: z.ZodObject<z.core.util.Flatten<IAccountSectionShape>, z.core.$strict> = z.strictObject({
    sectionId: id,
    currency: z.strictObject({ value: currency, evidence: fieldEvidence }),
    accountReference: referenceSchema.nullable(),
    evidence: fieldEvidence
});
interface IAdapterIdentityShape {
	bankId: z.ZodString;
	adapterId: z.ZodString;
	version: z.ZodString;
}
interface IAdapterLayoutShape { layoutId: z.ZodString; version: z.ZodString }
interface IAdapterMetadataShape extends IAdapterIdentityShape {
	layouts: z.ZodArray<z.ZodObject<z.core.util.Flatten<IAdapterLayoutShape>, z.core.$strict>>;
}
export const adapterMetadataSchema: z.ZodObject<z.core.util.Flatten<IAdapterMetadataShape>, z.core.$strict> = z.strictObject({
    bankId: id,
    adapterId: id,
    version: id,
    layouts: z
        .array(z.strictObject({ layoutId: id, version: id }))
        .min(1)
        .max(32)
});
interface ISelectedAdapterShape extends IAdapterIdentityShape { layoutId: z.ZodString; layoutVersion: z.ZodString }
const selectedAdapter: z.ZodObject<z.core.util.Flatten<ISelectedAdapterShape>, z.core.$strict> =
    z.strictObject({ bankId: id, adapterId: id, version: id, layoutId: id, layoutVersion: id });
interface ILocalRecognitionShape {
    model: z.ZodEnum<z.core.util.ToEnum<'paddleocr-vl-1.6' | 'nuextract3'>>;
    parserVersion: z.ZodLiteral<'1'>;
}
const localRecognitionSchema: z.ZodObject<z.core.util.Flatten<ILocalRecognitionShape>, z.core.$strict> =
    z.strictObject({ model: z.enum(['paddleocr-vl-1.6', 'nuextract3']), parserVersion: z.literal('1') });
interface ISourceProvenanceShape extends ISourceShape {
    extractionRunId: z.ZodString;
    extractionVersion: z.ZodString;
    pages: z.ZodArray<typeof pageMetadata>;
}
const provenanceSchema: z.ZodObject<z.core.util.Flatten<ISourceProvenanceShape>, z.core.$strict> =
    sourceSchema.extend({ extractionRunId: id, extractionVersion: id, pages: z.array(pageMetadata).min(1).max(BANK_IMPORT_LIMITS.pages) });
interface IBankImportResultShape {
	contractVersion: z.ZodLiteral<"1">;
	status: z.ZodEnum<z.core.util.ToEnum<'complete' | 'failed' | 'partial' | 'unsupported'>>;
	adapter: z.ZodNullable<typeof selectedAdapter>;
	localRecognition: z.ZodOptional<typeof localRecognitionSchema>;
	sourceProvenance: z.ZodNullable<typeof provenanceSchema>;
	accountSections: z.ZodArray<typeof accountSectionSchema>;
	transactions: z.ZodArray<typeof transactionSchema>;
	unresolvedDrafts: z.ZodArray<typeof draftSchema>;
	issues: typeof issues;
}
type BankImportResultSchemaType = z.ZodObject<z.core.util.Flatten<IBankImportResultShape>, z.core.$strict>;
export const bankImportResultSchema: BankImportResultSchemaType = z
    .strictObject({
        contractVersion: z.literal('1'),
        status: z.enum(['complete', 'partial', 'unsupported', 'failed']),
        adapter: selectedAdapter.nullable(),
        localRecognition: localRecognitionSchema.optional(),
        sourceProvenance: provenanceSchema.nullable(),
        accountSections: z.array(accountSectionSchema).max(200),
        transactions: z.array(transactionSchema).max(BANK_IMPORT_LIMITS.rows),
        unresolvedDrafts: z.array(draftSchema).max(BANK_IMPORT_LIMITS.rows),
        issues
    })
    .superRefine((value: z.output<BankImportResultSchemaType>, ctx: z.RefinementCtx): void => {
        const pages: PageMetadata[] = value.sourceProvenance?.pages ?? [];
        checkPages(pages, ctx);
        checkResultStatus(value, ctx);
        const sections: Set<string> = new Set<string>();
        const rowIds: Set<string> = new Set<string>();
        const allEvidence: Evidence[] = [];
        for (const section of value.accountSections) {
            if (sections.has(section.sectionId)) {
                ctx.addIssue({ code: 'custom', message: 'Account section IDs must be unique.' });
            }
            sections.add(section.sectionId);
            allEvidence.push(...section.evidence, ...section.currency.evidence, ...(section.accountReference?.evidence ?? []));
        }
        for (const row of [...value.transactions, ...value.unresolvedDrafts]) {
            checkResultRow(row, value.accountSections, sections, rowIds, allEvidence, ctx);
        }
        const allIssues: ImportIssue[] = [...value.issues, ...value.unresolvedDrafts.flatMap((row: UnresolvedDraft): ImportIssue[] => row.issues)];
        for (const issue of allIssues) {
            if ((issue.pageId !== null && !pages.some((page: PageMetadata): boolean => page.pageId === issue.pageId)) || (issue.rowId !== null && !rowIds.has(issue.rowId))) {
                ctx.addIssue({ code: 'custom', message: 'Issues must reference known pages and rows.' });
            }
            allEvidence.push(...issue.evidence);
        }
        checkEvidence(allEvidence, pages, ctx);
    });

function checkResultStatus(value: BankImportResult, ctx: z.RefinementCtx): void {
    const parser: BankImportResult['adapter'] | BankImportResult['localRecognition'] = value.adapter ?? value.localRecognition;
    if ((value.status === 'complete' || value.status === 'partial') && (!parser || !value.sourceProvenance || !value.accountSections.length)) {
        ctx.addIssue({ code: 'custom', message: 'Parsed results need parser, source and account provenance.' });
    }
    if (value.adapter && value.localRecognition) {
        ctx.addIssue({ code: 'custom', message: 'Results must identify a single statement parser.' });
    }
    if (value.status === 'complete' && (value.issues.length || value.unresolvedDrafts.length)) {
            ctx.addIssue({ code: 'custom', message: 'Complete results cannot hide issues or unresolved rows.' });
        }
    if (value.status !== 'complete' && !value.issues.length) {
        ctx.addIssue({ code: 'custom', message: 'Incomplete results need an explicit issue.' });
    }
    if ((value.status === 'unsupported' || value.status === 'failed') && (value.transactions.length || value.unresolvedDrafts.length)) {
            ctx.addIssue({ code: 'custom', message: 'Unparsed results cannot claim rows.' });
        }
}

function checkRowSigns(row: TransactionCandidate | UnresolvedDraft, ctx: z.RefinementCtx): void {
    for (const field of [row.accountAmount, row.reportedOriginalAmount]) {
        if (
            field &&
            row.direction &&
            moneySchema.safeParse(field.value).success &&
            ((row.direction === 'outgoing' && BigInt(field.value.coefficient) > 0n) || (row.direction === 'incoming' && BigInt(field.value.coefficient) < 0n))
        ) {
            ctx.addIssue({ code: 'custom', message: 'Amount sign conflicts with payment direction.' });
        }
    }
}

function checkResultRow(row: TransactionCandidate | UnresolvedDraft, accountSections: BankImportResult['accountSections'], sections: Set<string>,
    rowIds: Set<string>, allEvidence: Evidence[], ctx: z.RefinementCtx): void {
    if (rowIds.has(row.rowId) || !sections.has(row.accountSectionId)) {
        ctx.addIssue({ code: 'custom', message: 'Rows need unique IDs and a known account section.' });
    }
    rowIds.add(row.rowId);
    allEvidence.push(...row.evidence);
    for (const field of [row.bookingDate, row.valueDate, row.accountAmount, row.reportedOriginalAmount, row.description, row.counterpartyCandidate, ...row.references]) {
        if (field) {
            allEvidence.push(...field.evidence);
        }
    }
    const section: AccountSection | undefined = accountSections.find((section: AccountSection): boolean => section.sectionId === row.accountSectionId);
    if (row.accountAmount && row.accountAmount.value.currency !== section?.currency.value) {
            ctx.addIssue({ code: 'custom', message: 'Account amounts must use the section currency.' });
        }
    checkRowSigns(row, ctx);
}

export type BankImportInput = z.infer<typeof bankImportInputSchema>;
export type BankImportResult = z.infer<typeof bankImportResultSchema>;
export type ImportIssue = z.infer<typeof importIssueSchema>;
export type SourceEvidence = z.infer<typeof evidenceSchema>;
export type PositionedSpan = BankImportInput['pages'][number]['spans'][number];
export type ImportPage = BankImportInput['pages'][number];
export type TransactionCandidate = BankImportResult['transactions'][number];
export type UnresolvedDraft = BankImportResult['unresolvedDrafts'][number];
export interface IBankAdapter {
    readonly metadata: z.infer<typeof adapterMetadataSchema>;
    identify(input: BankImportInput): boolean;
    parse(input: BankImportInput): BankImportResult;
}
export function sourceProvenance(input: BankImportInput): NonNullable<BankImportResult['sourceProvenance']> {
    return {
        ...input.source,
        extractionRunId: input.extraction.runId,
        extractionVersion: input.extraction.version,
        pages: input.pages.map(({ pageId, pageNumber, width, height }: ImportPage): PageMetadata => ({ pageId, pageNumber, width, height }))
    };
}

export function importIssue(code: string, message: string, evidence: SourceEvidence[] = [], rowId: string | null = null, field: string | null = null): ImportIssue {
    return { code, severity: 'error', message, pageId: evidence[0]?.pageId ?? null, rowId, field, evidence };
}

export function emptyImportResult(input: BankImportInput | null, status: 'unsupported' | 'failed', issue: ImportIssue): BankImportResult {
    const overflow: boolean = (input?.issues.length ?? 0) >= 1000;
    const issues: ImportIssue[] = overflow
        ? [issue, importIssue('issue-limit', 'The import cannot retain all extraction issues together with this failure. No rows were imported.')]
        : [issue, ...(input?.issues ?? [])];
    return {
        contractVersion: '1',
        status: overflow ? 'failed' : status,
        adapter: null,
        sourceProvenance: input ? sourceProvenance(input) : null,
        accountSections: [],
        transactions: [],
        unresolvedDrafts: [],
        issues
    };
}
