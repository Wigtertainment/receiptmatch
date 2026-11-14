import type { BankImportResult, SourceEvidence, TransactionCandidate, UnresolvedDraft } from "./bank-import.js";
import { z } from 'zod';
import { bankImportResultSchema, importIssueSchema } from './bank-import.js';

const localId: z.ZodString = z.string().min(1).max(128);
type StoredBankImportSchemaType = z.ZodObject<{
	id: z.ZodUUID;
	importedAt: z.ZodISODateTime;
	filePath: z.ZodString;
	result: z.ZodObject<{
		contractVersion: z.ZodLiteral<"1">;
		status: z.ZodEnum<{
			complete: "complete";
			failed: "failed";
			partial: "partial";
			unsupported: "unsupported";
		}>;
		adapter: z.ZodNullable<z.ZodObject<{
			bankId: z.ZodString;
			adapterId: z.ZodString;
			version: z.ZodString;
			layoutId: z.ZodString;
			layoutVersion: z.ZodString;
		}, z.core.$strict>>;
		sourceProvenance: z.ZodNullable<z.ZodObject<{
			sourceId: z.ZodString;
			sha256: z.ZodString;
			extractionRunId: z.ZodString;
			extractionVersion: z.ZodString;
			pages: z.ZodArray<z.ZodObject<{
				pageId: z.ZodString;
				pageNumber: z.ZodNumber;
				width: z.ZodNumber;
				height: z.ZodNumber;
			}, z.core.$strict>>;
		}, z.core.$strict>>;
		accountSections: z.ZodArray<z.ZodObject<{
			sectionId: z.ZodString;
			currency: z.ZodObject<{
				value: z.ZodString;
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
			}, z.core.$strict>;
			accountReference: z.ZodNullable<z.ZodObject<{
				label: z.ZodString;
				value: z.ZodString;
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
		transactions: z.ZodArray<z.ZodObject<{
			bookingDate: z.ZodObject<{
				value: z.ZodISODate;
				basisLabel: z.ZodString;
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
			}, z.core.$strict>;
			accountAmount: z.ZodObject<{
				value: z.ZodObject<{
					coefficient: z.ZodString;
					currency: z.ZodString;
					scale: z.ZodNumber;
				}, z.core.$strict>;
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
			}, z.core.$strict>;
			direction: z.ZodEnum<{
				incoming: "incoming";
				outgoing: "outgoing";
			}>;
			description: z.ZodObject<{
				value: z.ZodString;
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
			}, z.core.$strict>;
			rowId: z.ZodString;
			accountSectionId: z.ZodString;
			valueDate: z.ZodNullable<z.ZodObject<{
				value: z.ZodISODate;
				basisLabel: z.ZodString;
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
			reportedOriginalAmount: z.ZodNullable<z.ZodObject<{
				value: z.ZodObject<{
					coefficient: z.ZodString;
					currency: z.ZodString;
					scale: z.ZodNumber;
				}, z.core.$strict>;
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
			counterpartyCandidate: z.ZodNullable<z.ZodObject<{
				value: z.ZodString;
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
				label: z.ZodString;
				value: z.ZodString;
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
		unresolvedDrafts: z.ZodArray<z.ZodObject<{
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
			rowId: z.ZodString;
			accountSectionId: z.ZodString;
			bookingDate: z.ZodNullable<z.ZodObject<{
				value: z.ZodISODate;
				basisLabel: z.ZodString;
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
			valueDate: z.ZodNullable<z.ZodObject<{
				value: z.ZodISODate;
				basisLabel: z.ZodString;
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
			accountAmount: z.ZodNullable<z.ZodObject<{
				value: z.ZodObject<{
					coefficient: z.ZodString;
					currency: z.ZodString;
					scale: z.ZodNumber;
				}, z.core.$strict>;
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
			direction: z.ZodNullable<z.ZodEnum<{
				incoming: "incoming";
				outgoing: "outgoing";
			}>>;
			reportedOriginalAmount: z.ZodNullable<z.ZodObject<{
				value: z.ZodObject<{
					coefficient: z.ZodString;
					currency: z.ZodString;
					scale: z.ZodNumber;
				}, z.core.$strict>;
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
			description: z.ZodNullable<z.ZodObject<{
				value: z.ZodString;
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
			counterpartyCandidate: z.ZodNullable<z.ZodObject<{
				value: z.ZodString;
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
				label: z.ZodString;
				value: z.ZodString;
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
	accounts: z.ZodArray<z.ZodObject<{
		sectionId: z.ZodString;
		accountId: z.ZodUUID;
		statementId: z.ZodUUID;
	}, z.core.$strict>>;
	transactions: z.ZodArray<z.ZodObject<{
		rowId: z.ZodString;
		transactionId: z.ZodUUID;
	}, z.core.$strict>>;
	drafts: z.ZodArray<z.ZodObject<{
		rowId: z.ZodString;
		draftId: z.ZodUUID;
	}, z.core.$strict>>;
}, z.core.$strict>;
export const storedBankImportSchema: StoredBankImportSchemaType = z.strictObject({
    id: z.uuid(),
    importedAt: z.iso.datetime(),
    filePath: z.string().min(1).max(32768).refine((value: string): boolean => !value.includes('\0')),
    result: bankImportResultSchema,
    accounts: z.array(z.strictObject({ sectionId: localId, accountId: z.uuid(), statementId: z.uuid() })).max(200),
    transactions: z.array(z.strictObject({ rowId: localId, transactionId: z.uuid() })).max(10000),
    drafts: z.array(z.strictObject({ rowId: localId, draftId: z.uuid() })).max(10000)
}).superRefine((record: z.output<StoredBankImportSchemaType>, ctx: z.RefinementCtx): void => {
    const result: BankImportResult = record.result;
    if (!['complete', 'partial'].includes(result.status) || !result.sourceProvenance || !z.uuid().safeParse(result.sourceProvenance.sourceId).success) {
        ctx.addIssue({ code: 'custom', message: 'Only parsed imports with host-owned source identities can be retained.' });
    }
    const ids: (string | undefined)[] = [record.id, result.sourceProvenance?.sourceId, ...record.accounts.flatMap((value: { sectionId: string; accountId: string; statementId: string; }): string[] => [value.accountId, value.statementId]), ...record.transactions.map((value: { rowId: string; transactionId: string; }): string => value.transactionId), ...record.drafts.map((value: { rowId: string; draftId: string; }): string => value.draftId)];
    if (new Set(ids.map((value: string | undefined): string | undefined => value?.toLowerCase())).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: 'Stored import identities must be distinct.' });
    }
    for (const [mapped, expected] of [
        [record.accounts.map((value: { sectionId: string; accountId: string; statementId: string; }): string => value.sectionId), result.accountSections.map((value: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): string => value.sectionId)],
        [record.transactions.map((value: { rowId: string; transactionId: string; }): string => value.rowId), result.transactions.map((value: TransactionCandidate): string => value.rowId)],
        [record.drafts.map((value: { rowId: string; draftId: string; }): string => value.rowId), result.unresolvedDrafts.map((value: UnresolvedDraft): string => value.rowId)]
    ]) {
        const expectedIds: Set<string> = new Set(expected);
        if (mapped.length !== expected.length || new Set(mapped).size !== mapped.length || mapped.some((value: string): boolean => !expectedIds.has(value))) {
            ctx.addIssue({ code: 'custom', message: 'Every parsed account, transaction and draft needs one stable workspace identity.' });
        }
    }
});
export type StoredBankImport = z.infer<typeof storedBankImportSchema>;
export type BankImportRunResult =
    | { status: 'imported'; record: StoredBankImport }
    | { status: 'skipped'; importId: string; existingSourceId?: never }
    | { status: 'skipped'; importId: null; existingSourceId: string }
    | { status: 'cancelled' }
    | { status: 'failed' | 'unsupported'; issues: z.infer<typeof importIssueSchema>[] };
export interface BankImportSummary {
    id: string;
    filePath: string;
    bankId: string;
    status: 'complete' | 'partial';
    transactions: number;
    drafts: number;
    issues: number;
}
