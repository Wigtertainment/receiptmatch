import type { BankImportInput, BankImportResult, ImportIssue, TransactionCandidate, UnresolvedDraft } from "../../src/shared/bank-import.js";
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { bankImportResultSchema, importIssue, sourceProvenance } from '../../src/shared/bank-import.js';
import {
    extractionProgressSchema,
    extractionResultSchema,
    PDF_EXTRACTION_VERSION,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';
import { storedBankImportSchema, type BankImportRunResult, type StoredBankImport } from '../../src/shared/workspace-import.js';
import type { WorkspaceSource } from '../../src/shared/workspace-documents.js';
import type { StatementProposalExtraction } from '../extraction/host.js';
import { parseBankStatement } from './registry.js';
import { readSourceSnapshot, SourceReadError as ImportFailure } from './source.js';

export interface BankImportOptions {
    existing: readonly StoredBankImport[];
    existingSources?: readonly WorkspaceSource[];
    signal?: AbortSignal;
    onProgress?: (progress: ExtractionProgress) => void;
}
export interface BankImportService {
    run(options: BankImportOptions): Promise<BankImportAttempt>;
}

type ProgressOptions = Pick<BankImportOptions, 'signal' | 'onProgress'>;
export type StatementFallbackResult = { status: 'proposed'; record: StoredBankImport } |
    { status: 'failed' | 'unavailable'; issues: ImportIssue[] } | { status: 'cancelled' };
export interface StatementFallback {
    filePath: string;
    run(options: ProgressOptions): Promise<StatementFallbackResult>;
}
export type BankImportAttempt = BankImportRunResult | { status: 'unsupported'; issues: ImportIssue[]; fallback: StatementFallback };
type ProposalAttempt = StatementProposalExtraction | { status: 'unavailable'; issues: ImportIssue[] };

interface ImportDependencies {
    choose(): Promise<string | null>;
    extract(bytes: Uint8Array, sourceId: string, options: ProgressOptions): Promise<ExtractionResult>;
    propose?: (bytes: Uint8Array, input: BankImportInput, options: ProgressOptions) => Promise<ProposalAttempt>;
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

function statementRecord(filePath: string, result: BankImportResult): StoredBankImport {
    return storedBankImportSchema.parse({
        id: randomUUID(), importedAt: new Date().toISOString(), filePath, result,
        accounts: result.accountSections.map((section: BankImportResult['accountSections'][number]): StoredBankImport['accounts'][number] => ({
            sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID()
        })),
        transactions: result.transactions.map((row: TransactionCandidate): StoredBankImport['transactions'][number] => ({ rowId: row.rowId, transactionId: randomUUID() })),
        drafts: result.unresolvedDrafts.map((row: UnresolvedDraft): StoredBankImport['drafts'][number] => ({ rowId: row.rowId, draftId: randomUUID() }))
    });
}

function progressCapture(options: ProgressOptions): { onProgress: (progress: ExtractionProgress) => void; finish: () => boolean } {
    let active: boolean = true, invalid: boolean = false;
    return {
        onProgress: (progress: ExtractionProgress): void => {
            if (!active || options.signal?.aborted) {
                return;
            }
            const checked: z.ZodSafeParseResult<ExtractionProgress> = extractionProgressSchema.safeParse(progress);
            if (checked.success) {
                options.onProgress?.(checked.data);
            } else {
                invalid = true;
            }
        },
        finish: (): boolean => {
            active = false;
            return !invalid;
        }
    };
}

async function runFallback(propose: NonNullable<ImportDependencies['propose']>, bytes: Uint8Array, input: BankImportInput, filePath: string,
    options: ProgressOptions): Promise<StatementFallbackResult> {
    const progress: ReturnType<typeof progressCapture> = progressCapture(options);
    try {
        cancelled(options.signal);
        const attempt: ProposalAttempt = await propose(bytes, input, { signal: options.signal, onProgress: progress.onProgress });
        cancelled(options.signal);
        if (!progress.finish()) {
            throw new ImportFailure('invalid-extraction', 'The local recognition engine returned invalid progress.');
        }
        if (attempt.status === 'cancelled') {
            return { status: 'cancelled' };
        }
        if (attempt.status !== 'proposed') {
            return { status: attempt.status, issues: attempt.issues };
        }
        const result: BankImportResult = bankImportResultSchema.parse(attempt.result);
        if (!result.localRecognition || result.adapter || !isDeepStrictEqual(result.sourceProvenance, sourceProvenance(input)) ||
            (result.status !== 'complete' && result.status !== 'partial')) {
            throw new ImportFailure('invalid-provenance', 'Local recognition did not match the selected statement and extraction execution.');
        }
        return { status: 'proposed', record: statementRecord(filePath, result) };
    } catch (error: unknown) {
        if (options.signal?.aborted) {
            return { status: 'cancelled' };
        }
        return { status: 'failed', issues: [error instanceof ImportFailure ? importIssue(error.code, error.message) :
            importIssue('local-recognition-failed', 'Local recognition could not propose bookings for this statement.')] };
    } finally {
        progress.finish();
    }
}

function finishImport(input: BankImportInput, bytes: Uint8Array, filePath: string, signal: AbortSignal | undefined, propose: ImportDependencies['propose']): BankImportAttempt {
    const parsed: BankImportResult = bankImportResultSchema.parse(parseBankStatement(input));
    cancelled(signal);
    if (parsed.status === 'unsupported' && parsed.issues[0]?.code === 'unsupported-bank' && propose) {
        return { status: 'unsupported', issues: parsed.issues, fallback: {
            filePath,
            run: (options: ProgressOptions): Promise<StatementFallbackResult> => runFallback(propose, bytes, input, filePath, options)
        } };
    }
    if (parsed.status === 'failed' || parsed.status === 'unsupported') {
        return { status: parsed.status, issues: parsed.issues };
    }
    const record: StoredBankImport = statementRecord(filePath, parsed);
    cancelled(signal);
    return { status: 'imported', record };
}

export class StatementImportService implements BankImportService {
    constructor(private readonly dependencies: ImportDependencies) {}

    async run(options: BankImportOptions): Promise<BankImportAttempt> {
        const progress: ReturnType<typeof progressCapture> = progressCapture(options);
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
            const raw: ExtractionResult = await this.dependencies.extract(bytes, sourceId, { signal: options.signal, onProgress: progress.onProgress });
            const validProgress: boolean = progress.finish();
            cancelled(options.signal);
            const extraction: z.ZodSafeParseResult<ExtractionResult> = extractionResultSchema.safeParse(raw);
            if (!extraction.success || !validProgress) {
                throw new ImportFailure('invalid-extraction', 'The local extraction engine returned an invalid result.');
            }
            const extracted: ExtractionResult = extraction.data;
            if (extracted.status === 'cancelled') {
                return { status: 'cancelled' };
            }
            if (extracted.status === 'failed') {
                return { status: 'failed', issues: extracted.issues };
            }
            checkProvenance(extracted.input, sourceId, sha256);
            return finishImport(extracted.input, bytes, selected, options.signal, this.dependencies.propose);
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
            progress.finish();
        }
    }
}
