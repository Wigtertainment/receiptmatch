import type { BankImportResult, PositionedSpan, TransactionCandidate, UnresolvedDraft } from "../src/shared/bank-import.js";
import type { SupportingDocument } from "../src/shared/supporting-document.js";
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { extractionResultSchema, PDF_EXTRACTION_VERSION, type ExtractionResult } from '../src/shared/pdf-extraction.js';
import type { IOriginalPreviewData } from '../src/shared/original-preview.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { storedDocumentImportSchema, type StoredDocumentImport, type StoredSupportingDocument } from '../src/shared/workspace-documents.js';
import { interpretSupportingDocument } from './documents/interpret.js';
import { parseBankStatement } from './import/registry.js';

export type ReplacementExtraction = (bytes: Uint8Array, sourceId: string, format: IOriginalPreviewData['format']) => Promise<ExtractionResult>;
interface IAnalyzedStatement { kind: 'statement'; record: StoredBankImport }
interface IAnalyzedDocument { kind: 'document'; record: StoredSupportingDocument; run: StoredDocumentImport }
export type AnalyzedSource = IAnalyzedStatement | IAnalyzedDocument;

type AccountSection = BankImportResult['accountSections'][number];
type GeneratedId = ReturnType<typeof randomUUID>;
interface IGeneratedAccountIds { sectionId: string; accountId: GeneratedId; statementId: GeneratedId }
interface IGeneratedTransactionId { rowId: string; transactionId: GeneratedId }
interface IGeneratedDraftId { rowId: string; draftId: GeneratedId }

export async function analyzeSource(
    kind: AnalyzedSource['kind'], filePath: string, format: IOriginalPreviewData['format'], bytes: Uint8Array, extract: ReplacementExtraction,
): Promise<AnalyzedSource> {
    const sourceId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(), sha256: string = createHash('sha256').update(bytes).digest('hex');
    const extraction: ExtractionResult = extractionResultSchema.parse(await extract(bytes, sourceId, format));
    if (extraction.status === 'failed' || extraction.status === 'cancelled') {
        throw new Error('The selected file could not be analyzed.');
    }
    const { input }: Extract<ExtractionResult, Record<'status', 'complete' | 'partial'>> = extraction;
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
            accounts: result.accountSections.map(({ sectionId }: AccountSection): IGeneratedAccountIds => ({ sectionId, accountId: randomUUID(), statementId: randomUUID() })),
            transactions: result.transactions.map(({ rowId }: TransactionCandidate): IGeneratedTransactionId => ({ rowId, transactionId: randomUUID() })),
            drafts: result.unresolvedDrafts.map(({ rowId }: UnresolvedDraft): IGeneratedDraftId => ({ rowId, draftId: randomUUID() })) }) };
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
