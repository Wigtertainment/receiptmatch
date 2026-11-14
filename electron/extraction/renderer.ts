import type { PDFOperatorList, TextContent } from 'pdfjs-dist/types/src/display/api.js';
import type { PageViewport } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist';
import { createWorker, type Worker } from 'tesseract.js';
import {
    BANK_IMPORT_LIMITS,
    bankImportInputSchema,
    importIssue,
    type BankImportInput,
    type ImportIssue,
    type ImportPage,
    type PositionedSpan
} from '../../src/shared/bank-import.js';
import {
    extractionJobSchema,
    LOCAL_OCR_VERSIONS,
    ocrRegionsSchema,
    PDF_EXTRACTION_LIMITS,
    PDF_EXTRACTION_VERSION,
    type ExtractionBridge,
    type ExtractionJob,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';
import { embeddedTextGeometry, ocrWordGeometry, type GeometryResult } from './geometry.js';
import { assertImageDimensions, imageInputDimensions, IMAGE_MIME_TYPES, ImageInputError } from './image-input.js';
import type { ZodSafeParseResult } from 'zod';

declare global {
    interface Window {
        receiptMatchExtraction: ExtractionBridge;
    }
}
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf/pdf.worker.min.mjs', location.href).href;
const imageOperations: Set<number> = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintInlineImageXObjectGroup,
    pdfjs.OPS.paintImageMaskXObjectRepeat,
    pdfjs.OPS.paintImageMaskXObjectGroup
]);
class ExtractionFault extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly fatal: boolean = false
    ) {
        super(message);
    }
}
function failed(code: string, message: string, pageId: string | null = null): ExtractionResult {
    return { status: 'failed', issues: [{ ...importIssue(code, message), pageId }] };
}

function extractionFailure(error: unknown, format: ExtractionJob['format'], pageNumber: number | null): ExtractionResult {
    if (error instanceof ExtractionFault) {
        return failed(error.code, error.message, pageNumber === null ? null : `page-${pageNumber}`);
    }
    if (error instanceof ImageInputError) {
        return failed(error.code, error.message, pageNumber === null ? null : `page-${pageNumber}`);
    }
    if (format !== 'pdf') {
        return failed('image-invalid', 'The local image decoder could not read this image.', pageNumber === null ? null : `page-${pageNumber}`);
    }
    if (error instanceof Error && error.name === 'PasswordException') {
            return failed('pdf-password', 'This PDF requires a password; encrypted-document interaction is not supported.');
        }
    return failed(
        pageNumber === null ? 'pdf-invalid' : 'document-failed',
        pageNumber === null ? 'The local PDF engine could not open this document.' : 'A PDF page failed before trustworthy geometry was available.',
        pageNumber === null ? null : `page-${pageNumber}`
    );
}

