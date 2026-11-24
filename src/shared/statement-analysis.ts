import { z } from 'zod';
import { storedBankImportSchema } from './workspace-import.js';

export const statementAnalysisVersionSchema: z.ZodObject<{ importId: z.ZodUUID; acceptedAt: z.ZodISODateTime; record: typeof storedBankImportSchema }, z.core.$strict> = z.strictObject({
    importId: z.uuid(), acceptedAt: z.iso.datetime(), record: storedBankImportSchema
}).refine((version: { importId: string; record: typeof storedBankImportSchema._output }): boolean => version.importId === version.record.id &&
    version.record.result.adapter === null && version.record.result.localRecognition?.model === 'nuextract3', 'Statement analysis versions require a local NuExtract result for their original import.');
export type StatementAnalysisVersion = z.infer<typeof statementAnalysisVersionSchema>;
