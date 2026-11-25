import { z } from 'zod';
import type { SupportingDocument } from './supporting-document.js';
import { originalAdoptionRequestSchema } from './original-preview.js';
import type { NuExtractDevice } from './local-ocr-settings.js';

export const NUEXTRACT_RECEIPT_VERSION: string = 'pdfjs-6.5.438+nuextract3-q4-k-m+receipt-1';

interface IReceiptAiRequestShape {
    reportId: z.ZodUUID;
    fileIndex: z.ZodNumber;
    loadRevision: z.ZodNumber;
}

export const receiptAiRequestSchema: z.ZodObject<z.core.util.Flatten<IReceiptAiRequestShape>, z.core.$strict> = z.strictObject({
    reportId: z.uuid(), fileIndex: z.number().int().nonnegative(), loadRevision: z.number().int().nonnegative()
});
export type ReceiptAiRequest = z.infer<typeof receiptAiRequestSchema>;
export const receiptAiDiscardRequestSchema: z.ZodObject<Pick<typeof originalAdoptionRequestSchema.shape, 'token' | 'loadRevision'>, z.core.$strict> = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type ReceiptAiDiscardRequest = z.infer<typeof receiptAiDiscardRequestSchema>;
const receiptAiFieldSchema: z.ZodEnum<z.core.util.ToEnum<'reference' | 'issue-date' | 'billed-total'>> =
    z.enum(['reference', 'issue-date', 'billed-total']);
export type ReceiptAiField = z.infer<typeof receiptAiFieldSchema>;
interface IReceiptAiSelectionShape {
    selectedFields: z.ZodOptional<z.ZodArray<typeof receiptAiFieldSchema>>;
    currency: z.ZodOptional<z.ZodString>;
}

export const receiptAiAcceptRequestSchema: z.ZodObject<typeof originalAdoptionRequestSchema.shape & z.core.util.Flatten<IReceiptAiSelectionShape>, z.core.$strict> = originalAdoptionRequestSchema.extend({
    selectedFields: z.array(receiptAiFieldSchema).min(1).max(3).refine((fields: ReceiptAiField[]): boolean => new Set(fields).size === fields.length).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional()
});
export type ReceiptAiAcceptRequest = z.infer<typeof receiptAiAcceptRequestSchema>;

export interface IReceiptAiProposal {
    field: ReceiptAiField;
    label: string;
    before: string | null;
    value: string;
    verified: boolean;
    currency?: string;
    needsCurrency?: boolean;
    unavailable?: string;
    sectionId?: string;
}
export interface IReceiptAiChange {
    label: string;
    before: string | null;
    after: string | null;
    kind?: 'section' | 'warnings' | 'matching' | 'omitted';
    section?: string;
    unrecognized?: true;
}

interface IReceiptAiReady {
    status: 'ready';
    model: 'nuextract3';
    device?: NuExtractDevice;
    analysis: SupportingDocument;
    proposals?: IReceiptAiProposal[];
    changes: IReceiptAiChange[];
    conflicts: string[];
}
interface IReceiptAiFailure { status: 'failed'; error: string }
interface IReceiptAiPreview extends IReceiptAiReady { token: string; blockingConflict?: string }
type IncompleteReceiptAiResult = Record<'status', 'cancelled'> | IReceiptAiFailure;
export type ReceiptAiResult = IReceiptAiReady | IncompleteReceiptAiResult;
export type ReceiptAiPreviewResult = IReceiptAiPreview | IncompleteReceiptAiResult;
