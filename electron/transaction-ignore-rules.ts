import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TransactionCandidate } from '../src/shared/bank-import.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';

export function transactionIgnoreRuleKey(row: TransactionCandidate): string | null {
    const description = row.description.value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ').replace(/’/gu, "'");
    if (!description) return null;
    return createHash('sha256').update(JSON.stringify([description, row.direction, row.accountAmount.value.currency])).digest('hex');
}

export function transactionsIgnoredByRules(imports: StoredBankImport[], rules: ReadonlySet<string>): Set<string> {
    const ignored = new Set<string>();
    if (!rules.size) return ignored;
    for (const record of imports) {
        const ids = new Map(record.transactions.map(({ rowId, transactionId }) => [rowId, transactionId]));
        for (const row of record.result.transactions) {
            const key = transactionIgnoreRuleKey(row);
            if (key && rules.has(key)) ignored.add(ids.get(row.rowId)!);
        }
    }
    return ignored;
}

export async function readTransactionIgnoreRules(directory: string): Promise<Set<string>> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return new Set(entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}$/u.test(entry.name)).map(entry => entry.name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
        throw error;
    }
}

export async function setTransactionIgnoreRule(directory: string, key: string, enabled: boolean): Promise<void> {
    const file = path.join(directory, key);
    if (enabled) {
        await mkdir(directory, { recursive: true });
        try {
            await writeFile(file, '', { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    } else await rm(file, { force: true });
}
