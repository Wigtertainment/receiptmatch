import { z } from 'zod';
import { calendarDateSchema, type TransactionCandidate, type UnresolvedDraft } from './bank-import.js';
import { moneySchema } from './money.js';
import type { StoredBankImport } from './workspace-import.js';

export const bankCorrectionChangesSchema = z.strictObject({ bookingDate: calendarDateSchema.optional(), accountAmount: moneySchema.optional() })
    .refine(value => value.bookingDate !== undefined || value.accountAmount !== undefined, 'Enter a booking date or an account amount.');
export const bankCorrectionSchema = bankCorrectionChangesSchema.safeExtend({ rowId: z.uuid(), revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER) });
export type BankCorrection = z.infer<typeof bankCorrectionSchema>;

function correctedValues(row: TransactionCandidate | UnresolvedDraft, correction: BankCorrection, currency: string) {
    const { bookingDate, accountAmount } = correction;
    const coefficient = accountAmount ? BigInt(accountAmount.coefficient) : 0n;
    const amountDirection = coefficient < 0n ? 'outgoing' : coefficient > 0n ? 'incoming' : null;
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
    if (!corrections.size) return imports;
    const pending = new Map(corrections);
    const records = imports.map(record => {
        const ids = new Map([...record.transactions.map(row => [row.rowId, row.transactionId] as const), ...record.drafts.map(row => [row.rowId, row.draftId] as const)]);
        if (![...ids.values()].some(id => pending.has(id))) return record;
        const currencies = new Map(record.result.accountSections.map(section => [section.sectionId, section.currency.value]));
        const take = (row: TransactionCandidate | UnresolvedDraft) => {
            const id = ids.get(row.rowId)!;
            const correction = pending.get(id);
            if (correction) pending.delete(id);
            return correction;
        };
        const transactions = record.result.transactions.map(row => {
            const correction = take(row);
            if (!correction) return row;
            const values = correctedValues(row, correction, currencies.get(row.accountSectionId)!);
            return { ...row, bookingDate: values.bookingDate!, accountAmount: values.accountAmount! };
        });
        const promoted = new Set<string>();
        const unresolvedDrafts = record.result.unresolvedDrafts.flatMap(row => {
            const correction = take(row);
            if (!correction) return [row];
            const values = correctedValues(row, correction, currencies.get(row.accountSectionId)!);
            const original = row.reportedOriginalAmount?.value;
            const directionConflict = original && values.direction && (values.direction === 'incoming' ? BigInt(original.coefficient) < 0n : BigInt(original.coefficient) > 0n);
            const { issues, ...source } = row;
            const remainingIssue = issues.some(issue => !((issue.field === 'bookingDate' && correction.bookingDate) || (issue.field === 'accountAmount' && correction.accountAmount)));
            if (!values.bookingDate || !values.accountAmount || !values.direction || !row.description || remainingIssue || directionConflict) return [{ ...row, ...values }];
            promoted.add(row.rowId);
            transactions.push({ ...source, bookingDate: values.bookingDate, accountAmount: values.accountAmount, direction: values.direction, description: row.description });
            return [];
        });
        return { ...record, result: { ...record.result, transactions, unresolvedDrafts }, drafts: record.drafts.filter(row => !promoted.has(row.rowId)),
            transactions: [...record.transactions, ...record.drafts.filter(row => promoted.has(row.rowId)).map(row => ({ rowId: row.rowId, transactionId: row.draftId }))] };
    });
    if (pending.size) throw new Error('A correction refers to a bank row outside the workspace imports.');
    return records;
}
