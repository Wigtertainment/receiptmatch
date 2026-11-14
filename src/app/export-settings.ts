import { Component, computed, input, signal, type Signal, type WritableSignal, type InputSignal } from '@angular/core';
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
	readonly workspace: InputSignal<WorkspaceView> = input.required<WorkspaceView>();
	readonly workspaceBusy: InputSignal<boolean> = input.required<boolean>();
	readonly pattern: WritableSignal<string> = signal<string>(defaultExportFilenamePattern);
	readonly savedPattern: WritableSignal<string | null> = signal<string | null>(null);
	readonly preview: Signal<{ filename: string; error?: never; } | { filename?: never; error: string; }> = computed((): { filename: string; error?: never; } | { filename?: never; error: string; } => renderExportFilename(this.pattern(), exportFilenameExample));
	readonly busy: WritableSignal<boolean> = signal(true);
	readonly error: WritableSignal<string | null> = signal<string | null>(null);
	readonly saved: WritableSignal<boolean> = signal(false);
	readonly exporting: WritableSignal<boolean> = signal(false);
	private readonly exportFeedback: WritableSignal<{ loadRevision: number; result: DocumentExportResponse; } | null> = signal<{ loadRevision: number; result: DocumentExportResponse } | null>(null);
	readonly exportResult: Signal<DocumentExportResponse | null> = computed((): DocumentExportResponse | null => {
		const feedback: { loadRevision: number; result: DocumentExportResponse; } | null = this.exportFeedback();
		return feedback?.loadRevision === this.workspace().loadRevision ? feedback.result : null;
	});
	readonly exportCounts: Signal<{ copied: number; skipped: number; failed: number; }> = computed((): { copied: number; skipped: number; failed: number; } => {
		const counts: { copied: number; skipped: number; failed: number; } = { copied: 0, skipped: 0, failed: 0 };
		const result: DocumentExportResponse | null = this.exportResult();
		if (result?.status === 'completed') {
			for (const outcome of result.report.outcomes) {
				counts[outcome.status]++;
			}
		}
		return counts;
	});
	readonly repeatedSourceNames: Signal<Set<string>> = computed((): Set<string> => {
		const names: Set<string> = new Set<string>();
		const repeated: Set<string> = new Set<string>();
		const result: DocumentExportResponse | null = this.exportResult();
		if (result?.status !== 'completed') {
			return repeated;
		}
		for (const { sourceName } of result.report.outcomes) {
			if (!sourceName) {
				continue;
			}
			if (names.has(sourceName)) {
				repeated.add(sourceName);
			}
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
	readonly defaultPattern: "{date}_{counterparty}_{currency}_{amount}" = defaultExportFilenamePattern;
	readonly patternLimit: number = exportFilenamePatternLimit;
	readonly outcomeColumns: TableConfig<DocumentExportOutcome> = { columns: [
		{ field: 'sourceName', text: 'Original', type: 'custom', template: 'original' },
		{ field: 'filename', text: 'Export filename', type: 'custom', template: 'filename' },
		{ field: 'status', text: 'Result', type: 'custom', template: 'result' },
	] };
	readonly placeholders: { token: string; label: string; }[] = [
		{ token: '{date}', label: 'Booking date' }, { token: '{counterparty}', label: 'Counterparty' },
		{ token: '{currency}', label: 'Currency' }, { token: '{amount}', label: 'Booking amount' },
	];

	constructor() {
		void this.load();
	}

	failureLabel(outcome: Extract<DocumentExportOutcome, { status: 'failed' }>): string {
		return this.failureLabels[outcome.reason];
	}

	private async load(): Promise<void> {
		try {
			const pattern: string = await window.receiptmatch.exportSettings({ type: 'read' });
			this.savedPattern.set(pattern);
			this.pattern.set(pattern);
		} catch {
			this.error.set('The saved pattern could not be loaded. Try saving a valid pattern.');
		} finally {
			this.busy.set(false);
		}
	}

	update(value: string): void {
		this.pattern.set(value);
		this.saved.set(false);
		this.error.set(null);
	}

	async save(event?: Event): Promise<void> {
		event?.preventDefault();
		if (this.busy() || this.exporting() || !this.preview().filename || this.savedPattern() === this.pattern().trim()) {
			return;
		}
		this.busy.set(true);
		this.error.set(null);
		try {
			const pattern: string = await window.receiptmatch.exportSettings({ type: 'save', pattern: this.pattern() });
			this.savedPattern.set(pattern);
			this.pattern.set(pattern);
			this.saved.set(true);
		} catch {
			this.error.set('The export pattern could not be saved. Try again.');
		} finally {
			this.busy.set(false);
		}
	}

	async exportDocuments(includeCsv: boolean = false): Promise<void> {
		const { loadRevision, approvedDocumentCount, filePath }: WorkspaceView = this.workspace();
		if ((includeCsv ? !filePath : !approvedDocumentCount) || this.exporting() || this.busy() || this.workspaceBusy()) {
			return;
		}
		this.exporting.set(true);
		this.exportFeedback.set(null);
		try {
			const result: DocumentExportResponse = includeCsv ? await window.receiptmatch.exportReconciliation(loadRevision) : await window.receiptmatch.exportDocuments(loadRevision);
			this.exportFeedback.set({ loadRevision, result });
		} catch {
			this.exportFeedback.set({ loadRevision, result: { status: 'failed', message: 'The export could not be started. Try again.' } });
		} finally {
			this.exporting.set(false);
		}
	}
}
