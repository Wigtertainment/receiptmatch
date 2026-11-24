import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { bankImportResultSchema, sourceProvenance, type BankImportInput, type BankImportResult } from '../../src/shared/bank-import.js';
import { extractionProgressSchema, extractionResultSchema, PDF_EXTRACTION_VERSION, type ExtractionProgress, type ExtractionResult } from '../../src/shared/pdf-extraction.js';
import type { StatementAiResult } from '../../src/shared/statement-ai.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import type { ExtractionOptions } from '../extraction/host.js';
import type { StatementProposalExtraction } from './nuextract-statement.js';
import { assertSourceNotCancelled, readSourceSnapshot, SourceReadError } from './source.js';

export interface StatementAiSource { filePath: string; original: StoredBankImport }
export interface StatementAiService { analyze(source: StatementAiSource, options?: ExtractionOptions): Promise<StatementAiResult> }
export interface StatementReanalysisDependencies {
    extract(bytes: Uint8Array, sourceId: string, options: ExtractionOptions): Promise<ExtractionResult>;
    propose(bytes: Uint8Array, input: BankImportInput, options: ExtractionOptions): Promise<StatementProposalExtraction>;
}

async function originalBytes(filePath: string, sha256: string, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes: Uint8Array = await readSourceSnapshot(filePath, ['.pdf'], signal);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        throw new SourceReadError('source-changed', 'The original statement changed. Restore or relink the original PDF before analyzing it again.');
    }
    return bytes;
}

function checkExtraction(input: BankImportInput, original: StoredBankImport): void {
    const provenance: NonNullable<BankImportResult['sourceProvenance']> = original.result.sourceProvenance!;
    if (input.source.sourceId !== provenance.sourceId || input.source.sha256 !== provenance.sha256 || !z.uuid().safeParse(input.extraction.runId).success ||
        input.extraction.version !== PDF_EXTRACTION_VERSION || !isDeepStrictEqual(sourceProvenance(input).pages, provenance.pages)) {
        throw new SourceReadError('invalid-provenance', 'The extracted statement does not match the original PDF and its pages.');
    }
}

function checkedProposal(attempt: StatementProposalExtraction, input: BankImportInput): StatementAiResult {
    if (attempt.status === 'cancelled') {
        return { status: 'cancelled' };
    }
    if (attempt.status !== 'proposed') {
        return { status: attempt.status, error: attempt.issues[0]?.message ?? 'Local recognition could not analyze this statement.' };
    }
    const result: BankImportResult = bankImportResultSchema.parse(attempt.result);
    if (result.adapter || result.localRecognition?.model !== 'nuextract3' || !['complete', 'partial'].includes(result.status) ||
        !isDeepStrictEqual(result.sourceProvenance, sourceProvenance(input))) {
        throw new SourceReadError('invalid-provenance', 'Local recognition did not match the original statement and extraction execution.');
    }
    return { status: 'ready', model: 'nuextract3', result };
}

export class StatementReanalysisService implements StatementAiService {
    constructor(private readonly dependencies: StatementReanalysisDependencies) {}

    async analyze(source: StatementAiSource, options: ExtractionOptions = {}): Promise<StatementAiResult> {
        let active: boolean = true, invalidProgress: boolean = false;
        const progress: ExtractionOptions = { ...options, onProgress: (value: ExtractionProgress): void => {
            if (!active || options.signal?.aborted) {
                return;
            }
            const checked: z.ZodSafeParseResult<ExtractionProgress> = extractionProgressSchema.safeParse(value);
            if (checked.success) {
                options.onProgress?.(checked.data);
            } else {
                invalidProgress = true;
            }
        } };
        try {
            assertSourceNotCancelled(options.signal);
            const original: StoredBankImport = storedBankImportSchema.parse(source.original);
            const filePath: string = source.filePath;
            const provenance: NonNullable<BankImportResult['sourceProvenance']> = original.result.sourceProvenance!;
            const bytes: Uint8Array = await originalBytes(filePath, provenance.sha256, options.signal);
            const extracted: ExtractionResult = extractionResultSchema.parse(await this.dependencies.extract(bytes, provenance.sourceId, progress));
            assertSourceNotCancelled(options.signal);
            if (extracted.status === 'cancelled') {
                return { status: 'cancelled' };
            }
            if (extracted.status === 'failed') {
                return { status: 'failed', error: extracted.issues[0].message };
            }
            checkExtraction(extracted.input, original);
            const attempt: StatementProposalExtraction = await this.dependencies.propose(bytes, extracted.input, progress);
            assertSourceNotCancelled(options.signal);
            if (invalidProgress) {
                throw new SourceReadError('invalid-extraction', 'The local recognition engine returned invalid progress.');
            }
            const result: StatementAiResult = checkedProposal(attempt, extracted.input);
            await originalBytes(filePath, provenance.sha256, options.signal);
            return result;
        } catch (error: unknown) {
            return options.signal?.aborted || (error instanceof SourceReadError && error.code === 'cancelled') ? { status: 'cancelled' } :
                { status: 'failed', error: error instanceof SourceReadError ? error.message : 'The original statement could not be reanalyzed locally.' };
        } finally {
            active = false;
        }
    }
}
