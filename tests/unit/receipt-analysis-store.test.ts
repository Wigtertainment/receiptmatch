import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'vitest';
import type { BankImportInput } from '../../src/shared/bank-import.js';
import { documentCorrectionKey, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import { NUEXTRACT_RECEIPT_VERSION } from '../../src/shared/receipt-ai.js';
import type { DocumentSection } from '../../src/shared/supporting-document.js';
import type { DocumentFileResult, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import type { TransactionMatch } from '../../src/shared/workspace-matching.js';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { projectReceiptAnalyses, type ReceiptAnalysisVersion } from '../../electron/documents/analysis-history.js';
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

function newAnalysis(record: StoredSupportingDocument, amount: string, version: string = NUEXTRACT_RECEIPT_VERSION): ReceiptAnalysisVersion {
  const input: BankImportInput = structuredClone(record.result.input!);
  input.extraction = { runId: randomUUID(), version };
  for (const span of input.pages[0].spans) {
    if (version !== NUEXTRACT_RECEIPT_VERSION) {
      span.method = 'local-ocr';
    }
    span.text = span.text.replace('9007199254740993.27', amount).replace('2032-05-20', '2032-02-28');
  }
  return { documentId: record.id, acceptedAt: '2032-05-21T00:00:00.000Z', analysis: interpretSupportingDocument(input) };
}

function saveHistory(current: SavedWorkspace, versions: ReceiptAnalysisVersion[]): Promise<SavedWorkspace> {
  return saveWorkspace(current, current.metadata, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, versions);
}

function candidatesFor(saved: SavedWorkspace, documentId: string): boolean {
  return saved.matches.some((match: TransactionMatch): boolean => match.candidates.some((candidate: TransactionMatch['candidates'][number]): boolean => candidate.documentId === documentId));
}

test('migrates version 12 and reopens historical OCR and NuExtract analyses under the same matching and source identities', async (): Promise<void> => {
  const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-analysis-store-'));
  try {
    const file: string = path.join(root, 'history.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    await createWorkspace(file, newMetadata(), [retainedBank(root)], [documentRun(root, [document])]);
    const oldDatabase: Database.Database = new Database(file);
    try {
      oldDatabase.exec('DROP TABLE receipt_analysis_versions; PRAGMA user_version=12;');
    } finally {
      oldDatabase.close();
    }
    const previous: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(previous.receiptAnalysisVersions, []);
    assert.equal(candidatesFor(previous, document.id), false);
    const paddleVl: ReceiptAnalysisVersion = newAnalysis(document, '1,234.56', 'pdfjs-6.5.438+paddleocr-vl-1.6-gguf-spotting+document-2');
    const updated: SavedWorkspace = await saveHistory(previous, [paddleVl]);
    assert.equal(updated.schemaVersion, SCHEMA_VERSION);
    assert.equal(candidatesFor(updated, document.id), true);
    const reopened: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(reopened.documentImports, previous.documentImports);
    assert.deepEqual(reopened.sources, previous.sources);
    assert.deepEqual(reopened.receiptAnalysisVersions, [paddleVl]);
    assert.deepEqual(reopened.matches, updated.matches);
    const paddleMedium: ReceiptAnalysisVersion = newAnalysis(document, '599.99', 'pdfjs-6.5.438+pp-ocrv6-medium-onnx+document-2');
    const nuExtract: ReceiptAnalysisVersion = newAnalysis(document, '499.99');
    await saveHistory(reopened, [paddleVl, paddleMedium, nuExtract]);
    const latest: SavedWorkspace = await loadWorkspace(file);
    const projected: DocumentFileResult = projectReceiptAnalyses(latest.documentImports, latest.receiptAnalysisVersions)[0].files[0];
    assert.ok(projected.status === 'imported');
    assert.equal(projected.record.id, document.id);
    assert.deepEqual(projected.record.result, nuExtract.analysis);
    assert.deepEqual(latest.receiptAnalysisVersions, [paddleVl, paddleMedium, nuExtract]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid receipt provenance and prevents changes to saved earlier versions', async (): Promise<void> => {
  const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-analysis-store-'));
  try {
    const file: string = path.join(root, 'history.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    const first: ReceiptAnalysisVersion = newAnalysis(document, '1,234.56');
    const wrongHash: ReceiptAnalysisVersion = newAnalysis(document, '499.99');
    wrongHash.analysis.input!.source.sha256 = 'f'.repeat(64);
    const wrongModel: ReceiptAnalysisVersion = newAnalysis(document, '499.99');
    wrongModel.analysis.input!.extraction.version = 'unrecognized';
    const reused: ReceiptAnalysisVersion = newAnalysis(document, '499.99');
    reused.analysis.input!.extraction.runId = document.result.input!.extraction.runId;
    const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [], [documentRun(root, [document])]);
    await assert.rejects(saveHistory(saved, [wrongHash]), /original document/);
    await assert.rejects(saveHistory(saved, [wrongModel]), /invalid model provenance/);
    await assert.rejects(saveHistory(saved, [reused]), /invalid model provenance/);
    const updated: SavedWorkspace = await saveHistory(saved, [first]);
    await assert.rejects(saveHistory(updated, []), /cannot be removed/);
    await assert.rejects(saveHistory(updated, [{ ...first, acceptedAt: '2032-05-22T00:00:00.000Z' }]), /cannot be removed/);
    const db: Database.Database = new Database(file);
    try {
      db.prepare('UPDATE receipt_analysis_versions SET record_json=?').run(JSON.stringify({ ...first, documentId: randomUUID() }));
    } finally {
      db.close();
    }
    await assert.rejects(loadWorkspace(file), /do not agree with their original documents/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies saved manual corrections to projected model fields while retaining their raw recognition evidence', async (): Promise<void> => {
  const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-analysis-store-'));
  try {
    const file: string = path.join(root, 'corrected-history.receiptmatch');
    const document: StoredSupportingDocument = retainedDocument(root);
    const revision: ReceiptAnalysisVersion = newAnalysis(document, '499.99');
    const section: DocumentSection = revision.analysis.sections[0];
    const amount: DocumentSection['amounts'][number] | undefined = section.amounts.find((item: DocumentSection['amounts'][number]): boolean => item.role === 'billed-total');
    assert.ok(amount);
    amount.id = 'model-only-field';
    const edit: DocumentCorrection = { documentId: document.id, sectionId: section.sectionId, fieldId: amount.id, revision: 2,
      change: { kind: 'amount', value: { coefficient: '123456', scale: 2, currency: 'EUR' } } };
    const corrections: Map<string, DocumentCorrection> = new Map([[documentCorrectionKey(edit, edit.change.kind), edit]]);
    const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [retainedBank(root)], [documentRun(root, [document])], undefined, undefined,
      corrections, undefined, undefined, undefined, undefined, undefined, undefined, [revision]);
    assert.equal(candidatesFor(saved, document.id), true);
    const loaded: SavedWorkspace = await loadWorkspace(file);
    assert.deepEqual(loaded.documentCorrections, corrections);
    assert.deepEqual(loaded.receiptAnalysisVersions, [revision]);
    assert.equal(candidatesFor(loaded, document.id), true);
    assert.deepEqual(loaded.documentImports, saved.documentImports);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
