import { Component, computed, input, signal } from '@angular/core';
import { defaultExportFilenamePattern, exportFilenameExample, exportFilenamePatternLimit, renderExportFilename } from '../shared/export-filename.js';
import type { DocumentExportFailure, DocumentExportResponse } from '../shared/document-export.js';
import type { WorkspaceView } from '../shared/protocol.js';

@Component({
	selector: 'app-export-settings', standalone: true, templateUrl: './export-settings.html',
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
	readonly placeholders = [
		{ token: '{date}', label: 'Booking date' }, { token: '{counterparty}', label: 'Counterparty' },
		{ token: '{currency}', label: 'Currency' }, { token: '{amount}', label: 'Booking amount' },
	];

	constructor() { void this.load(); }

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

	async save(event: Event) {
		event.preventDefault();
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

	async exportDocuments() {
		const { loadRevision, approvedDocumentCount } = this.workspace();
		if (!approvedDocumentCount || this.exporting() || this.busy() || this.workspaceBusy()) return;
		this.exporting.set(true);
		this.exportFeedback.set(null);
		try {
			const result = await window.receiptmatch.exportDocuments(loadRevision);
			this.exportFeedback.set({ loadRevision, result });
		} catch {
			this.exportFeedback.set({ loadRevision, result: { status: 'failed', message: 'The export could not be started. Try again.' } });
		} finally {
			this.exporting.set(false);
		}
	}
}
