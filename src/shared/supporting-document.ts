import type { ImportPage } from "./bank-import.js";
import { z } from 'zod';
import { bankImportInputSchema, calendarDateSchema, evidenceSchema, type SourceEvidence } from './bank-import.js';
import { moneySchema } from './money.js';

const id: z.ZodString = z.string().min(1).max(128);
const text: z.ZodString = z.string().min(1).max(16384);
type EvidenceType = z.ZodArray<z.ZodObject<{
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
const evidence: EvidenceType = z.array(evidenceSchema).max(256);
const field: { id: z.ZodString; label: z.ZodString; evidence: typeof evidence; } = { id, label: text, evidence: evidence.min(1) };
const amount: z.ZodObject<{ coefficient: z.ZodString; scale: z.ZodNumber; currency: z.ZodNullable<z.ZodString>; }, z.core.$strict> = moneySchema.extend({ currency: moneySchema.shape.currency.nullable() });
type AmountFieldType = z.ZodObject<{
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
	candidates: z.ZodArray<typeof amount>;
	id: z.ZodString;
	label: z.ZodString;
	evidence: typeof evidence;
}, z.core.$strict>;
const amountField: AmountFieldType = z.strictObject({
	...field,
	role: z.enum(['billed-total', 'balance-due', 'payment', 'refund-payment', 'credit-note-component', 'informational-fx', 'tax', 'subtotal', 'line-item', 'unknown']),
	candidates: z.array(amount).max(8)
});
type DateFieldType = z.ZodObject<{
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
	evidence: typeof evidence;
}, z.core.$strict>;
const dateField: DateFieldType = z.strictObject({
	...field,
	role: z.enum(['issue', 'payment', 'due', 'service-period', 'service-start', 'service-end', 'unknown']),
	candidates: z.array(calendarDateSchema).max(8)
});
const merchantField: z.ZodObject<{ role: z.ZodLiteral<"merchant">; candidates: z.ZodArray<z.ZodString>; id: z.ZodString; label: z.ZodString; evidence: typeof evidence; }, z.core.$strict> = z.strictObject({ ...field, role: z.literal('merchant'), candidates: z.array(text).max(8) });
type ReferenceFieldType = z.ZodObject<{
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
	evidence: typeof evidence;
}, z.core.$strict>;
const referenceField: ReferenceFieldType = z.strictObject({
	...field,
	role: z.enum(['invoice', 'receipt', 'payment', 'order', 'customer', 'account', 'table', 'related-invoice', 'unknown']),
	candidates: z.array(text).max(8)
});
type CurrencyFieldType = z.ZodObject<{
	role: z.ZodEnum<{
		unknown: "unknown";
		"informational-fx": "informational-fx";
		settlement: "settlement";
	}>;
	candidates: z.ZodArray<z.ZodString>;
	id: z.ZodString;
	label: z.ZodString;
	evidence: typeof evidence;
}, z.core.$strict>;
const currencyField: CurrencyFieldType = z.strictObject({
	...field,
	role: z.enum(['settlement', 'informational-fx', 'unknown']),
	candidates: z.array(moneySchema.shape.currency).max(8)
});
type SectionType = z.ZodObject<{
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
	evidence: typeof evidence;
	amounts: z.ZodArray<typeof amountField>;
	dates: z.ZodArray<typeof dateField>;
	merchants: z.ZodArray<typeof merchantField>;
	references: z.ZodArray<typeof referenceField>;
	currencies: z.ZodArray<typeof currencyField>;
}, z.core.$strict>;
const section: SectionType = z.strictObject({
	sectionId: id,
	kind: z.enum(['billing-summary', 'invoice', 'receipt', 'credit-note', 'payment-information', 'unknown']),
	pageIds: z.array(id).min(1).max(200),
	evidence,
	amounts: z.array(amountField).max(10000),
	dates: z.array(dateField).max(10000),
	merchants: z.array(merchantField).max(10000),
	references: z.array(referenceField).max(10000),
	currencies: z.array(currencyField).max(10000)
});
type IssueType = z.ZodObject<{
	code: z.ZodString;
	severity: z.ZodEnum<{
		error: "error";
		warning: "warning";
	}>;
	message: z.ZodString;
	sectionId: z.ZodNullable<z.ZodString>;
	fieldId: z.ZodNullable<z.ZodString>;
	field: z.ZodNullable<z.ZodString>;
	evidence: typeof evidence;
}, z.core.$strict>;
const issue: IssueType = z.strictObject({
	code: z.string().min(1).max(80),
	severity: z.enum(['warning', 'error']),
	message: z.string().min(1).max(512),
	sectionId: id.nullable(),
	fieldId: id.nullable(),
	field: z.string().min(1).max(80).nullable(),
	evidence
});

// Candidate arrays retain alternative readings; no bank payment direction is inferred from document signs or labels.
type SupportingDocumentSchemaType = z.ZodObject<{
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
			evidence: typeof evidence;
		}, z.core.$strict>>;
	}, z.core.$strict>>;
	sections: z.ZodArray<typeof section>;
	issues: z.ZodArray<typeof issue>;
}, z.core.$strict>;
export const supportingDocumentSchema: SupportingDocumentSchemaType = z.strictObject({
	contractVersion: z.literal('1'),
	parserVersion: z.enum(['1', '2']),
	status: z.enum(['complete', 'partial', 'failed']),
	input: bankImportInputSchema.nullable(),
	sections: z.array(section).max(10000),
	issues: z.array(issue).max(10000)
}).superRefine((value: z.output<SupportingDocumentSchemaType>, ctx: z.RefinementCtx): void => {
	const invalid: (message: string) => void = (message: string): void => ctx.addIssue({ code: 'custom', message });
	if (!value.input) {
		if (value.status !== 'failed' || value.sections.length || !value.issues.length) {
			invalid('Invalid extraction input requires an explicit failed result without sections.');
		}
		if (value.issues.some((item: { code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; }): boolean => Boolean(item.sectionId) || Boolean(item.fieldId) || item.evidence.length > 0)) {
			invalid('Invalid input cannot establish section or source evidence.');
		}
		return;
	}
	const pages: Map<string, ImportPage> = new Map(value.input.pages.map((page: ImportPage): [string, ImportPage] => [page.pageId, page]));
	const sectionIds: Set<string> = new Set<string>();
	const fieldIds: Map<string, string> = new Map<string, string>();
	const allEvidence: { values: SourceEvidence[]; pages: string[] }[] = [];
	for (const item of value.sections) {
		checkDocumentSection(item, value, pages, sectionIds, fieldIds, allEvidence, invalid);
	}
	checkDocumentIssues(value, pages, sectionIds, fieldIds, allEvidence, invalid);
	checkDocumentEvidence(allEvidence, pages, invalid);
	if (value.status === 'complete' && (value.issues.length || value.input.issues.length || !value.sections.length || value.input.pages.some((page: ImportPage): boolean => page.status === 'failed'))) {
		invalid('Complete interpretation cannot hide extraction failures or uncertainty.');
	}
	if (value.status !== 'complete' && !value.issues.length) {
		invalid('Incomplete interpretation needs an explicit issue.');
	}
});

