import type { BankImportResult, TransactionCandidate, UnresolvedDraft } from "./bank-import.js";
import { z } from 'zod';
import { bankImportResultSchema, importIssueSchema } from './bank-import.js';

const localId: z.ZodString = z.string().min(1).max(128);

interface IBankAccountLinkShape {
    sectionId: z.ZodString;
    accountId: z.ZodUUID;
    statementId: z.ZodUUID;
}

interface IBankTransactionLinkShape {
    rowId: z.ZodString;
    transactionId: z.ZodUUID;
}

interface IBankDraftLinkShape {
    rowId: z.ZodString;
    draftId: z.ZodUUID;
}

interface IStoredBankImportShape {
    id: z.ZodUUID;
    importedAt: z.ZodISODateTime;
    filePath: z.ZodString;
    result: typeof bankImportResultSchema;
    accounts: z.ZodArray<z.ZodObject<z.core.util.Flatten<IBankAccountLinkShape>, z.core.$strict>>;
    transactions: z.ZodArray<z.ZodObject<z.core.util.Flatten<IBankTransactionLinkShape>, z.core.$strict>>;
    drafts: z.ZodArray<z.ZodObject<z.core.util.Flatten<IBankDraftLinkShape>, z.core.$strict>>;
}

type StoredBankImportSchemaType = z.ZodObject<z.core.util.Flatten<IStoredBankImportShape>, z.core.$strict>;
export const storedBankImportSchema: StoredBankImportSchemaType = z.strictObject({
    id: z.uuid(),
    importedAt: z.iso.datetime(),
    filePath: z.string().min(1).max(32768).refine((value: string): boolean => !value.includes('\0')),
    result: bankImportResultSchema,
    accounts: z.array(z.strictObject({ sectionId: localId, accountId: z.uuid(), statementId: z.uuid() })).max(200),
    transactions: z.array(z.strictObject({ rowId: localId, transactionId: z.uuid() })).max(10000),
    drafts: z.array(z.strictObject({ rowId: localId, draftId: z.uuid() })).max(10000)
}).superRefine((record: z.output<StoredBankImportSchemaType>, ctx: z.RefinementCtx): void => {
    const result: BankImportResult = record.result;
    if (!['complete', 'partial'].includes(result.status) || !result.sourceProvenance || !z.uuid().safeParse(result.sourceProvenance.sourceId).success) {
        ctx.addIssue({ code: 'custom', message: 'Only parsed imports with host-owned source identities can be retained.' });
    }
    const ids: (string | undefined)[] = [
        record.id,
        result.sourceProvenance?.sourceId,
        ...record.accounts.flatMap((value: StoredBankImport['accounts'][number]): string[] => [value.accountId, value.statementId]),
        ...record.transactions.map((value: StoredBankImport['transactions'][number]): string => value.transactionId),
        ...record.drafts.map((value: StoredBankImport['drafts'][number]): string => value.draftId)
    ];
    if (new Set(ids.map((value: string | undefined): string | undefined => value?.toLowerCase())).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: 'Stored import identities must be distinct.' });
    }
    for (const [mapped, expected] of [
        [
            record.accounts.map((value: StoredBankImport['accounts'][number]): string => value.sectionId),
            result.accountSections.map((value: BankImportResult['accountSections'][number]): string => value.sectionId)
        ],
        [
            record.transactions.map((value: StoredBankImport['transactions'][number]): string => value.rowId),
            result.transactions.map((value: TransactionCandidate): string => value.rowId)
        ],
        [record.drafts.map((value: StoredBankImport['drafts'][number]): string => value.rowId), result.unresolvedDrafts.map((value: UnresolvedDraft): string => value.rowId)]
    ]) {
        const expectedIds: Set<string> = new Set(expected);
        if (mapped.length !== expected.length || new Set(mapped).size !== mapped.length || mapped.some((value: string): boolean => !expectedIds.has(value))) {
            ctx.addIssue({ code: 'custom', message: 'Every parsed account, transaction and draft needs one stable workspace identity.' });
        }
    }
});
export type StoredBankImport = z.infer<typeof storedBankImportSchema>;

interface IBankImportCompleted {
    status: 'imported';
    record: StoredBankImport;
}

interface IBankImportSkippedDuplicate {
    status: 'skipped';
    importId: string;
    existingSourceId?: never;
}

interface IBankImportSkippedSource {
    status: 'skipped';
    importId: null;
    existingSourceId: string;
}

interface IBankImportCancelled {
    status: 'cancelled';
}

interface IBankImportFailed {
    status: 'failed' | 'unsupported';
    issues: z.infer<typeof importIssueSchema>[];
}

export type BankImportRunResult = IBankImportCompleted | IBankImportSkippedDuplicate | IBankImportSkippedSource | IBankImportCancelled | IBankImportFailed;
export interface IBankImportSummary {
    id: string;
    filePath: string;
    replacesStatementId?: string;
    bankId: string | null;
    status: 'complete' | 'partial';
    transactions: number;
    drafts: number;
    issues: number;
}
