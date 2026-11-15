import { z } from 'zod';
import type { LocalOcrModel } from './pdf-extraction.js';
import type { SupportingDocument } from './supporting-document.js';

export const receiptAiRequestSchema: z.ZodObject<{ reportId: z.ZodUUID; fileIndex: z.ZodNumber; loadRevision: z.ZodNumber }, z.core.$strict> = z.strictObject({
    reportId: z.uuid(), fileIndex: z.number().int().nonnegative(), loadRevision: z.number().int().nonnegative()
});
export type ReceiptAiRequest = z.infer<typeof receiptAiRequestSchema>;
export type ReceiptAiResult = { status: 'ready'; model: LocalOcrModel; analysis: SupportingDocument;
    changes: { label: string; before: string | null; after: string | null }[]; conflicts: string[] }
    | { status: 'cancelled' } | { status: 'failed'; error: string };
