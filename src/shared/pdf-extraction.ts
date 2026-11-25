import { z } from 'zod';
import { bankImportInputSchema, importIssueSchema, type ImportPage } from './bank-import.js';
import { nuExtractDeviceSchema } from './local-ocr-settings.js';

export const PDF_EXTRACTION_VERSION: "pdfjs-6.5.438+tesseract-7.0.0-eng-1.0.0+document-2" = 'pdfjs-6.5.438+tesseract-7.0.0-eng-1.0.0+document-2';
interface IPdfExtractionLimits {
    readonly bytes: number;
    readonly pages: 200;
    readonly pixelsPerPage: 16000000;
    readonly pixelsTotal: 64000000;
    readonly timeoutMs: 120000;
}
interface IReceiptRasterLimits { readonly pages: 16; readonly bytes: number }
interface IExtractionChannels {
    readonly ready: 'extraction:ready';
    readonly job: 'extraction:job';
    readonly event: 'extraction:event';
    readonly raster: 'extraction:raster';
}

// Fixed execution guards, not supported-workload or performance promises.
export const PDF_EXTRACTION_LIMITS: IPdfExtractionLimits = { bytes: 25 * 1024 * 1024, pages: 200, pixelsPerPage: 16000000, pixelsTotal: 64000000, timeoutMs: 120000 } as const;
export const OCR_RASTER_BYTES: number = PDF_EXTRACTION_LIMITS.pixelsPerPage * 4 + 1024 * 1024;
export const RECEIPT_RASTER_LIMITS: IReceiptRasterLimits = { pages: 16, bytes: 48 * 1024 * 1024 };
export const EXTRACTION_CHANNELS: IExtractionChannels = { ready: 'extraction:ready', job: 'extraction:job', event: 'extraction:event', raster: 'extraction:raster' } as const;
const rasterSide: z.ZodNumber = z.number().int().min(1).max(20000);
interface IOcrRasterShape {
    pageNumber: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
    png: z.ZodInstanceOf<Uint8Array<ArrayBuffer>>;
}
export const ocrRasterSchema: z.ZodObject<z.core.util.Flatten<IOcrRasterShape>, z.core.$strict> = z.strictObject({
    pageNumber: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages),
    width: rasterSide,
    height: rasterSide,
    png: z.instanceof(Uint8Array).refine((png: Uint8Array<ArrayBuffer>): boolean => png.byteLength > 0 && png.byteLength <= OCR_RASTER_BYTES)
}).refine((raster: OcrRaster): boolean => raster.width * raster.height <= PDF_EXTRACTION_LIMITS.pixelsPerPage);
export type OcrRaster = z.infer<typeof ocrRasterSchema>;
interface IExtractionProgressShape {
    phase: z.ZodEnum<z.core.util.ToEnum<'text' | 'loading' | 'rendering' | 'ocr' | 'page-complete'>>;
    pageNumber: z.ZodNullable<z.ZodNumber>;
    pageCount: z.ZodNullable<z.ZodNumber>;
    completedPages: z.ZodNumber;
}
const rendererProgressSchema: z.ZodObject<z.core.util.Flatten<IExtractionProgressShape>, z.core.$strict> = z.strictObject({
    phase: z.enum(['loading', 'text', 'rendering', 'ocr', 'page-complete']),
    pageNumber: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    pageCount: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    completedPages: z.number().int().min(0).max(PDF_EXTRACTION_LIMITS.pages)
});
interface IDeviceExtractionProgressShape extends IExtractionProgressShape {
    device: z.ZodOptional<typeof nuExtractDeviceSchema>;
}
export const extractionProgressSchema: z.ZodObject<z.core.util.Flatten<IDeviceExtractionProgressShape>, z.core.$strict> =
    rendererProgressSchema.extend({ device: nuExtractDeviceSchema.optional() });
