import { z } from 'zod';
import type { SupportingDocument } from './supporting-document.js';

export const NUEXTRACT_RECEIPT_VERSION: string = 'pdfjs-6.5.438+nuextract3-q4-k-m+receipt-1';

export const receiptAiRequestSchema: z.ZodObject<{ reportId: z.ZodUUID; fileIndex: z.ZodNumber; loadRevision: z.ZodNumber }, z.core.$strict> = z.strictObject({
    reportId: z.uuid(), fileIndex: z.number().int().nonnegative(), loadRevision: z.number().int().nonnegative()
});
export type ReceiptAiRequest = z.infer<typeof receiptAiRequestSchema>;
export const receiptAiDiscardRequestSchema: z.ZodObject<{ token: z.ZodUUID; loadRevision: z.ZodNumber }, z.core.$strict> = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type ReceiptAiDiscardRequest = z.infer<typeof receiptAiDiscardRequestSchema>;
export interface ReceiptAiChange {
    label: string;
    before: string | null;
    after: string | null;
    kind?: 'section' | 'warnings' | 'matching' | 'omitted';
    section?: string;
    unrecognized?: true;
}
export type ReceiptAiResult = { status: 'ready'; model: 'nuextract3'; analysis: SupportingDocument;
    changes: ReceiptAiChange[]; conflicts: string[] }
    | { status: 'cancelled' } | { status: 'failed'; error: string };
export type ReceiptAiPreviewResult = (Extract<ReceiptAiResult, { status: 'ready' }> & { token: string; blockingConflict?: string }) | Exclude<ReceiptAiResult, { status: 'ready' }>;
