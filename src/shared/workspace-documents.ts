import type { SupportingDocument } from "./supporting-document.js";
import type { PositionedSpan } from "./bank-import.js";
import { z } from "zod";
import { importIssueSchema } from "./bank-import.js";
import type { ExtractionProgress } from "./pdf-extraction.js";
import { hasManualDocumentFields, supportingDocumentSchema } from "./supporting-document.js";

interface IDocumentImportLimits {
	readonly files: 1000;
	readonly directories: 1000;
	readonly depth: 64;
}

// Fixed execution guards, not supported-workload or processing-time promises.
export const DOCUMENT_IMPORT_LIMITS: IDocumentImportLimits = { files: 1000, directories: 1000, depth: 64 } as const;
export const documentFormatSchema: z.ZodEnum<z.core.util.ToEnum<"pdf" | "png" | "jpeg">> = z.enum(["pdf", "png", "jpeg"]);
const localPath: z.ZodString = z
	.string()
	.min(1)
	.max(32768)
	.refine((value: string): boolean => !value.includes("\0") && /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value));
const hash: z.ZodString = z.string().regex(/^[a-f0-9]{64}$/);
const sourceId: z.ZodString = z.string().min(1).max(128);
const issues: z.ZodArray<typeof importIssueSchema> = z.array(importIssueSchema).min(1).max(1000);

type SupportingDocumentShape = typeof supportingDocumentSchema.shape;
type SupportingDocumentSectionShape = SupportingDocumentShape["sections"]["element"]["shape"];
type CorrectableSectionField = "amounts" | "dates" | "merchants" | "references" | "currencies";
// Stored originals exclude review markers, as enforced by the manifest refinements below.
type OriginalFieldArray<Shape extends z.core.$ZodShape> = z.ZodArray<z.ZodObject<Omit<Shape, "confirmedByUser" | "correctedByUser">, z.core.$strict>>;

interface IOriginalDocumentSectionShape extends Omit<SupportingDocumentSectionShape, CorrectableSectionField> {
	amounts: OriginalFieldArray<SupportingDocumentSectionShape["amounts"]["element"]["shape"]>;
	dates: OriginalFieldArray<SupportingDocumentSectionShape["dates"]["element"]["shape"]>;
	merchants: OriginalFieldArray<SupportingDocumentSectionShape["merchants"]["element"]["shape"]>;
	references: OriginalFieldArray<SupportingDocumentSectionShape["references"]["element"]["shape"]>;
	currencies: OriginalFieldArray<SupportingDocumentSectionShape["currencies"]["element"]["shape"]>;
}

interface IOriginalDocumentShape extends Omit<SupportingDocumentShape, "sections"> {
	sections: z.ZodArray<z.ZodObject<z.core.util.Flatten<IOriginalDocumentSectionShape>, z.core.$strict>>;
}

type OriginalDocumentSchema = z.ZodObject<z.core.util.Flatten<IOriginalDocumentShape>, z.core.$strict>;

interface IStoredSupportingDocumentShape {
	id: z.ZodUUID;
	importedAt: z.ZodISODateTime;
	filePath: typeof localPath;
	format: typeof documentFormatSchema;
	result: OriginalDocumentSchema;
}

type StoredSupportingDocumentSchemaType = z.ZodObject<z.core.util.Flatten<IStoredSupportingDocumentShape>, z.core.$strict>;
export const storedSupportingDocumentSchema: StoredSupportingDocumentSchemaType = z
	.strictObject({
		id: z.uuid(),
		importedAt: z.iso.datetime(),
		filePath: localPath,
		format: documentFormatSchema,
		result: supportingDocumentSchema,
	})
	.superRefine((record: z.output<StoredSupportingDocumentSchemaType>, ctx: z.RefinementCtx): void => {
		if (hasManualDocumentFields(record.result)) {
			ctx.addIssue({ code: "custom", message: "Original document manifests cannot contain manual correction markers." });
		}
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
				record.result.input.pages[0].spans.some((span: PositionedSpan): boolean => span.method !== "local-ocr"))
		) {
				ctx.addIssue({ code: "custom", message: "Image documents require one complete page with local OCR evidence." });
			}
	});

