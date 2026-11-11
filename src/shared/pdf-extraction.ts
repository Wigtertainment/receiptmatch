import { z } from 'zod';
import { bankImportInputSchema, importIssueSchema } from './bank-import.js';

export const PDF_EXTRACTION_VERSION = 'pdfjs-6.5.438+tesseract-7.0.0-eng-1.0.0+document-2';
// Fixed execution guards, not supported-workload or performance promises.
export const PDF_EXTRACTION_LIMITS = { bytes: 25 * 1024 * 1024, pages: 200, pixelsPerPage: 16000000, pixelsTotal: 64000000, timeoutMs: 120000 } as const;
export const EXTRACTION_CHANNELS = { ready: 'extraction:ready', job: 'extraction:job', event: 'extraction:event' } as const;
export const extractionProgressSchema = z.strictObject({
    phase: z.enum(['loading', 'text', 'rendering', 'ocr', 'page-complete']),
    pageNumber: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    pageCount: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    completedPages: z.number().int().min(0).max(PDF_EXTRACTION_LIMITS.pages)
});
export const extractionResultSchema = z
    .discriminatedUnion('status', [
        z.strictObject({ status: z.literal('complete'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('partial'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('failed'), issues: z.array(importIssueSchema).min(1).max(1000) }),
        z.strictObject({ status: z.literal('cancelled'), issues: z.array(importIssueSchema).min(1).max(1000) })
    ])
    .superRefine((value, ctx) => {
        if (value.status === 'complete' && (value.input.issues.length || value.input.pages.some((page) => page.status === 'failed'))) {
            ctx.addIssue({ code: 'custom', message: 'Complete extraction cannot hide issues or failed pages.' });
        }
        if (value.status === 'partial' && !value.input.issues.length) ctx.addIssue({ code: 'custom', message: 'Partial extraction must explain its uncertainty.' });
    });
export const extractionJobSchema = z.strictObject({
    jobId: z.uuid(),
    format: z.enum(['pdf', 'png', 'jpeg']),
    sourceId: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= PDF_EXTRACTION_LIMITS.bytes)
});
export const extractionEventSchema = z.strictObject({
    jobId: z.uuid(),
    event: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('progress'), progress: extractionProgressSchema }),
        z.strictObject({ type: z.literal('result'), result: extractionResultSchema })
    ])
});
export type ExtractionProgress = z.infer<typeof extractionProgressSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionJob = z.infer<typeof extractionJobSchema>;
export type ExtractionEvent = z.infer<typeof extractionEventSchema>['event'];
export interface ExtractionBridge {
    onJob(listener: (job: unknown) => void): void;
    ready(): void;
    report(event: ExtractionEvent): void;
}
