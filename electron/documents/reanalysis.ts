import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BankImportInput, ImportPage, PositionedSpan } from '../../src/shared/bank-import.js';
import { originalSourceExtensions } from '../../src/shared/original-preview.js';
import { extractionResultSchema, LOCAL_OCR_VERSIONS, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import type { ReceiptAiResult } from '../../src/shared/receipt-ai.js';
import type { SupportingDocument } from '../../src/shared/supporting-document.js';
import type { DocumentFormat } from '../../src/shared/workspace-documents.js';
import type { ExtractionOptions, LocalDocumentOcr } from '../extraction/host.js';
import { assertSourceNotCancelled, readSourceSnapshot, SourceReadError } from '../import/source.js';
import { compareDocuments } from '../source-comparison.js';
import { interpretSupportingDocument } from './interpret.js';

export interface ReceiptAiSource {
    filePath: string;
    format: DocumentFormat;
    sha256: string;
    sourceId?: string;
    previous: SupportingDocument | null;
}

export interface ReceiptAiDependencies {
    selectedModel(): Promise<LocalDocumentOcr | undefined>;
    extract(bytes: Uint8Array, sourceId: string, format: DocumentFormat, model: LocalDocumentOcr, options?: ExtractionOptions): Promise<ExtractionResult>;
}

async function readReceipt(source: ReceiptAiSource, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes: Uint8Array = await readSourceSnapshot(source.filePath, originalSourceExtensions[source.format], signal);
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new SourceReadError('source-changed', 'The original receipt changed. Restore or relink the original file and try again.');
    }
    return bytes;
}

function checkedModelInput(input: BankImportInput, source: ReceiptAiSource, sourceId: string, model: LocalDocumentOcr): BankImportInput {
    if (input.source.sourceId !== sourceId || input.source.sha256 !== source.sha256 || input.extraction.version !== LOCAL_OCR_VERSIONS[model.model] ||
        !z.uuid().safeParse(input.extraction.runId).success || input.extraction.runId === source.previous?.input?.extraction.runId ||
        input.pages.some((page: ImportPage): boolean => page.spans.some((span: PositionedSpan): boolean => span.method !== 'local-ocr')) ||
        (source.format !== 'pdf' && (input.pages.length !== 1 || input.pages[0].status !== 'complete'))) {
        throw new SourceReadError('invalid-provenance', 'Local AI results could not be verified against the original receipt.');
    }
    return input;
}

function receiptError(error: unknown, signal?: AbortSignal): ReceiptAiResult {
    if (signal?.aborted || (error instanceof SourceReadError && error.code === 'cancelled')) {
        return { status: 'cancelled' };
    }
    if (error instanceof SourceReadError) {
        return { status: 'failed', error: error.message };
    }
    return { status: 'failed', error: 'The local AI analysis could not be completed. Check that the original receipt is available and try again.' };
}

export async function reanalyzeReceipt(source: ReceiptAiSource, dependencies: ReceiptAiDependencies, options: ExtractionOptions = {}): Promise<ReceiptAiResult> {
    try {
        assertSourceNotCancelled(options.signal);
        const model: LocalDocumentOcr | undefined = await dependencies.selectedModel();
        assertSourceNotCancelled(options.signal);
        if (!model) {
            return { status: 'failed', error: 'Choose an installed model under Settings → Document recognition to analyze this receipt with AI.' };
        }
        const bytes: Uint8Array = await readReceipt(source, options.signal);
        const sourceId: string = source.sourceId ?? randomUUID();
        const raw: ExtractionResult = await dependencies.extract(bytes, sourceId, source.format, model, options);
        assertSourceNotCancelled(options.signal);
        const extraction: ExtractionResult = extractionResultSchema.parse(raw);
        if (extraction.status === 'cancelled') {
            return { status: 'cancelled' };
        }
        if (extraction.status === 'failed') {
            return { status: 'failed', error: extraction.issues[0]?.message ?? 'The local AI model could not read the original receipt.' };
        }
        const analysis: SupportingDocument = interpretSupportingDocument(checkedModelInput(extraction.input, source, sourceId, model));
        if (analysis.status === 'failed') {
            return { status: 'failed', error: 'The local AI model did not find a readable receipt.' };
        }
        const { changes, conflicts }: ReturnType<typeof compareDocuments> = compareDocuments(source.previous ? { result: source.previous } : null, { result: analysis });
        return { status: 'ready', model: model.model, analysis, changes, conflicts };
    } catch (error: unknown) {
        return receiptError(error, options.signal);
    }
}
