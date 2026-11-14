import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, ImportIssue } from "../../src/shared/bank-import.js";
import type { SupportingDocument } from "../../src/shared/supporting-document.js";
import type { ExtractionProgress } from "../../src/shared/pdf-extraction.js";
import { test, vi, type Mock } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { FolderDocumentImportService } from "../../electron/documents/service.js";
import { StatementImportService } from "../../electron/import/service.js";
import { importIssue } from "../../src/shared/bank-import.js";
import { LOCAL_OCR_VERSIONS } from "../../src/shared/pdf-extraction.js";
import { storedDocumentImportSchema, type DocumentImportProgress, type StoredDocumentImport } from "../../src/shared/workspace-documents.js";
import { extractedDocument } from "./document-fixtures.js";
import type { Mode } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { Stats } from 'node:fs';
import type { StatOptions } from 'node:fs';
import type { Dir } from 'node:fs';
import type { OpenDirOptions } from 'node:fs';
import type { PathLike } from 'node:fs';
import type { LocalDocumentOcr } from '../../electron/extraction/host.js';

async function directory(): Promise<string> {
	await mkdir("artifacts", { recursive: true });
	return mkdtemp(path.resolve("artifacts/doc-service-"));
}

const sha: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function imported(run: StoredDocumentImport): StoredSupportingDocument[] {
	return run.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): StoredSupportingDocument[] => (file.status === "imported" ? [file.record] : []));
}

test("a nested mixed folder preserves originals, records failures and skips identical bytes before extraction", async (): Promise<void> => {
	const root: string = await directory();
	await mkdir(path.join(root, "nested"));
	const names: string[] = ["a.PDF", "b.PNG", "c.JpG", "d-copy.pdf", "e-broken.pdf", "notes.txt", "nested/z.jpeg"];
	for (const name of names) {
		await writeFile(path.join(root, name), name === "d-copy.pdf" ? "a.PDF" : name);
	}
	const before: NonSharedBuffer[] = await Promise.all(names.map((name: string): Promise<NonSharedBuffer> => readFile(path.join(root, name))));
	const calls: string[] = [],
		progress: DocumentImportProgress[] = [];
	const service: FolderDocumentImportService = new FolderDocumentImportService({
		choose: async (): Promise<string> => Promise.resolve(root),
		extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg"): Promise<({ status: "complete"; input: BankImportInput; } & { status: "complete"; }) | { status: "failed"; issues: ImportIssue[]; }> => {
			calls.push(Buffer.from(bytes).toString());
			if (Buffer.from(bytes).toString().includes("broken")) {
				return Promise.resolve({ status: "failed", issues: [importIssue("synthetic-failure", "Synthetic corrupt file.")] });
			}
			return Promise.resolve(extractedDocument(bytes, id, format));
		},
	});
	const run: StoredDocumentImport | null = await service.run({ existingSources: [], onProgress: (value: DocumentImportProgress): number => progress.push(value) });
	assert.ok(run);
	assert.equal(run.status, "finished");
	assert.equal(run.files.length, 7);
	assert.equal(imported(run).length, 4);
	assert.equal(run.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } => file.status === "skipped").length, 1);
	assert.equal(run.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } => file.status === "failed").length, 1);
	assert.equal(run.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "unsupported"; filePath: string; issues: ImportIssue[]; } => file.status === "unsupported").length, 1);
	assert.equal(calls.length, 5);
	assert.ok(!calls.includes("d-copy.pdf"));
	assert.deepEqual(new Set(imported(run).map((record: StoredSupportingDocument): "png" | "pdf" | "jpeg" => record.format)), new Set(["pdf", "png", "jpeg"]));
	assert.equal(storedDocumentImportSchema.safeParse(run).success, true);
	assert.ok(progress.some((value: DocumentImportProgress): string | false | null => value.phase === "extracting" && value.filePath));
	assert.deepEqual(await Promise.all(names.map((name: string): Promise<NonSharedBuffer> => readFile(path.join(root, name)))), before);
	const sources: { id: string; filePath: string; sha256: string; }[] = imported(run).map((record: StoredSupportingDocument): { id: string; filePath: string; sha256: string; } => ({ id: record.result.input!.source.sourceId, filePath: record.filePath, sha256: record.result.input!.source.sha256 }));
	calls.length = 0;
	const repeated: StoredDocumentImport | null = await service.run({ existingSources: sources });
	assert.ok(repeated);
	assert.equal(imported(repeated).length, 0);
	assert.equal(repeated.files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } => file.status === "skipped").length, 5);
	assert.equal(calls.length, 1, "previously failed content must be retried");
});

