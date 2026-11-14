import type { BankImportInput, ImportIssue, ImportPage, PositionedSpan } from "../../src/shared/bank-import.js";
import type { SupportingDocument } from "../../src/shared/supporting-document.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
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
import type { Stats } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { BigIntStats } from 'node:fs';

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
function inside(root: string, target: string): boolean {
	const relative: string = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function failureDetail(error: unknown): { code: string; message: string; } {
	return error instanceof SourceReadError
		? { code: error.code, message: error.message }
		: { code: "source-unavailable", message: "The local file or folder could not be read safely." };
}

function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (error instanceof SourceReadError && error.code === "cancelled");
}

function assertExtractionProvenance(input: BankImportInput, sourceId: string, sha256: string, format: 'pdf' | 'png' | 'jpeg', localOcr: LocalDocumentOcr | undefined): void {
	const expectedVersion: string = localOcr ? LOCAL_OCR_VERSIONS[localOcr.model] : PDF_EXTRACTION_VERSION;
	const validVersion: boolean = input.extraction.version === expectedVersion || isEmbeddedPdfExtraction(input, format);
	const validImage: boolean = format === 'pdf' || isCompleteImageExtraction(input);
	if (input.source.sourceId !== sourceId || input.source.sha256 !== sha256 || !z.uuid().safeParse(input.extraction.runId).success || !validVersion || !validImage) {
		throw new SourceReadError("invalid-provenance", "The extraction does not match the selected source and execution.");
	}
}

function isEmbeddedPdfExtraction(input: BankImportInput, format: 'pdf' | 'png' | 'jpeg'): boolean {
	return format === 'pdf' && input.extraction.version === PDF_EXTRACTION_VERSION &&
		input.pages.every((page: ImportPage): boolean => page.spans.every((span: PositionedSpan): boolean => span.method === 'embedded-text'));
}

function isCompleteImageExtraction(input: BankImportInput): boolean {
	return input.pages.length === 1 && input.pages[0].status === 'complete' &&
		input.pages[0].spans.every((span: PositionedSpan): boolean => span.method === 'local-ocr');
}

async function verifyDirectoryPath(directoryPath: string, canonicalRoot: string): Promise<void> {
	const before: BigIntStats = await lstat(directoryPath, { bigint: true });
	if (!before.isDirectory() || before.isSymbolicLink()) {
		throw new SourceReadError("linked-directory", "Choose a regular directory; linked folders are not followed.");
	}
	const canonical: string = await realpath(directoryPath);
	if (!inside(canonicalRoot, canonical)) {
		throw new SourceReadError("outside-folder", "This directory resolves outside the selected folder.");
	}
	const after: BigIntStats = await lstat(directoryPath, { bigint: true });
	if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
			throw new SourceReadError("source-changed", "The selected directory changed before it could be read.");
		}
}

export class FolderDocumentImportService implements DocumentImportService {
	constructor(private readonly dependencies: DocumentImportDependencies) {}

