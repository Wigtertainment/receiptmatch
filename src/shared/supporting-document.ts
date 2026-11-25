import { z } from 'zod';
import { bankImportInputSchema, calendarDateSchema, evidenceSchema, type ImportPage, type SourceEvidence } from './bank-import.js';
import { moneySchema } from './money.js';

const id: z.ZodString = z.string().min(1).max(128);
const text: z.ZodString = z.string().min(1).max(16384);
const evidence: z.ZodArray<typeof evidenceSchema> = z.array(evidenceSchema).max(256);
interface IDocumentFieldShape { id: z.ZodString; label: z.ZodString; evidence: typeof evidence }
const field: IDocumentFieldShape = { id, label: text, evidence: evidence.min(1) };
const userConfirmation: z.ZodOptional<z.ZodLiteral<true>> = z.literal(true).optional();
interface IDocumentAmountShape {
    coefficient: z.ZodString;
    scale: z.ZodNumber;
    currency: z.ZodNullable<z.ZodString>;
}
const amount: z.ZodObject<z.core.util.Flatten<IDocumentAmountShape>, z.core.$strict> = moneySchema.extend({ currency: moneySchema.shape.currency.nullable() });
interface IAmountFieldShape extends IDocumentFieldShape {
	role: z.ZodEnum<z.core.util.ToEnum<
		'unknown' | 'billed-total' | 'balance-due' | 'payment' | 'refund-payment' | 'credit-note-component' | 'informational-fx' | 'tax' | 'subtotal' | 'line-item'
	>>;
	candidates: z.ZodArray<typeof amount>;
	confirmedByUser: typeof userConfirmation;
}
const amountField: z.ZodObject<z.core.util.Flatten<IAmountFieldShape>, z.core.$strict> = z.strictObject({
	...field,
	evidence,
	confirmedByUser: userConfirmation,
	role: z.enum(['billed-total', 'balance-due', 'payment', 'refund-payment', 'credit-note-component', 'informational-fx', 'tax', 'subtotal', 'line-item', 'unknown']),
	candidates: z.array(amount).max(8)
});
interface IDateFieldShape extends IDocumentFieldShape {
	role: z.ZodEnum<z.core.util.ToEnum<'unknown' | 'payment' | 'issue' | 'due' | 'service-period' | 'service-start' | 'service-end'>>;
	candidates: z.ZodArray<z.ZodISODate>;
	confirmedByUser: typeof userConfirmation;
}
const dateField: z.ZodObject<z.core.util.Flatten<IDateFieldShape>, z.core.$strict> = z.strictObject({
	...field,
	evidence,
	confirmedByUser: userConfirmation,
	role: z.enum(['issue', 'payment', 'due', 'service-period', 'service-start', 'service-end', 'unknown']),
	candidates: z.array(calendarDateSchema).max(8)
});
interface IMerchantFieldShape extends IDocumentFieldShape {
	role: z.ZodLiteral<'merchant'>;
	candidates: z.ZodArray<z.ZodString>;
	correctedByUser: typeof userConfirmation;
}
const merchantField: z.ZodObject<z.core.util.Flatten<IMerchantFieldShape>, z.core.$strict> = z.strictObject({
	...field, evidence, correctedByUser: userConfirmation, role: z.literal('merchant'), candidates: z.array(text).max(8)
});
interface IReferenceFieldShape extends IDocumentFieldShape {
	role: z.ZodEnum<z.core.util.ToEnum<'unknown' | 'payment' | 'invoice' | 'receipt' | 'order' | 'customer' | 'account' | 'table' | 'related-invoice'>>;
	candidates: z.ZodArray<z.ZodString>;
	confirmedByUser: typeof userConfirmation;
	correctedByUser: typeof userConfirmation;
}
const referenceField: z.ZodObject<z.core.util.Flatten<IReferenceFieldShape>, z.core.$strict> = z.strictObject({
	...field,
	evidence,
	confirmedByUser: userConfirmation,
	correctedByUser: userConfirmation,
	role: z.enum(['invoice', 'receipt', 'payment', 'order', 'customer', 'account', 'table', 'related-invoice', 'unknown']),
	candidates: z.array(text).max(8)
});
interface ICurrencyFieldShape extends IDocumentFieldShape {
	role: z.ZodEnum<z.core.util.ToEnum<'unknown' | 'informational-fx' | 'settlement'>>;
	candidates: z.ZodArray<z.ZodString>;
	correctedByUser: typeof userConfirmation;
}
const currencyField: z.ZodObject<z.core.util.Flatten<ICurrencyFieldShape>, z.core.$strict> = z.strictObject({
	...field,
	evidence,
	correctedByUser: userConfirmation,
	role: z.enum(['settlement', 'informational-fx', 'unknown']),
	candidates: z.array(moneySchema.shape.currency).max(8)
});
interface IDocumentSectionShape {
	sectionId: z.ZodString;
	kind: z.ZodEnum<z.core.util.ToEnum<'unknown' | 'invoice' | 'receipt' | 'billing-summary' | 'credit-note' | 'payment-information'>>;
	pageIds: z.ZodArray<z.ZodString>;
	evidence: typeof evidence;
	amounts: z.ZodArray<typeof amountField>;
	dates: z.ZodArray<typeof dateField>;
	merchants: z.ZodArray<typeof merchantField>;
	references: z.ZodArray<typeof referenceField>;
	currencies: z.ZodArray<typeof currencyField>;
}
const section: z.ZodObject<z.core.util.Flatten<IDocumentSectionShape>, z.core.$strict> = z.strictObject({
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
interface IDocumentIssueShape {
	code: z.ZodString;
	severity: z.ZodEnum<z.core.util.ToEnum<'error' | 'warning'>>;
	message: z.ZodString;
	sectionId: z.ZodNullable<z.ZodString>;
	fieldId: z.ZodNullable<z.ZodString>;
	field: z.ZodNullable<z.ZodString>;
	evidence: typeof evidence;
}
const issue: z.ZodObject<z.core.util.Flatten<IDocumentIssueShape>, z.core.$strict> = z.strictObject({
	code: z.string().min(1).max(80),
	severity: z.enum(['warning', 'error']),
	message: z.string().min(1).max(512),
	sectionId: id.nullable(),
	fieldId: id.nullable(),
	field: z.string().min(1).max(80).nullable(),
	evidence
});

// Candidate arrays retain alternative readings; no bank payment direction is inferred from document signs or labels.
interface IDocumentParserVersions { 1: '1'; 2: '2' }
interface ISupportingDocumentShape {
	contractVersion: z.ZodLiteral<'1'>;
	parserVersion: z.ZodEnum<z.core.util.Flatten<IDocumentParserVersions>>;
	status: z.ZodEnum<z.core.util.ToEnum<'complete' | 'failed' | 'partial'>>;
	input: z.ZodNullable<typeof bankImportInputSchema>;
	sections: z.ZodArray<typeof section>;
	issues: z.ZodArray<typeof issue>;
}
type SupportingDocumentSchemaType = z.ZodObject<z.core.util.Flatten<ISupportingDocumentShape>, z.core.$strict>;
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
		if (value.issues.some((item: DocumentIssue): boolean => Boolean(item.sectionId) || Boolean(item.fieldId) || item.evidence.length > 0)) {
			invalid('Invalid input cannot establish section or source evidence.');
		}
		return;
	}
	const pages: Map<string, ImportPage> = new Map(value.input.pages.map((page: ImportPage): [string, ImportPage] => [page.pageId, page]));
	const sectionIds: Set<string> = new Set<string>();
	const fieldIds: Map<string, string> = new Map<string, string>();
	const allEvidence: IEvidenceByPage[] = [];
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

interface IEvidenceByPage { values: SourceEvidence[]; pages: string[] }
type DocumentField = DocumentSection['amounts' | 'dates' | 'merchants' | 'references' | 'currencies'][number];
type AmountCandidate = z.infer<typeof amount>;
type AmountField = DocumentSection['amounts'][number];
type DateField = DocumentSection['dates'][number];
type ReferenceField = DocumentSection['references'][number];
type CurrencyField = DocumentSection['currencies'][number];
type ScalarFieldGroup = DocumentSection['amounts' | 'dates' | 'references' | 'currencies'];
type ScalarField = ScalarFieldGroup[number];

function checkDocumentSection(item: DocumentSection, value: SupportingDocument, pages: ReadonlyMap<string, ImportPage>, sectionIds: Set<string>,
	fieldIds: Map<string, string>, allEvidence: IEvidenceByPage[], invalid: (message: string) => void): void {
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
		if (candidate.candidates.some((amount: AmountCandidate): boolean => amount.currency === null) &&
			!value.issues.some((issue: DocumentIssue): boolean => issue.fieldId === candidate.id)) {
			invalid('Amounts without established currency need an explicit issue.');
		}
	}
	for (const fieldId of documentScalarConflicts(item)) {
		if (!value.issues.some((issue: DocumentIssue): boolean => issue.sectionId === item.sectionId && issue.fieldId === fieldId && issue.code === 'conflicting-field')) {
			invalid('Conflicting scalar fields need an explicit conflict issue.');
		}
	}
	if (value.status === 'complete' && item.kind !== 'payment-information') {
		checkRequiredFields(item, invalid);
	}
}

