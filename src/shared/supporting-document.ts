import { z } from 'zod';
import { bankImportInputSchema, calendarDateSchema, evidenceSchema, type SourceEvidence } from './bank-import.js';
import { moneySchema } from './money.js';

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(16384);
const evidence = z.array(evidenceSchema).max(256);
const field = { id, label: text, evidence: evidence.min(1) };
const amount = moneySchema.extend({ currency: moneySchema.shape.currency.nullable() });
const amountField = z.strictObject({
	...field,
	role: z.enum(['billed-total', 'balance-due', 'payment', 'refund-payment', 'credit-note-component', 'informational-fx', 'tax', 'subtotal', 'line-item', 'unknown']),
	candidates: z.array(amount).max(8)
});
const dateField = z.strictObject({
	...field,
	role: z.enum(['issue', 'payment', 'due', 'service-period', 'service-start', 'service-end', 'unknown']),
	candidates: z.array(calendarDateSchema).max(8)
});
const merchantField = z.strictObject({ ...field, role: z.literal('merchant'), candidates: z.array(text).max(8) });
const referenceField = z.strictObject({
	...field,
	role: z.enum(['invoice', 'receipt', 'payment', 'order', 'customer', 'account', 'table', 'related-invoice', 'unknown']),
	candidates: z.array(text).max(8)
});
const currencyField = z.strictObject({
	...field,
	role: z.enum(['settlement', 'informational-fx', 'unknown']),
	candidates: z.array(moneySchema.shape.currency).max(8)
});
const section = z.strictObject({
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
const issue = z.strictObject({
	code: z.string().min(1).max(80),
	severity: z.enum(['warning', 'error']),
	message: z.string().min(1).max(512),
	sectionId: id.nullable(),
	fieldId: id.nullable(),
	field: z.string().min(1).max(80).nullable(),
	evidence
});

// Candidate arrays retain alternative readings; no bank payment direction is inferred from document signs or labels.
export const supportingDocumentSchema = z.strictObject({
	contractVersion: z.literal('1'),
	parserVersion: z.enum(['1', '2']),
	status: z.enum(['complete', 'partial', 'failed']),
	input: bankImportInputSchema.nullable(),
	sections: z.array(section).max(10000),
	issues: z.array(issue).max(10000)
}).superRefine((value, ctx) => {
	const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
	if (!value.input) {
		if (value.status !== 'failed' || value.sections.length || !value.issues.length) invalid('Invalid extraction input requires an explicit failed result without sections.');
		if (value.issues.some(item => item.sectionId || item.fieldId || item.evidence.length)) invalid('Invalid input cannot establish section or source evidence.');
		return;
	}
	const pages = new Map(value.input.pages.map(page => [page.pageId, page]));
	const sectionIds = new Set<string>();
	const fieldIds = new Map<string, string>();
	const allEvidence: { values: SourceEvidence[]; pages: string[] }[] = [];
	for (const item of value.sections) {
		if (sectionIds.has(item.sectionId) || fieldIds.has(item.sectionId)) invalid('Section and field identities must be unique.');
		sectionIds.add(item.sectionId);
		if (new Set(item.pageIds).size !== item.pageIds.length || item.pageIds.some(pageId => !pages.has(pageId))) invalid('Sections must reference distinct known pages.');
		allEvidence.push({ values: item.evidence, pages: item.pageIds });
		const fields = [...item.amounts, ...item.dates, ...item.merchants, ...item.references, ...item.currencies];
		for (const candidate of fields) {
			if (fieldIds.has(candidate.id) || sectionIds.has(candidate.id)) invalid('Section and field identities must be unique.');
			fieldIds.set(candidate.id, item.sectionId);
			allEvidence.push({ values: candidate.evidence, pages: item.pageIds });
			if (new Set(candidate.candidates.map(value => JSON.stringify(value))).size !== candidate.candidates.length) invalid('A field cannot repeat the same candidate.');
			if (candidate.candidates.length !== 1 && !value.issues.some(issue => issue.fieldId === candidate.id)) invalid('Unresolved or ambiguous fields need an explicit issue.');
		}
		for (const candidate of item.amounts) {
			if (candidate.candidates.some(amount => amount.currency === null) && !value.issues.some(issue => issue.fieldId === candidate.id)) invalid('Amounts without established currency need an explicit issue.');
		}
		for (const fieldId of documentScalarConflicts(item)) {
			if (!value.issues.some(issue => issue.sectionId === item.sectionId && issue.fieldId === fieldId && issue.code === 'conflicting-field')) invalid('Conflicting scalar fields need an explicit conflict issue.');
		}
		if (value.status === 'complete' && item.kind !== 'payment-information') {
			const totalRole = item.kind === 'credit-note' ? 'credit-note-component' : 'billed-total';
			if (item.kind === 'unknown' || !item.amounts.some(field => field.role === totalRole) || !item.dates.some(field => field.role === 'issue') ||
				!item.merchants.length || !item.references.some(field => ['invoice', 'receipt'].includes(field.role))) invalid('Complete document sections need their main fields.');
		}
	}
	for (const item of value.issues) {
		if (item.sectionId !== null && !sectionIds.has(item.sectionId)) invalid('Issues must reference a known section.');
		if (item.fieldId !== null && (!fieldIds.has(item.fieldId) || fieldIds.get(item.fieldId) !== item.sectionId)) invalid('Issues must reference a field in the stated section.');
		allEvidence.push({ values: item.evidence, pages: item.sectionId === null ? [...pages.keys()] : value.sections.find(section => section.sectionId === item.sectionId)?.pageIds ?? [] });
	}
	for (const item of allEvidence) for (const evidence of item.values) {
		const page = pages.get(evidence.pageId);
		if (!page || !item.pages.includes(evidence.pageId) || evidence.region.x + evidence.region.width > page.width || evidence.region.y + evidence.region.height > page.height) {
			invalid('Evidence must lie within a page belonging to its section.');
		}
	}
	if (value.status === 'complete' && (value.issues.length || value.input.issues.length || !value.sections.length || value.input.pages.some(page => page.status === 'failed'))) {
		invalid('Complete interpretation cannot hide extraction failures or uncertainty.');
	}
	if (value.status !== 'complete' && !value.issues.length) invalid('Incomplete interpretation needs an explicit issue.');
});

export type SupportingDocument = z.infer<typeof supportingDocumentSchema>;
export type DocumentSection = SupportingDocument['sections'][number];
export type DocumentIssue = SupportingDocument['issues'][number];

export function documentScalarConflicts(section: DocumentSection): Set<string> {
	const groups = [
		...(['billed-total', 'balance-due', 'credit-note-component'] as const).map(role => section.amounts.filter(field => field.role === role)),
		section.dates.filter(field => field.role === 'issue'), section.dates.filter(field => field.role === 'due'),
		section.references.filter(field => field.role === 'invoice'), section.currencies.filter(field => field.role === 'settlement')
	];
	const conflicts = new Set<string>();
	for (const fields of groups) {
		const values = fields.flatMap<unknown>(field => field.candidates).map(value => {
			if (typeof value === 'string') return value;
			const parsed = amount.safeParse(value);
			if (!parsed.success) return 'invalid-amount';
			let coefficient = BigInt(parsed.data.coefficient), scale = parsed.data.scale;
			while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
			return `${parsed.data.currency}:${coefficient}:${scale}`;
		});
		if (new Set(values).size > 1) for (const field of fields) conflicts.add(field.id);
	}
	return conflicts;
}
