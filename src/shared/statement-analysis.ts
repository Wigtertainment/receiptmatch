import { z } from 'zod';
import { storedBankImportSchema } from './workspace-import.js';

interface IStatementAnalysisVersionShape {
    importId: z.ZodUUID;
    acceptedAt: z.ZodISODateTime;
    record: typeof storedBankImportSchema;
}

export const statementAnalysisVersionSchema: z.ZodObject<z.core.util.Flatten<IStatementAnalysisVersionShape>, z.core.$strict> = z.strictObject({
    importId: z.uuid(), acceptedAt: z.iso.datetime(), record: storedBankImportSchema
}).refine((version: Pick<StatementAnalysisVersion, 'importId' | 'record'>): boolean => version.importId === version.record.id &&
    version.record.result.adapter === null && version.record.result.localRecognition?.model === 'nuextract3', 'Statement analysis versions require a local NuExtract result for their original import.');
export type StatementAnalysisVersion = z.infer<typeof statementAnalysisVersionSchema>;
