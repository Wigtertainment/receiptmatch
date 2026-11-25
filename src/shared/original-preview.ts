import { z } from 'zod';

interface IOriginalPreviewRequestShape {
    kind: z.ZodEnum<z.core.util.ToEnum<'statement' | 'document'>>;
    id: z.ZodUUID;
    loadRevision: z.ZodNumber;
}

interface IOriginalAdoptionRequestShape {
    token: z.ZodUUID;
    loadRevision: z.ZodNumber;
    acknowledgeConflicts: z.ZodBoolean;
}

export const originalPreviewRequestSchema: z.ZodObject<z.core.util.Flatten<IOriginalPreviewRequestShape>, z.core.$strict> = z.strictObject({
    kind: z.enum(['statement', 'document']), id: z.uuid(), loadRevision: z.number().int().nonnegative()
});
export type OriginalPreviewRequest = z.infer<typeof originalPreviewRequestSchema>;
export interface IOriginalPreviewResult { error: string | null; status?: 'missing' | 'changed' | 'unreadable'; }
interface IOriginalSourceFailure { status: 'failed'; error: string }
export type OriginalRelinkResult = Record<'status', 'linked' | 'cancelled'> | IOriginalSourceFailure;
export const originalAdoptionRequestSchema: z.ZodObject<z.core.util.Flatten<IOriginalAdoptionRequestShape>, z.core.$strict> = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative(), acknowledgeConflicts: z.boolean()
});
export type OriginalAdoptionRequest = z.infer<typeof originalAdoptionRequestSchema>;
interface IOriginalAnalysisChange { label: string; before: string | null; after: string | null }
export interface IOriginalAnalysisComparison {
    token: string;
    oldPath: string;
    newPath: string;
    changes: IOriginalAnalysisChange[];
    conflicts: string[];
    preserved: number;
    revoked: number;
}
interface IOriginalAnalysisReady { status: 'ready'; comparison: IOriginalAnalysisComparison }
export type OriginalAnalysisResult = IOriginalAnalysisReady | Record<'status', 'cancelled'> | IOriginalSourceFailure;
export type OriginalAdoptionResult = Record<'status', 'adopted'> | IOriginalSourceFailure;

interface IOriginalSourceExtensions {
    readonly pdf: readonly ['.pdf'];
    readonly png: readonly ['.png'];
    readonly jpeg: readonly ['.jpg', '.jpeg'];
}
export const originalSourceExtensions: IOriginalSourceExtensions = { pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'] } as const;
export interface IOriginalPreviewData {
    name: string;
    format: 'pdf' | 'png' | 'jpeg';
    bytes: Uint8Array;
}