export type SupportingDocument = z.infer<typeof supportingDocumentSchema>;
export type DocumentSection = SupportingDocument['sections'][number];
export type DocumentIssue = SupportingDocument['issues'][number];

interface EvidenceByPage { values: SourceEvidence[]; pages: string[] }
type DocumentField = DocumentSection['amounts' | 'dates' | 'merchants' | 'references' | 'currencies'][number];

function checkDocumentSection(item: DocumentSection, value: SupportingDocument, pages: ReadonlyMap<string, ImportPage>, sectionIds: Set<string>,
	fieldIds: Map<string, string>, allEvidence: EvidenceByPage[], invalid: (message: string) => void): void {
	if (sectionIds.has(item.sectionId) || fieldIds.has(item.sectionId)) {
		invalid('Section and field identities must be unique.');
	}
	sectionIds.add(item.sectionId);
	if (new Set(item.pageIds).size !== item.pageIds.length || item.pageIds.some((pageId: string): boolean => !pages.has(pageId))) {
		invalid('Sections must reference distinct known pages.');
	}
	allEvidence.push({ values: item.evidence, pages: item.pageIds });
	const fields: DocumentField[] = [...item.amounts, ...item.dates, ...item.merchants, ...item.references, ...item.currencies];
	for (const candidate of fields) {
		checkDocumentField(candidate, item, value.issues, sectionIds, fieldIds, allEvidence, invalid);
	}
	for (const candidate of item.amounts) {
		if (candidate.candidates.some((amount: { coefficient: string; scale: number; currency: string | null; }): boolean => amount.currency === null) && !value.issues.some((issue: { code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; }): boolean => issue.fieldId === candidate.id)) {
			invalid('Amounts without established currency need an explicit issue.');
		}
	}
	for (const fieldId of documentScalarConflicts(item)) {
		if (!value.issues.some((issue: { code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; }): boolean => issue.sectionId === item.sectionId && issue.fieldId === fieldId && issue.code === 'conflicting-field')) {
			invalid('Conflicting scalar fields need an explicit conflict issue.');
		}
	}
	if (value.status === 'complete' && item.kind !== 'payment-information') {
		checkRequiredFields(item, invalid);
	}
}