function assertPageGeometry(viewport: pdfjs.PageViewport): void {
    if (![viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 20000 || viewport.height > 20000) {
        throw new ExtractionFault('page-geometry', 'The PDF page has unsupported visible dimensions.', true);
    }
}

async function execute(job: ExtractionJob): Promise<ExtractionResult> {
    const loadingTask: pdfjs.PDFDocumentLoadingTask | null = job.format === 'pdf' ? pdfjs.getDocument({
        data: new Uint8Array(job.bytes),
        cMapUrl: new URL('./pdf/cmaps/', location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('./pdf/standard_fonts/', location.href).href,
        wasmUrl: new URL('./pdf/wasm/', location.href).href,
        useSystemFonts: false,
        enableXfa: false,
        stopAtErrors: true,
        maxImageSize: PDF_EXTRACTION_LIMITS.pixelsPerPage,
        canvasMaxAreaInBytes: PDF_EXTRACTION_LIMITS.pixelsPerPage * 4
    }) : null;
    let worker: Worker | undefined;
    let ocrUnavailable: boolean = false;
    let extractionVersion: string = PDF_EXTRACTION_VERSION;
    let pageNumber: number | null = null;
    let totalPixels: number = 0;
    let totalSpans: number = 0;
    let totalText: number = 0;
    const issues: ImportIssue[] = [];
    const pages: ImportPage[] = [];
    const progress: (phase: ExtractionProgress["phase"], pageCount: number | null) => void = (phase: ExtractionProgress['phase'], pageCount: number | null): void =>
        window.receiptMatchExtraction.report({ type: 'progress', progress: { phase, pageNumber, pageCount, completedPages: pages.length } });

    const issue: (code: string, message: string, pageId: string, severity?: "warning" | "error") => void = (code: string, message: string, pageId: string, severity: 'warning' | 'error' = 'warning'): void => {
        if (issues.length >= 1000) {
            throw new ExtractionFault('extraction-limit', 'The extraction issue count exceeded its local limit.', true);
        }
        issues.push({ ...importIssue(code, message), pageId, severity });
    };

    const append: (page: ImportPage, span: PositionedSpan) => void = (page: ImportPage, span: PositionedSpan): void => {
        if (
            span.text.length > BANK_IMPORT_LIMITS.spanText ||
            page.spans.length >= BANK_IMPORT_LIMITS.spansPerPage ||
            totalSpans >= BANK_IMPORT_LIMITS.spans ||
            totalText + span.text.length > BANK_IMPORT_LIMITS.text
        ) {
            throw new ExtractionFault('extraction-limit', 'Extracted text exceeded the bounded import contract.', true);
        }
        page.spans.push(span);
        totalSpans++;
        totalText += span.text.length;
    };

    const recognizeStandard: (canvas: HTMLCanvasElement, pageCount: number) => Promise<{ x0: number; y0: number; x1: number; y1: number; text: string; }[]> = async (canvas: HTMLCanvasElement, pageCount: number): Promise<{ x0: number; y0: number; x1: number; y1: number; text: string; }[]> => {
        if (ocrUnavailable) {
            throw new ExtractionFault('ocr-unavailable', 'The bundled English OCR resources are unavailable for this job.');
        }
        if (!worker) {
            try {
                worker = await new Promise<Worker>((resolve: (value: Worker | PromiseLike<Worker>) => void, reject: (reason?: unknown) => void): void => {
                    // Tesseract's language-init error callback can run without rejecting createWorker's promise.
                    void createWorker('eng', 1, {
                        workerPath: new URL('./ocr/worker.min.js', location.href).href,
                        corePath: new URL('./ocr/core/', location.href).href,
                        langPath: new URL('./ocr/', location.href).href,
                        workerBlobURL: false,
                        cacheMethod: 'none',
                        errorHandler: (): void => {
                            console.error('The local OCR worker failed.');
                            reject(new ExtractionFault('ocr-unavailable', 'The bundled English OCR resources could not be initialized.'));
                        }
                    }).then(resolve, reject);
                });
            } catch {
                ocrUnavailable = true;
                throw new ExtractionFault('ocr-unavailable', 'The bundled English OCR resources could not be initialized.');
            }
        }
        progress('ocr', pageCount);
        const recognized: Tesseract.RecognizeResult = await worker.recognize(canvas, {}, { blocks: true });
        if (!recognized.data.blocks && recognized.data.text.trim()) {
            throw new ExtractionFault('ocr-result', 'OCR returned text without positioned word evidence.');
        }
        return (recognized.data.blocks ?? []).flatMap((block: Tesseract.Block): Tesseract.Word[] => block.paragraphs.flatMap((paragraph: Tesseract.Paragraph): Tesseract.Word[] => paragraph.lines.flatMap((line: Tesseract.Line): Tesseract.Word[] => line.words)))
            .filter((word: Tesseract.Word): string => word.text.trim()).map((word: Tesseract.Word): { x0: number; y0: number; x1: number; y1: number; text: string; } => ({ text: word.text, ...word.bbox }));
    };

    const recognizeModel: (canvas: HTMLCanvasElement, page: ImportPage, pageCount: number, model: NonNullable<ExtractionJob["ocrModel"]>) => Promise<{ text: string; x0: number; y0: number; x1: number; y1: number; }[]> = async (canvas: HTMLCanvasElement, page: ImportPage, pageCount: number, model: NonNullable<ExtractionJob['ocrModel']>): Promise<{ text: string; x0: number; y0: number; x1: number; y1: number; }[]> => {
        progress('ocr', pageCount);
        try {
            const blob: Blob | null = await new Promise<Blob | null>((resolve: (value: Blob | PromiseLike<Blob | null> | null) => void): void => canvas.toBlob(resolve, 'image/png'));
            if (!blob) {
                throw new Error('Raster serialization failed.');
            }
            const raster: { pageNumber: number; width: number; height: number; png: Uint8Array<ArrayBuffer>; } = { pageNumber: page.pageNumber, width: canvas.width, height: canvas.height, png: new Uint8Array(await blob.arrayBuffer()) };
            const regions: { text: string; x0: number; y0: number; x1: number; y1: number; }[] = ocrRegionsSchema.parse(await window.receiptMatchExtraction.recognize(raster));
            extractionVersion = LOCAL_OCR_VERSIONS[model];
            return regions;
        } catch {
            throw new ExtractionFault('ocr-model', 'The selected local OCR model could not read this page.');
        }
    };

    const recognize: (canvas: HTMLCanvasElement, page: ImportPage, pageCount: number) => Promise<void> = async (canvas: HTMLCanvasElement, page: ImportPage, pageCount: number): Promise<void> => {
        const words: { text: string; x0: number; y0: number; x1: number; y1: number; }[] = job.ocrModel ? await recognizeModel(canvas, page, pageCount, job.ocrModel) : await recognizeStandard(canvas, pageCount);
        for (const { text, ...bounds } of words) {
            const box: GeometryResult = ocrWordGeometry(bounds, page, canvas);
            if (!box.region || box.clipped) {
                issue('geometry-warning', 'An OCR region touches or exceeds the visible page bounds.', page.pageId);
            }
            if (box.region) {
                append(page, { text, region: box.region, method: 'local-ocr' });
            }
        }
        if (!page.spans.length) {
            issue('no-readable-text', 'No positioned text was readable on this page.', page.pageId);
        }
    };

    const result: () => ExtractionResult = (): ExtractionResult => {
        if (pages.every((page: ImportPage): boolean => page.status === 'failed')) {
            return { status: 'failed', issues };
        }
        const input: BankImportInput = { source: { sourceId: job.sourceId, sha256: job.sha256 }, extraction: { runId: job.jobId, version: extractionVersion }, pages, issues };
        const checked: ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(input);
        if (!checked.success) {
            return failed('extraction-limit', 'The extracted document could not satisfy the bounded positioned-text contract.');
        }
        return { status: issues.length ? 'partial' : 'complete', input: checked.data };
    };

    async function extractImage(format: Exclude<ExtractionJob['format'], 'pdf'>): Promise<ExtractionResult> {
        const header: { width: number; height: number; } = imageInputDimensions(job.bytes, format);
        pageNumber = 1;
        let bitmap: ImageBitmap | undefined;
        let canvas: HTMLCanvasElement | undefined;
        try {
            progress('rendering', 1);
            bitmap = await createImageBitmap(new Blob([new Uint8Array(job.bytes)], { type: IMAGE_MIME_TYPES[format] }), { imageOrientation: 'from-image' });
            assertImageDimensions(bitmap.width, bitmap.height);
            if (!((bitmap.width === header.width && bitmap.height === header.height) || (bitmap.width === header.height && bitmap.height === header.width))) {
                throw new ExtractionFault('image-dimensions', 'Decoded image dimensions do not match the authorized image header.');
            }
            const page: ImportPage = { pageId: 'page-1', pageNumber: 1, width: bitmap.width, height: bitmap.height, status: 'complete', spans: [] };
            canvas = globalThis.document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
            if (!context) {
                throw new ExtractionFault('image-failed', 'The local image rasterizer is unavailable.');
            }
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0);
            await recognize(canvas, page, 1);
            pages.push(page);
            progress('page-complete', 1);
            return result();
        } finally {
            bitmap?.close();
            if (canvas) {
                canvas.width = 1; canvas.height = 1;
            }
        }
    }

    async function appendEmbeddedText(pdfPage: pdfjs.PDFPageProxy, page: ImportPage, viewport: pdfjs.PageViewport, pageCount: number): Promise<void> {
        progress('text', pageCount);
        const content: TextContent = await pdfPage.getTextContent();
        for (const item of content.items) {
            if (!('str' in item) || !item.str.trim()) {
                continue;
            }
            try {
                const box: GeometryResult = embeddedTextGeometry(item, content.styles[item.fontName] ?? {}, viewport);
                if (box.region) {
                    append(page, { text: item.str, region: box.region, method: 'embedded-text' });
                }
                if (!box.region || box.clipped || box.approximate) {
                        issue('geometry-warning', 'Embedded text has clipped or approximate font geometry; review its page evidence.', page.pageId);
                    }
            } catch (error: unknown) {
                if (error instanceof ExtractionFault) {
                    throw error;
                }
                issue('geometry-warning', 'Some embedded text could not be positioned safely and needs page review.', page.pageId);
            }
        }
    }

    function createPageCanvas(raster: PageViewport, pageCount: number): HTMLCanvasElement {
        const width: number = Math.ceil(raster.width);
        const height: number = Math.ceil(raster.height);
        const pixels: number = width * height;
        if (!Number.isSafeInteger(pixels) || pixels > PDF_EXTRACTION_LIMITS.pixelsPerPage || totalPixels + pixels > PDF_EXTRACTION_LIMITS.pixelsTotal) {
            throw new ExtractionFault('pixel-limit', 'Local PDF rasterization exceeded its pixel limit.');
        }
        totalPixels += pixels;
        progress('rendering', pageCount);
        const canvas: HTMLCanvasElement = globalThis.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    async function extractPdfPage(pdf: pdfjs.PDFDocumentProxy, number: number, pageCount: number): Promise<void> {
        pageNumber = number;
        const pageId: string = `page-${number}`;
        // getPage/viewport failures cannot be represented using invented dimensions.
        const pdfPage: pdfjs.PDFPageProxy = await pdf.getPage(number);
        const viewport: pdfjs.PageViewport = pdfPage.getViewport({ scale: 1 });
        assertPageGeometry(viewport);
        const page: ImportPage = { pageId, pageNumber: number, width: viewport.width, height: viewport.height, status: 'complete', spans: [] };
        let canvas: HTMLCanvasElement | undefined;
        try {
            await appendEmbeddedText(pdfPage, page, viewport, pageCount);
            const operations: PDFOperatorList = await pdfPage.getOperatorList();
            const hasImages: boolean = operations.fnArray.some((operation: number): boolean => imageOperations.has(operation));
            if (page.spans.length) {
                if (hasImages) {
                    issue('mixed-content', 'This page contains embedded text and image content. Image regions were not separately OCR-interpreted.', pageId);
                }
            } else {
                const raster: PageViewport = pdfPage.getViewport({ scale: 2 });
                canvas = createPageCanvas(raster, pageCount);
                const context: CanvasRenderingContext2D | null = canvas.getContext('2d');
                if (!context) {
                    throw new ExtractionFault('page-failed', 'The local page rasterizer is unavailable.');
                }
                await pdfPage.render({ canvas, canvasContext: context, viewport: raster }).promise;
                await recognize(canvas, page, pageCount);
            }
        } catch (error: unknown) {
            if (error instanceof ExtractionFault && error.fatal) {
                throw error;
            }
            page.status = 'failed';
            page.spans = [];
            issue(
                error instanceof ExtractionFault ? error.code : 'page-failed',
                error instanceof ExtractionFault ? error.message : 'A PDF page could not be extracted.',
                pageId,
                'error'
            );
        } finally {
            if (canvas) {
                canvas.width = 1;
                canvas.height = 1;
            }
            pdfPage.cleanup();
        }
        pages.push(page);
        progress('page-complete', pageCount);
    }

    try {
        progress('loading', null);
        if (job.format !== 'pdf') {
            return await extractImage(job.format);
        }
        const document: pdfjs.PDFDocumentProxy = await loadingTask!.promise;
        if (document.numPages < 1 || document.numPages > PDF_EXTRACTION_LIMITS.pages) {
            throw new ExtractionFault('page-limit', 'The PDF exceeds the local page limit.', true);
        }
        for (let number: number = 1; number <= document.numPages; number++) {
            await extractPdfPage(document, number, document.numPages);
        }
        return result();
    } catch (error: unknown) {
        return extractionFailure(error, job.format, pageNumber);
    } finally {
        try {
            if (worker) {
                await worker.terminate();
            }
        } finally {
            await loadingTask?.destroy();
        }
    }
}
let received: boolean = false;
window.receiptMatchExtraction.onJob((value: unknown): void => {
    if (received) {
        return;
    }
    received = true;
    const checked: ZodSafeParseResult<ExtractionJob> = extractionJobSchema.safeParse(value);
    if (!checked.success) {
        window.receiptMatchExtraction.report({ type: 'result', result: failed('invalid-job', 'The extraction job did not satisfy its input contract.') });
        return;
    }
    void execute(checked.data).then(
        (result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }): void => window.receiptMatchExtraction.report({ type: 'result', result }),
        (): void => window.receiptMatchExtraction.report({ type: 'result', result: failed('engine-failed', 'The local extraction engine could not finish safely.') })
    );
});
window.receiptMatchExtraction.ready();
