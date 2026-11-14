import type { DocumentIssue, DocumentSection } from "../../src/shared/supporting-document.js";
import type { ImportIssue, SourceEvidence } from "../../src/shared/bank-import.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import { applyDocumentFieldCorrections, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import type { SupportingDocument } from '../../src/shared/supporting-document.js';
import type { StoredDocumentImport } from '../../src/shared/workspace-documents.js';
import { evaluateStoredReceipt, withGenericIssueDate } from './interpret.js';

export class SupportingDocumentState {
	readonly automatic: SupportingDocument;
	readonly correctionBase: SupportingDocument;
	readonly effective: SupportingDocument;

	constructor(readonly original: SupportingDocument, readonly corrections: readonly DocumentCorrection[] = []) {
		const receipt: SupportingDocument = evaluateStoredReceipt(original);
		const sections: DocumentSection[] = receipt.sections.map((section: DocumentSection): DocumentSection => {
			const dates: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }[] = withGenericIssueDate(section, receipt.input?.pages ?? []);
			return dates === section.dates ? section : { ...section, dates };
		});
		this.automatic = sections.some((section: DocumentSection, index: number): boolean => section !== receipt.sections[index]) ? { ...receipt, sections } : receipt;
		this.correctionBase = this.restoreEditedFields();
		this.effective = applyDocumentFieldCorrections(this.correctionBase, corrections, original);
	}

	private restoreEditedFields(): SupportingDocument {
		if (!this.corrections.length || this.automatic.sections.length !== 1) {
			return this.automatic;
		}

		// Preserve valid manual edits to fields removed by automatic receipt recovery.
		const originalSection: DocumentSection = this.original.sections[0];
		const section: DocumentSection = this.automatic.sections[0];
		const editedIds: Set<string | null> = new Set(this.corrections.filter((correction: DocumentCorrection): boolean => correction.sectionId === section.sectionId).map((correction: DocumentCorrection): string | null => correction.fieldId));
		const suppressed: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }[] = originalSection.amounts.filter((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => editedIds.has(field.id) && !section.amounts.some((amount: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => amount.id === field.id));
		if (!suppressed.length) {
			return this.automatic;
		}
		const suppressedIds: Set<string> = new Set(suppressed.map((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): string => field.id));
		const issues: DocumentIssue[] = this.original.issues.filter((issue: DocumentIssue): boolean => issue.fieldId !== null && suppressedIds.has(issue.fieldId));
		return {
			...this.automatic, sections: [{ ...section, amounts: [...section.amounts, ...suppressed] }],
			issues: [...this.automatic.issues, ...issues],
		};
	}
}

export class WorkspaceDocumentState {
	readonly correctionBase: StoredDocumentImport[];
	readonly effective: StoredDocumentImport[];
	readonly hasAutomaticChanges: boolean;

	constructor(readonly imports: StoredDocumentImport[], readonly corrections: ReadonlyMap<string, DocumentCorrection>) {
		const byDocument: Map<string, DocumentCorrection[]> = new Map<string, DocumentCorrection[]>();
		for (const correction of corrections.values()) {
			const fields: DocumentCorrection[] = byDocument.get(correction.documentId) ?? [];
			fields.push(correction);
			byDocument.set(correction.documentId, fields);
		}
		const states: Map<string, SupportingDocumentState> = new Map(imports.flatMap((run: StoredDocumentImport): (readonly [string, SupportingDocumentState])[] => run.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [readonly [string, SupportingDocumentState]] => file.status === 'imported' ?
			[[file.record.id, new SupportingDocumentState(file.record.result, byDocument.get(file.record.id))] as const] : [])));
		this.hasAutomaticChanges = [...states.values()].some((state: SupportingDocumentState): boolean => state.automatic !== state.original);
		const project: (view: "correctionBase" | "effective") => StoredDocumentImport[] = (view: 'correctionBase' | 'effective'): StoredDocumentImport[] => {
			const records: StoredDocumentImport[] = imports.map((run: StoredDocumentImport): StoredDocumentImport => {
				const files: ({ status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; })[] = run.files.map((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } => {
					if (file.status !== 'imported') {
						return file;
					}
					const result: SupportingDocument = states.get(file.record.id)![view];
					return result === file.record.result ? file : { ...file, record: { ...file.record, result } };
				});
				return files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }, index: number): boolean => file !== run.files[index]) ? { ...run, files } : run;
			});
			return records.some((run: StoredDocumentImport, index: number): boolean => run !== imports[index]) ? records : imports;
		};
		this.correctionBase = project('correctionBase');
		this.effective = project('effective');
	}
}
