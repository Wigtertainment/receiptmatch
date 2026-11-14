import type { StoredDocumentImport, StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, ImportIssue } from "../../src/shared/bank-import.js";
import type { SupportingDocument } from "../../src/shared/supporting-document.js";
import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { createWorkspace, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from "../../electron/store.js";
import { importIssue } from "../../src/shared/bank-import.js";
import { storedDocumentImportSchema } from "../../src/shared/workspace-documents.js";
import { documentRun, extractedDocument, retainedDocument, retainedBank } from "./document-fixtures.js";

async function directory(): Promise<string> {
	await mkdir("artifacts", { recursive: true });
	return mkdtemp(path.resolve("artifacts/doc-store-"));
}

function rows(file: string): Record<string, unknown[]> {
	const db: Database.Database = new Database(file, { readonly: true });
	try {
		return Object.fromEntries(
			["sources", "accounts", "statements", "transactions", "documents", "associations"].map((table: string): [string, unknown[]] => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
		);
	} finally {
		db.close();
	}
}

test("document runs preserve exact fields, complete source evidence, failures and skipped aliases through explicit saves", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "workspace.receiptmatch");
	const document: StoredSupportingDocument = retainedDocument(root);
	await writeFile(document.filePath, "synthetic.pdf");
	const original: NonSharedBuffer = await readFile(document.filePath);
	const run: StoredDocumentImport = documentRun(root, [document]);
	run.files.push({
		status: "skipped",
		filePath: path.join(root, "duplicate.pdf"),
		sha256: document.result.input!.source.sha256,
		existingSourceId: document.result.input!.source.sourceId,
	});
	run.files.push({
		status: "failed",
		filePath: path.join(root, "broken.png"),
		format: "png",
		sha256: "f".repeat(64),
		issues: [importIssue("image-invalid", "Synthetic image failure.")],
		analysis: null,
	});
	run.files.push({ status: "unsupported", filePath: path.join(root, "notes.txt"), issues: [importIssue("unsupported-format", "Unsupported fixture.")] });
	const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [], [run]);
	const loaded: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(loaded.documentImports, [run]);
	const retained: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = loaded.documentImports[0].files[0];
	assert.equal(retained.status, "imported");
	if (retained.status === "imported") {
		assert.equal(retained.record.result.sections[0].amounts[0].candidates[0].coefficient, "900719925474099327");
	}
	assert.equal(loaded.sources.length, 1);
	assert.equal(loaded.sources[0].sha256, document.result.input!.source.sha256);
	assert.equal(rows(file).documents.length, 1);
	assert.equal(rows(file).sources.length, 1);
	const renamed: SavedWorkspace = await saveWorkspace(loaded, { ...loaded.metadata, name: "Saved document report" });
	assert.deepEqual(renamed.documentImports, [run]);
	assert.deepEqual((await loadWorkspace(file)).documentImports, [run]);
	assert.deepEqual(await readFile(document.filePath), original);
});

