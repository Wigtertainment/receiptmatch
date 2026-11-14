import { Component, computed, input, signal } from '@angular/core';
import { type TableConfig, WigAlertComponent, WigButtonComponent, WigInputComponent, WigTableComponent, WigTemplateDirective } from '@wigtertainment-ltd/comp-lib';
import { InputLength } from './input-length.js';
import { defaultExportFilenamePattern, exportFilenameExample, exportFilenamePatternLimit, renderExportFilename } from '../shared/export-filename.js';
import type { DocumentExportFailure, DocumentExportOutcome, DocumentExportResponse } from '../shared/document-export.js';
import type { WorkspaceView } from '../shared/protocol.js';

@Component({
	selector: 'app-export-settings', standalone: true, templateUrl: './export-settings.html',
	imports: [WigAlertComponent, WigButtonComponent, WigInputComponent, WigTableComponent, WigTemplateDirective, InputLength],
})
export class ExportSettings {
	readonly workspace = input.required<WorkspaceView>();
	readonly workspaceBusy = input.required<boolean>();
	readonly pattern = signal(defaultExportFilenamePattern);
	readonly savedPattern = signal<string | null>(null);
	readonly preview = computed(() => renderExportFilename(this.pattern(), exportFilenameExample));
	readonly busy = signal(true);
	readonly error = signal<string | null>(null);
	readonly saved = signal(false);
	readonly exporting = signal(false);
	private readonly exportFeedback = signal<{ loadRevision: number; result: DocumentExportResponse } | null>(null);
	readonly exportResult = computed(() => {
		const feedback = this.exportFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision ? feedback.result : null;
	});
	readonly exportCounts = computed(() => {
		const counts = { copied: 0, skipped: 0, failed: 0 };
		const result = this.exportResult();
		if (result?.status === 'completed') for (const outcome of result.report.outcomes) counts[outcome.status]++;
		return counts;
	});
	readonly repeatedSourceNames = computed(() => {
		const names = new Set<string>();
		const repeated = new Set<string>();
		const result = this.exportResult();
		if (result?.status !== 'completed') return repeated;
		for (const { sourceName } of result.report.outcomes) {
			if (!sourceName) continue;
			if (names.has(sourceName)) repeated.add(sourceName);
			names.add(sourceName);
		}
		return repeated;
	});
	readonly failureLabels: Record<DocumentExportFailure, string> = {
		'invalid-filename': 'The saved pattern could not generate a valid filename.',
		'source-missing': 'The original file is missing.',
		'source-changed': 'The original file changed since import.',
		'source-unreadable': 'The original file could not be read.',
		'write-failed': 'The copy could not be written.',
	};
	readonly defaultPattern = defaultExportFilenamePattern;
	readonly patternLimit = exportFilenamePatternLimit;
	readonly outcomeColumns: TableConfig<DocumentExportOutcome> = { columns: [
		{ field: 'sourceName', text: 'Original', type: 'custom', template: 'original' },
		{ field: 'filename', text: 'Export filename', type: 'custom', template: 'filename' },
		{ field: 'status', text: 'Result', type: 'custom', template: 'result' },
	] };
	readonly placeholders = [
		{ token: '{date}', label: 'Booking date' }, { token: '{counterparty}', label: 'Counterparty' },
		{ token: '{currency}', label: 'Currency' }, { token: '{amount}', label: 'Booking amount' },
	];

	constructor() { void this.load(); }

	failureLabel(outcome: Extract<DocumentExportOutcome, { status: 'failed' }>) { return this.failureLabels[outcome.reason]; }

	private async load() {
		try {
			const pattern = await window.receiptmatch.exportSettings({ type: 'read' });
			this.savedPattern.set(pattern);
			this.pattern.set(pattern);
		} catch {
			this.error.set('The saved pattern could not be loaded. Try saving a valid pattern.');
		} finally {
			this.busy.set(false);
		}
	}

	update(value: string) {
		this.pattern.set(value);
		this.saved.set(false);
		this.error.set(null);
	}

	async save(event?: Event) {
		event?.preventDefault();
		if (this.busy() || this.exporting() || !this.preview().filename || this.savedPattern() === this.pattern().trim()) return;
		this.busy.set(true);
		this.error.set(null);
		try {
			const pattern = await window.receiptmatch.exportSettings({ type: 'save', pattern: this.pattern() });
			this.savedPattern.set(pattern);
			this.pattern.set(pattern);
			this.saved.set(true);
		} catch {
			this.error.set('The export pattern could not be saved. Try again.');
		} finally {
			this.busy.set(false);
		}
	}

	async exportDocuments(includeCsv = false) {
		const { loadRevision, approvedDocumentCount, filePath } = this.workspace();
		if ((includeCsv ? !filePath : !approvedDocumentCount) || this.exporting() || this.busy() || this.workspaceBusy()) return;
		this.exporting.set(true);
		this.exportFeedback.set(null);
		try {
			const result = includeCsv ? await window.receiptmatch.exportReconciliation(loadRevision) : await window.receiptmatch.exportDocuments(loadRevision);
			this.exportFeedback.set({ loadRevision, result });
		} catch {
			this.exportFeedback.set({ loadRevision, result: { status: 'failed', message: 'The export could not be started. Try again.' } });
		} finally {
			this.exporting.set(false);
		}
	}
}