function checkDocumentField(candidate: DocumentField, item: DocumentSection, issues: DocumentIssue[], sectionIds: Set<string>,
	fieldIds: Map<string, string>, allEvidence: EvidenceByPage[], invalid: (message: string) => void): void {
	if (fieldIds.has(candidate.id) || sectionIds.has(candidate.id)) {
		invalid('Section and field identities must be unique.');
	}
	fieldIds.set(candidate.id, item.sectionId);
	allEvidence.push({ values: candidate.evidence, pages: item.pageIds });
	if (new Set(candidate.candidates.map((value: string | { coefficient: string; scale: number; currency: string | null; }): string => JSON.stringify(value))).size !== candidate.candidates.length) {
		invalid('A field cannot repeat the same candidate.');
	}
	if (candidate.candidates.length !== 1 && !issues.some((issue: { code: string; severity: "error" | "warning"; message: string; sectionId: string | null; fieldId: string | null; field: string | null; evidence: SourceEvidence[]; }): boolean => issue.fieldId === candidate.id)) {
		invalid('Unresolved or ambiguous fields need an explicit issue.');
	}
}

function checkRequiredFields(item: DocumentSection, invalid: (message: string) => void): void {
	const totalRole: "billed-total" | "credit-note-component" = item.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
	if (item.kind === 'unknown' || !item.amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === totalRole) || !item.dates.some((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'issue') ||
		!item.merchants.length || !item.references.some((field: { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => ['invoice', 'receipt'].includes(field.role))) {
			invalid('Complete document sections need their main fields.');
		}
}

function checkDocumentIssues(value: SupportingDocument, pages: ReadonlyMap<string, ImportPage>, sectionIds: ReadonlySet<string>,
	fieldIds: ReadonlyMap<string, string>, allEvidence: EvidenceByPage[], invalid: (message: string) => void): void {
	for (const item of value.issues) {
		if (item.sectionId !== null && !sectionIds.has(item.sectionId)) {
			invalid('Issues must reference a known section.');
		}
		if (item.fieldId !== null && (!fieldIds.has(item.fieldId) || fieldIds.get(item.fieldId) !== item.sectionId)) {
			invalid('Issues must reference a field in the stated section.');
		}
		allEvidence.push({ values: item.evidence, pages: item.sectionId === null ? [...pages.keys()] : value.sections.find((section: { sectionId: string; kind: "unknown" | "invoice" | "receipt" | "billing-summary" | "credit-note" | "payment-information"; pageIds: string[]; evidence: SourceEvidence[]; amounts: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[]; dates: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[]; merchants: { role: "merchant"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[]; references: { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[]; currencies: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[]; }): boolean => section.sectionId === item.sectionId)?.pageIds ?? [] });
	}
}

function checkDocumentEvidence(allEvidence: EvidenceByPage[], pages: ReadonlyMap<string, ImportPage>, invalid: (message: string) => void): void {
	for (const item of allEvidence) {
		for (const evidence of item.values) {
		const page: ImportPage | undefined = pages.get(evidence.pageId);
		if (!page || !item.pages.includes(evidence.pageId) || evidence.region.x + evidence.region.width > page.width || evidence.region.y + evidence.region.height > page.height) {
			invalid('Evidence must lie within a page belonging to its section.');
		}
	}
	}
}

export function documentScalarConflicts(section: DocumentSection): Set<string> {
	const groups: ({ role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] | { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[])[] = [
		...(['billed-total', 'balance-due', 'credit-note-component'] as const).map((role: "billed-total" | "balance-due" | "credit-note-component"): { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] => section.amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === role)),
		section.dates.filter((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'issue'), section.dates.filter((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'due'),
		section.references.filter((field: { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'invoice'), section.currencies.filter((field: { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'settlement')
	];
	const conflicts: Set<string> = new Set<string>();
	for (const fields of groups) {
		const values: string[] = fields.flatMap<unknown>((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "payment" | "invoice" | "receipt" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; } | { role: "unknown" | "informational-fx" | "settlement"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): string[] | { coefficient: string; scale: number; currency: string | null; }[] => field.candidates).map((value: unknown): string => {
			if (typeof value === 'string') {
				return value;
			}
			const parsed: z.ZodSafeParseResult<{ coefficient: string; scale: number; currency: string | null; }> = amount.safeParse(value);
			if (!parsed.success) {
				return 'invalid-amount';
			}
			let coefficient: bigint = BigInt(parsed.data.coefficient), scale: number = parsed.data.scale;
			while (scale > 0 && coefficient % 10n === 0n) {
				coefficient /= 10n; scale--;
			}
			return `${parsed.data.currency}:${coefficient}:${scale}`;
		});
		if (new Set(values).size > 1) {
			for (const field of fields) {
				conflicts.add(field.id);
			}
		}
	}
	return conflicts;
}