for (const version of [1, 2]) {
		test(`version ${version} opens read-only and migrates atomically without changing legacy manual associations`, async (): Promise<void> => {
		const root: string = await directory(),
			file: string = path.join(root, "legacy.receiptmatch");
		await createWorkspace(file, newMetadata());
		const db: Database.Database = new Database(file);
		db.exec(`DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews;
			DROP TABLE match_results; DROP TABLE document_imports; ${version === 1 ? "DROP TABLE bank_imports;" : ""} PRAGMA user_version=${version};`);
		db.prepare("INSERT INTO sources VALUES(?,?,?)").run("legacy-source", path.join(root, "legacy.pdf"), "a".repeat(64));
		db.prepare("INSERT INTO sources VALUES(?,?,?)").run("legacy-duplicate-hash", path.join(root, "legacy-copy.pdf"), "a".repeat(64));
		db.prepare("INSERT INTO sources VALUES(?,?,?)").run("legacy-null-hash", path.join(root, "legacy-unknown.pdf"), null);
		db.exec(
			"INSERT INTO accounts VALUES('legacy-account','Manual account','EUR'); INSERT INTO statements VALUES('legacy-statement','legacy-account','legacy-source'); INSERT INTO transactions VALUES('legacy-transaction','legacy-statement','-5000','EUR',2,4); INSERT INTO documents VALUES('legacy-document','legacy-source',3); INSERT INTO associations VALUES('legacy-association','legacy-transaction','legacy-document','reliable',5,'4:5:3');",
		);
		db.close();
		const before: NonSharedBuffer = await readFile(file),
			legacyRows: Record<string, unknown[]> = rows(file);
		const opened: SavedWorkspace = await loadWorkspace(file);
		assert.equal(opened.schemaVersion, version);
		assert.deepEqual(opened.documentImports, []);
		assert.equal(opened.sources.length, 3);
		assert.deepEqual(await readFile(file), before);
		const run: StoredDocumentImport = documentRun(root, []);
		run.files.push({ status: "skipped", filePath: path.join(root, "alias.pdf"), sha256: "a".repeat(64), existingSourceId: "legacy-source" });
		const saved: SavedWorkspace = await saveWorkspace(opened, opened.metadata, [], [run]);
		assert.equal(saved.schemaVersion, SCHEMA_VERSION);
		assert.deepEqual(rows(file), legacyRows);
		assert.deepEqual((await loadWorkspace(file)).documentImports, [run]);
	});
	}

test("failed interpretation retains raw extraction and its identity but permits retrying the same content", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "retry.receiptmatch");
	const extracted: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(Buffer.from("retry-content"), randomUUID());
	const analysis: { contractVersion: "1"; parserVersion: "1"; status: "failed"; input: BankImportInput; sections: never[]; issues: { code: string; severity: "warning"; message: string; sectionId: null; fieldId: null; field: null; evidence: never[]; }[]; } = {
		contractVersion: "1" as const,
		parserVersion: "1" as const,
		status: "failed" as const,
		input: extracted.input,
		sections: [],
		issues: [
			{ code: "interpretation-limit", severity: "warning" as const, message: "Synthetic interpretation failure.", sectionId: null, fieldId: null, field: null, evidence: [] },
		],
	};
	const failed: StoredDocumentImport = documentRun(root, []);
	failed.files.push({
		status: "failed",
		filePath: path.join(root, "failed.pdf"),
		format: "pdf",
		sha256: extracted.input.source.sha256,
		issues: [importIssue("interpretation-limit", "Synthetic interpretation failure.")],
		analysis,
	});
	const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [], [failed]);
	assert.equal(saved.sources.length, 0);
	assert.deepEqual((await loadWorkspace(file)).documentImports[0].files[0], failed.files[0]);
	const retried: StoredDocumentImport = documentRun(root, [retainedDocument(root, "failed.pdf", "retry-content")]);
	const done: SavedWorkspace = await saveWorkspace(saved, saved.metadata, [], [failed, retried]);
	assert.equal(done.sources.length, 1);
	const collision: StoredDocumentImport = documentRun(root);
	collision.id = extracted.input.source.sourceId;
	await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(done, done.metadata, [], [failed, retried, collision]), /identity/);
});

test("v2 bank manifests survive document migration and both import types share the global identity space", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "bank-v2.receiptmatch"),
		bank: StoredBankImport = retainedBank(root);
	await createWorkspace(file, newMetadata(), [bank]);
	const db: Database.Database = new Database(file);
	db.exec(`DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews;
		DROP TABLE match_results; DROP TABLE document_imports; PRAGMA user_version=2;`);
	db.close();
	const before: NonSharedBuffer = await readFile(file),
		opened: SavedWorkspace = await loadWorkspace(file);
	assert.deepEqual(await readFile(file), before);
	assert.deepEqual(opened.imports, [bank]);
	const report: StoredDocumentImport = documentRun(root),
		saved: SavedWorkspace = await saveWorkspace(opened, opened.metadata, opened.imports, [report]);
	assert.deepEqual((await loadWorkspace(file)).imports, [bank]);
	assert.deepEqual(saved.documentImports, [report]);
	const collidingDocument: StoredDocumentImport = documentRun(root, [retainedDocument(root, "other.pdf")]);
	collidingDocument.id = bank.id;
	await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, saved.imports, [report, collidingDocument]), /identity/);
	const collidingBank: StoredBankImport = retainedBank(root);
	collidingBank.id = report.id;
	await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, [bank, collidingBank]), /identity/);
});

