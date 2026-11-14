import type { BankImportInput, BankImportResult, ImportIssue, PositionedSpan, SourceEvidence, TransactionCandidate, UnresolvedDraft } from "../src/shared/bank-import.js";
import type { SupportingDocument } from "../src/shared/supporting-document.js";
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { extractionResultSchema, PDF_EXTRACTION_VERSION, type ExtractionResult } from '../src/shared/pdf-extraction.js';
import type { OriginalPreviewData } from '../src/shared/original-preview.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { storedDocumentImportSchema, type StoredDocumentImport, type StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import { interpretSupportingDocument } from './documents/interpret.js';
import { parseBankStatement } from './import/registry.js';

export type ReplacementExtraction = (bytes: Uint8Array, sourceId: string, format: OriginalPreviewData['format']) => Promise<ExtractionResult>;
export type AnalyzedSource = { kind: 'statement'; record: StoredBankImport } |
    { kind: 'document'; record: StoredSupportingDocument; run: StoredDocumentImport };

export async function analyzeSource(
    kind: AnalyzedSource['kind'], filePath: string, format: OriginalPreviewData['format'], bytes: Uint8Array, extract: ReplacementExtraction,
): Promise<AnalyzedSource> {
    const sourceId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(), sha256: string = createHash('sha256').update(bytes).digest('hex');
    const extraction: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = extractionResultSchema.parse(await extract(bytes, sourceId, format));
    if (extraction.status === 'failed' || extraction.status === 'cancelled') {
        throw new Error('The selected file could not be analyzed.');
    }
    const { input }: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } = extraction;
    if (input.source.sourceId !== sourceId || input.source.sha256 !== sha256 || input.extraction.version !== PDF_EXTRACTION_VERSION ||
        (format !== 'pdf' && (input.pages.length !== 1 || input.pages[0].status !== 'complete' || input.pages[0].spans.some((span: PositionedSpan): boolean => span.method !== 'local-ocr')))) {
        throw new Error('The analysis did not match the selected file.');
    }
    const importedAt: string = new Date().toISOString();
    if (kind === 'statement') {
        const result: BankImportResult = parseBankStatement(input);
        if (result.status === 'failed' || result.status === 'unsupported' || !result.transactions.length) {
            throw new Error('The selected file did not produce a supported bank statement with readable bookings.');
        }
        return { kind, record: storedBankImportSchema.parse({ id: randomUUID(), importedAt, filePath, result,
            accounts: result.accountSections.map(({ sectionId }: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): { sectionId: string; accountId: `${string}-${string}-${string}-${string}-${string}`; statementId: `${string}-${string}-${string}-${string}-${string}`; } => ({ sectionId, accountId: randomUUID(), statementId: randomUUID() })),
            transactions: result.transactions.map(({ rowId }: TransactionCandidate): { rowId: string; transactionId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId, transactionId: randomUUID() })),
            drafts: result.unresolvedDrafts.map(({ rowId }: UnresolvedDraft): { rowId: string; draftId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId, draftId: randomUUID() })) }) };
    }
    const result: SupportingDocument = interpretSupportingDocument(input);
    if (result.status === 'failed') {
        throw new Error('The selected file did not produce a readable supporting document.');
    }
    const record: StoredSupportingDocument = { id: randomUUID(), importedAt, filePath, format, result };
    const run: StoredDocumentImport = storedDocumentImportSchema.parse({ id: randomUUID(), folderPath: path.dirname(filePath), startedAt: importedAt, finishedAt: importedAt,
        status: 'finished', files: [{ status: 'imported', record }], directoryIssues: [] });
    return { kind, record, run };
}
