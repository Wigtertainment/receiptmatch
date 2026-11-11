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
export function retainedBank(root: string) {
	const input = statement();
	input.source = { sourceId: randomUUID(), sha256: createHash("sha256").update(randomUUID()).digest("hex") };
	input.extraction.runId = randomUUID();
	const result = parseBankStatement(input);
	return storedBankImportSchema.parse({
		id: randomUUID(),
		importedAt: "2032-05-20T12:00:00.000Z",
		filePath: path.join(root, "bank.pdf"),
		result,
		accounts: result.accountSections.map((section) => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
		transactions: result.transactions.map((row) => ({ rowId: row.rowId, transactionId: randomUUID() })),
		drafts: result.unresolvedDrafts.map((row) => ({ rowId: row.rowId, draftId: randomUUID() })),
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
						(text, index) => ({ text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: format === "pdf" ? "embedded-text" : "local-ocr" }),
					),
				},
			],
		},
	};
}
export function retainedDocument(root: string, name = "synthetic.pdf", content = name): StoredSupportingDocument {
	const extracted = extractedDocument(Buffer.from(content), randomUUID());
	return { id: randomUUID(), importedAt: "2032-05-20T12:00:00.000Z", filePath: path.join(root, name), format: "pdf", result: interpretSupportingDocument(extracted.input) };
}
export function documentRun(root: string, records = [retainedDocument(root)]) {
	return storedDocumentImportSchema.parse({
		id: randomUUID(),
		folderPath: root,
		startedAt: "2032-05-20T11:00:00.000Z",
		finishedAt: "2032-05-20T13:00:00.000Z",
		status: "finished",
		files: records.map((record) => ({ status: "imported", record })),
		directoryIssues: [],
	});
}
