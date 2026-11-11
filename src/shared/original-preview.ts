import { z } from 'zod';

export const originalPreviewRequestSchema = z.strictObject({ kind: z.enum(['statement', 'document']), id: z.uuid(), loadRevision: z.number().int().nonnegative() });
export type OriginalPreviewRequest = z.infer<typeof originalPreviewRequestSchema>;
export interface OriginalPreviewResult { error: string | null; }
export interface OriginalPreviewData {
    name: string;
    format: 'pdf' | 'png' | 'jpeg';
    bytes: Uint8Array;
}
