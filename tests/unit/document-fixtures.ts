import type { BankImportInput, BankImportResult, PositionedSpan, SourceEvidence, TransactionCandidate, UnresolvedDraft } from "../../src/shared/bank-import.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredDocumentImport } from "../../src/shared/workspace-documents.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtractionResult } from "../../src/shared/pdf-extraction.js";
import { PDF_EXTRACTION_VERSION } from "../../src/shared/pdf-extraction.js";
import { interpretSupportingDocument } from "../../electron/documents/interpret.js";
import { storedDocumentImportSchema, type DocumentFormat, type StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import { storedBankImportSchema } from "../../src/shared/workspace-import.js";
import { parseBankStatement } from "../../electron/import/registry.js";
import { statement } from "./bank-fixtures.js";

// Independently invented data; no private document values or source names.
export function retainedBank(root: string, input: BankImportInput = statement()): StoredBankImport {
	input.source = { sourceId: randomUUID(), sha256: createHash("sha256").update(randomUUID()).digest("hex") };
	input.extraction.runId = randomUUID();
	const result: BankImportResult = parseBankStatement(input);
	return storedBankImportSchema.parse({
		id: randomUUID(),
		importedAt: "2032-05-20T12:00:00.000Z",
		filePath: path.join(root, "bank.pdf"),
		result,
		accounts: result.accountSections.map((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): { sectionId: string; accountId: `${string}-${string}-${string}-${string}-${string}`; statementId: `${string}-${string}-${string}-${string}-${string}`; } => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
		transactions: result.transactions.map((row: TransactionCandidate): { rowId: string; transactionId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: row.rowId, transactionId: randomUUID() })),
		drafts: result.unresolvedDrafts.map((row: UnresolvedDraft): { rowId: string; draftId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: row.rowId, draftId: randomUUID() })),
	});
}

export function extractedDocument(bytes: Uint8Array, sourceId: string, format: DocumentFormat = "pdf"): ExtractionResult & { status: "complete" } {
	return {
		status: "complete",
		input: {
			source: { sourceId, sha256: createHash("sha256").update(bytes).digest("hex") },
			extraction: { runId: randomUUID(), version: PDF_EXTRACTION_VERSION },
			issues: [],
			pages: [
				{
					pageId: "page-1",
					pageNumber: 1,
					width: 600,
					height: 800,
					status: "complete",
					spans: ["Invoice", "Merchant: Cedar Workshop", "Invoice Number: SYNTHETIC-ONLY", "Invoice Date: 2032-05-20", "Invoice Total: EUR 9007199254740993.27"].map(
						(text: string, index: number): PositionedSpan => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: format === "pdf" ? "embedded-text" : "local-ocr" }),
					),
				},
			],
		},
	};
}

export function retainedDocument(root: string, name: string = "synthetic.pdf", content: string = name): StoredSupportingDocument {
	const extracted: ReturnType<typeof extractedDocument> = extractedDocument(Buffer.from(content), randomUUID());
	return { id: randomUUID(), importedAt: "2032-05-20T12:00:00.000Z", filePath: path.join(root, name), format: "pdf", result: interpretSupportingDocument(extracted.input) };
}

export function documentRun(root: string, records: StoredSupportingDocument[] = [retainedDocument(root)]): StoredDocumentImport {
	return storedDocumentImportSchema.parse({
		id: randomUUID(),
		folderPath: root,
		startedAt: "2032-05-20T11:00:00.000Z",
		finishedAt: "2032-05-20T13:00:00.000Z",
		status: "finished",
		files: records.map((record: StoredSupportingDocument): { status: string; record: StoredSupportingDocument; } => ({ status: "imported", record })),
		directoryIssues: [],
	});
}