	async run(options: DocumentImportOptions): Promise<StoredDocumentImport | null> {
		if (options.signal?.aborted) {
			return null;
		}
		const selected: string | null = await this.dependencies.choose();
		if (selected === null) {
			return null;
		}
		if (!path.isAbsolute(selected) || selected.length > 32768 || selected.includes("\0")) {
				throw new SourceReadError("invalid-source", "Choose an absolute local folder using the document dialog.");
			}
		const folderPath: string = path.resolve(selected),
			identities: Set<string> = new Set(options.existingSources.map((source: WorkspaceSource): string => source.id.toLowerCase()));
		const localOcr: LocalDocumentOcr | undefined = await this.dependencies.localOcr?.();
		const freshId: () => string = (): string => {
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
		const seen: Map<string, string> = new Map(options.existingSources.filter((source: WorkspaceSource): boolean => source.sha256 !== null).map((source: WorkspaceSource): [string, string] => [source.sha256!, source.id]));
		let canonicalRoot: string = "",
			directories: number = 0,
			stopped: boolean = false;
		const progress: (phase: DocumentImportProgress["phase"], filePath?: string | null, extraction?: ExtractionProgress | null) => void = (phase: DocumentImportProgress["phase"], filePath: string | null = null, extraction: ExtractionProgress | null = null): void => {
			if (!options.signal?.aborted) {
				options.onProgress?.({ phase, filePath, completedFiles: report.files.length, extraction });
			}
		};

		const directoryIssue: (directoryPath: string, code: string, message: string) => void = (directoryPath: string, code: string, message: string): void => {
			report.directoryIssues.push({ directoryPath, code, message });
		};

		const limit: (directoryPath: string, code: string, message: string) => void = (directoryPath: string, code: string, message: string): void => {
			stopped = true;
			directoryIssue(directoryPath, code, message);
		};

		const processFile: (filePath: string) => Promise<void> = async (filePath: string): Promise<void> => {
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
			const format: "png" | "jpeg" | "pdf" = formats[path.extname(filePath).toLowerCase()] ?? null;
			let acceptingProgress: boolean = false,
				invalidProgress: boolean = false;
			try {
				const entry: BigIntStats = await lstat(filePath, { bigint: true });
				if (entry.isSymbolicLink()) {
					report.files.push({ status: "unsupported", filePath, issues: [importIssue("linked-source", "Linked files or folders are not followed.")] });
					return;
				}
				if (!entry.isFile()) {
					throw new SourceReadError("invalid-source", "This entry is not a regular document file.");
				}
				const canonical: string = await realpath(filePath);
				if (!inside(canonicalRoot, canonical)) {
					throw new SourceReadError("outside-folder", "The source resolves outside the selected folder.");
				}
				if (!format) {
					report.files.push({ status: "unsupported", filePath, issues: [importIssue("unsupported-format", "Only PDF, PNG and JPEG documents are supported.")] });
					return;
				}
				const bytes: Uint8Array<ArrayBufferLike> = await readSourceSnapshot(canonical, Object.keys(formats), options.signal, entry);
				if ((await realpath(filePath)) !== canonical || (await lstat(filePath)).isSymbolicLink()) {
						throw new SourceReadError("source-changed", "The selected source path changed while it was being read.");
					}
				sha256 = createHash("sha256").update(bytes).digest("hex");
				assertSourceNotCancelled(options.signal);
				const existingSourceId: string | undefined = seen.get(sha256);
				if (existingSourceId) {
					report.files.push({ status: "skipped", filePath, sha256, existingSourceId });
					return;
				}
				const sourceId: string = freshId();
				acceptingProgress = true;
				progress("extracting", filePath);
				assertSourceNotCancelled(options.signal);
				const raw: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = await this.dependencies.extract(bytes, sourceId, format, {
					signal: options.signal,
					localOcr,
					onProgress: (value: ExtractionProgress): void => {
						if (!acceptingProgress || options.signal?.aborted) {
							return;
						}
						const checked: z.ZodSafeParseResult<ExtractionProgress> = extractionProgressSchema.safeParse(value);
						if (!checked.success) {
							invalidProgress = true;
							return;
						}
						progress("extracting", filePath, checked.data);
					},
				});
				acceptingProgress = false;
				assertSourceNotCancelled(options.signal);
				const checked: z.ZodSafeParseResult<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> = extractionResultSchema.safeParse(raw);
				if (!checked.success || invalidProgress) {
					throw new SourceReadError("invalid-extraction", "The local extraction engine returned an invalid result.");
				}
				const extraction: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = checked.data;
				if (extraction.status === "cancelled") {
					throw new SourceReadError("cancelled", "Document import was cancelled.");
				}
				if (extraction.status === "failed") {
					report.files.push({ status: "failed", filePath, format, sha256, issues: extraction.issues, analysis: null });
					return;
				}
				assertExtractionProvenance(extraction.input, sourceId, sha256, format, localOcr);
				const analysis: SupportingDocument = interpretSupportingDocument(extraction.input);
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
				const record: StoredSupportingDocument = storedSupportingDocumentSchema.parse({ id: freshId(), importedAt: new Date().toISOString(), filePath, format, result: analysis });
				assertSourceNotCancelled(options.signal);
				report.files.push({ status: "imported", record });
				seen.set(sha256, sourceId);
			} catch (error: unknown) {
				if (isCancelled(error, options.signal)) {
					throw error;
				}
				const detail: { code: string; message: string; } = failureDetail(error);
				report.files.push({ status: "failed", filePath, format, sha256, analysis: null, issues: [importIssue(detail.code, detail.message)] });
			} finally {
				acceptingProgress = false;
			}
		};

		async function readDirectoryEntries(directoryPath: string): Promise<Dirent<string>[] | null> {
			const entries: Dirent<string>[] = [];
			for await (const entry of await opendir(directoryPath)) {
				assertSourceNotCancelled(options.signal);
				if (entries.length >= DOCUMENT_IMPORT_LIMITS.files + DOCUMENT_IMPORT_LIMITS.directories) {
					limit(directoryPath, "entry-limit", "This directory exceeds the local entry-count limit; its entries were not processed.");
					return null;
				}
				entries.push(entry);
			}
			return entries;
		}

		const walk: (directoryPath: string, depth: number) => Promise<void> = async (directoryPath: string, depth: number): Promise<void> => {
			assertSourceNotCancelled(options.signal);
			if (stopped) {
				return;
			}
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
				await verifyDirectoryPath(directoryPath, canonicalRoot);
				progress("scanning", directoryPath);
				assertSourceNotCancelled(options.signal);
				const entries: Dirent<string>[] | null = await readDirectoryEntries(directoryPath);
				if (!entries) {
					return;
				}
				entries.sort((a: Dirent<string>, b: Dirent<string>): 0 | 1 | -1 => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
				for (const entry of entries) {
					assertSourceNotCancelled(options.signal);
					if (stopped) {
						break;
					}
					const child: string = path.join(directoryPath, entry.name);
					if (entry.isDirectory() && !entry.isSymbolicLink()) {
						await walk(child, depth + 1);
					} else {
						await processFile(child);
						progress("scanning", child);
					}
				}
			} catch (error: unknown) {
				if (isCancelled(error, options.signal)) {
					throw error;
				}
				const detail: { code: string; message: string; } = failureDetail(error);
				directoryIssue(directoryPath, detail.code, detail.message);
			}
		};
		try {
			assertSourceNotCancelled(options.signal);
			const root: Stats = await lstat(folderPath);
			if (!root.isDirectory() || root.isSymbolicLink()) {
				throw new SourceReadError("invalid-source", "Choose a regular folder rather than a linked folder.");
			}
			canonicalRoot = await realpath(folderPath);
			await walk(folderPath, 0);
			assertSourceNotCancelled(options.signal);
		} catch (error: unknown) {
			if (isCancelled(error, options.signal)) {
				report.status = "cancelled";
			} else {
				const detail: { code: string; message: string; } = failureDetail(error);
				directoryIssue(folderPath, detail.code, detail.message);
			}
		}
		report.finishedAt = new Date(Math.max(Date.now(), Date.parse(report.startedAt))).toISOString();
		return storedDocumentImportSchema.parse(report);
	}
}
