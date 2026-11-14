import type { BankImportInput, BankImportResult, ImportIssue, SourceEvidence, TransactionCandidate, UnresolvedDraft } from "../../src/shared/bank-import.js";
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bankImportResultSchema, importIssue } from '../../src/shared/bank-import.js';
import {
    extractionProgressSchema,
    extractionResultSchema,
    PDF_EXTRACTION_VERSION,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';
import { storedBankImportSchema, type BankImportRunResult, type StoredBankImport } from '../../src/shared/workspace-import.js';
import type { WorkspaceSource } from '../../src/shared/workspace-documents.js';
import { parseBankStatement } from './registry.js';
import { readSourceSnapshot, SourceReadError as ImportFailure } from './source.js';

export interface BankImportOptions {
    existing: readonly StoredBankImport[];
    existingSources?: readonly WorkspaceSource[];
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
function cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new ImportFailure('cancelled', 'Statement import was cancelled.');
    }
}

function checkProvenance(input: BankImportInput, sourceId: string, sha256: string): void {
    if (
        input.source.sourceId !== sourceId ||
        input.source.sha256 !== sha256 ||
        !z.uuid().safeParse(input.extraction.runId).success ||
        input.extraction.version !== PDF_EXTRACTION_VERSION
    ) {
        throw new ImportFailure('invalid-provenance', 'The extracted statement does not match the selected PDF and extraction execution.');
    }
}

export class StatementImportService implements BankImportService {
    constructor(private readonly dependencies: ImportDependencies) {}

    async run(options: BankImportOptions): Promise<BankImportRunResult> {
        let acceptingProgress: boolean = true;
        let invalidProgress: boolean = false;
        try {
            cancelled(options.signal);
            const selected: string | null = await this.dependencies.choose();
            cancelled(options.signal);
            if (selected === null) {
                return { status: 'cancelled' };
            }
            const bytes: Uint8Array<ArrayBufferLike> = await readSourceSnapshot(selected, ['.pdf'], options.signal);
            const sha256: string = createHash('sha256').update(bytes).digest('hex');
            cancelled(options.signal);
            const duplicate: StoredBankImport | undefined = options.existing.find((record: StoredBankImport): boolean => record.result.sourceProvenance?.sha256 === sha256);
            if (duplicate) {
                return { status: 'skipped', importId: duplicate.id };
            }
            const existingSource: WorkspaceSource | undefined = options.existingSources?.find((source: WorkspaceSource): boolean => source.sha256 === sha256);
            if (existingSource) {
                return { status: 'skipped', importId: null, existingSourceId: existingSource.id };
            }
            const sourceId: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
            const raw: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = await this.dependencies.extract(bytes, sourceId, {
                signal: options.signal,
                onProgress: (progress: ExtractionProgress): void => {
                    if (!acceptingProgress || options.signal?.aborted) {
                        return;
                    }
                    const checked: z.ZodSafeParseResult<ExtractionProgress> = extractionProgressSchema.safeParse(progress);
                    if (!checked.success) {
                        invalidProgress = true;
                        return;
                    }
                    options.onProgress?.(checked.data);
                }
            });
            acceptingProgress = false;
            cancelled(options.signal);
            const extraction: z.ZodSafeParseResult<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> = extractionResultSchema.safeParse(raw);
            if (!extraction.success || invalidProgress) {
                throw new ImportFailure('invalid-extraction', 'The local extraction engine returned an invalid result.');
            }
            const extracted: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = extraction.data;
            if (extracted.status === 'cancelled') {
                return { status: 'cancelled' };
            }
            if (extracted.status === 'failed') {
                return { status: 'failed', issues: extracted.issues };
            }
            checkProvenance(extracted.input, sourceId, sha256);
            const parsed: BankImportResult = bankImportResultSchema.parse(parseBankStatement(extracted.input));
            cancelled(options.signal);
            if (parsed.status === 'failed' || parsed.status === 'unsupported') {
                return { status: parsed.status, issues: parsed.issues };
            }
            const record: StoredBankImport = storedBankImportSchema.parse({
                id: randomUUID(),
                importedAt: new Date().toISOString(),
                filePath: selected,
                result: parsed,
                accounts: parsed.accountSections.map((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): { sectionId: string; accountId: `${string}-${string}-${string}-${string}-${string}`; statementId: `${string}-${string}-${string}-${string}-${string}`; } => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
                transactions: parsed.transactions.map((row: TransactionCandidate): { rowId: string; transactionId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: row.rowId, transactionId: randomUUID() })),
                drafts: parsed.unresolvedDrafts.map((row: UnresolvedDraft): { rowId: string; draftId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: row.rowId, draftId: randomUUID() }))
            });
            cancelled(options.signal);
            return { status: 'imported', record };
        } catch (error: unknown) {
            if (options.signal?.aborted || (error instanceof ImportFailure && error.code === 'cancelled')) {
                return { status: 'cancelled' };
            }
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