test("legacy and bank source hashes are deduplicated, including bank import after document analysis", async (): Promise<void> => {
	const root: string = await directory(),
		source: string = path.join(root, "already.pdf");
	await writeFile(source, "existing content");
	const catalog: { id: string; filePath: string; sha256: string; }[] = [{ id: "legacy-source", filePath: path.join(root, "elsewhere.pdf"), sha256: sha(await readFile(source)) }];
	const service: FolderDocumentImportService = new FolderDocumentImportService({ choose: async (): Promise<string> => Promise.resolve(root), extract: async (): Promise<never> => Promise.resolve().then((): never => assert.fail("Duplicate reached extraction.")) });
	const run: StoredDocumentImport | null = await service.run({ existingSources: catalog });
	assert.ok(run);
	assert.deepEqual(run.files, [{ status: "skipped", filePath: source, sha256: catalog[0].sha256, existingSourceId: "legacy-source" }]);
	const bank: StatementImportService = new StatementImportService({ choose: async (): Promise<string> => Promise.resolve(source), extract: async (): Promise<never> => Promise.resolve().then((): never => assert.fail("Cross-domain duplicate reached bank extraction.")) });
	assert.deepEqual(await bank.run({ existing: [], existingSources: catalog }), { status: "skipped", importId: null, existingSourceId: "legacy-source" });
});

test("cancellation keeps completed files, discards the pending file and ignores late extraction progress", async (): Promise<void> => {
	const root: string = await directory();
	await writeFile(path.join(root, "a.pdf"), "first");
	await writeFile(path.join(root, "b.pdf"), "second");
	const controller: AbortController = new AbortController(),
		progress: DocumentImportProgress[] = [];
	let release!: () => void, secondStarted!: () => void;
	const started: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => {
		secondStarted = resolve;
	});
	const pending: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => {
		release = resolve;
	});
	const service: FolderDocumentImportService = new FolderDocumentImportService({
		choose: async (): Promise<string> => Promise.resolve(root),
		extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg", options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; localOcr?: LocalDocumentOcr; }): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => {
			if (Buffer.from(bytes).toString() === "second") {
				secondStarted();
				await pending;
				options.onProgress?.({ phase: "ocr", pageNumber: 1, pageCount: 1, completedPages: 0 });
			}
			return extractedDocument(bytes, id, format);
		},
	});
	const running: Promise<StoredDocumentImport | null> = service.run({ existingSources: [], signal: controller.signal, onProgress: (value: DocumentImportProgress): number => progress.push(value) });
	await started;
	controller.abort();
	const count: number = progress.length;
	release();
	const run: StoredDocumentImport | null = await running;
	assert.ok(run);
	assert.equal(run.status, "cancelled");
	assert.equal(imported(run).length, 1);
	assert.equal(run.files.length, 1);
	assert.equal(progress.length, count);
	assert.ok(imported(run)[0].filePath.endsWith("a.pdf"));
	assert.equal(await new FolderDocumentImportService({ choose: async (): Promise<null> => Promise.resolve(null), extract: async (): Promise<never> => Promise.resolve().then((): never => assert.fail()) }).run({ existingSources: [] }), null);
});

