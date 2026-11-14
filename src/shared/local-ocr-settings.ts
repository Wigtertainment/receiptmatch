import { z } from 'zod';
import { localOcrModelSchema, type LocalOcrModel } from './pdf-extraction.js';

export const localOcrSelectionSchema: z.ZodUnion<readonly [z.ZodLiteral<"standard">, z.ZodEnum<{ "pp-ocrv6-medium": "pp-ocrv6-medium"; "paddleocr-vl-1.6": "paddleocr-vl-1.6"; }>]> = z.union([z.literal('standard'), localOcrModelSchema]);
export type LocalOcrSelection = z.infer<typeof localOcrSelectionSchema>;
export const localOcrRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{ type: z.ZodLiteral<"status">; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"select">; selection: typeof localOcrSelectionSchema; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"install">; model: z.ZodEnum<{ "pp-ocrv6-medium": "pp-ocrv6-medium"; "paddleocr-vl-1.6": "paddleocr-vl-1.6"; }>; }, z.core.$strict>, z.ZodObject<{ type: z.ZodLiteral<"cancel">; }, z.core.$strict>], "type"> = z.discriminatedUnion('type', [
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
