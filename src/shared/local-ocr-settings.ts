import { z } from 'zod';
import { localOcrModelSchema, type LocalOcrModel } from './pdf-extraction.js';

export const localOcrSelectionSchema: z.ZodUnion<readonly [z.ZodLiteral<"standard">, z.ZodEnum<{ "pp-ocrv6-medium": "pp-ocrv6-medium"; "paddleocr-vl-1.6": "paddleocr-vl-1.6"; }>]> = z.union([z.literal('standard'), localOcrModelSchema]);
export type LocalOcrSelection = z.infer<typeof localOcrSelectionSchema>;
export const localOcrDeviceSchema: z.ZodEnum<{ cpu: 'cpu'; gpu: 'gpu' }> = z.enum(['cpu', 'gpu']);
export type LocalOcrDevice = z.infer<typeof localOcrDeviceSchema>;

type LocalOcrRequests = [
    z.ZodObject<{ type: z.ZodLiteral<'status'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'select'>; selection: typeof localOcrSelectionSchema }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'install'>; model: typeof localOcrModelSchema }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'select-device'>; device: typeof localOcrDeviceSchema }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'install-gpu-runtime'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'check-gpu'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'cancel'> }, z.core.$strict>
];
export const localOcrRequestSchema: z.ZodDiscriminatedUnion<LocalOcrRequests, 'type'> = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('status') }),
    z.strictObject({ type: z.literal('select'), selection: localOcrSelectionSchema }),
    z.strictObject({ type: z.literal('install'), model: localOcrModelSchema }),
    z.strictObject({ type: z.literal('select-device'), device: localOcrDeviceSchema }),
    z.strictObject({ type: z.literal('install-gpu-runtime') }),
    z.strictObject({ type: z.literal('check-gpu') }),
    z.strictObject({ type: z.literal('cancel') })
]);
export type LocalOcrRequest = z.infer<typeof localOcrRequestSchema>;
export interface LocalOcrDownload {
    receivedBytes: number;
    totalBytes: number;
}

export interface LocalOcrGpuStatus {
    state: 'unsupported' | 'download-required' | 'model-required' | 'unchecked' | 'checking' | 'available' | 'unavailable';
    cancellableCheck: boolean;
    issue?: string;
    downloadBytes: number;
    download: LocalOcrDownload | null;
    failedDownload: boolean;
}

export interface LocalOcrStatus {
    selection: LocalOcrSelection;
    device: LocalOcrDevice;
    gpu: LocalOcrGpuStatus;
    models: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; gpuSupported: boolean; runtimeIssue?: string }[];
    download: (LocalOcrDownload & { model: LocalOcrModel }) | null;
    failedDownload: LocalOcrModel | null;
}