test("directory links are reported without following them and unreadable sibling directories do not hide healthy files", async (): Promise<void> => {
	const root: string = await directory(),
		folder: string = path.join(root, "chosen"),
		external: string = path.join(root, "outside");
	await mkdir(folder);
	await mkdir(external);
	await mkdir(path.join(folder, "denied"));
	await writeFile(path.join(folder, "healthy.pdf"), "healthy");
	await writeFile(path.join(external, "outside.pdf"), "outside");
	const link: string = path.join(folder, "linked");
	await symlink(external, link, "junction");
	const original: (path: PathLike, options?: OpenDirOptions) => Promise<Dir> = fsPromises.opendir;
	const patched: Mock<(path: PathLike, options?: OpenDirOptions) => Promise<Dir>> = vi.spyOn(fsPromises, "opendir").mockImplementation(((selected: PathLike, ...args: [options?: OpenDirOptions]): Promise<Dir> => {
		if (String(selected) === path.join(folder, "denied")) {
			return Promise.reject(Object.assign(new Error("Synthetic access denial."), { code: "EACCES" }));
		}
		return original(selected, ...args);
	}));
	syncBuiltinESMExports();
	try {
		const service: FolderDocumentImportService = new FolderDocumentImportService({ choose: async (): Promise<string> => Promise.resolve(folder), extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg"): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => Promise.resolve(extractedDocument(bytes, id, format)) });
		const run: StoredDocumentImport | null = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(imported(run).length, 1);
		assert.ok(run.directoryIssues.some((issue: { directoryPath: string; code: string; message: string; }): boolean => issue.directoryPath.endsWith("denied")));
		assert.ok(run.files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => file.status === "unsupported" && file.filePath === link) || run.directoryIssues.some((issue: { directoryPath: string; code: string; message: string; }): boolean => issue.directoryPath === link));
		assert.ok(!run.files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => (file.status === "imported" ? file.record.filePath : file.filePath).includes("outside.pdf")));
	} finally {
		patched.mockRestore();
		syncBuiltinESMExports();
		await unlink(link);
	}
});

test("invalid provenance and malformed progress are isolated as per-file failures rather than accepted records", async (): Promise<void> => {
	const root: string = await directory();
	await writeFile(path.join(root, "a.pdf"), "first");
	await writeFile(path.join(root, "z.pdf"), "last");
	for (const defect of ["hash", "source", "version", "progress"] as const) {
		const service: FolderDocumentImportService = new FolderDocumentImportService({
			choose: async (): Promise<string> => Promise.resolve(root),
			extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg", options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; localOcr?: LocalDocumentOcr; }): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => {
				const result: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(bytes, id, format);
				if (Buffer.from(bytes).toString() === "first") {
					if (defect === "hash") {
						result.input.source.sha256 = "f".repeat(64);
					}
					if (defect === "source") {
						result.input.source.sourceId = randomUUID();
					}
					if (defect === "version") {
						result.input.extraction.version = "wrong-engine";
					}
					if (defect === "progress") {
						options.onProgress?.({ phase: "ocr", pageNumber: -1, pageCount: 1, completedPages: 0 });
					}
				}
				return Promise.resolve(result);
			},
		});
		const run: StoredDocumentImport | null = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(run.files[0].status, "failed", defect);
		assert.equal(imported(run).length, 1, defect);
	}
});

test("the selected OCR model is used for the folder and embedded PDF text retains standard provenance", async (): Promise<void> => {
	const root: string = await directory();
	for (const name of ["a.png", "b.pdf", "c.jpg", "d.pdf", "e.jpeg"]) {
		await writeFile(path.join(root, name), name);
	}
	const localOcr: { readonly model: "pp-ocrv6-medium"; readonly files: { readonly executable: "python"; readonly detection: "det"; readonly recognition: "rec"; }; } = { model: "pp-ocrv6-medium", files: { executable: "python", detection: "det", recognition: "rec" } } as const;
	const service: FolderDocumentImportService = new FolderDocumentImportService({
		choose: async (): Promise<string> => Promise.resolve(root),
		localOcr: async (): Promise<{ readonly model: "pp-ocrv6-medium"; readonly files: { readonly executable: "python"; readonly detection: "det"; readonly recognition: "rec"; }; }> => Promise.resolve(localOcr),
		extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg", options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; localOcr?: LocalDocumentOcr; }): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => {
			assert.equal(options.localOcr, localOcr);
			const result: { status: "complete"; input: BankImportInput; } & { status: "complete"; } = extractedDocument(bytes, id, format);
			const name: string = Buffer.from(bytes).toString();
			if (name === "a.png") {
				result.input.extraction.version = LOCAL_OCR_VERSIONS[localOcr.model];
			}
			if (name === "c.jpg") {
				result.input.extraction.version = LOCAL_OCR_VERSIONS["paddleocr-vl-1.6"];
			}
			if (name === "d.pdf") {
				for (const span of result.input.pages[0].spans) {
					span.method = "local-ocr";
				}
			}
			return Promise.resolve(result);
		},
	});
	const run: StoredDocumentImport | null = await service.run({ existingSources: [] });
	assert.ok(run);
	assert.deepEqual(run.files.map((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): "failed" | "unsupported" | "imported" | "skipped" => file.status), ["imported", "imported", "failed", "failed", "failed"]);
});

