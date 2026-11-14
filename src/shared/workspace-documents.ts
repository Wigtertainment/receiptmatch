import type { SupportingDocument } from "./supporting-document.js";
import type { ImportIssue, PositionedSpan } from "./bank-import.js";
import { z } from "zod";
import { importIssueSchema } from "./bank-import.js";
import type { ExtractionProgress } from "./pdf-extraction.js";
import { supportingDocumentSchema } from "./supporting-document.js";

// Fixed execution guards, not supported-workload or processing-time promises.
export const DOCUMENT_IMPORT_LIMITS: { readonly files: 1000; readonly directories: 1000; readonly depth: 64; } = { files: 1000, directories: 1000, depth: 64 } as const;
export const documentFormatSchema: z.ZodEnum<{ png: "png"; pdf: "pdf"; jpeg: "jpeg"; }> = z.enum(["pdf", "png", "jpeg"]);
const localPath: z.ZodString = z
	.string()
	.min(1)
	.max(32768)
	.refine((value: string): boolean => !value.includes("\0") && /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value));
const hash: z.ZodString = z.string().regex(/^[a-f0-9]{64}$/);
const sourceId: z.ZodString = z.string().min(1).max(128);
type IssuesType = z.ZodArray<z.ZodObject<{
	code: z.ZodString;
	severity: z.ZodEnum<{
		error: "error";
		warning: "warning";
	}>;
	message: z.ZodString;
	pageId: z.ZodNullable<z.ZodString>;
	rowId: z.ZodNullable<z.ZodString>;
	field: z.ZodNullable<z.ZodString>;
	evidence: z.ZodArray<z.ZodObject<{
		pageId: z.ZodString;
		region: z.ZodObject<{
			x: z.ZodNumber;
			y: z.ZodNumber;
			width: z.ZodNumber;
			height: z.ZodNumber;
		}, z.core.$strict>;
		rawText: z.ZodString;
		method: z.ZodEnum<{
			"embedded-text": "embedded-text";
			"local-ocr": "local-ocr";
		}>;
	}, z.core.$strict>>;
}, z.core.$strict>>;
const issues: IssuesType = z.array(importIssueSchema).min(1).max(1000);
type StoredSupportingDocumentSchemaType = z.ZodObject<{
	id: z.ZodUUID;
	importedAt: z.ZodISODateTime;
	filePath: z.ZodString;
	format: z.ZodEnum<{
		png: "png";
		pdf: "pdf";
		jpeg: "jpeg";
	}>;
	result: z.ZodObject<{
		contractVersion: z.ZodLiteral<"1">;
		parserVersion: z.ZodEnum<{
			1: "1";
			2: "2";
		}>;
		status: z.ZodEnum<{
			complete: "complete";
			failed: "failed";
			partial: "partial";
		}>;
		input: z.ZodNullable<z.ZodObject<{
			source: z.ZodObject<{
				sourceId: z.ZodString;
				sha256: z.ZodString;
			}, z.core.$strict>;
			extraction: z.ZodObject<{
				runId: z.ZodString;
				version: z.ZodString;
			}, z.core.$strict>;
			pages: z.ZodArray<z.ZodObject<{
				pageId: z.ZodString;
				pageNumber: z.ZodNumber;
				width: z.ZodNumber;
				height: z.ZodNumber;
				status: z.ZodEnum<{
					complete: "complete";
					failed: "failed";
				}>;
				spans: z.ZodArray<z.ZodObject<{
					text: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			issues: typeof issues;
		}, z.core.$strict>>;
		sections: z.ZodArray<z.ZodObject<{
			sectionId: z.ZodString;
			kind: z.ZodEnum<{
				unknown: "unknown";
				invoice: "invoice";
				receipt: "receipt";
				"billing-summary": "billing-summary";
				"credit-note": "credit-note";
				"payment-information": "payment-information";
			}>;
			pageIds: z.ZodArray<z.ZodString>;
			evidence: z.ZodArray<z.ZodObject<{
				pageId: z.ZodString;
				region: z.ZodObject<{
					x: z.ZodNumber;
					y: z.ZodNumber;
					width: z.ZodNumber;
					height: z.ZodNumber;
				}, z.core.$strict>;
				rawText: z.ZodString;
				method: z.ZodEnum<{
					"embedded-text": "embedded-text";
					"local-ocr": "local-ocr";
				}>;
			}, z.core.$strict>>;
			amounts: z.ZodArray<z.ZodObject<{
				role: z.ZodEnum<{
					unknown: "unknown";
					"billed-total": "billed-total";
					"balance-due": "balance-due";
					payment: "payment";
					"refund-payment": "refund-payment";
					"credit-note-component": "credit-note-component";
					"informational-fx": "informational-fx";
					tax: "tax";
					subtotal: "subtotal";
					"line-item": "line-item";
				}>;
				candidates: z.ZodArray<z.ZodObject<{
					coefficient: z.ZodString;
					scale: z.ZodNumber;
					currency: z.ZodNullable<z.ZodString>;
				}, z.core.$strict>>;
				id: z.ZodString;
				label: z.ZodString;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			dates: z.ZodArray<z.ZodObject<{
				role: z.ZodEnum<{
					unknown: "unknown";
					payment: "payment";
					issue: "issue";
					due: "due";
					"service-period": "service-period";
					"service-start": "service-start";
					"service-end": "service-end";
				}>;
				candidates: z.ZodArray<z.ZodISODate>;
				id: z.ZodString;
				label: z.ZodString;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			merchants: z.ZodArray<z.ZodObject<{
				role: z.ZodLiteral<"merchant">;
				candidates: z.ZodArray<z.ZodString>;
				id: z.ZodString;
				label: z.ZodString;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			references: z.ZodArray<z.ZodObject<{
				role: z.ZodEnum<{
					unknown: "unknown";
					payment: "payment";
					invoice: "invoice";
					receipt: "receipt";
					order: "order";
					customer: "customer";
					account: "account";
					table: "table";
					"related-invoice": "related-invoice";
				}>;
				candidates: z.ZodArray<z.ZodString>;
				id: z.ZodString;
				label: z.ZodString;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			currencies: z.ZodArray<z.ZodObject<{
				role: z.ZodEnum<{
					unknown: "unknown";
					"informational-fx": "informational-fx";
					settlement: "settlement";
				}>;
				candidates: z.ZodArray<z.ZodString>;
				id: z.ZodString;
				label: z.ZodString;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
		}, z.core.$strict>>;
		issues: z.ZodArray<z.ZodObject<{
			code: z.ZodString;
			severity: z.ZodEnum<{
				error: "error";
				warning: "warning";
			}>;
			message: z.ZodString;
			sectionId: z.ZodNullable<z.ZodString>;
			fieldId: z.ZodNullable<z.ZodString>;
			field: z.ZodNullable<z.ZodString>;
			evidence: z.ZodArray<z.ZodObject<{
				pageId: z.ZodString;
				region: z.ZodObject<{
					x: z.ZodNumber;
					y: z.ZodNumber;
					width: z.ZodNumber;
					height: z.ZodNumber;
				}, z.core.$strict>;
				rawText: z.ZodString;
				method: z.ZodEnum<{
					"embedded-text": "embedded-text";
					"local-ocr": "local-ocr";
				}>;
			}, z.core.$strict>>;
		}, z.core.$strict>>;
	}, z.core.$strict>;
}, z.core.$strict>;
export const storedSupportingDocumentSchema: StoredSupportingDocumentSchemaType = z
	.strictObject({
		id: z.uuid(),
		importedAt: z.iso.datetime(),
		filePath: localPath,
		format: documentFormatSchema,
		result: supportingDocumentSchema,
	})
	.superRefine((record: z.output<StoredSupportingDocumentSchemaType>, ctx: z.RefinementCtx): void => {
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
type FileResultType = z.ZodDiscriminatedUnion<[
	z.ZodObject<{
		status: z.ZodLiteral<"imported">;
		record: typeof storedSupportingDocumentSchema;
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"skipped">;
		filePath: z.ZodString;
		sha256: z.ZodString;
		existingSourceId: z.ZodString;
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"unsupported">;
		filePath: z.ZodString;
		issues: typeof issues;
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"failed">;
		filePath: z.ZodString;
		format: z.ZodNullable<z.ZodEnum<{
			png: "png";
			pdf: "pdf";
			jpeg: "jpeg";
		}>>;
		sha256: z.ZodNullable<z.ZodString>;
		issues: typeof issues;
		analysis: z.ZodNullable<z.ZodObject<{
			contractVersion: z.ZodLiteral<"1">;
			parserVersion: z.ZodEnum<{
				1: "1";
				2: "2";
			}>;
			status: z.ZodEnum<{
				complete: "complete";
				failed: "failed";
				partial: "partial";
			}>;
			input: z.ZodNullable<z.ZodObject<{
				source: z.ZodObject<{
					sourceId: z.ZodString;
					sha256: z.ZodString;
				}, z.core.$strict>;
				extraction: z.ZodObject<{
					runId: z.ZodString;
					version: z.ZodString;
				}, z.core.$strict>;
				pages: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					pageNumber: z.ZodNumber;
					width: z.ZodNumber;
					height: z.ZodNumber;
					status: z.ZodEnum<{
						complete: "complete";
						failed: "failed";
					}>;
					spans: z.ZodArray<z.ZodObject<{
						text: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
				issues: typeof issues;
			}, z.core.$strict>>;
			sections: z.ZodArray<z.ZodObject<{
				sectionId: z.ZodString;
				kind: z.ZodEnum<{
					unknown: "unknown";
					invoice: "invoice";
					receipt: "receipt";
					"billing-summary": "billing-summary";
					"credit-note": "credit-note";
					"payment-information": "payment-information";
				}>;
				pageIds: z.ZodArray<z.ZodString>;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
				amounts: z.ZodArray<z.ZodObject<{
					role: z.ZodEnum<{
						unknown: "unknown";
						"billed-total": "billed-total";
						"balance-due": "balance-due";
						payment: "payment";
						"refund-payment": "refund-payment";
						"credit-note-component": "credit-note-component";
						"informational-fx": "informational-fx";
						tax: "tax";
						subtotal: "subtotal";
						"line-item": "line-item";
					}>;
					candidates: z.ZodArray<z.ZodObject<{
						coefficient: z.ZodString;
						scale: z.ZodNumber;
						currency: z.ZodNullable<z.ZodString>;
					}, z.core.$strict>>;
					id: z.ZodString;
					label: z.ZodString;
					evidence: z.ZodArray<z.ZodObject<{
						pageId: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						rawText: z.ZodString;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
				dates: z.ZodArray<z.ZodObject<{
					role: z.ZodEnum<{
						unknown: "unknown";
						payment: "payment";
						issue: "issue";
						due: "due";
						"service-period": "service-period";
						"service-start": "service-start";
						"service-end": "service-end";
					}>;
					candidates: z.ZodArray<z.ZodISODate>;
					id: z.ZodString;
					label: z.ZodString;
					evidence: z.ZodArray<z.ZodObject<{
						pageId: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						rawText: z.ZodString;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
				merchants: z.ZodArray<z.ZodObject<{
					role: z.ZodLiteral<"merchant">;
					candidates: z.ZodArray<z.ZodString>;
					id: z.ZodString;
					label: z.ZodString;
					evidence: z.ZodArray<z.ZodObject<{
						pageId: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						rawText: z.ZodString;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
				references: z.ZodArray<z.ZodObject<{
					role: z.ZodEnum<{
						unknown: "unknown";
						payment: "payment";
						invoice: "invoice";
						receipt: "receipt";
						order: "order";
						customer: "customer";
						account: "account";
						table: "table";
						"related-invoice": "related-invoice";
					}>;
					candidates: z.ZodArray<z.ZodString>;
					id: z.ZodString;
					label: z.ZodString;
					evidence: z.ZodArray<z.ZodObject<{
						pageId: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						rawText: z.ZodString;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
				currencies: z.ZodArray<z.ZodObject<{
					role: z.ZodEnum<{
						unknown: "unknown";
						"informational-fx": "informational-fx";
						settlement: "settlement";
					}>;
					candidates: z.ZodArray<z.ZodString>;
					id: z.ZodString;
					label: z.ZodString;
					evidence: z.ZodArray<z.ZodObject<{
						pageId: z.ZodString;
						region: z.ZodObject<{
							x: z.ZodNumber;
							y: z.ZodNumber;
							width: z.ZodNumber;
							height: z.ZodNumber;
						}, z.core.$strict>;
						rawText: z.ZodString;
						method: z.ZodEnum<{
							"embedded-text": "embedded-text";
							"local-ocr": "local-ocr";
						}>;
					}, z.core.$strict>>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
			issues: z.ZodArray<z.ZodObject<{
				code: z.ZodString;
				severity: z.ZodEnum<{
					error: "error";
					warning: "warning";
				}>;
				message: z.ZodString;
				sectionId: z.ZodNullable<z.ZodString>;
				fieldId: z.ZodNullable<z.ZodString>;
				field: z.ZodNullable<z.ZodString>;
				evidence: z.ZodArray<z.ZodObject<{
					pageId: z.ZodString;
					region: z.ZodObject<{
						x: z.ZodNumber;
						y: z.ZodNumber;
						width: z.ZodNumber;
						height: z.ZodNumber;
					}, z.core.$strict>;
					rawText: z.ZodString;
					method: z.ZodEnum<{
						"embedded-text": "embedded-text";
						"local-ocr": "local-ocr";
					}>;
				}, z.core.$strict>>;
			}, z.core.$strict>>;
		}, z.core.$strict>>;
	}, z.core.$strict>
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
type StoredDocumentImportSchemaType = z.ZodObject<{
	id: z.ZodUUID;
	folderPath: z.ZodString;
	startedAt: z.ZodISODateTime;
	finishedAt: z.ZodISODateTime;
	status: z.ZodEnum<{
		cancelled: "cancelled";
		finished: "finished";
	}>;
	files: z.ZodArray<typeof fileResult>;
	directoryIssues: z.ZodArray<z.ZodObject<{
		directoryPath: z.ZodString;
		code: z.ZodString;
		message: z.ZodString;
	}, z.core.$strict>>;
}, z.core.$strict>;
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
		const invalid: (message: string) => void = (message: string): void => ctx.addIssue({ code: "custom", message });
		if (record.finishedAt < record.startedAt) {
			invalid("A document import cannot finish before it starts.");
		}
		const identities: Set<string> = new Set([record.id.toLowerCase()]),
			paths: Set<string> = new Set<string>(),
			importedHashes: Set<string> = new Set<string>();
		const importedSources: Map<string, string> = new Map(
			record.files.flatMap((file: { status: "imported"; record: { id: string; importedAt: string; filePath: string; format: "png" | "pdf" | "jpeg"; result: SupportingDocument; }; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [readonly [string, string]] =>
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
		const source: { sourceId: string; sha256: string; } = file.record.result.input.source;
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
