import { z } from 'zod';

export const originalPreviewRequestSchema = z.strictObject({ kind: z.enum(['statement', 'document']), id: z.uuid(), loadRevision: z.number().int().nonnegative() });
export type OriginalPreviewRequest = z.infer<typeof originalPreviewRequestSchema>;
export interface OriginalPreviewResult { error: string | null; status?: 'missing' | 'changed' | 'unreadable'; }
export type OriginalRelinkResult = { status: 'linked' | 'cancelled' } | { status: 'failed'; error: string };
export const originalAdoptionRequestSchema = z.strictObject({
    token: z.uuid(), loadRevision: z.number().int().nonnegative(), acknowledgeConflicts: z.boolean()
});
export type OriginalAdoptionRequest = z.infer<typeof originalAdoptionRequestSchema>;
export interface OriginalAnalysisComparison {
    token: string;
    oldPath: string;
    newPath: string;
    changes: { label: string; before: string | null; after: string | null }[];
    conflicts: string[];
    preserved: number;
    revoked: number;
}
export type OriginalAnalysisResult = { status: 'ready'; comparison: OriginalAnalysisComparison } | { status: 'cancelled' } | { status: 'failed'; error: string };
export type OriginalAdoptionResult = { status: 'adopted' } | { status: 'failed'; error: string };
export const originalSourceExtensions = { pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'] } as const;
export interface OriginalPreviewData {
    name: string;
    format: 'pdf' | 'png' | 'jpeg';
    bytes: Uint8Array;
}