function checkDocumentField(candidate: DocumentField, item: DocumentSection, issues: DocumentIssue[], sectionIds: Set<string>,
	fieldIds: Map<string, string>, allEvidence: IEvidenceByPage[], invalid: (message: string) => void): void {
	if (fieldIds.has(candidate.id) || sectionIds.has(candidate.id)) {
		invalid('Section and field identities must be unique.');
	}
	fieldIds.set(candidate.id, item.sectionId);
	allEvidence.push({ values: candidate.evidence, pages: item.pageIds });
	if (issues.some((issue: DocumentIssue): boolean => issue.fieldId === candidate.id && issue.sectionId === item.sectionId && ['rejected-field', 'unavailable-field'].includes(issue.code))) {
		checkExcludedField(candidate, invalid);
	} else if ('correctedByUser' in candidate && candidate.correctedByUser) {
		if (candidate.candidates.length !== 1) {
			invalid('A manually corrected field needs one value.');
		}
	} else if ('confirmedByUser' in candidate && candidate.confirmedByUser) {
		if (candidate.evidence.length || candidate.candidates.length !== 1) {
			invalid('A user-confirmed field needs one value and cannot claim extracted source evidence.');
		}
	} else if (!candidate.evidence.length) {
		invalid('A recognized field needs source evidence.');
	}
	if (new Set(candidate.candidates.map((value: string | AmountCandidate): string => JSON.stringify(value))).size !== candidate.candidates.length) {
		invalid('A field cannot repeat the same candidate.');
	}
	if (candidate.candidates.length !== 1 && !issues.some((issue: DocumentIssue): boolean => issue.fieldId === candidate.id)) {
		invalid('Unresolved or ambiguous fields need an explicit issue.');
	}
}

