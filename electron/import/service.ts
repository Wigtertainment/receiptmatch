import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bankImportResultSchema, importIssue } from '../../src/shared/bank-import.js';
import {
    extractionProgressSchema,
    extractionResultSchema,
    PDF_EXTRACTION_LIMITS,
    PDF_EXTRACTION_VERSION,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';
import { storedBankImportSchema, type BankImportRunResult, type StoredBankImport } from '../../src/shared/workspace-import.js';
import { parseBankStatement } from './registry.js';

export interface BankImportOptions {
    existing: readonly StoredBankImport[];
    signal?: AbortSignal;
    onProgress?: (progress: ExtractionProgress) => void;
}
export interface BankImportService {
    run(options: BankImportOptions): Promise<BankImportRunResult>;
}
interface ImportDependencies {
    choose(): Promise<string | null>;
    extract(bytes: Uint8Array, sourceId: string, options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void }): Promise<ExtractionResult>;
}
class ImportFailure extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}
function cancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw new ImportFailure('cancelled', 'Statement import was cancelled.');
}
function sameRevision(left: BigIntStats, right: BigIntStats) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function snapshot(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf' || filePath.length > 32768 || filePath.includes('\0')) {
        throw new ImportFailure('invalid-source', 'Choose an absolute local PDF file using the statement dialog.');
    }
    cancelled(signal);
    const selected = await lstat(filePath, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink()) throw new ImportFailure('invalid-source', 'Choose a regular PDF file rather than a directory or linked file.');
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || !sameRevision(selected, before)) throw new ImportFailure('source-changed', 'The selected PDF changed before it could be read. Choose it again.');
        if (before.size < 1n || before.size > BigInt(PDF_EXTRACTION_LIMITS.bytes))
            throw new ImportFailure('source-limit', 'The selected PDF is empty or exceeds the local extraction byte limit.');
        const bytes = Buffer.alloc(Number(before.size));
        let position = 0;
        while (position < bytes.length) {
            cancelled(signal);
            const { bytesRead } = await file.read(bytes, position, Math.min(65536, bytes.length - position), position);
            if (!bytesRead) throw new ImportFailure('source-changed', 'The selected PDF changed while it was being read. Choose it again.');
            position += bytesRead;
        }
        cancelled(signal);
        const extra = await file.read(Buffer.alloc(1), 0, 1, position);
        const after = await file.stat({ bigint: true });
        const currentPath = await lstat(filePath, { bigint: true });
        if (extra.bytesRead || !currentPath.isFile() || currentPath.isSymbolicLink() || !sameRevision(before, after) || !sameRevision(before, currentPath)) {
            throw new ImportFailure('source-changed', 'The selected PDF changed while it was being read. Choose it again.');
        }
        cancelled(signal);
        return bytes;
    } finally {
        await file.close();
    }
}

export class StatementImportService implements BankImportService {
    constructor(private readonly dependencies: ImportDependencies) {}

    async run(options: BankImportOptions): Promise<BankImportRunResult> {
        let acceptingProgress = true;
        let invalidProgress = false;
        try {
            cancelled(options.signal);
            const selected = await this.dependencies.choose();
            cancelled(options.signal);
            if (selected === null) return { status: 'cancelled' };
            const bytes = await snapshot(selected, options.signal);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            cancelled(options.signal);
            const duplicate = options.existing.find((record) => record.result.sourceProvenance?.sha256 === sha256);
            if (duplicate) return { status: 'skipped', importId: duplicate.id };
            const sourceId = randomUUID();
            const raw = await this.dependencies.extract(bytes, sourceId, {
                signal: options.signal,
                onProgress: (progress) => {
                    if (!acceptingProgress || options.signal?.aborted) return;
                    const checked = extractionProgressSchema.safeParse(progress);
                    if (!checked.success) {
                        invalidProgress = true;
                        return;
                    }
                    options.onProgress?.(checked.data);
                }
            });
            acceptingProgress = false;
            cancelled(options.signal);
            const extraction = extractionResultSchema.safeParse(raw);
            if (!extraction.success || invalidProgress) throw new ImportFailure('invalid-extraction', 'The local extraction engine returned an invalid result.');
            const extracted = extraction.data;
            if (extracted.status === 'cancelled') return { status: 'cancelled' };
            if (extracted.status === 'failed') return { status: 'failed', issues: extracted.issues };
            if (
                extracted.input.source.sourceId !== sourceId ||
                extracted.input.source.sha256 !== sha256 ||
                !z.uuid().safeParse(extracted.input.extraction.runId).success ||
                extracted.input.extraction.version !== PDF_EXTRACTION_VERSION
            ) {
                throw new ImportFailure('invalid-provenance', 'The extracted statement does not match the selected PDF and extraction execution.');
            }
            const parsed = bankImportResultSchema.parse(parseBankStatement(extracted.input));
            cancelled(options.signal);
            if (parsed.status === 'failed' || parsed.status === 'unsupported') return { status: parsed.status, issues: parsed.issues };
            const record = storedBankImportSchema.parse({
                id: randomUUID(),
                importedAt: new Date().toISOString(),
                filePath: selected,
                result: parsed,
                accounts: parsed.accountSections.map((section) => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
                transactions: parsed.transactions.map((row) => ({ rowId: row.rowId, transactionId: randomUUID() })),
                drafts: parsed.unresolvedDrafts.map((row) => ({ rowId: row.rowId, draftId: randomUUID() }))
            });
            cancelled(options.signal);
            return { status: 'imported', record };
        } catch (error) {
            if (options.signal?.aborted || (error instanceof ImportFailure && error.code === 'cancelled')) return { status: 'cancelled' };
            return {
                status: 'failed',
                issues: [
                    importIssue(
                        error instanceof ImportFailure ? error.code : 'import-failed',
                        error instanceof ImportFailure ? error.message : 'The selected statement could not be read or imported.'
                    )
                ]
            };
        } finally {
            acceptingProgress = false;
        }
    }
}
