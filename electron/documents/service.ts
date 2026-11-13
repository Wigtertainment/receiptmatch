import { createHash, randomUUID } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { importIssue } from "../../src/shared/bank-import.js";
import { extractionProgressSchema, extractionResultSchema, LOCAL_OCR_VERSIONS, PDF_EXTRACTION_VERSION, type ExtractionProgress, type ExtractionResult } from "../../src/shared/pdf-extraction.js";
import {
	DOCUMENT_IMPORT_LIMITS,
	storedDocumentImportSchema,
	storedSupportingDocumentSchema,
	type DocumentFormat,
	type DocumentImportProgress,
	type StoredDocumentImport,
	type WorkspaceSource,
} from "../../src/shared/workspace-documents.js";
import { assertSourceNotCancelled, readSourceSnapshot, SourceReadError } from "../import/source.js";
import type { LocalDocumentOcr } from "../extraction/host.js";
import { interpretSupportingDocument } from "./interpret.js";

export interface DocumentImportOptions {
	existingSources: readonly WorkspaceSource[];
	signal?: AbortSignal;
	onProgress?: (progress: DocumentImportProgress) => void;
}
export interface DocumentImportService {
	run(options: DocumentImportOptions): Promise<StoredDocumentImport | null>;
}
interface DocumentImportDependencies {
	choose(): Promise<string | null>;
	localOcr?: () => Promise<LocalDocumentOcr | undefined>;
	extract(
		bytes: Uint8Array,
		sourceId: string,
		format: DocumentFormat,
		options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void; localOcr?: LocalDocumentOcr },
	): Promise<ExtractionResult>;
}
const formats: Readonly<Record<string, DocumentFormat>> = { ".pdf": "pdf", ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" };
function inside(root: string, target: string) {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}
function failureDetail(error: unknown) {
	return error instanceof SourceReadError
		? { code: error.code, message: error.message }
		: { code: "source-unavailable", message: "The local file or folder could not be read safely." };
}

export class FolderDocumentImportService implements DocumentImportService {
	constructor(private readonly dependencies: DocumentImportDependencies) {}

	async run(options: DocumentImportOptions): Promise<StoredDocumentImport | null> {
		if (options.signal?.aborted) return null;
		const selected = await this.dependencies.choose();
		if (selected === null) return null;
		if (!path.isAbsolute(selected) || selected.length > 32768 || selected.includes("\0"))
			throw new SourceReadError("invalid-source", "Choose an absolute local folder using the document dialog.");
		const folderPath = path.resolve(selected),
			identities = new Set(options.existingSources.map((source) => source.id.toLowerCase()));
		const localOcr = await this.dependencies.localOcr?.();
		const freshId = () => {
			let id: string;
			do {
				id = randomUUID();
			} while (identities.has(id));
			identities.add(id);
			return id;
		};
		const report: StoredDocumentImport = {
			id: freshId(),
			folderPath,
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			status: "finished",
			files: [],
			directoryIssues: [],
		};
		const seen = new Map(options.existingSources.filter((source) => source.sha256 !== null).map((source) => [source.sha256!, source.id]));
		let canonicalRoot = "",
			directories = 0,
			stopped = false;
		const progress = (phase: DocumentImportProgress["phase"], filePath: string | null = null, extraction: ExtractionProgress | null = null) => {
			if (!options.signal?.aborted) options.onProgress?.({ phase, filePath, completedFiles: report.files.length, extraction });
		};
		const directoryIssue = (directoryPath: string, code: string, message: string) => {
			report.directoryIssues.push({ directoryPath, code, message });
		};
		const limit = (directoryPath: string, code: string, message: string) => {
			stopped = true;
			directoryIssue(directoryPath, code, message);
		};
		const processFile = async (filePath: string) => {
			assertSourceNotCancelled(options.signal);
			if (filePath.length > 32768) {
				limit(path.dirname(filePath), "path-limit", "The local path-length limit was reached; this entry was not processed.");
				return;
			}
			if (report.files.length >= DOCUMENT_IMPORT_LIMITS.files) {
				limit(path.dirname(filePath), "file-limit", "The local file-count limit was reached; remaining entries were not processed.");
				return;
			}
			let sha256: string | null = null;
			const format = formats[path.extname(filePath).toLowerCase()] ?? null;
			let acceptingProgress = false,
				invalidProgress = false;
			try {
				const entry = await lstat(filePath, { bigint: true });
				if (entry.isSymbolicLink()) {
					report.files.push({ status: "unsupported", filePath, issues: [importIssue("linked-source", "Linked files or folders are not followed.")] });
					return;
				}
				if (!entry.isFile()) throw new SourceReadError("invalid-source", "This entry is not a regular document file.");
				const canonical = await realpath(filePath);
				if (!inside(canonicalRoot, canonical)) throw new SourceReadError("outside-folder", "The source resolves outside the selected folder.");
				if (!format) {
					report.files.push({ status: "unsupported", filePath, issues: [importIssue("unsupported-format", "Only PDF, PNG and JPEG documents are supported.")] });
					return;
				}
				const bytes = await readSourceSnapshot(canonical, Object.keys(formats), options.signal, entry);
				if ((await realpath(filePath)) !== canonical || (await lstat(filePath)).isSymbolicLink())
					throw new SourceReadError("source-changed", "The selected source path changed while it was being read.");
				sha256 = createHash("sha256").update(bytes).digest("hex");
				assertSourceNotCancelled(options.signal);
				const existingSourceId = seen.get(sha256);
				if (existingSourceId) {
					report.files.push({ status: "skipped", filePath, sha256, existingSourceId });
					return;
				}
				const sourceId = freshId();
				acceptingProgress = true;
				progress("extracting", filePath);
				assertSourceNotCancelled(options.signal);
				const raw = await this.dependencies.extract(bytes, sourceId, format, {
					signal: options.signal,
					localOcr,
					onProgress: (value) => {
						if (!acceptingProgress || options.signal?.aborted) return;
						const checked = extractionProgressSchema.safeParse(value);
						if (!checked.success) {
							invalidProgress = true;
							return;
						}
						progress("extracting", filePath, checked.data);
					},
				});
				acceptingProgress = false;
				assertSourceNotCancelled(options.signal);
				const checked = extractionResultSchema.safeParse(raw);
				if (!checked.success || invalidProgress) throw new SourceReadError("invalid-extraction", "The local extraction engine returned an invalid result.");
				const extraction = checked.data;
				if (extraction.status === "cancelled") throw new SourceReadError("cancelled", "Document import was cancelled.");
				if (extraction.status === "failed") {
					report.files.push({ status: "failed", filePath, format, sha256, issues: extraction.issues, analysis: null });
					return;
				}
				if (
					extraction.input.source.sourceId !== sourceId ||
					extraction.input.source.sha256 !== sha256 ||
					!z.uuid().safeParse(extraction.input.extraction.runId).success ||
					(extraction.input.extraction.version !== (localOcr ? LOCAL_OCR_VERSIONS[localOcr.model] : PDF_EXTRACTION_VERSION) &&
						!(format === "pdf" && extraction.input.extraction.version === PDF_EXTRACTION_VERSION &&
							extraction.input.pages.every(page => page.spans.every(span => span.method === "embedded-text")))) ||
					(format !== "pdf" &&
						(extraction.input.pages.length !== 1 ||
							extraction.input.pages[0].status !== "complete" ||
							extraction.input.pages[0].spans.some((span) => span.method !== "local-ocr")))
				)
					throw new SourceReadError("invalid-provenance", "The extraction does not match the selected source and execution.");
				const analysis = interpretSupportingDocument(extraction.input);
				assertSourceNotCancelled(options.signal);
				if (analysis.status === "failed") {
					report.files.push({
						status: "failed",
						filePath,
						format,
						sha256,
						analysis,
						issues: [importIssue("interpretation-failed", "The extracted source could not establish a readable supporting document; available analysis is retained.")],
					});
					return;
				}
				const record = storedSupportingDocumentSchema.parse({ id: freshId(), importedAt: new Date().toISOString(), filePath, format, result: analysis });
				assertSourceNotCancelled(options.signal);
				report.files.push({ status: "imported", record });
				seen.set(sha256, sourceId);
			} catch (error) {
				if (options.signal?.aborted || (error instanceof SourceReadError && error.code === "cancelled")) throw error;
				const detail = failureDetail(error);
				report.files.push({ status: "failed", filePath, format, sha256, analysis: null, issues: [importIssue(detail.code, detail.message)] });
			} finally {
				acceptingProgress = false;
			}
		};
		const walk = async (directoryPath: string, depth: number): Promise<void> => {
			assertSourceNotCancelled(options.signal);
			if (stopped) return;
			if (directoryPath.length > 32768) {
				limit(path.dirname(directoryPath), "path-limit", "The local path-length limit was reached; this directory was not followed.");
				return;
			}
			if (directories >= DOCUMENT_IMPORT_LIMITS.directories) {
				limit(directoryPath, "directory-limit", "The local directory-count limit was reached; remaining entries were not processed.");
				return;
			}
			directories++;
			if (depth > DOCUMENT_IMPORT_LIMITS.depth) {
				directoryIssue(directoryPath, "depth-limit", "This directory exceeds the local recursion-depth limit and was not followed.");
				return;
			}
			try {
				const before = await lstat(directoryPath, { bigint: true });
				if (!before.isDirectory() || before.isSymbolicLink()) throw new SourceReadError("linked-directory", "Choose a regular directory; linked folders are not followed.");
				const canonical = await realpath(directoryPath);
				if (!inside(canonicalRoot, canonical)) throw new SourceReadError("outside-folder", "This directory resolves outside the selected folder.");
				const after = await lstat(directoryPath, { bigint: true });
				if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
					throw new SourceReadError("source-changed", "The selected directory changed before it could be read.");
				progress("scanning", directoryPath);
				assertSourceNotCancelled(options.signal);
				const entries = [];
				for await (const entry of await opendir(directoryPath)) {
					assertSourceNotCancelled(options.signal);
					if (entries.length >= DOCUMENT_IMPORT_LIMITS.files + DOCUMENT_IMPORT_LIMITS.directories) {
						limit(directoryPath, "entry-limit", "This directory exceeds the local entry-count limit; its entries were not processed.");
						return;
					}
					entries.push(entry);
				}
				entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
				for (const entry of entries) {
					assertSourceNotCancelled(options.signal);
					if (stopped) break;
					const child = path.join(directoryPath, entry.name);
					if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child, depth + 1);
					else {
						await processFile(child);
						progress("scanning", child);
					}
				}
			} catch (error) {
				if (options.signal?.aborted || (error instanceof SourceReadError && error.code === "cancelled")) throw error;
				const detail = failureDetail(error);
				directoryIssue(directoryPath, detail.code, detail.message);
			}
		};
		try {
			assertSourceNotCancelled(options.signal);
			const root = await lstat(folderPath);
			if (!root.isDirectory() || root.isSymbolicLink()) throw new SourceReadError("invalid-source", "Choose a regular folder rather than a linked folder.");
			canonicalRoot = await realpath(folderPath);
			await walk(folderPath, 0);
			assertSourceNotCancelled(options.signal);
		} catch (error) {
			if (options.signal?.aborted || (error instanceof SourceReadError && error.code === "cancelled")) report.status = "cancelled";
			else {
				const detail = failureDetail(error);
				directoryIssue(folderPath, detail.code, detail.message);
			}
		}
		report.finishedAt = new Date(Math.max(Date.now(), Date.parse(report.startedAt))).toISOString();
		return storedDocumentImportSchema.parse(report);
	}
}
