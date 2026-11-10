import { z } from 'zod';
import { moneySchema } from './money.js';

// Transport safety bounds, not a claim about supported document sizes or OCR quality.
export const BANK_IMPORT_LIMITS = { pages: 200, spansPerPage: 10000, spans: 100000, text: 2000000, spanText: 4096, fieldText: 16384, rows: 10000, evidence: 256 } as const;
const id = z.string().min(1).max(128);
const text = z.string().min(1).max(BANK_IMPORT_LIMITS.fieldText);
const currency = z.string().regex(/^[A-Z]{3}$/);
const method = z.enum(['embedded-text', 'local-ocr']);
export const regionSchema = z.strictObject({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
});
export const calendarDateSchema = z.iso.date().refine((value) => !value.startsWith('0000-'), 'Use a calendar year from 0001.');
export const evidenceSchema = z.strictObject({ pageId: id, region: regionSchema, rawText: text, method });
const evidenceList = z.array(evidenceSchema).max(BANK_IMPORT_LIMITS.evidence);
const fieldEvidence = evidenceList.min(1);
export const importIssueSchema = z.strictObject({
    code: z.string().min(1).max(80),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(512),
    pageId: id.nullable(),
    rowId: id.nullable(),
    field: z.string().min(1).max(80).nullable(),
    evidence: evidenceList
});
const issues = z.array(importIssueSchema).max(1000);
const sourceSchema = z.strictObject({ sourceId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const pageMetadata = z.strictObject({
    pageId: id,
    pageNumber: z.number().int().min(1).max(100000),
    width: z.number().finite().positive().max(20000),
    height: z.number().finite().positive().max(20000)
});
const spanSchema = z.strictObject({ text: z.string().min(1).max(BANK_IMPORT_LIMITS.spanText), region: regionSchema, method });
const pageSchema = pageMetadata.extend({ status: z.enum(['complete', 'failed']), spans: z.array(spanSchema).max(BANK_IMPORT_LIMITS.spansPerPage) });
type PageMetadata = z.infer<typeof pageMetadata>;
type Evidence = z.infer<typeof evidenceSchema>;

function withinPage(region: z.infer<typeof regionSchema>, page: PageMetadata) {
    return region.x + region.width <= page.width && region.y + region.height <= page.height;
}
function checkPages(pages: PageMetadata[], ctx: z.RefinementCtx) {
    const ids = new Set<string>();
    let previous = 0;
    for (const [index, page] of pages.entries()) {
        if (ids.has(page.pageId) || page.pageNumber <= previous)
            ctx.addIssue({ code: 'custom', message: 'Pages need unique IDs and increasing source page numbers.', path: ['pages', index] });
        ids.add(page.pageId);
        previous = page.pageNumber;
    }
}
function checkEvidence(values: Evidence[], pages: PageMetadata[], ctx: z.RefinementCtx) {
    for (const value of values) {
        const page = pages.find((page) => page.pageId === value.pageId);
        if (!page || !withinPage(value.region, page)) ctx.addIssue({ code: 'custom', message: 'Evidence must reference a region within a source page.' });
    }
}
export const bankImportInputSchema = z
    .strictObject({
        source: sourceSchema,
        extraction: z.strictObject({ runId: id, version: id }),
        pages: z.array(pageSchema).min(1).max(BANK_IMPORT_LIMITS.pages),
        issues
    })
    .superRefine((value, ctx) => {
        checkPages(value.pages, ctx);
        let spanCount = 0;
        let textCount = 0;
        for (const [index, page] of value.pages.entries()) {
            spanCount += page.spans.length;
            for (const span of page.spans) {
                textCount += span.text.length;
                if (!withinPage(span.region, page)) ctx.addIssue({ code: 'custom', message: 'Text spans must stay within the page.', path: ['pages', index, 'spans'] });
            }
            if (page.status === 'failed' && page.spans.length) ctx.addIssue({ code: 'custom', message: 'Failed pages cannot claim extracted spans.', path: ['pages', index] });
        }
        if (spanCount > BANK_IMPORT_LIMITS.spans || textCount > BANK_IMPORT_LIMITS.text) ctx.addIssue({ code: 'custom', message: 'The extraction exceeds transport limits.' });
        for (const issue of value.issues) {
            if (issue.rowId !== null) ctx.addIssue({ code: 'custom', message: 'Extraction issues cannot claim parser-local row IDs.' });
            if (issue.pageId !== null && !value.pages.some((page) => page.pageId === issue.pageId)) ctx.addIssue({ code: 'custom', message: 'Issue references an unknown page.' });
            checkEvidence(issue.evidence, value.pages, ctx);
        }
    });
const dateField = z.strictObject({ value: calendarDateSchema, basisLabel: z.string().min(1).max(80), evidence: fieldEvidence });
const moneyField = z.strictObject({ value: moneySchema, evidence: fieldEvidence });
const textField = z.strictObject({ value: text, evidence: fieldEvidence });
const referenceSchema = z.strictObject({ label: z.string().min(1).max(80), value: text, evidence: fieldEvidence });
const rowShape = {
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
const transactionSchema = z.strictObject({ ...rowShape, bookingDate: dateField, accountAmount: moneyField, direction: z.enum(['incoming', 'outgoing']), description: textField });
const draftSchema = z.strictObject({ ...rowShape, issues: issues.min(1) });
const accountSectionSchema = z.strictObject({
    sectionId: id,
    currency: z.strictObject({ value: currency, evidence: fieldEvidence }),
    accountReference: referenceSchema.nullable(),
    evidence: fieldEvidence
});
export const adapterMetadataSchema = z.strictObject({
    bankId: id,
    adapterId: id,
    version: id,
    layouts: z
        .array(z.strictObject({ layoutId: id, version: id }))
        .min(1)
        .max(32)
});
const selectedAdapter = z.strictObject({ bankId: id, adapterId: id, version: id, layoutId: id, layoutVersion: id });
const provenanceSchema = sourceSchema.extend({ extractionRunId: id, extractionVersion: id, pages: z.array(pageMetadata).min(1).max(BANK_IMPORT_LIMITS.pages) });
export const bankImportResultSchema = z
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
    .superRefine((value, ctx) => {
        const pages = value.sourceProvenance?.pages ?? [];
        checkPages(pages, ctx);
        if ((value.status === 'complete' || value.status === 'partial') && (!value.adapter || !value.sourceProvenance || !value.accountSections.length)) {
            ctx.addIssue({ code: 'custom', message: 'Parsed results need adapter, source and account provenance.' });
        }
        if (value.status === 'complete' && (value.issues.length || value.unresolvedDrafts.length))
            ctx.addIssue({ code: 'custom', message: 'Complete results cannot hide issues or unresolved rows.' });
        if (value.status !== 'complete' && !value.issues.length) ctx.addIssue({ code: 'custom', message: 'Incomplete results need an explicit issue.' });
        if ((value.status === 'unsupported' || value.status === 'failed') && (value.transactions.length || value.unresolvedDrafts.length))
            ctx.addIssue({ code: 'custom', message: 'Unparsed results cannot claim rows.' });
        const sections = new Set<string>();
        const rowIds = new Set<string>();
        const allEvidence: Evidence[] = [];
        for (const section of value.accountSections) {
            if (sections.has(section.sectionId)) ctx.addIssue({ code: 'custom', message: 'Account section IDs must be unique.' });
            sections.add(section.sectionId);
            allEvidence.push(...section.evidence, ...section.currency.evidence, ...(section.accountReference?.evidence ?? []));
        }
        for (const row of [...value.transactions, ...value.unresolvedDrafts]) {
            if (rowIds.has(row.rowId) || !sections.has(row.accountSectionId)) ctx.addIssue({ code: 'custom', message: 'Rows need unique IDs and a known account section.' });
            rowIds.add(row.rowId);
            allEvidence.push(...row.evidence);
            for (const field of [row.bookingDate, row.valueDate, row.accountAmount, row.reportedOriginalAmount, row.description, row.counterpartyCandidate, ...row.references]) {
                if (field) allEvidence.push(...field.evidence);
            }
            const section = value.accountSections.find((section) => section.sectionId === row.accountSectionId);
            if (row.accountAmount && row.accountAmount.value.currency !== section?.currency.value)
                ctx.addIssue({ code: 'custom', message: 'Account amounts must use the section currency.' });
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
        const allIssues = [...value.issues, ...value.unresolvedDrafts.flatMap((row) => row.issues)];
        for (const issue of allIssues) {
            if ((issue.pageId !== null && !pages.some((page) => page.pageId === issue.pageId)) || (issue.rowId !== null && !rowIds.has(issue.rowId))) {
                ctx.addIssue({ code: 'custom', message: 'Issues must reference known pages and rows.' });
            }
            allEvidence.push(...issue.evidence);
        }
        checkEvidence(allEvidence, pages, ctx);
    });

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
        pages: input.pages.map(({ pageId, pageNumber, width, height }) => ({ pageId, pageNumber, width, height }))
    };
}
export function importIssue(code: string, message: string, evidence: SourceEvidence[] = [], rowId: string | null = null, field: string | null = null): ImportIssue {
    return { code, severity: 'error', message, pageId: evidence[0]?.pageId ?? null, rowId, field, evidence };
}
export function emptyImportResult(input: BankImportInput | null, status: 'unsupported' | 'failed', issue: ImportIssue): BankImportResult {
    const overflow = (input?.issues.length ?? 0) >= 1000;
    const issues = overflow
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
