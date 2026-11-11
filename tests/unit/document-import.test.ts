import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { FolderDocumentImportService } from "../../electron/documents/service.js";
import { StatementImportService } from "../../electron/import/service.js";
import { importIssue } from "../../src/shared/bank-import.js";
import { storedDocumentImportSchema, type DocumentImportProgress, type StoredDocumentImport } from "../../src/shared/workspace-documents.js";
import { extractedDocument } from "./document-fixtures.js";

async function directory() {
	await mkdir("artifacts", { recursive: true });
	return mkdtemp(path.resolve("artifacts/doc-service-"));
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function imported(run: StoredDocumentImport) {
	return run.files.flatMap((file) => (file.status === "imported" ? [file.record] : []));
}

test("a nested mixed folder preserves originals, records failures and skips identical bytes before extraction", async () => {
	const root = await directory();
	await mkdir(path.join(root, "nested"));
	const names = ["a.PDF", "b.PNG", "c.JpG", "d-copy.pdf", "e-broken.pdf", "notes.txt", "nested/z.jpeg"];
	for (const name of names) await writeFile(path.join(root, name), name === "d-copy.pdf" ? "a.PDF" : name);
	const before = await Promise.all(names.map((name) => readFile(path.join(root, name))));
	const calls: string[] = [],
		progress: DocumentImportProgress[] = [];
	const service = new FolderDocumentImportService({
		choose: async () => root,
		extract: async (bytes, id, format) => {
			calls.push(Buffer.from(bytes).toString());
			if (Buffer.from(bytes).toString().includes("broken")) return { status: "failed", issues: [importIssue("synthetic-failure", "Synthetic corrupt file.")] };
			return extractedDocument(bytes, id, format);
		},
	});
	const run = await service.run({ existingSources: [], onProgress: (value) => progress.push(value) });
	assert.ok(run);
	assert.equal(run.status, "finished");
	assert.equal(run.files.length, 7);
	assert.equal(imported(run).length, 4);
	assert.equal(run.files.filter((file) => file.status === "skipped").length, 1);
	assert.equal(run.files.filter((file) => file.status === "failed").length, 1);
	assert.equal(run.files.filter((file) => file.status === "unsupported").length, 1);
	assert.equal(calls.length, 5);
	assert.ok(!calls.includes("d-copy.pdf"));
	assert.deepEqual(new Set(imported(run).map((record) => record.format)), new Set(["pdf", "png", "jpeg"]));
	assert.equal(storedDocumentImportSchema.safeParse(run).success, true);
	assert.ok(progress.some((value) => value.phase === "extracting" && value.filePath));
	assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(root, name)))), before);
	const sources = imported(run).map((record) => ({ id: record.result.input!.source.sourceId, filePath: record.filePath, sha256: record.result.input!.source.sha256 }));
	calls.length = 0;
	const repeated = await service.run({ existingSources: sources });
	assert.ok(repeated);
	assert.equal(imported(repeated).length, 0);
	assert.equal(repeated.files.filter((file) => file.status === "skipped").length, 5);
	assert.equal(calls.length, 1, "previously failed content must be retried");
});

test("legacy and bank source hashes are deduplicated, including bank import after document analysis", async () => {
	const root = await directory(),
		source = path.join(root, "already.pdf");
	await writeFile(source, "existing content");
	const catalog = [{ id: "legacy-source", filePath: path.join(root, "elsewhere.pdf"), sha256: sha(await readFile(source)) }];
	const service = new FolderDocumentImportService({ choose: async () => root, extract: async () => assert.fail("Duplicate reached extraction.") });
	const run = await service.run({ existingSources: catalog });
	assert.ok(run);
	assert.deepEqual(run.files, [{ status: "skipped", filePath: source, sha256: catalog[0].sha256, existingSourceId: "legacy-source" }]);
	const bank = new StatementImportService({ choose: async () => source, extract: async () => assert.fail("Cross-domain duplicate reached bank extraction.") });
	assert.deepEqual(await bank.run({ existing: [], existingSources: catalog }), { status: "skipped", importId: null, existingSourceId: "legacy-source" });
});

test("cancellation keeps completed files, discards the pending file and ignores late extraction progress", async () => {
	const root = await directory();
	await writeFile(path.join(root, "a.pdf"), "first");
	await writeFile(path.join(root, "b.pdf"), "second");
	const controller = new AbortController(),
		progress: DocumentImportProgress[] = [];
	let release!: () => void, secondStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		secondStarted = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const service = new FolderDocumentImportService({
		choose: async () => root,
		extract: async (bytes, id, format, options) => {
			if (Buffer.from(bytes).toString() === "second") {
				secondStarted();
				await pending;
				options.onProgress?.({ phase: "ocr", pageNumber: 1, pageCount: 1, completedPages: 0 });
			}
			return extractedDocument(bytes, id, format);
		},
	});
	const running = service.run({ existingSources: [], signal: controller.signal, onProgress: (value) => progress.push(value) });
	await started;
	controller.abort();
	const count = progress.length;
	release();
	const run = await running;
	assert.ok(run);
	assert.equal(run.status, "cancelled");
	assert.equal(imported(run).length, 1);
	assert.equal(run.files.length, 1);
	assert.equal(progress.length, count);
	assert.ok(imported(run)[0].filePath.endsWith("a.pdf"));
	assert.equal(await new FolderDocumentImportService({ choose: async () => null, extract: async () => assert.fail() }).run({ existingSources: [] }), null);
});