test("document manifests reject rewritten history, duplicate successful content, identity reuse and forged skips without writes", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "protected.receiptmatch"),
		first: StoredDocumentImport = documentRun(root);
	const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [], [first]);
	const duplicate: StoredDocumentImport = documentRun(root);
	const collision: StoredDocumentImport = documentRun(root, [retainedDocument(root, "other.pdf")]);
	collision.id = saved.metadata.id;
	const forged: StoredDocumentImport = documentRun(root, []);
	forged.files.push({ status: "skipped", filePath: path.join(root, "alias.pdf"), sha256: "b".repeat(64), existingSourceId: "missing-source" });
	const rewritten: StoredDocumentImport = structuredClone(first);
	rewritten.folderPath = path.join(root, "rewritten");
	for (const requested of [[], [rewritten], [first, duplicate], [first, collision], [first, forged]]) {
		const before: NonSharedBuffer = await readFile(file);
		await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, [], requested));
		assert.deepEqual(await readFile(file), before);
	}
});

test("manifest and projected document/source tampering are rejected read-only", async (): Promise<void> => {
	const root: string = await directory(),
		original: string = path.join(root, "original.receiptmatch"),
		run: StoredDocumentImport = documentRun(root);
	await createWorkspace(original, newMetadata(), [], [run]);
	for (const [index, sql] of ["UPDATE sources SET fingerprint='bad'", "UPDATE documents SET source_id='missing'", "UPDATE document_imports SET id='mismatched'"].entries()) {
		const file: string = path.join(root, `damaged-${index}.receiptmatch`);
		await copyFile(original, file);
		const db: Database.Database = new Database(file);
		db.pragma("foreign_keys = OFF");
		db.exec(sql);
		db.close();
		const before: NonSharedBuffer = await readFile(file);
		await assert.rejects((): Promise<SavedWorkspace> => loadWorkspace(file));
		assert.deepEqual(await readFile(file), before);
	}
});

test("an append failure rolls back schema migration, document projection and metadata together", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "rollback.receiptmatch");
	await createWorkspace(file, newMetadata());
	const db: Database.Database = new Database(file);
	db.exec(`DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews;
		DROP TABLE match_results; DROP TABLE document_imports; PRAGMA user_version=2;`);
	db.close();
	const saved: SavedWorkspace = await loadWorkspace(file),
		before: NonSharedBuffer = await readFile(file);
	const original: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
	const patched: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string): Database.Statement<[object], unknown> | Database.Statement<unknown[], unknown> {
		if (sql.startsWith("INSERT INTO documents")) {
			throw new Error("Synthetic document append failure.");
		}
		return original(this, sql);
	});
	try {
		await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, { ...saved.metadata, name: "Never committed" }, [], [documentRun(root)]), /Synthetic/);
	} finally {
		patched.mockRestore();
	}
	assert.deepEqual(await readFile(file), before);
	assert.equal((await loadWorkspace(file)).schemaVersion, 2);
});

test("document schema refuses outside paths, successful failed-analysis claims and reused local identities", (): void => {
	const root: string = path.resolve("artifacts/schema-documents"),
		run: StoredDocumentImport = documentRun(root);
	assert.equal(storedDocumentImportSchema.safeParse(run).success, true);
	const imported: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = run.files[0];
	assert.equal(imported.status, "imported");
	if (imported.status !== "imported") {
		return;
	}
	const original: string = imported.record.filePath;
	imported.record.filePath = path.resolve(root, "..", "outside.pdf");
	assert.equal(storedDocumentImportSchema.safeParse(run).success, false);
	imported.record.filePath = original;
	run.id = imported.record.id;
	assert.equal(storedDocumentImportSchema.safeParse(run).success, false);
});
