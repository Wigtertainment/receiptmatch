import { z } from 'zod';
import { bankImportResultSchema, importIssueSchema } from './bank-import.js';

const localId = z.string().min(1).max(128);
export const storedBankImportSchema = z.strictObject({
    id: z.uuid(),
    importedAt: z.iso.datetime(),
    filePath: z.string().min(1).max(32768).refine(value => !value.includes('\0')),
    result: bankImportResultSchema,
    accounts: z.array(z.strictObject({ sectionId: localId, accountId: z.uuid(), statementId: z.uuid() })).max(200),
    transactions: z.array(z.strictObject({ rowId: localId, transactionId: z.uuid() })).max(10000),
    drafts: z.array(z.strictObject({ rowId: localId, draftId: z.uuid() })).max(10000)
}).superRefine((record, ctx) => {
    const result = record.result;
    if (!['complete', 'partial'].includes(result.status) || !result.sourceProvenance || !z.uuid().safeParse(result.sourceProvenance.sourceId).success) {
        ctx.addIssue({ code: 'custom', message: 'Only parsed imports with host-owned source identities can be retained.' });
    }
    const ids = [record.id, result.sourceProvenance?.sourceId, ...record.accounts.flatMap(value => [value.accountId, value.statementId]), ...record.transactions.map(value => value.transactionId), ...record.drafts.map(value => value.draftId)];
    if (new Set(ids.map(value => value?.toLowerCase())).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Stored import identities must be distinct.' });
    for (const [mapped, expected] of [
        [record.accounts.map(value => value.sectionId), result.accountSections.map(value => value.sectionId)],
        [record.transactions.map(value => value.rowId), result.transactions.map(value => value.rowId)],
        [record.drafts.map(value => value.rowId), result.unresolvedDrafts.map(value => value.rowId)]
    ]) {
        const expectedIds = new Set(expected);
        if (mapped.length !== expected.length || new Set(mapped).size !== mapped.length || mapped.some(value => !expectedIds.has(value))) {
            ctx.addIssue({ code: 'custom', message: 'Every parsed account, transaction and draft needs one stable workspace identity.' });
        }
    }
});
export type StoredBankImport = z.infer<typeof storedBankImportSchema>;
export type BankImportRunResult =
    | { status: 'imported'; record: StoredBankImport }
    | { status: 'skipped'; importId: string }
    | { status: 'cancelled' }
    | { status: 'failed' | 'unsupported'; issues: z.infer<typeof importIssueSchema>[] };
export interface BankImportSummary {
    id: string;
    filePath: string;
    bankId: string;
    status: 'complete' | 'partial';
    transactions: number;
    drafts: number;
    issues: number;
}
