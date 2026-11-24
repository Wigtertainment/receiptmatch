import { z } from 'zod';
import type { ImportPage, PositionedSpan } from '../../src/shared/bank-import.js';
import { NUEXTRACT_RECEIPT_VERSION } from '../../src/shared/receipt-ai.js';
import { hasManualDocumentFields, supportingDocumentSchema } from '../../src/shared/supporting-document.js';
import type { DocumentFileResult, StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';

export const receiptAnalysisVersionSchema: z.ZodObject<{
  documentId: z.ZodUUID; acceptedAt: z.ZodISODateTime; analysis: typeof supportingDocumentSchema;
}, z.core.$strict> = z.strictObject({ documentId: z.uuid(), acceptedAt: z.iso.datetime(), analysis: supportingDocumentSchema }).refine((version: { analysis: typeof supportingDocumentSchema._output }): boolean => !hasManualDocumentFields(version.analysis), 'Receipt analysis versions cannot contain manual correction markers.');
export type ReceiptAnalysisVersion = z.infer<typeof receiptAnalysisVersionSchema>;

const modelVersions: ReadonlySet<string> = new Set([
  'pdfjs-6.5.438+pp-ocrv6-medium-onnx+document-2',
  'pdfjs-6.5.438+paddleocr-vl-1.6-gguf-spotting+document-2',
  NUEXTRACT_RECEIPT_VERSION
]);

function collectOriginalAnalyses(imports: StoredDocumentImport[]): { originals: Map<string, StoredSupportingDocument>; runIds: Set<string> } {
  const originals: Map<string, StoredSupportingDocument> = new Map();
  const runIds: Set<string> = new Set();
  for (const report of imports) {
    for (const file of report.files) {
      if (file.status === 'imported') {
        originals.set(file.record.id, file.record);
        runIds.add(file.record.result.input!.extraction.runId.toLowerCase());
      } else if (file.status === 'failed' && file.analysis?.input) {
        runIds.add(file.analysis.input.extraction.runId.toLowerCase());
      }
    }
  }
  return { originals, runIds };
}

function latestAnalyses(imports: StoredDocumentImport[], versions: readonly ReceiptAnalysisVersion[]): Map<string, ReceiptAnalysisVersion['analysis']> {
  const { originals, runIds }: ReturnType<typeof collectOriginalAnalyses> = collectOriginalAnalyses(imports);
  const latest: Map<string, ReceiptAnalysisVersion['analysis']> = new Map();
  for (const { documentId, analysis } of versions) {
    const original: StoredSupportingDocument | undefined = originals.get(documentId);
    const input: ReceiptAnalysisVersion['analysis']['input'] = analysis.input;
    const source: NonNullable<ReceiptAnalysisVersion['analysis']['input']>['source'] | undefined = original?.result.input?.source;
    if (!source || !input || analysis.status === 'failed' || input.source.sourceId !== source.sourceId || input.source.sha256 !== source.sha256) {
      throw new Error('A receipt analysis version does not match its original document.');
    }
    const { runId, version }: NonNullable<ReceiptAnalysisVersion['analysis']['input']>['extraction'] = input.extraction;
    if (!z.uuid().safeParse(runId).success || runIds.has(runId.toLowerCase()) || !modelVersions.has(version) ||
      (original?.format !== 'pdf' && (input.pages.length !== 1 || input.pages[0].status !== 'complete')) ||
      (version !== NUEXTRACT_RECEIPT_VERSION && input.pages.some((page: ImportPage): boolean => page.spans.some((span: PositionedSpan): boolean => span.method !== 'local-ocr')))) {
      throw new Error('A receipt analysis version has invalid model provenance.');
    }
    runIds.add(runId.toLowerCase());
    latest.set(documentId, analysis);
  }
  return latest;
}

export function projectReceiptAnalyses(imports: StoredDocumentImport[], versions: readonly ReceiptAnalysisVersion[]): StoredDocumentImport[] {
  if (!versions.length) {
    return imports;
  }
  const latest: Map<string, ReceiptAnalysisVersion['analysis']> = latestAnalyses(imports, versions);
  return imports.map((report: StoredDocumentImport): StoredDocumentImport => {
    const files: DocumentFileResult[] = report.files.map((file: DocumentFileResult): DocumentFileResult => {
      const analysis: ReceiptAnalysisVersion['analysis'] | undefined = file.status === 'imported' ? latest.get(file.record.id) : undefined;
      return file.status === 'imported' && analysis ? { ...file, record: { ...file.record, result: analysis } } : file;
    });
    return files.some((file: DocumentFileResult, index: number): boolean => file !== report.files[index]) ? { ...report, files } : report;
  });
}