function checkExcludedField(candidate: DocumentField, invalid: (message: string) => void): void {
	if (candidate.candidates.length) {
		invalid('An excluded document field cannot retain effective values.');
	}
}

function checkRequiredFields(item: DocumentSection, invalid: (message: string) => void): void {
	const totalRole: "billed-total" | "credit-note-component" = item.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
	if (item.kind === 'unknown' || !item.amounts.some((field: AmountField): boolean => field.role === totalRole) ||
		!item.dates.some((field: DateField): boolean => field.role === 'issue') ||
		!item.merchants.length || !item.references.some((field: ReferenceField): boolean => ['invoice', 'receipt'].includes(field.role))) {
			invalid('Complete document sections need their main fields.');
		}
}

function checkDocumentIssues(value: SupportingDocument, pages: ReadonlyMap<string, ImportPage>, sectionIds: ReadonlySet<string>,
	fieldIds: ReadonlyMap<string, string>, allEvidence: IEvidenceByPage[], invalid: (message: string) => void): void {
	for (const item of value.issues) {
		if (item.sectionId !== null && !sectionIds.has(item.sectionId)) {
			invalid('Issues must reference a known section.');
		}
		if (item.fieldId !== null && (!fieldIds.has(item.fieldId) || fieldIds.get(item.fieldId) !== item.sectionId)) {
			invalid('Issues must reference a field in the stated section.');
		}
		allEvidence.push({
			values: item.evidence,
			pages: item.sectionId === null ? [...pages.keys()] : value.sections.find((section: DocumentSection): boolean => section.sectionId === item.sectionId)?.pageIds ?? []
		});
	}
}

function checkDocumentEvidence(allEvidence: IEvidenceByPage[], pages: ReadonlyMap<string, ImportPage>, invalid: (message: string) => void): void {
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
	const groups: ScalarFieldGroup[] = [
		...(['billed-total', 'balance-due', 'credit-note-component'] as const).map((role: "billed-total" | "balance-due" | "credit-note-component"): AmountField[] =>
			section.amounts.filter((field: AmountField): boolean => field.role === role)),
		section.dates.filter((field: DateField): boolean => field.role === 'issue'), section.dates.filter((field: DateField): boolean => field.role === 'due'),
		section.references.filter((field: ReferenceField): boolean => field.role === 'invoice'), section.currencies.filter((field: CurrencyField): boolean => field.role === 'settlement')
	];
	const conflicts: Set<string> = new Set<string>();
	for (const fields of groups) {
		const values: string[] = fields.flatMap<unknown>((field: ScalarField): string[] | AmountCandidate[] => field.candidates).map((value: unknown): string => {
			if (typeof value === 'string') {
				return value;
			}
			const parsed: z.ZodSafeParseResult<AmountCandidate> = amount.safeParse(value);
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

export function hasManualDocumentFields(analysis: SupportingDocument): boolean {
	if (analysis.issues.some((issue: DocumentIssue): boolean => ['rejected-field', 'unavailable-field'].includes(issue.code))) {
		return true;
	}
	return analysis.sections.some((section: DocumentSection): boolean => [...section.merchants, ...section.references, ...section.currencies].some((field: DocumentSection['merchants' | 'references' | 'currencies'][number]): boolean => field.correctedByUser === true));
}