interface IImportedDocumentFileShape {
	status: z.ZodLiteral<"imported">;
	record: typeof storedSupportingDocumentSchema;
}

interface ISkippedDocumentFileShape {
	status: z.ZodLiteral<"skipped">;
	filePath: typeof localPath;
	sha256: typeof hash;
	existingSourceId: typeof sourceId;
}

interface IUnsupportedDocumentFileShape {
	status: z.ZodLiteral<"unsupported">;
	filePath: typeof localPath;
	issues: typeof issues;
}

interface IFailedDocumentFileShape {
	status: z.ZodLiteral<"failed">;
	filePath: typeof localPath;
	format: z.ZodNullable<typeof documentFormatSchema>;
	sha256: z.ZodNullable<typeof hash>;
	issues: typeof issues;
	analysis: z.ZodNullable<OriginalDocumentSchema>;
}

type FileResultType = z.ZodDiscriminatedUnion<[
	z.ZodObject<z.core.util.Flatten<IImportedDocumentFileShape>, z.core.$strict>,
	z.ZodObject<z.core.util.Flatten<ISkippedDocumentFileShape>, z.core.$strict>,
	z.ZodObject<z.core.util.Flatten<IUnsupportedDocumentFileShape>, z.core.$strict>,
	z.ZodObject<z.core.util.Flatten<IFailedDocumentFileShape>, z.core.$strict>
], "status">;
const fileResult: FileResultType = z.discriminatedUnion("status", [
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
function normalized(value: string): string {
	const absolute: string = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	return /^(?:[A-Za-z]:|\/\/)/.test(absolute) ? absolute.toLowerCase() : absolute;
}

function within(folder: string, file: string): boolean {
	const root: string = normalized(folder),
		target: string = normalized(file);
	return !target.split("/").some((part: string): part is "." | ".." => part === "." || part === "..") && (target === root || target.startsWith(root === "/" ? "/" : root + "/"));
}

interface IDirectoryIssueShape {
	directoryPath: typeof localPath;
	code: z.ZodString;
	message: z.ZodString;
}

interface IStoredDocumentImportShape {
	id: z.ZodUUID;
	folderPath: typeof localPath;
	startedAt: z.ZodISODateTime;
	finishedAt: z.ZodISODateTime;
	status: z.ZodEnum<z.core.util.ToEnum<"cancelled" | "finished">>;
	files: z.ZodArray<typeof fileResult>;
	directoryIssues: z.ZodArray<z.ZodObject<z.core.util.Flatten<IDirectoryIssueShape>, z.core.$strict>>;
}

type StoredDocumentImportSchemaType = z.ZodObject<z.core.util.Flatten<IStoredDocumentImportShape>, z.core.$strict>;
export const storedDocumentImportSchema: StoredDocumentImportSchemaType = z
	.strictObject({
		id: z.uuid(),
		folderPath: localPath,
		startedAt: z.iso.datetime(),
		finishedAt: z.iso.datetime(),
		status: z.enum(["finished", "cancelled"]),
		files: z.array(fileResult).max(DOCUMENT_IMPORT_LIMITS.files),
		directoryIssues: z.array(z.strictObject({ directoryPath: localPath, code: z.string().min(1).max(80), message: z.string().min(1).max(512) })).max(2000),
	})
	.superRefine((record: z.output<StoredDocumentImportSchemaType>, ctx: z.RefinementCtx): void => {
		if (record.files.some((file: DocumentFileResult): boolean => file.status === "failed" && !!file.analysis && hasManualDocumentFields(file.analysis))) {
			ctx.addIssue({ code: "custom", message: "Original document manifests cannot contain manual correction markers." });
		}
		const invalid: (message: string) => void = (message: string): void => ctx.addIssue({ code: "custom", message });
		if (record.finishedAt < record.startedAt) {
			invalid("A document import cannot finish before it starts.");
		}
		const identities: Set<string> = new Set([record.id.toLowerCase()]),
			paths: Set<string> = new Set<string>(),
			importedHashes: Set<string> = new Set<string>();
		const importedSources: Map<string, string> = new Map(
			record.files.flatMap((file: DocumentFileResult): [] | [readonly [string, string]] =>
				file.status === "imported" && file.record.result.input ? [[file.record.result.input.source.sourceId, file.record.result.input.source.sha256] as const] : [],
			),
		);
		const seenSources: Map<string, string> = new Map<string, string>();
		const ownIdentity: (id: string) => void = (id: string): void => {
			if (identities.has(id.toLowerCase())) {
				invalid("Document import identities must be distinct.");
			}
			identities.add(id.toLowerCase());
		};
		for (const file of record.files) {
			const filePath: string = file.status === "imported" ? file.record.filePath : file.filePath;
			if (!within(record.folderPath, filePath) || normalized(filePath) === normalized(record.folderPath) || paths.has(normalized(filePath))) {
					invalid("Every file needs one distinct path inside the selected folder.");
				}
			paths.add(normalized(filePath));
			checkFileProvenance(file, importedSources, seenSources, importedHashes, ownIdentity, invalid);
		}
		for (const file of record.files) {
				if (file.status === "skipped" && identities.has(file.existingSourceId.toLowerCase()) && !importedSources.has(file.existingSourceId)) {
				invalid("Skipped files cannot reference report, document or failed-analysis identities.");
			}
			}
		for (const issue of record.directoryIssues) {
			if (!within(record.folderPath, issue.directoryPath)) {
				invalid("Directory issues must reference the selected folder tree.");
			}
		}
	});

function checkFileProvenance(file: DocumentFileResult, importedSources: ReadonlyMap<string, string>, seenSources: Map<string, string>,
	importedHashes: Set<string>, ownIdentity: (id: string) => void, invalid: (message: string) => void): void {
	if (file.status === "imported" && file.record.result.input) {
		ownIdentity(file.record.id);
		ownIdentity(file.record.result.input.source.sourceId);
		const source: NonNullable<SupportingDocument["input"]>["source"] = file.record.result.input.source;
		if (importedHashes.has(source.sha256)) {
			invalid("Content-identical successful files must be skipped.");
		}
		importedHashes.add(source.sha256);
		seenSources.set(source.sourceId, source.sha256);
	} else if (file.status === "skipped") {
		if (seenSources.has(file.existingSourceId) && seenSources.get(file.existingSourceId) !== file.sha256) {
				invalid("Skipped content must match its referenced source hash.");
			}
		if (importedSources.has(file.existingSourceId) && !seenSources.has(file.existingSourceId)) {
				invalid("A skipped file cannot reference a later import from the same run.");
			}
		seenSources.set(file.existingSourceId, file.sha256);
		importedHashes.add(file.sha256);
	} else if (file.status === "failed" && file.analysis) {
		checkFailedAnalysis(file.analysis, file.sha256, ownIdentity, invalid);
	}
}

function checkFailedAnalysis(analysis: SupportingDocument, sha256: string | null, ownIdentity: (id: string) => void, invalid: (message: string) => void): void {
	if (analysis.status !== "failed") {
		invalid("Failed file analysis cannot claim a successful interpretation.");
	}
	if (analysis.input) {
		if (!z.uuid().safeParse(analysis.input.source.sourceId).success || sha256 !== analysis.input.source.sha256) {
				invalid("Failed analysis needs matching source provenance.");
			}
		ownIdentity(analysis.input.source.sourceId);
	}
}

export type DocumentFormat = z.infer<typeof documentFormatSchema>;
export type StoredSupportingDocument = z.infer<typeof storedSupportingDocumentSchema>;
export type StoredDocumentImport = z.infer<typeof storedDocumentImportSchema>;
export type DocumentFileResult = z.infer<typeof fileResult>;
export interface IWorkspaceSource {
	id: string;
	filePath: string;
	sha256: string | null;
}
export interface IDocumentImportProgress {
	phase: "scanning" | "extracting";
	filePath: string | null;
	completedFiles: number;
	extraction: ExtractionProgress | null;
}
