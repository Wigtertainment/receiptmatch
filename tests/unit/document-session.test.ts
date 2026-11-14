import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { ImportIssue } from "../../src/shared/bank-import.js";
import type { SupportingDocument } from "../../src/shared/supporting-document.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type BetterSqlite3 from 'better-sqlite3';
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceSession, type WorkspaceDialogs } from "../../electron/workspace-session.js";
import type { DocumentImportOptions, DocumentImportService } from "../../electron/documents/service.js";
import { createWorkspace, newMetadata } from "../../electron/store.js";
import type { StoredDocumentImport } from "../../src/shared/workspace-documents.js";
import { documentRun } from "./document-fixtures.js";

async function directory(): Promise<string> {
	await mkdir("artifacts", { recursive: true });
	return mkdtemp(path.resolve("artifacts/doc-session-"));
}

function dialogs(): { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } {
	const plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[] } = { saves: [], opens: [], choices: [] };
	const handlers: WorkspaceDialogs = {
		save: async (): Promise<string | null> => Promise.resolve(plan.saves.shift() ?? null),
		open: async (): Promise<string | null> => Promise.resolve(plan.opens.shift() ?? null),
		unsaved: async (): Promise<"discard" | "save" | "cancel"> => Promise.resolve(plan.choices.shift() ?? "cancel"),
	};
	return { plan, handlers };
}

test("document analysis remains unsaved until explicit save and reopens with immutable records and a complete dedupe catalog", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "documents.receiptmatch"),
		first: StoredDocumentImport = documentRun(root),
		script: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
	let next: StoredDocumentImport | null = first;
	const sources: DocumentImportOptions["existingSources"][] = [];
	const service: DocumentImportService = {
		run: async (options: DocumentImportOptions): Promise<StoredDocumentImport | null> => {
			sources.push(options.existingSources);
			return Promise.resolve(next);
		},
	};
	const session: WorkspaceSession = new WorkspaceSession(script.handlers, undefined, undefined, service);
	await session.dispatch({ type: "new" });
	const result: WorkspaceState = await session.dispatch({ type: "import-documents" });
	assert.equal(result.documentOutcome?.status, "finished");
	assert.equal(result.workspace?.documentImports[0].imported, 1);
	assert.equal(result.workspace?.dirty, true);
	const snapshot: StoredDocumentImport[] = session.documentImports();
	snapshot[0].files.length = 0;
	assert.equal(session.documentImports()[0].files.length, 1);
	script.plan.saves.push(file);
	await session.dispatch({ type: "save" });
	assert.equal(session.state().workspace?.dirty, false);
	next = documentRun(root, []);
	const document: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } = first.files[0];
	assert.equal(document.status, "imported");
	if (document.status !== "imported") {
		return;
	}
	next.files.push({
		status: "skipped",
		filePath: path.join(root, "copy.pdf"),
		sha256: document.record.result.input!.source.sha256,
		existingSourceId: document.record.result.input!.source.sourceId,
	});
	await session.dispatch({ type: "import-documents" });
	assert.equal(sources[1].length, 1);
	assert.equal(session.state().workspace?.dirty, true, "the new run report is an explicit unsaved change");
	await session.dispatch({ type: "save" });
	const reopen: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
	reopen.plan.opens.push(file);
	const restored: WorkspaceSession = new WorkspaceSession(reopen.handlers);
	await restored.dispatch({ type: "open" });
	assert.deepEqual(restored.documentImports(), session.documentImports());
	assert.equal(restored.state().workspace?.dirty, false);
});

