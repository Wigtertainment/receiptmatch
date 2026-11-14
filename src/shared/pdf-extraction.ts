import type { BankImportInput, ImportIssue, ImportPage } from "./bank-import.js";
import { z } from 'zod';
import { BANK_IMPORT_LIMITS, bankImportInputSchema, importIssueSchema } from './bank-import.js';

export const PDF_EXTRACTION_VERSION: "pdfjs-6.5.438+tesseract-7.0.0-eng-1.0.0+document-2" = 'pdfjs-6.5.438+tesseract-7.0.0-eng-1.0.0+document-2';
export const LOCAL_OCR_VERSIONS: { readonly 'pp-ocrv6-medium': "pdfjs-6.5.438+pp-ocrv6-medium-onnx+document-2"; readonly 'paddleocr-vl-1.6': "pdfjs-6.5.438+paddleocr-vl-1.6-gguf-spotting+document-2"; } = {
    'pp-ocrv6-medium': 'pdfjs-6.5.438+pp-ocrv6-medium-onnx+document-2',
    'paddleocr-vl-1.6': 'pdfjs-6.5.438+paddleocr-vl-1.6-gguf-spotting+document-2'
} as const;
export const localOcrModelSchema: z.ZodEnum<{ "pp-ocrv6-medium": "pp-ocrv6-medium"; "paddleocr-vl-1.6": "paddleocr-vl-1.6"; }> = z.enum(['pp-ocrv6-medium', 'paddleocr-vl-1.6']);
export type LocalOcrModel = z.infer<typeof localOcrModelSchema>;
// Fixed execution guards, not supported-workload or performance promises.
export const PDF_EXTRACTION_LIMITS: { readonly bytes: number; readonly pages: 200; readonly pixelsPerPage: 16000000; readonly pixelsTotal: 64000000; readonly timeoutMs: 120000; } = { bytes: 25 * 1024 * 1024, pages: 200, pixelsPerPage: 16000000, pixelsTotal: 64000000, timeoutMs: 120000 } as const;
export const OCR_RASTER_BYTES: number = PDF_EXTRACTION_LIMITS.pixelsPerPage * 4 + 1024 * 1024;
export const EXTRACTION_CHANNELS: { readonly ready: "extraction:ready"; readonly job: "extraction:job"; readonly event: "extraction:event"; readonly recognize: "extraction:recognize"; } = { ready: 'extraction:ready', job: 'extraction:job', event: 'extraction:event', recognize: 'extraction:recognize' } as const;
const rasterSide: z.ZodNumber = z.number().int().min(1).max(20000);
export const ocrRasterSchema: z.ZodObject<{ pageNumber: z.ZodNumber; width: z.ZodNumber; height: z.ZodNumber; png: z.ZodInstanceOf<Uint8Array<ArrayBuffer>>; }, z.core.$strict> = z.strictObject({
    pageNumber: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages),
    width: rasterSide,
    height: rasterSide,
    png: z.instanceof(Uint8Array).refine((png: Uint8Array<ArrayBuffer>): boolean => png.byteLength > 0 && png.byteLength <= OCR_RASTER_BYTES)
}).refine((raster: { pageNumber: number; width: number; height: number; png: Uint8Array<ArrayBuffer>; }): boolean => raster.width * raster.height <= PDF_EXTRACTION_LIMITS.pixelsPerPage);
const coordinate: z.ZodNumber = z.number().finite().min(0).max(20000);
export const ocrRegionsSchema: z.ZodArray<z.ZodObject<{ text: z.ZodString; x0: z.ZodNumber; y0: z.ZodNumber; x1: z.ZodNumber; y1: z.ZodNumber; }, z.core.$strict>> = z.array(z.strictObject({
    text: z.string().min(1).max(BANK_IMPORT_LIMITS.spanText).refine((text: string): boolean => !!text.trim()),
    x0: coordinate, y0: coordinate, x1: coordinate, y1: coordinate
}).refine((region: { text: string; x0: number; y0: number; x1: number; y1: number; }): boolean => region.x1 > region.x0 && region.y1 > region.y0)).max(BANK_IMPORT_LIMITS.spansPerPage);
export type OcrRaster = z.infer<typeof ocrRasterSchema>;
export type OcrRegion = z.infer<typeof ocrRegionsSchema>[number];
type ExtractionProgressSchemaType = z.ZodObject<{
	phase: z.ZodEnum<{
		text: "text";
		loading: "loading";
		rendering: "rendering";
		ocr: "ocr";
		"page-complete": "page-complete";
	}>;
	pageNumber: z.ZodNullable<z.ZodNumber>;
	pageCount: z.ZodNullable<z.ZodNumber>;
	completedPages: z.ZodNumber;
}, z.core.$strict>;
export const extractionProgressSchema: ExtractionProgressSchemaType = z.strictObject({
    phase: z.enum(['loading', 'text', 'rendering', 'ocr', 'page-complete']),
    pageNumber: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    pageCount: z.number().int().min(1).max(PDF_EXTRACTION_LIMITS.pages).nullable(),
    completedPages: z.number().int().min(0).max(PDF_EXTRACTION_LIMITS.pages)
});
type ExtractionResultSchemaType = z.ZodDiscriminatedUnion<[
	z.ZodObject<{
		status: z.ZodLiteral<"complete">;
		input: z.ZodObject<{
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
			issues: z.ZodArray<z.ZodObject<{
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
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"partial">;
		input: z.ZodObject<{
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
			issues: z.ZodArray<z.ZodObject<{
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
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"failed">;
		issues: z.ZodArray<z.ZodObject<{
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
	}, z.core.$strict>,
	z.ZodObject<{
		status: z.ZodLiteral<"cancelled">;
		issues: z.ZodArray<z.ZodObject<{
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
	}, z.core.$strict>
], "status">;
export const extractionResultSchema: ExtractionResultSchemaType = z
    .discriminatedUnion('status', [
        z.strictObject({ status: z.literal('complete'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('partial'), input: bankImportInputSchema }),
        z.strictObject({ status: z.literal('failed'), issues: z.array(importIssueSchema).min(1).max(1000) }),
        z.strictObject({ status: z.literal('cancelled'), issues: z.array(importIssueSchema).min(1).max(1000) })
    ])
    .superRefine((value: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }, ctx: z.core.$RefinementCtx<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }>): void => {
        if (value.status === 'complete' && (value.input.issues.length || value.input.pages.some((page: ImportPage): boolean => page.status === 'failed'))) {
            ctx.addIssue({ code: 'custom', message: 'Complete extraction cannot hide issues or failed pages.' });
        }
        if (value.status === 'partial' && !value.input.issues.length) {
            ctx.addIssue({ code: 'custom', message: 'Partial extraction must explain its uncertainty.' });
        }
    });
type ExtractionJobSchemaType = z.ZodObject<{
	jobId: z.ZodUUID;
	format: z.ZodEnum<{
		png: "png";
		pdf: "pdf";
		jpeg: "jpeg";
	}>;
	sourceId: z.ZodString;
	sha256: z.ZodString;
	bytes: z.ZodInstanceOf<Uint8Array<ArrayBuffer>>;
	ocrModel: z.ZodOptional<typeof localOcrModelSchema>;
}, z.core.$strict>;
export const extractionJobSchema: ExtractionJobSchemaType = z.strictObject({
    jobId: z.uuid(),
    format: z.enum(['pdf', 'png', 'jpeg']),
    sourceId: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.instanceof(Uint8Array).refine((value: Uint8Array<ArrayBuffer>): boolean => value.byteLength > 0 && value.byteLength <= PDF_EXTRACTION_LIMITS.bytes),
    ocrModel: localOcrModelSchema.optional()
});
type ExtractionEventSchemaType = z.ZodObject<{
	jobId: z.ZodUUID;
	event: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			type: z.ZodLiteral<"progress">;
			progress: typeof extractionProgressSchema;
		}, z.core.$strict>,
		z.ZodObject<{
			type: z.ZodLiteral<"result">;
			result: typeof extractionResultSchema;
		}, z.core.$strict>
	], "type">;
}, z.core.$strict>;
export const extractionEventSchema: ExtractionEventSchemaType = z.strictObject({
    jobId: z.uuid(),
    event: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('progress'), progress: extractionProgressSchema }),
        z.strictObject({ type: z.literal('result'), result: extractionResultSchema })
    ])
});
export type ExtractionProgress = z.infer<typeof extractionProgressSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionJob = z.infer<typeof extractionJobSchema>;
export type ExtractionEvent = z.infer<typeof extractionEventSchema>['event'];
export interface ExtractionBridge {
    onJob(listener: (job: unknown) => void): void;
    ready(): void;
    report(event: ExtractionEvent): void;
    recognize(raster: OcrRaster): Promise<unknown>;
}
