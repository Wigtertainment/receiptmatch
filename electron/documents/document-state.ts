import { applyDocumentFieldCorrections, type DocumentCorrection } from '../../src/shared/document-corrections.js';
import type { SupportingDocument } from '../../src/shared/supporting-document.js';
import type { StoredDocumentImport } from '../../src/shared/workspace-documents.js';
import { evaluateStoredReceipt, withGenericIssueDate } from './interpret.js';

export class SupportingDocumentState {
	readonly automatic: SupportingDocument;
	readonly correctionBase: SupportingDocument;
	readonly effective: SupportingDocument;

	constructor(readonly original: SupportingDocument, readonly corrections: readonly DocumentCorrection[] = []) {
		const receipt = evaluateStoredReceipt(original);
		const sections = receipt.sections.map(section => {
			const dates = withGenericIssueDate(section, receipt.input?.pages ?? []);
			return dates === section.dates ? section : { ...section, dates };
		});
		this.automatic = sections.some((section, index) => section !== receipt.sections[index]) ? { ...receipt, sections } : receipt;
		this.correctionBase = this.restoreEditedFields();
		this.effective = applyDocumentFieldCorrections(this.correctionBase, corrections, original);
	}

	private restoreEditedFields(): SupportingDocument {
		if (!this.corrections.length || this.automatic.sections.length !== 1) return this.automatic;

		// Preserve valid manual edits to fields removed by automatic receipt recovery.
		const originalSection = this.original.sections[0];
		const section = this.automatic.sections[0];
		const editedIds = new Set(this.corrections.filter(correction => correction.sectionId === section.sectionId).map(correction => correction.fieldId));
		const suppressed = originalSection.amounts.filter(field => editedIds.has(field.id) && !section.amounts.some(amount => amount.id === field.id));
		if (!suppressed.length) return this.automatic;
		const suppressedIds = new Set(suppressed.map(field => field.id));
		const issues = this.original.issues.filter(issue => issue.fieldId !== null && suppressedIds.has(issue.fieldId));
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
		const byDocument = new Map<string, DocumentCorrection[]>();
		for (const correction of corrections.values()) {
			const fields = byDocument.get(correction.documentId) ?? [];
			fields.push(correction);
			byDocument.set(correction.documentId, fields);
		}
		const states = new Map(imports.flatMap(run => run.files.flatMap(file => file.status === 'imported' ?
			[[file.record.id, new SupportingDocumentState(file.record.result, byDocument.get(file.record.id))] as const] : [])));
		this.hasAutomaticChanges = [...states.values()].some(state => state.automatic !== state.original);
		const project = (view: 'correctionBase' | 'effective') => {
			const records = imports.map(run => {
				const files = run.files.map(file => {
					if (file.status !== 'imported') return file;
					const result = states.get(file.record.id)![view];
					return result === file.record.result ? file : { ...file, record: { ...file.record, result } };
				});
				return files.some((file, index) => file !== run.files[index]) ? { ...run, files } : run;
			});
			return records.some((run, index) => run !== imports[index]) ? records : imports;
		};
		this.correctionBase = project('correctionBase');
		this.effective = project('effective');
	}
}
