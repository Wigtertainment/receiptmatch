import { z } from 'zod';
import { localOcrModelSchema, type LocalOcrModel } from './pdf-extraction.js';

export const localOcrSelectionSchema = z.union([z.literal('standard'), localOcrModelSchema]);
export type LocalOcrSelection = z.infer<typeof localOcrSelectionSchema>;
export const localOcrRequestSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('status') }),
    z.strictObject({ type: z.literal('select'), selection: localOcrSelectionSchema }),
    z.strictObject({ type: z.literal('install'), model: localOcrModelSchema }),
    z.strictObject({ type: z.literal('cancel') })
]);
export type LocalOcrRequest = z.infer<typeof localOcrRequestSchema>;
export interface LocalOcrStatus {
    selection: LocalOcrSelection;
    models: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string }[];
    download: { model: LocalOcrModel; receivedBytes: number; totalBytes: number } | null;
    failedDownload: LocalOcrModel | null;
}
