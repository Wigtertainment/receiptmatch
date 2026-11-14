import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TransactionCandidate } from '../src/shared/bank-import.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { Dirent } from 'node:fs';

export function transactionIgnoreRuleKey(row: TransactionCandidate): string | null {
    const description: string = row.description.value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ').replace(/’/gu, "'");
    if (!description) {
        return null;
    }
    return createHash('sha256').update(JSON.stringify([description, row.direction, row.accountAmount.value.currency])).digest('hex');
}

export function transactionsIgnoredByRules(imports: StoredBankImport[], rules: ReadonlySet<string>): Set<string> {
    const ignored: Set<string> = new Set<string>();
    if (!rules.size) {
        return ignored;
    }
    for (const record of imports) {
        const ids: Map<string, string> = new Map(record.transactions.map(({ rowId, transactionId }: { rowId: string; transactionId: string; }): [string, string] => [rowId, transactionId]));
        for (const row of record.result.transactions) {
            const key: string | null = transactionIgnoreRuleKey(row);
            if (key && rules.has(key)) {
                ignored.add(ids.get(row.rowId)!);
            }
        }
    }
    return ignored;
}

export async function readTransactionIgnoreRules(directory: string): Promise<Set<string>> {
    try {
        const entries: Dirent<string>[] = await readdir(directory, { withFileTypes: true });
        return new Set(entries.filter((entry: Dirent<string>): boolean => entry.isFile() && /^[a-f0-9]{64}$/u.test(entry.name)).map((entry: Dirent<string>): string => entry.name));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return new Set();
        }
        throw error;
    }
}

export async function setTransactionIgnoreRule(directory: string, key: string, enabled: boolean): Promise<void> {
    const file: string = path.join(directory, key);
    if (enabled) {
        await mkdir(directory, { recursive: true });
        try {
            await writeFile(file, '', { flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
    } else {
        await rm(file, { force: true });
    }
}
