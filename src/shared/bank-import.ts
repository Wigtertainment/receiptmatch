import { z } from 'zod';
import { moneySchema } from './money.js';

// Transport safety bounds, not a claim about supported document sizes or OCR quality.
export const BANK_IMPORT_LIMITS: { readonly pages: 200; readonly spansPerPage: 10000; readonly spans: 100000; readonly text: 2000000; readonly spanText: 4096; readonly fieldText: 16384; readonly rows: 10000; readonly evidence: 256; } = { pages: 200, spansPerPage: 10000, spans: 100000, text: 2000000, spanText: 4096, fieldText: 16384, rows: 10000, evidence: 256 } as const;
const id: z.ZodString = z.string().min(1).max(128);
const text: z.ZodString = z.string().min(1).max(BANK_IMPORT_LIMITS.fieldText);
const currency: z.ZodString = z.string().regex(/^[A-Z]{3}$/);
const method: z.ZodEnum<{ "embedded-text": "embedded-text"; "local-ocr": "local-ocr"; }> = z.enum(['embedded-text', 'local-ocr']);
export const regionSchema: z.ZodObject<{ x: z.ZodNumber; y: z.ZodNumber; width: z.ZodNumber; height: z.ZodNumber; }, z.core.$strict> = z.strictObject({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
});
export const calendarDateSchema: z.ZodISODate = z.iso.date().refine((value: string): boolean => !value.startsWith('0000-'), 'Use a calendar year from 0001.');
type EvidenceSchemaType = z.ZodObject<{
	pageId: z.ZodString;
	region: typeof regionSchema;
	rawText: z.ZodString;
	method: z.ZodEnum<{
		"embedded-text": "embedded-text";
		"local-ocr": "local-ocr";
	}>;
}, z.core.$strict>;
export const evidenceSchema: EvidenceSchemaType = z.strictObject({ pageId: id, region: regionSchema, rawText: text, method });
const evidenceList: z.ZodArray<typeof evidenceSchema> = z.array(evidenceSchema).max(BANK_IMPORT_LIMITS.evidence);
const fieldEvidence: typeof evidenceList = evidenceList.min(1);
type ImportIssueSchemaType = z.ZodObject<{
	code: z.ZodString;
	severity: z.ZodEnum<{
		error: "error";
		warning: "warning";
	}>;
	message: z.ZodString;
	pageId: z.ZodNullable<z.ZodString>;
	rowId: z.ZodNullable<z.ZodString>;
	field: z.ZodNullable<z.ZodString>;
	evidence: typeof evidenceList;
}, z.core.$strict>;
export const importIssueSchema: ImportIssueSchemaType = z.strictObject({
    code: z.string().min(1).max(80),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(512),
    pageId: id.nullable(),
    rowId: id.nullable(),
    field: z.string().min(1).max(80).nullable(),
    evidence: evidenceList
});
const issues: z.ZodArray<typeof importIssueSchema> = z.array(importIssueSchema).max(1000);
const sourceSchema: z.ZodObject<{ sourceId: z.ZodString; sha256: z.ZodString; }, z.core.$strict> = z.strictObject({ sourceId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const pageMetadata: z.ZodObject<{ pageId: z.ZodString; pageNumber: z.ZodNumber; width: z.ZodNumber; height: z.ZodNumber; }, z.core.$strict> = z.strictObject({
    pageId: id,
    pageNumber: z.number().int().min(1).max(100000),
    width: z.number().finite().positive().max(20000),
    height: z.number().finite().positive().max(20000)
});
const spanSchema: z.ZodObject<{ text: z.ZodString; region: typeof regionSchema; method: z.ZodEnum<{ "embedded-text": "embedded-text"; "local-ocr": "local-ocr"; }>; }, z.core.$strict> = z.strictObject({ text: z.string().min(1).max(BANK_IMPORT_LIMITS.spanText), region: regionSchema, method });
type PageSchemaType = z.ZodObject<{
	pageId: z.ZodString;
	pageNumber: z.ZodNumber;
	width: z.ZodNumber;
	height: z.ZodNumber;
	status: z.ZodEnum<{
		complete: "complete";
		failed: "failed";
	}>;
	spans: z.ZodArray<typeof spanSchema>;
}, z.core.$strict>;
const pageSchema: PageSchemaType = pageMetadata.extend({ status: z.enum(['complete', 'failed']), spans: z.array(spanSchema).max(BANK_IMPORT_LIMITS.spansPerPage) });
type PageMetadata = z.infer<typeof pageMetadata>;
type Evidence = z.infer<typeof evidenceSchema>;

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
        const page: { pageId: string; pageNumber: number; width: number; height: number; } | undefined = pages.find((page: { pageId: string; pageNumber: number; width: number; height: number; }): boolean => page.pageId === value.pageId);
        if (!page || !withinPage(value.region, page)) {
            ctx.addIssue({ code: 'custom', message: 'Evidence must reference a region within a source page.' });
        }
    }
}
type BankImportInputSchemaType = z.ZodObject<{
	source: z.ZodObject<{
		sourceId: z.ZodString;
		sha256: z.ZodString;
	}, z.core.$strict>;
	extraction: z.ZodObject<{
		runId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>;
	pages: z.ZodArray<typeof pageSchema>;
	issues: typeof issues;
}, z.core.$strict>;
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
            if (issue.pageId !== null && !value.pages.some((page: { pageId: string; pageNumber: number; width: number; height: number; status: "complete" | "failed"; spans: { text: string; region: { x: number; y: number; width: number; height: number; }; method: "embedded-text" | "local-ocr"; }[]; }): boolean => page.pageId === issue.pageId)) {
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

const dateField: z.ZodObject<{ value: z.ZodISODate; basisLabel: z.ZodString; evidence: typeof evidenceList; }, z.core.$strict> = z.strictObject({ value: calendarDateSchema, basisLabel: z.string().min(1).max(80), evidence: fieldEvidence });
const moneyField: z.ZodObject<{ value: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict>; evidence: typeof evidenceList; }, z.core.$strict> = z.strictObject({ value: moneySchema, evidence: fieldEvidence });
const textField: z.ZodObject<{ value: z.ZodString; evidence: typeof evidenceList; }, z.core.$strict> = z.strictObject({ value: text, evidence: fieldEvidence });
const referenceSchema: z.ZodObject<{ label: z.ZodString; value: z.ZodString; evidence: typeof evidenceList; }, z.core.$strict> = z.strictObject({ label: z.string().min(1).max(80), value: text, evidence: fieldEvidence });
const rowShape: { rowId: z.ZodString; accountSectionId: z.ZodString; bookingDate: z.ZodNullable<typeof dateField>; valueDate: z.ZodNullable<typeof dateField>; accountAmount: z.ZodNullable<typeof moneyField>; direction: z.ZodNullable<z.ZodEnum<{ incoming: "incoming"; outgoing: "outgoing"; }>>; reportedOriginalAmount: z.ZodNullable<typeof moneyField>; description: z.ZodNullable<typeof textField>; counterpartyCandidate: z.ZodNullable<typeof textField>; references: z.ZodArray<typeof referenceSchema>; evidence: typeof evidenceList; } = {
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
type TransactionSchemaType = z.ZodObject<{
	bookingDate: typeof dateField;
	accountAmount: typeof moneyField;
	direction: z.ZodEnum<{
		incoming: "incoming";
		outgoing: "outgoing";
	}>;
	description: typeof textField;
	rowId: z.ZodString;
	accountSectionId: z.ZodString;
	valueDate: z.ZodNullable<typeof dateField>;
	reportedOriginalAmount: z.ZodNullable<typeof moneyField>;
	counterpartyCandidate: z.ZodNullable<typeof textField>;
	references: z.ZodArray<typeof referenceSchema>;
	evidence: typeof evidenceList;
}, z.core.$strict>;
const transactionSchema: TransactionSchemaType = z.strictObject({ ...rowShape, bookingDate: dateField, accountAmount: moneyField, direction: z.enum(['incoming', 'outgoing']), description: textField });
type DraftSchemaType = z.ZodObject<{
	issues: typeof issues;
	rowId: z.ZodString;
	accountSectionId: z.ZodString;
	bookingDate: z.ZodNullable<typeof dateField>;
	valueDate: z.ZodNullable<typeof dateField>;
	accountAmount: z.ZodNullable<typeof moneyField>;
	direction: z.ZodNullable<z.ZodEnum<{
		incoming: "incoming";
		outgoing: "outgoing";
	}>>;
	reportedOriginalAmount: z.ZodNullable<typeof moneyField>;
	description: z.ZodNullable<typeof textField>;
	counterpartyCandidate: z.ZodNullable<typeof textField>;
	references: z.ZodArray<typeof referenceSchema>;
	evidence: typeof evidenceList;
}, z.core.$strict>;
const draftSchema: DraftSchemaType = z.strictObject({ ...rowShape, issues: issues.min(1) });
const accountSectionSchema: z.ZodObject<{ sectionId: z.ZodString; currency: typeof textField; accountReference: z.ZodNullable<typeof referenceSchema>; evidence: typeof evidenceList; }, z.core.$strict> = z.strictObject({
    sectionId: id,
    currency: z.strictObject({ value: currency, evidence: fieldEvidence }),
    accountReference: referenceSchema.nullable(),
    evidence: fieldEvidence
});
type AdapterMetadataSchemaType = z.ZodObject<{
	bankId: z.ZodString;
	adapterId: z.ZodString;
	version: z.ZodString;
	layouts: z.ZodArray<z.ZodObject<{
		layoutId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>>;
}, z.core.$strict>;
export const adapterMetadataSchema: AdapterMetadataSchemaType = z.strictObject({
    bankId: id,
    adapterId: id,
    version: id,
    layouts: z
        .array(z.strictObject({ layoutId: id, version: id }))
        .min(1)
        .max(32)
});
const selectedAdapter: z.ZodObject<{ bankId: z.ZodString; adapterId: z.ZodString; version: z.ZodString; layoutId: z.ZodString; layoutVersion: z.ZodString; }, z.core.$strict> = z.strictObject({ bankId: id, adapterId: id, version: id, layoutId: id, layoutVersion: id });
const provenanceSchema: z.ZodObject<{ sourceId: z.ZodString; sha256: z.ZodString; extractionRunId: z.ZodString; extractionVersion: z.ZodString; pages: z.ZodArray<typeof pageMetadata>; }, z.core.$strict> = sourceSchema.extend({ extractionRunId: id, extractionVersion: id, pages: z.array(pageMetadata).min(1).max(BANK_IMPORT_LIMITS.pages) });
type BankImportResultSchemaType = z.ZodObject<{
	contractVersion: z.ZodLiteral<"1">;
	status: z.ZodEnum<{
		complete: "complete";
		failed: "failed";
		partial: "partial";
		unsupported: "unsupported";
	}>;
	adapter: z.ZodNullable<typeof selectedAdapter>;
	sourceProvenance: z.ZodNullable<typeof provenanceSchema>;
	accountSections: z.ZodArray<typeof accountSectionSchema>;
	transactions: z.ZodArray<typeof transactionSchema>;
	unresolvedDrafts: z.ZodArray<typeof draftSchema>;
	issues: typeof issues;
}, z.core.$strict>;
export const bankImportResultSchema: BankImportResultSchemaType = z
    .strictObject({
        contractVersion: z.literal('1'),
        status: z.enum(['complete', 'partial', 'unsupported', 'failed']),
        adapter: selectedAdapter.nullable(),
        sourceProvenance: provenanceSchema.nullable(),
        accountSections: z.array(accountSectionSchema).max(200),
        transactions: z.array(transactionSchema).max(BANK_IMPORT_LIMITS.rows),
        unresolvedDrafts: z.array(draftSchema).max(BANK_IMPORT_LIMITS.rows),
        issues
    })
    .superRefine((value: z.output<BankImportResultSchemaType>, ctx: z.RefinementCtx): void => {
        const pages: { pageId: string; pageNumber: number; width: number; height: number; }[] = value.sourceProvenance?.pages ?? [];
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
        const allIssues: { code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: Evidence[]; }[] = [...value.issues, ...value.unresolvedDrafts.flatMap((row: { issues: { code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: Evidence[]; }[]; rowId: string; accountSectionId: string; bookingDate: { value: string; basisLabel: string; evidence: Evidence[]; } | null; valueDate: { value: string; basisLabel: string; evidence: Evidence[]; } | null; accountAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: Evidence[]; } | null; direction: "incoming" | "outgoing" | null; reportedOriginalAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: Evidence[]; } | null; description: { value: string; evidence: Evidence[]; } | null; counterpartyCandidate: { value: string; evidence: Evidence[]; } | null; references: { label: string; value: string; evidence: Evidence[]; }[]; evidence: Evidence[]; }): { code: string; severity: "error" | "warning"; message: string; pageId: string | null; rowId: string | null; field: string | null; evidence: Evidence[]; }[] => row.issues)];
        for (const issue of allIssues) {
            if ((issue.pageId !== null && !pages.some((page: { pageId: string; pageNumber: number; width: number; height: number; }): boolean => page.pageId === issue.pageId)) || (issue.rowId !== null && !rowIds.has(issue.rowId))) {
                ctx.addIssue({ code: 'custom', message: 'Issues must reference known pages and rows.' });
            }
            allEvidence.push(...issue.evidence);
        }
        checkEvidence(allEvidence, pages, ctx);
    });

function checkResultStatus(value: BankImportResult, ctx: z.RefinementCtx): void {
    if ((value.status === 'complete' || value.status === 'partial') && (!value.adapter || !value.sourceProvenance || !value.accountSections.length)) {
        ctx.addIssue({ code: 'custom', message: 'Parsed results need adapter, source and account provenance.' });
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
    const section: { sectionId: string; currency: { value: string; evidence: Evidence[]; }; accountReference: { label: string; value: string; evidence: Evidence[]; } | null; evidence: Evidence[]; } | undefined = accountSections.find((section: { sectionId: string; currency: { value: string; evidence: Evidence[]; }; accountReference: { label: string; value: string; evidence: Evidence[]; } | null; evidence: Evidence[]; }): boolean => section.sectionId === row.accountSectionId);
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
export interface BankAdapter {
    readonly metadata: z.infer<typeof adapterMetadataSchema>;
    identify(input: BankImportInput): boolean;
    parse(input: BankImportInput): BankImportResult;
}
export function sourceProvenance(input: BankImportInput): NonNullable<BankImportResult['sourceProvenance']> {
    return {
        ...input.source,
        extractionRunId: input.extraction.runId,
        extractionVersion: input.extraction.version,
        pages: input.pages.map(({ pageId, pageNumber, width, height }: ImportPage): { pageId: string; pageNumber: number; width: number; height: number; } => ({ pageId, pageNumber, width, height }))
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