test("cancelled document runs retain completed files while concurrent actions and late progress cannot overwrite the workspace", async (): Promise<void> => {
	const root: string = await directory(),
		script: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs(),
		run: StoredDocumentImport = documentRun(root);
	run.status = "cancelled";
	let finish!: (value: StoredDocumentImport) => void, captured!: DocumentImportOptions;
	const pending: Promise<StoredDocumentImport> = new Promise<StoredDocumentImport>((resolve: (value: StoredDocumentImport | PromiseLike<StoredDocumentImport>) => void): void => {
		finish = resolve;
	});
	const session: WorkspaceSession = new WorkspaceSession(script.handlers, undefined, undefined, {
		run: async (options: DocumentImportOptions): Promise<StoredDocumentImport> => {
			captured = options;
			return pending;
		},
	});
	await session.dispatch({ type: "new" });
	const id: string = session.state().workspace!.id;
	const running: Promise<WorkspaceState> = session.dispatch({ type: "import-documents" });
	assert.equal(session.state().busy, true);
	assert.ok(session.state().documentImport);
	for (const command of [{ type: "new" }, { type: "open" }, { type: "save" }, { type: "import-statement" }, { type: "rename", name: "Blocked" }] as const) {
		const blocked: WorkspaceState = await session.dispatch(command);
		assert.ok(blocked.error);
		assert.equal(blocked.workspace?.id, id);
	}
	await session.dispatch({ type: "cancel-import" });
	assert.equal(captured.signal?.aborted, true);
	assert.equal(session.state().documentImport?.cancelling, true);
	captured.onProgress?.({ phase: "extracting", completedFiles: 999, filePath: path.join(root, "late.pdf"), extraction: null });
	assert.equal(session.state().documentImport?.progress, null);
	finish(run);
	await running;
	assert.equal(session.state().documentOutcome?.status, "cancelled");
	assert.equal(session.documentImports().length, 1);
	assert.equal(session.state().busy, false);
	assert.equal(session.state().documentImport, null);
	script.plan.saves.push(path.join(root, "cancelled.receiptmatch"));
	await session.dispatch({ type: "save" });
	assert.equal(session.state().workspace?.dirty, false);
});

test("cancelled folder selection stays clean and failed saves or invalid Open preserve the pending document report", async (): Promise<void> => {
	const root: string = await directory(),
		file: string = path.join(root, "saved.receiptmatch");
	await createWorkspace(file, newMetadata());
	const script: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
	script.plan.opens.push(file);
	let next: StoredDocumentImport | null = null;
	const session: WorkspaceSession = new WorkspaceSession(script.handlers, undefined, undefined, { run: async (): Promise<StoredDocumentImport | null> => Promise.resolve(next) });
	await session.dispatch({ type: "open" });
	await session.dispatch({ type: "import-documents" });
	assert.equal(session.state().workspace?.dirty, false);
	assert.deepEqual(session.documentImports(), []);
	next = documentRun(root);
	await session.dispatch({ type: "import-documents" });
	const expected: StoredDocumentImport[] = session.documentImports();
	script.plan.choices.push("discard");
	script.plan.opens.push(path.join(root, "missing.receiptmatch"));
	await session.dispatch({ type: "open" });
	assert.deepEqual(session.documentImports(), expected);
	assert.equal(session.state().workspace?.dirty, true);
	const original: NonSharedBuffer = await readFile(file);
	const { default: external }: { default: typeof BetterSqlite3 } = await import("better-sqlite3");
	const db: BetterSqlite3.Database = new external(file);
	db.exec("UPDATE workspace SET name='External edit'");
	db.close();
	const externalBytes: NonSharedBuffer = await readFile(file);
	await session.dispatch({ type: "save" });
	assert.ok(session.state().error);
	assert.deepEqual(session.documentImports(), expected);
	assert.notDeepEqual(await readFile(file), original);
	assert.deepEqual(await readFile(file), externalBytes);
});

test("invalid document skips and reused identities are rejected without retaining a report", async (): Promise<void> => {
	const root: string = await directory(),
		script: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; handlers: WorkspaceDialogs; } = dialogs();
	let candidate: StoredDocumentImport = documentRun(root, []);
	const session: WorkspaceSession = new WorkspaceSession(script.handlers, undefined, undefined, { run: async (): Promise<StoredDocumentImport> => Promise.resolve(candidate) });
	await session.dispatch({ type: "new" });
	candidate.files.push({ status: "skipped", filePath: path.join(root, "forged.pdf"), sha256: "a".repeat(64), existingSourceId: "not-present" });
	await session.dispatch({ type: "import-documents" });
	assert.equal(session.state().documentOutcome?.status, "failed");
	assert.deepEqual(session.documentImports(), []);
	candidate = documentRun(root);
	candidate.id = session.state().workspace!.id;
	await session.dispatch({ type: "import-documents" });
	assert.equal(session.state().documentOutcome?.status, "failed");
	assert.deepEqual(session.documentImports(), []);
});
