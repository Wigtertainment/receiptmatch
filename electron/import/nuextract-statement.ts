import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BANK_IMPORT_LIMITS, bankImportInputSchema, importIssue, type BankImportInput, type BankImportResult, type ImportIssue } from '../../src/shared/bank-import.js';
import { RECEIPT_RASTER_LIMITS } from '../../src/shared/pdf-extraction.js';
import type { NuExtractDevice } from '../../src/shared/local-ocr-settings.js';
import type { ExtractionOptions, renderDocumentImages } from '../extraction/host.js';
import { NuExtractGpuCheckCancelledError, NuExtractGpuUnavailableError, NuExtractRuntime, type NuExtractRuntimeFiles } from '../extraction/nuextract-runtime.js';
import { proposeStatementTransactions } from './statement-table.js';

export type StatementProposalExtraction = { status: 'proposed'; result: BankImportResult } |
    { status: 'failed' | 'cancelled' | 'unavailable'; issues: ImportIssue[] };

interface StatementRecognitionDependencies {
    runtimeFiles(signal?: AbortSignal): Promise<NuExtractRuntimeFiles | undefined>;
    render: typeof renderDocumentImages;
    start?: (files: NuExtractRuntimeFiles, signal?: AbortSignal) => Promise<Pick<NuExtractRuntime, 'extract' | 'close'>>;
}

const cell: z.ZodString = z.string().max(BANK_IMPORT_LIMITS.spanText);
const tableSchema: z.ZodObject<{
    headings: z.ZodArray<z.ZodString>;
    rows: z.ZodArray<z.ZodObject<{ cells: z.ZodArray<z.ZodNullable<z.ZodString>> }, z.core.$strict>>;
}, z.core.$strict> = z.strictObject({
    headings: z.array(cell).min(3).max(BANK_IMPORT_LIMITS.evidence),
    rows: z.array(z.strictObject({ cells: z.array(cell.nullable()).max(BANK_IMPORT_LIMITS.evidence) })).max(BANK_IMPORT_LIMITS.rows)
});
const template: Readonly<Record<string, unknown>> = { headings: ['verbatim-string'], rows: [{ cells: ['verbatim-string'] }] };
const instructions: string = 'Transcribe the printed transaction table on this page. Preserve the printed column headings, column order, row order, ' +
    'dates, descriptions, amount signs and decimal separators. Provide exactly one cell per column in each row. Use null or an empty string in the position of an empty cell. ' +
    'Exclude account metadata, opening and closing balances and page totals. If there is no transaction table, return empty headings and rows.';

function readTable(output: Record<string, unknown>): string[][] | undefined {
    const checked: z.ZodSafeParseResult<z.infer<typeof tableSchema>> = tableSchema.safeParse(output);
    if (!checked.success) {
        return undefined;
    }
    const { headings, rows }: z.infer<typeof tableSchema> = checked.data;
    if (headings.some((heading: string): boolean => !heading.trim()) ||
        rows.some(({ cells }: typeof rows[number]): boolean => cells.length !== headings.length)) {
        return undefined;
    }
    return [headings, ...rows.map(({ cells }: typeof rows[number]): string[] => cells.map((value: string | null): string => value ?? ''))];
}

async function recognizePages(files: NuExtractRuntimeFiles, images: Uint8Array[], input: BankImportInput, options: ExtractionOptions,
    start: NonNullable<StatementRecognitionDependencies['start']>): Promise<Map<number, string[][]>> {
    const runtime: Pick<NuExtractRuntime, 'extract' | 'close'> = await start(files, options.signal);
    const device: NuExtractDevice = files.gpuDevice ? 'gpu' : 'cpu';
    const tables: Map<number, string[][]> = new Map();
    try {
        for (const [index, image] of images.entries()) {
            const page: BankImportInput['pages'][number] = input.pages[index];
            options.signal?.throwIfAborted();
            if (page.status === 'complete' && page.spans.length) {
                options.onProgress?.({ phase: 'ocr', pageNumber: page.pageNumber, pageCount: images.length, completedPages: index, device });
                const table: string[][] | undefined = readTable(await runtime.extract({ images: [image], template, instructions, maxTokens: 4096, jsonObject: true }, options.signal));
                options.signal?.throwIfAborted();
                if (table) {
                    tables.set(page.pageNumber, table);
                }
            }
            options.onProgress?.({ phase: 'page-complete', pageNumber: page.pageNumber, pageCount: images.length, completedPages: index + 1, device });
        }
        return tables;
    } finally {
        await runtime.close();
    }
}

export async function proposeNuExtractStatement(bytes: Uint8Array, input: BankImportInput, dependencies: StatementRecognitionDependencies,
    options: ExtractionOptions = {}): Promise<StatementProposalExtraction> {
    options.signal?.throwIfAborted();
    const checked: z.ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(input);
    if (!checked.success || createHash('sha256').update(bytes).digest('hex') !== input.source.sha256) {
        return { status: 'failed', issues: [importIssue('invalid-provenance', 'The selected PDF does not match the original statement analysis.')] };
    }
    const source: BankImportInput = checked.data;
    if (source.pages.length > RECEIPT_RASTER_LIMITS.pages) {
        return { status: 'failed', issues: [importIssue('page-limit', `NuExtract3 can review up to ${RECEIPT_RASTER_LIMITS.pages} statement pages at a time.`)] };
    }
    try {
        const files: NuExtractRuntimeFiles | undefined = await dependencies.runtimeFiles(options.signal);
        options.signal?.throwIfAborted();
        if (!files) {
            return { status: 'unavailable', issues: [importIssue('local-model-unavailable', 'Download NuExtract3 and select a compatible device under Settings → Document recognition.')] };
        }
        const rendered: Awaited<ReturnType<typeof renderDocumentImages>> = await dependencies.render(bytes, source.source.sourceId, 'pdf', options);
        options.signal?.throwIfAborted();
        if (rendered.status !== 'complete') {
            return rendered;
        }
        if (rendered.images.length !== source.pages.length) {
            return { status: 'failed', issues: [importIssue('invalid-provenance', 'The rendered pages do not match the original statement analysis.')] };
        }
        const start: NonNullable<StatementRecognitionDependencies['start']> = dependencies.start ??
            ((model: NuExtractRuntimeFiles, signal?: AbortSignal): Promise<NuExtractRuntime> => NuExtractRuntime.start(model, signal));
        const tables: Map<number, string[][]> = await recognizePages(files, rendered.images, source, options, start);
        options.signal?.throwIfAborted();
        const result: BankImportResult = proposeStatementTransactions(source, tables);
        return result.status === 'complete' || result.status === 'partial' ? { status: 'proposed', result } : { status: 'failed', issues: result.issues };
    } catch (error: unknown) {
        if (error instanceof NuExtractGpuCheckCancelledError) {
            return { status: 'cancelled', issues: [] };
        }
        if (error instanceof NuExtractGpuUnavailableError) {
            return { status: 'unavailable', issues: [importIssue('local-gpu-unavailable', error.message)] };
        }
        throw error;
    }
}