test("a transient ancestor replacement cannot replace the file identity selected before snapshotting", async (): Promise<void> => {
	const root: string = await directory(),
		folder: string = path.join(root, "chosen");
	await mkdir(folder);
	const source: string = path.join(folder, "a.pdf"),
		healthy: string = path.join(folder, "z.pdf"),
		external: string = path.join(root, "outside.pdf");
	await writeFile(source, "selected original");
	await writeFile(healthy, "healthy sibling");
	await writeFile(external, "outside content must not reach extraction");
	const originalLstat: { (path: PathLike, opts?: StatOptions & { bigint?: false | undefined; }): Promise<Stats>; (path: PathLike, opts: StatOptions & { bigint: true; }): Promise<BigIntStats>; (path: PathLike, opts?: StatOptions): Promise<Stats | BigIntStats>; } = fsPromises.lstat,
		originalOpen: (path: PathLike, flags?: string | number, mode?: Mode) => Promise<fsPromises.FileHandle> = fsPromises.open;
	let selections: number = 0;
	const statPatch: Mock<{ (path: PathLike, opts?: StatOptions & { bigint?: false | undefined; }): Promise<Stats>; (path: PathLike, opts: StatOptions & { bigint: true; }): Promise<BigIntStats>; (path: PathLike, opts?: StatOptions): Promise<Stats | BigIntStats>; }> = vi.spyOn(fsPromises, "lstat").mockImplementation((async (selected: PathLike, options?: StatOptions): Promise<Stats | BigIntStats> => {
		let requested: PathLike = selected;
		if (String(selected) === source && [2, 3].includes(++selections)) {
			requested = external;
		}
		return originalLstat(requested, options);
	}));
	const openPatch: Mock<(path: PathLike, flags?: string | number, mode?: Mode) => Promise<fsPromises.FileHandle>> = vi.spyOn(fsPromises, "open").mockImplementation((async (selected: PathLike, ...args: [flags?: string | number, mode?: Mode]): Promise<fsPromises.FileHandle> => {
		return originalOpen(String(selected) === source ? external : selected, ...args);
	}));
	syncBuiltinESMExports();
	const extracted: string[] = [];
	try {
		const service: FolderDocumentImportService = new FolderDocumentImportService({
			choose: async (): Promise<string> => Promise.resolve(folder),
			extract: async (bytes: Uint8Array<ArrayBufferLike>, id: string, format: "png" | "pdf" | "jpeg"): Promise<{ status: "complete"; input: BankImportInput; } & { status: "complete"; }> => {
				extracted.push(Buffer.from(bytes).toString());
				return Promise.resolve(extractedDocument(bytes, id, format));
			},
		});
		const run: StoredDocumentImport | null = await service.run({ existingSources: [] });
		assert.ok(run);
		assert.equal(run.files[0].status, "failed");
		if (run.files[0].status === "failed") {
			assert.ok(run.files[0].issues.some((issue: ImportIssue): boolean => issue.code === "source-changed"));
		}
		assert.deepEqual(extracted, ["healthy sibling"]);
	} finally {
		statPatch.mockRestore();
		openPatch.mockRestore();
		syncBuiltinESMExports();
	}
	assert.equal((await readFile(source)).toString(), "selected original");
	assert.equal((await readFile(external)).toString(), "outside content must not reach extraction");
});
