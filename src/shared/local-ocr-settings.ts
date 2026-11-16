import { z } from 'zod';
export const nuExtractDeviceSchema: z.ZodEnum<{ cpu: 'cpu'; gpu: 'gpu' }> = z.enum(['cpu', 'gpu']);
export type NuExtractDevice = z.infer<typeof nuExtractDeviceSchema>;

type OcrRequestOptions = [
    z.ZodObject<{ type: z.ZodLiteral<'status'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'install-nuextract'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'install-nuextract-vulkan'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'check-nuextract-gpu'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'cancel-nuextract'> }, z.core.$strict>,
    z.ZodObject<{ type: z.ZodLiteral<'select-nuextract-device'>; device: typeof nuExtractDeviceSchema }, z.core.$strict>
];
export const localOcrRequestSchema: z.ZodDiscriminatedUnion<OcrRequestOptions, 'type'> = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('status') }),
    z.strictObject({ type: z.literal('install-nuextract') }),
    z.strictObject({ type: z.literal('install-nuextract-vulkan') }),
    z.strictObject({ type: z.literal('check-nuextract-gpu') }),
    z.strictObject({ type: z.literal('cancel-nuextract') }),
    z.strictObject({ type: z.literal('select-nuextract-device'), device: nuExtractDeviceSchema })
]);
export type LocalOcrRequest = z.infer<typeof localOcrRequestSchema>;
export type LocalOcrStatus = NuExtractSettingsStatus;

export interface NuExtractDownload {
    kind: 'model' | 'vulkan';
    receivedBytes: number;
    totalBytes: number;
}

export interface NuExtractSettingsStatus {
    installed: boolean;
    cpuAvailable: boolean;
    cpuIssue?: string;
    device: NuExtractDevice;
    effectiveDevice: NuExtractDevice | null;
    modelDownloadBytes: number;
    vulkanDownloadBytes: number;
    gpu: 'unsupported' | 'download-required' | 'unchecked' | 'checking' | 'available' | 'unavailable';
    gpuIssue?: string;
    download: NuExtractDownload | null;
    busy: boolean;
    failedDownload: NuExtractDownload['kind'] | null;
}