test("directory links are reported without following them and unreadable sibling directories do not hide healthy files", async () => {
	const root = await directory(),
		folder = path.join(root, "chosen"),
		external = path.join(root, "outside");
	await mkdir(folder);
	await mkdir(external);
	await mkdir(path.join(folder, "denied"));
	await writeFile(path.join(folder, "healthy.pdf"), "healthy");
	await writeFile(path.join(external, "outside.pdf"), "outside");
	const link = path.join(folder, "linked");
	await symlink(external, link, "junction");
	const original = fsPromises.opendir;
	const patched = mock.method(fsPromises, "opendir", ((selected: unknown, ...args: unknown[]) => {
		if (String(selected) === path.join(folder, "denied")) return Promise.reject(Object.assign(new Error("Synthetic access denial."), { code: "EACCES" }));
		return Reflect.apply(original, fsPromises, [selected, ...args]);
	}) as typeof fsPromises.opendir);
	syncBuiltinESMExports();
	try {
		const service = new FolderDocumentImportService({ choose: async () => folder, extract: async (bytes, id, format) => extractedDocument(bytes, id, format) });
		const run = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(imported(run).length, 1);
		assert.ok(run.directoryIssues.some((issue) => issue.directoryPath.endsWith("denied")));
		assert.ok(run.files.some((file) => file.status === "unsupported" && file.filePath === link) || run.directoryIssues.some((issue) => issue.directoryPath === link));
		assert.ok(!run.files.some((file) => (file.status === "imported" ? file.record.filePath : file.filePath).includes("outside.pdf")));
	} finally {
		patched.mock.restore();
		syncBuiltinESMExports();
		await unlink(link);
	}
});

test("invalid provenance and malformed progress are isolated as per-file failures rather than accepted records", async () => {
	const root = await directory();
	await writeFile(path.join(root, "a.pdf"), "first");
	await writeFile(path.join(root, "z.pdf"), "last");
	for (const defect of ["hash", "source", "version", "progress"] as const) {
		const service = new FolderDocumentImportService({
			choose: async () => root,
			extract: async (bytes, id, format, options) => {
				const result = extractedDocument(bytes, id, format);
				if (Buffer.from(bytes).toString() === "first") {
					if (defect === "hash") result.input.source.sha256 = "f".repeat(64);
					if (defect === "source") result.input.source.sourceId = randomUUID();
					if (defect === "version") result.input.extraction.version = "wrong-engine";
					if (defect === "progress") options.onProgress?.({ phase: "ocr", pageNumber: -1, pageCount: 1, completedPages: 0 });
				}
				return result;
			},
		});
		const run = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(run.files[0].status, "failed", defect);
		assert.equal(imported(run).length, 1, defect);
	}
});

test("a transient ancestor replacement cannot replace the file identity selected before snapshotting", async () => {
	const root = await directory(),
		folder = path.join(root, "chosen");
	await mkdir(folder);
	const source = path.join(folder, "a.pdf"),
		healthy = path.join(folder, "z.pdf"),
		external = path.join(root, "outside.pdf");
	await writeFile(source, "selected original");
	await writeFile(healthy, "healthy sibling");
	await writeFile(external, "outside content must not reach extraction");
	const originalLstat = fsPromises.lstat,
		originalOpen = fsPromises.open;
	let selections = 0;
	const statPatch = mock.method(fsPromises, "lstat", (async (selected: unknown, ...args: unknown[]) => {
		let requested = selected;
		if (String(selected) === source && [2, 3].includes(++selections)) requested = external;
		return Reflect.apply(originalLstat, fsPromises, [requested, ...args]);
	}) as typeof fsPromises.lstat);
	const openPatch = mock.method(fsPromises, "open", (async (selected: unknown, ...args: unknown[]) => {
		return Reflect.apply(originalOpen, fsPromises, [String(selected) === source ? external : selected, ...args]);
	}) as typeof fsPromises.open);
	syncBuiltinESMExports();
	const extracted: string[] = [];
	try {
		const service = new FolderDocumentImportService({
			choose: async () => folder,
			extract: async (bytes, id, format) => {
				extracted.push(Buffer.from(bytes).toString());
				return extractedDocument(bytes, id, format);
			},
		});
		const run = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(run.files[0].status, "failed");
		if (run.files[0].status === "failed") assert.ok(run.files[0].issues.some((issue) => issue.code === "source-changed"));
		assert.deepEqual(extracted, ["healthy sibling"]);
	} finally {
		statPatch.mock.restore();
		openPatch.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal((await readFile(source)).toString(), "selected original");
	assert.equal((await readFile(external)).toString(), "outside content must not reach extraction");
});
