import type { SourceEvidence } from '../../src/shared/bank-import.js';
import { applyDocumentFieldCorrections, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import { applyDocumentFieldReviews, documentFieldReviewKey, type DocumentFieldReview } from '../../src/shared/document-field-reviews.js';
import type { DocumentIssue, DocumentSection, SupportingDocument } from '../../src/shared/supporting-document.js';
import type { DocumentFileResult, StoredDocumentImport } from '../../src/shared/workspace-documents.js';
import { evaluateStoredReceipt, printedCurrencies, withGenericIssueDate } from './interpret.js';
import { projectReceiptAnalyses, type ReceiptAnalysisVersion } from './analysis-history.js';

type AmountField = DocumentSection['amounts'][number];

export class SupportingDocumentState {
	constructor(readonly original: SupportingDocument, readonly corrections: readonly DocumentCorrection[] = []) {
		const receipt: SupportingDocument = evaluateStoredReceipt(original);
		const sections: DocumentSection[] = receipt.sections.map((section: DocumentSection): DocumentSection => {
			const dates: DocumentSection['dates'] = withGenericIssueDate(section, receipt.input?.pages ?? []);
			return dates === section.dates ? section : { ...section, dates };
		});
		this.automatic = sections.some((section: DocumentSection, index: number): boolean => section !== receipt.sections[index]) ? { ...receipt, sections } : receipt;
		this.correctionBase = this.restoreEditedFields();
		this.effective = applyDocumentFieldCorrections(this.correctionBase, corrections, original);
	}

	readonly automatic: SupportingDocument;
	readonly correctionBase: SupportingDocument;
	readonly effective: SupportingDocument;

	private restoreEditedFields(): SupportingDocument {
		if (!this.corrections.length || this.automatic.sections.length !== 1) {
			return this.automatic;
		}

		// Preserve valid manual edits to fields removed by automatic receipt recovery.
		const originalSection: DocumentSection = this.original.sections[0];
		const section: DocumentSection = this.automatic.sections[0];
		const editedIds: Set<string | null> = new Set(this.corrections.filter((correction: DocumentCorrection): boolean => correction.sectionId === section.sectionId).map((correction: DocumentCorrection): string | null => correction.fieldId));
		const suppressed: AmountField[] = originalSection.amounts.filter((field: AmountField): boolean =>
			editedIds.has(field.id) && !section.amounts.some((amount: AmountField): boolean => amount.id === field.id));
		if (!suppressed.length) {
			return this.automatic;
		}
		const suppressedIds: Set<string> = new Set(suppressed.map((field: AmountField): string => field.id));
		const issues: DocumentIssue[] = this.original.issues.filter((issue: DocumentIssue): boolean => issue.fieldId !== null && suppressedIds.has(issue.fieldId));
		return {
			...this.automatic, sections: [{ ...section, amounts: [...section.amounts, ...suppressed] }],
			issues: [...this.automatic.issues, ...issues],
		};
	}
}

export class WorkspaceDocumentState {
	constructor(readonly imports: StoredDocumentImport[], readonly corrections: ReadonlyMap<string, DocumentCorrection>,
		readonly versions: readonly ReceiptAnalysisVersion[] = [], readonly reviews: ReadonlyMap<string, DocumentFieldReview> = new Map()) {
		this.analyzed = projectReceiptAnalyses(imports, versions);
		const byDocument: Map<string, DocumentCorrection[]> = new Map<string, DocumentCorrection[]>();
		for (const correction of corrections.values()) {
			const fields: DocumentCorrection[] = byDocument.get(correction.documentId) ?? [];
			fields.push(correction);
			byDocument.set(correction.documentId, fields);
		}
		const states: Map<string, SupportingDocumentState> = new Map(this.analyzed.flatMap((run: StoredDocumentImport): (readonly [string, SupportingDocumentState])[] =>
			run.files.flatMap((file: DocumentFileResult): [] | [readonly [string, SupportingDocumentState]] => file.status === 'imported' ?
				[[file.record.id, new SupportingDocumentState(file.record.result, byDocument.get(file.record.id))] as const] : [])));
		this.hasAutomaticChanges = [...states.values()].some((state: SupportingDocumentState): boolean => state.automatic !== state.original);
		const project: (view: "correctionBase" | "effective") => StoredDocumentImport[] = (view: 'correctionBase' | 'effective'): StoredDocumentImport[] => {
			const records: StoredDocumentImport[] = this.analyzed.map((run: StoredDocumentImport): StoredDocumentImport => {
				const files: DocumentFileResult[] = run.files.map((file: DocumentFileResult): DocumentFileResult => {
					if (file.status !== 'imported') {
						return file;
					}
					const result: SupportingDocument = states.get(file.record.id)![view];
					return result === file.record.result ? file : { ...file, record: { ...file.record, result } };
				});
				return files.some((file: DocumentFileResult, index: number): boolean => file !== run.files[index]) ? { ...run, files } : run;
			});
			return records.some((run: StoredDocumentImport, index: number): boolean => run !== this.analyzed[index]) ? records : this.analyzed;
		};
		this.correctionBase = project('correctionBase');
		this.reviewBase = project('effective');
		const independentCurrencies: Set<string> = new Set(this.reviewBase.flatMap((run: StoredDocumentImport): string[] => run.files.flatMap((file: StoredDocumentImport['files'][number]): string[] => file.status === 'imported' ?
			file.record.result.sections.flatMap((section: DocumentSection): string[] => independentCurrencyFields(section, file.record.id, corrections)) : [])));
		this.effective = applyDocumentFieldReviews(this.reviewBase, reviews, independentCurrencies);
	}

	readonly analyzed: StoredDocumentImport[];
	readonly correctionBase: StoredDocumentImport[];
	readonly effective: StoredDocumentImport[];
	readonly reviewBase: StoredDocumentImport[];
	readonly hasAutomaticChanges: boolean;
}

function independentCurrencyFields(section: DocumentSection, documentId: string, corrections: ReadonlyMap<string, DocumentCorrection>): string[] {
	const corrected: Set<string | null> = new Set([...corrections.values()].filter((correction: DocumentCorrection): boolean => correction.documentId === documentId && correction.sectionId === section.sectionId && correction.change.kind === 'amount').map((correction: DocumentCorrection): string | null => correction.fieldId));
	return section.amounts.filter((field: DocumentSection['amounts'][number]): boolean => field.confirmedByUser === true || corrected.has(field.id) ||
		(corrected.has(null) && !field.evidence.length && ['billed-total', 'credit-note-component'].includes(field.role)) ||
		field.candidates.every((value: DocumentSection['amounts'][number]['candidates'][number]): boolean => !!value.currency && field.evidence.some((evidence: SourceEvidence): boolean => printedCurrencies(evidence.rawText).includes(value.currency!))))
		.map((field: DocumentSection['amounts'][number]): string => documentFieldReviewKey({ documentId, sectionId: section.sectionId, fieldId: field.id }));
}
