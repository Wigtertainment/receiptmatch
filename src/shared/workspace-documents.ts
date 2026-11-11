import { z } from "zod";
import { importIssueSchema } from "./bank-import.js";
import type { ExtractionProgress } from "./pdf-extraction.js";
import { supportingDocumentSchema } from "./supporting-document.js";

// Fixed execution guards, not supported-workload or processing-time promises.
export const DOCUMENT_IMPORT_LIMITS = { files: 1000, directories: 1000, depth: 64 } as const;
export const documentFormatSchema = z.enum(["pdf", "png", "jpeg"]);
const localPath = z
	.string()
	.min(1)
	.max(32768)
	.refine((value) => !value.includes("\0") && /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceId = z.string().min(1).max(128);
const issues = z.array(importIssueSchema).min(1).max(1000);
export const storedSupportingDocumentSchema = z
	.strictObject({
		id: z.uuid(),
		importedAt: z.iso.datetime(),
		filePath: localPath,
		format: documentFormatSchema,
		result: supportingDocumentSchema,
	})
	.superRefine((record, ctx) => {
		if (
			!["complete", "partial"].includes(record.result.status) ||
			!record.result.input ||
			!z.uuid().safeParse(record.result.input.source.sourceId).success ||
			!z.uuid().safeParse(record.result.input.extraction.runId).success ||
			record.id.toLowerCase() === record.result.input.source.sourceId.toLowerCase()
		) {
			ctx.addIssue({ code: "custom", message: "Retained documents require parsed results and distinct host-owned document/source identities." });
		}
		if (
			record.format !== "pdf" &&
			record.result.input &&
			(record.result.input.pages.length !== 1 ||
				record.result.input.pages[0].status !== "complete" ||
				record.result.input.pages[0].spans.some((span) => span.method !== "local-ocr"))
		)
			ctx.addIssue({ code: "custom", message: "Image documents require one complete page with local OCR evidence." });
	});
const fileResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("imported"), record: storedSupportingDocumentSchema }),
	z.strictObject({ status: z.literal("skipped"), filePath: localPath, sha256: hash, existingSourceId: sourceId }),
	z.strictObject({ status: z.literal("unsupported"), filePath: localPath, issues }),
	z.strictObject({
		status: z.literal("failed"),
		filePath: localPath,
		format: documentFormatSchema.nullable(),
		sha256: hash.nullable(),
		issues,
		analysis: supportingDocumentSchema.nullable(),
	}),
]);
function normalized(value: string) {
	const absolute = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	return /^(?:[A-Za-z]:|\/\/)/.test(absolute) ? absolute.toLowerCase() : absolute;
}
function within(folder: string, file: string) {
	const root = normalized(folder),
		target = normalized(file);
	return !target.split("/").some((part) => part === "." || part === "..") && (target === root || target.startsWith(root === "/" ? "/" : root + "/"));
}
export const storedDocumentImportSchema = z
	.strictObject({
		id: z.uuid(),
		folderPath: localPath,
		startedAt: z.iso.datetime(),
		finishedAt: z.iso.datetime(),
		status: z.enum(["finished", "cancelled"]),
		files: z.array(fileResult).max(DOCUMENT_IMPORT_LIMITS.files),
		directoryIssues: z.array(z.strictObject({ directoryPath: localPath, code: z.string().min(1).max(80), message: z.string().min(1).max(512) })).max(2000),
	})
	.superRefine((record, ctx) => {
		const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
		if (record.finishedAt < record.startedAt) invalid("A document import cannot finish before it starts.");
		const identities = new Set([record.id.toLowerCase()]),
			paths = new Set<string>(),
			importedHashes = new Set<string>();
		const importedSources = new Map(
			record.files.flatMap((file) =>
				file.status === "imported" && file.record.result.input ? [[file.record.result.input.source.sourceId, file.record.result.input.source.sha256] as const] : [],
			),
		);
		const seenSources = new Map<string, string>();
		const ownIdentity = (id: string) => {
			if (identities.has(id.toLowerCase())) invalid("Document import identities must be distinct.");
			identities.add(id.toLowerCase());
		};
		for (const file of record.files) {
			const filePath = file.status === "imported" ? file.record.filePath : file.filePath;
			if (!within(record.folderPath, filePath) || normalized(filePath) === normalized(record.folderPath) || paths.has(normalized(filePath)))
				invalid("Every file needs one distinct path inside the selected folder.");
			paths.add(normalized(filePath));
			if (file.status === "imported" && file.record.result.input) {
				ownIdentity(file.record.id);
				ownIdentity(file.record.result.input.source.sourceId);
				const source = file.record.result.input.source;
				if (importedHashes.has(source.sha256)) invalid("Content-identical successful files must be skipped.");
				importedHashes.add(source.sha256);
				seenSources.set(source.sourceId, source.sha256);
			} else if (file.status === "skipped") {
				if (seenSources.has(file.existingSourceId) && seenSources.get(file.existingSourceId) !== file.sha256)
					invalid("Skipped content must match its referenced source hash.");
				if (importedSources.has(file.existingSourceId) && !seenSources.has(file.existingSourceId))
					invalid("A skipped file cannot reference a later import from the same run.");
				seenSources.set(file.existingSourceId, file.sha256);
				importedHashes.add(file.sha256);
			} else if (file.status === "failed" && file.analysis) {
				if (file.analysis.status !== "failed") invalid("Failed file analysis cannot claim a successful interpretation.");
				if (file.analysis.input) {
					if (!z.uuid().safeParse(file.analysis.input.source.sourceId).success || file.sha256 !== file.analysis.input.source.sha256)
						invalid("Failed analysis needs matching source provenance.");
					ownIdentity(file.analysis.input.source.sourceId);
				}
			}
		}
		for (const file of record.files)
			if (file.status === "skipped" && identities.has(file.existingSourceId.toLowerCase()) && !importedSources.has(file.existingSourceId)) {
				invalid("Skipped files cannot reference report, document or failed-analysis identities.");
			}
		for (const issue of record.directoryIssues) if (!within(record.folderPath, issue.directoryPath)) invalid("Directory issues must reference the selected folder tree.");
	});

export type DocumentFormat = z.infer<typeof documentFormatSchema>;
export type StoredSupportingDocument = z.infer<typeof storedSupportingDocumentSchema>;
export type StoredDocumentImport = z.infer<typeof storedDocumentImportSchema>;
export type DocumentFileResult = z.infer<typeof fileResult>;
export interface WorkspaceSource {
	id: string;
	filePath: string;
	sha256: string | null;
}
export interface DocumentImportProgress {
	phase: "scanning" | "extracting";
	filePath: string | null;
	completedFiles: number;
	extraction: ExtractionProgress | null;
}
