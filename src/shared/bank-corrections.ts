import { z } from 'zod';
import { calendarDateSchema, type ImportIssue, type TransactionCandidate, type UnresolvedDraft } from './bank-import.js';
import { moneySchema, type Money } from './money.js';
import type { StoredBankImport } from './workspace-import.js';

interface IBankCorrectionChangesShape {
    bookingDate: z.ZodOptional<typeof calendarDateSchema>;
    accountAmount: z.ZodOptional<typeof moneySchema>;
}

interface IBankCorrectionShape extends IBankCorrectionChangesShape {
    rowId: z.ZodUUID;
    revision: z.ZodNumber;
}

export const bankCorrectionChangesSchema: z.ZodObject<z.core.util.Flatten<IBankCorrectionChangesShape>, z.core.$strict> =
    z.strictObject({ bookingDate: calendarDateSchema.optional(), accountAmount: moneySchema.optional() })
        .refine((value: Pick<BankCorrection, 'bookingDate' | 'accountAmount'>): boolean => value.bookingDate !== undefined || value.accountAmount !== undefined,
            'Enter a booking date or an account amount.');
export const bankCorrectionSchema: z.ZodObject<z.core.util.Flatten<IBankCorrectionShape>, z.core.$strict> =
    bankCorrectionChangesSchema.safeExtend({ rowId: z.uuid(), revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER) });
export type BankCorrection = z.infer<typeof bankCorrectionSchema>;

type CorrectedBankValues = Pick<UnresolvedDraft, 'bookingDate' | 'accountAmount' | 'direction'>;
type StoredTransaction = StoredBankImport['transactions'][number];
type StoredDraft = StoredBankImport['drafts'][number];
type AccountSection = StoredBankImport['result']['accountSections'][number];

function correctedValues(row: TransactionCandidate | UnresolvedDraft, correction: BankCorrection, currency: string): CorrectedBankValues {
    const { bookingDate, accountAmount }: BankCorrection = correction;
    const coefficient: bigint = accountAmount ? BigInt(accountAmount.coefficient) : 0n;
    const amountDirection: "incoming" | "outgoing" | null = coefficient < 0n ? 'outgoing' : coefficient > 0n ? 'incoming' : null;
    if (accountAmount && (accountAmount.currency !== currency || (row.direction && amountDirection && row.direction !== amountDirection))) {
        throw new Error('The corrected amount must use the account currency and agree with the payment direction.');
    }
    return {
        bookingDate: bookingDate === undefined ? row.bookingDate : { value: bookingDate, basisLabel: 'User correction', evidence: row.bookingDate?.evidence ?? [] },
        accountAmount: accountAmount === undefined ? row.accountAmount : { value: accountAmount, evidence: row.accountAmount?.evidence ?? [] },
        direction: row.direction ?? amountDirection
    };
}

// The projection is used for matching and display. Only the original import is stored as extraction evidence.
export function applyBankCorrections(imports: StoredBankImport[], corrections: ReadonlyMap<string, BankCorrection>): StoredBankImport[] {
    if (!corrections.size) {
        return imports;
    }
    const pending: Map<string, BankCorrection> = new Map(corrections);
    const records: StoredBankImport[] = imports.map((record: StoredBankImport): StoredBankImport => {
        const ids: Map<string, string> = new Map([
            ...record.transactions.map((row: StoredTransaction): readonly [string, string] => [row.rowId, row.transactionId] as const),
            ...record.drafts.map((row: StoredDraft): readonly [string, string] => [row.rowId, row.draftId] as const),
        ]);
        if (![...ids.values()].some((id: string): boolean => pending.has(id))) {
            return record;
        }
        const currencies: Map<string, string> = new Map(record.result.accountSections.map((section: AccountSection): [string, string] => [section.sectionId, section.currency.value]));
        const take: (row: TransactionCandidate | UnresolvedDraft) => BankCorrection | undefined = (row: TransactionCandidate | UnresolvedDraft): BankCorrection | undefined => {
            const id: string = ids.get(row.rowId)!;
            const correction: BankCorrection | undefined = pending.get(id);
            if (correction) {
                pending.delete(id);
            }
            return correction;
        };
        const transactions: TransactionCandidate[] = record.result.transactions.map((row: TransactionCandidate): TransactionCandidate => {
            const correction: BankCorrection | undefined = take(row);
            if (!correction) {
                return row;
            }
            const values: ReturnType<typeof correctedValues> = correctedValues(row, correction, currencies.get(row.accountSectionId)!);
            return { ...row, bookingDate: values.bookingDate!, accountAmount: values.accountAmount! };
        });
        const promoted: Set<string> = new Set<string>();
        const unresolvedDrafts: UnresolvedDraft[] = record.result.unresolvedDrafts.flatMap((row: UnresolvedDraft): UnresolvedDraft[] => {
            const correction: BankCorrection | undefined = take(row);
            if (!correction) {
                return [row];
            }
            const values: ReturnType<typeof correctedValues> = correctedValues(row, correction, currencies.get(row.accountSectionId)!);
            const original: Money | undefined = row.reportedOriginalAmount?.value;
            const directionConflict: boolean | null | undefined = original && values.direction && (values.direction === 'incoming' ? BigInt(original.coefficient) < 0n : BigInt(original.coefficient) > 0n);
            const { issues, ...source }: UnresolvedDraft = row;
            const remainingIssue: boolean = issues.some((issue: ImportIssue): boolean => !((issue.field === 'bookingDate' && Boolean(correction.bookingDate)) || (issue.field === 'accountAmount' && Boolean(correction.accountAmount))));
            if (!values.bookingDate || !values.accountAmount || !values.direction || !row.description || remainingIssue || directionConflict) {
                return [{ ...row, ...values }];
            }
            promoted.add(row.rowId);
            transactions.push({ ...source, bookingDate: values.bookingDate, accountAmount: values.accountAmount, direction: values.direction, description: row.description });
            return [];
        });
        return { ...record, result: { ...record.result, transactions, unresolvedDrafts }, drafts: record.drafts.filter((row: StoredDraft): boolean => !promoted.has(row.rowId)),
            transactions: [...record.transactions, ...record.drafts.filter((row: StoredDraft): boolean => promoted.has(row.rowId))
                .map((row: StoredDraft): StoredTransaction => ({ rowId: row.rowId, transactionId: row.draftId }))] };
    });
    if (pending.size) {
        throw new Error('A correction refers to a bank row outside the workspace imports.');
    }
    return records;
}
