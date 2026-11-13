import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import type { LocalOcrModel } from '../shared/pdf-extraction.js';
import type { LocalOcrRequest, LocalOcrStatus } from '../shared/local-ocr-settings.js';

@Component({
	selector: 'app-local-ocr-settings', standalone: true, templateUrl: './local-ocr-settings.html',
})
export class LocalOcrSettings {
	readonly active = input.required<boolean>();
	readonly status = signal<LocalOcrStatus | null>(null);
	readonly changing = signal(false);
	readonly cancelling = signal(false);
	readonly error = signal<string | null>(null);
	readonly descriptions: Record<LocalOcrModel, string> = {
		'pp-ocrv6-medium': 'Smaller model for everyday scans and photos.',
		'paddleocr-vl-1.6': 'Larger, slower model for difficult scans, photos, and complex layouts.',
	};
	private revision = 0;
	private refreshId = 0;
	private disposed = false;
	private cancellationRequested = false;

	constructor() {
		effect(onCleanup => {
			if (!this.active()) return;
			void this.refresh();
			const timer = window.setInterval(() => {
				if (this.changing() || this.status()?.download) void this.refresh();
			}, 500);
			onCleanup(() => window.clearInterval(timer));
		});
		inject(DestroyRef).onDestroy(() => { this.disposed = true; });
	}

	size(bytes: number) {
		const unit = bytes >= 1_000_000_000 ? 'gigabyte' : 'megabyte';
		return new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 2 })
			.format(bytes / (unit === 'gigabyte' ? 1_000_000_000 : 1_000_000));
	}

	async refresh() {
		const revision = this.revision;
		const id = ++this.refreshId;
		try {
			const status = await window.receiptmatch.localOcr({ type: 'status' });
			if (!this.disposed && revision === this.revision && id === this.refreshId) {
				this.status.set(status);
				if (this.error() === 'OCR settings could not be loaded.') this.error.set(null);
			}
		} catch {
			if (!this.disposed && revision === this.revision && id === this.refreshId && !this.status()) this.error.set('OCR settings could not be loaded.');
		}
	}

	async change(request: Extract<LocalOcrRequest, { type: 'install' | 'select' }>, event: Event) {
		if (this.changing() || this.status()?.download) return;
		this.revision++;
		this.cancellationRequested = false;
		this.changing.set(true);
		this.error.set(null);
		const trigger = event.currentTarget;
		const selection = request.type === 'install' ? request.model : request.selection;
		try {
			const status = await window.receiptmatch.localOcr(request);
			if (!this.disposed) this.status.set(status);
		} catch {
			if (!this.disposed && !this.cancellationRequested) {
				this.error.set(request.type === 'install' ? 'The model could not be downloaded or installed. Try again.' : 'The OCR selection could not be saved. Try again.');
			}
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.changing.set(false);
				void this.refresh();
				this.restoreFocus(trigger, selection);
			}
		}
	}

	async cancel(event: Event) {
		const download = this.status()?.download;
		if (this.cancelling() || !download) return;
		const trigger = event.currentTarget;
		this.revision++;
		this.cancellationRequested = true;
		this.cancelling.set(true);
		try {
			const status = await window.receiptmatch.localOcr({ type: 'cancel' });
			if (!this.disposed) { this.status.set(status); this.error.set(null); }
		} catch {
			if (!this.disposed) this.error.set('The download could not be cancelled. Try again.');
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.cancelling.set(false);
				this.restoreFocus(trigger, download.model);
			}
		}
	}

	private restoreFocus(trigger: EventTarget | null, selection: string) {
		requestAnimationFrame(() => {
			if (this.disposed || !this.active() || (document.activeElement !== document.body && document.activeElement !== trigger)) return;
			const heading = document.getElementById('ocr-option-' + selection);
			(heading?.parentElement?.parentElement?.querySelector<HTMLElement>('button:not(:disabled)') ?? heading)?.focus();
		});
	}
}