interface IExtractionWithInputShape<Status extends 'complete' | 'partial'> {
    status: z.ZodLiteral<Status>;
    input: typeof bankImportInputSchema;
}
interface IExtractionWithIssuesShape<Status extends 'failed' | 'cancelled'> {
    status: z.ZodLiteral<Status>;
    issues: z.ZodArray<typeof importIssueSchema>;
}
type ExtractionResultSchemaType = z.ZodDiscriminatedUnion<[
    z.ZodObject<z.core.util.Flatten<IExtractionWithInputShape<'complete'>>, z.core.$strict>,
    z.ZodObject<z.core.util.Flatten<IExtractionWithInputShape<'partial'>>, z.core.$strict>,
    z.ZodObject<z.core.util.Flatten<IExtractionWithIssuesShape<'failed'>>, z.core.$strict>,
    z.ZodObject<z.core.util.Flatten<IExtractionWithIssuesShape<'cancelled'>>, z.core.$strict>
], 'status'>;
export const extractionResultSchema: ExtractionResultSchemaType = z
    .discriminatedUnion('status', [
        z.strictObject({ status: z.literal('complete'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('partial'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('failed'), issues: z.array(importIssueSchema).min(1).max(1000) }),
        z.strictObject({ status: z.literal('cancelled'), issues: z.array(importIssueSchema).min(1).max(1000) })
    ])
    .superRefine((value: ExtractionResult, ctx: z.core.$RefinementCtx<ExtractionResult>): void => {
        if (value.status === 'complete' && (value.input.issues.length || value.input.pages.some((page: ImportPage): boolean => page.status === 'failed'))) {
            ctx.addIssue({ code: 'custom', message: 'Complete extraction cannot hide issues or failed pages.' });
        }
        if (value.status === 'partial' && !value.input.issues.length) {
            ctx.addIssue({ code: 'custom', message: 'Partial extraction must explain its uncertainty.' });
        }
    });
interface IExtractionJobShape {
    jobId: z.ZodUUID;
    format: z.ZodEnum<z.core.util.ToEnum<'png' | 'pdf' | 'jpeg'>>;
    sourceId: z.ZodString;
    sha256: z.ZodString;
    bytes: z.ZodInstanceOf<Uint8Array<ArrayBuffer>>;
    rasterOnly: z.ZodOptional<z.ZodLiteral<true>>;
}
export const extractionJobSchema: z.ZodObject<z.core.util.Flatten<IExtractionJobShape>, z.core.$strict> = z.strictObject({
    jobId: z.uuid(),
    format: z.enum(['pdf', 'png', 'jpeg']),
    sourceId: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.instanceof(Uint8Array).refine((value: Uint8Array<ArrayBuffer>): boolean => value.byteLength > 0 && value.byteLength <= PDF_EXTRACTION_LIMITS.bytes),
    rasterOnly: z.literal(true).optional()
});
interface IExtractionProgressEventShape {
    type: z.ZodLiteral<'progress'>;
    progress: typeof rendererProgressSchema;
}
interface IExtractionResultEventShape {
    type: z.ZodLiteral<'result'>;
    result: typeof extractionResultSchema;
}
interface IExtractionEventShape {
    jobId: z.ZodUUID;
    event: z.ZodDiscriminatedUnion<[
        z.ZodObject<z.core.util.Flatten<IExtractionProgressEventShape>, z.core.$strict>,
        z.ZodObject<z.core.util.Flatten<IExtractionResultEventShape>, z.core.$strict>
    ], 'type'>;
}
export const extractionEventSchema: z.ZodObject<z.core.util.Flatten<IExtractionEventShape>, z.core.$strict> = z.strictObject({
    jobId: z.uuid(),
    event: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('progress'), progress: rendererProgressSchema }),
        z.strictObject({ type: z.literal('result'), result: extractionResultSchema })
    ])
});
export type ExtractionProgress = z.infer<typeof extractionProgressSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionJob = z.infer<typeof extractionJobSchema>;
export type ExtractionEvent = z.infer<typeof extractionEventSchema>['event'];
export interface IExtractionBridge {
    onJob(listener: (job: unknown) => void): void;
    ready(): void;
    report(event: ExtractionEvent): void;
    sendRaster(raster: OcrRaster): Promise<void>;
}
