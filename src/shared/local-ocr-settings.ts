import { z } from 'zod';
export const nuExtractDeviceSchema: z.ZodEnum<z.core.util.ToEnum<'cpu' | 'gpu'>> = z.enum(['cpu', 'gpu']);
export type NuExtractDevice = z.infer<typeof nuExtractDeviceSchema>;

interface ISelectNuExtractDeviceShape {
    type: z.ZodLiteral<'select-nuextract-device'>;
    device: typeof nuExtractDeviceSchema;
}

type OcrRequestOption<Type extends string> = z.ZodObject<Record<'type', z.ZodLiteral<Type>>, z.core.$strict>;
type OcrRequestOptions = [
    OcrRequestOption<'status'>,
    OcrRequestOption<'install-nuextract'>,
    OcrRequestOption<'install-nuextract-vulkan'>,
    OcrRequestOption<'check-nuextract-gpu'>,
    OcrRequestOption<'cancel-nuextract'>,
    z.ZodObject<z.core.util.Flatten<ISelectNuExtractDeviceShape>, z.core.$strict>
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
export type LocalOcrStatus = INuExtractSettingsStatus;

export interface INuExtractDownload {
    kind: 'model' | 'vulkan';
    receivedBytes: number;
    totalBytes: number;
}

export interface INuExtractSettingsStatus {
    installed: boolean;
    cpuAvailable: boolean;
    cpuIssue?: string;
    device: NuExtractDevice;
    effectiveDevice: NuExtractDevice | null;
    modelDownloadBytes: number;
    vulkanDownloadBytes: number;
    gpu: 'unsupported' | 'download-required' | 'unchecked' | 'checking' | 'available' | 'unavailable';
    gpuIssue?: string;
    download: INuExtractDownload | null;
    busy: boolean;
    failedDownload: INuExtractDownload['kind'] | null;
}
