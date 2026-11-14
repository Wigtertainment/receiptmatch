import { Component, DestroyRef, effect, inject, input, signal, type EffectCleanupRegisterFn, type WritableSignal, type InputSignal } from '@angular/core';
import type { LocalOcrModel } from '../shared/pdf-extraction.js';
import type { LocalOcrRequest, LocalOcrStatus } from '../shared/local-ocr-settings.js';

@Component({
	selector: 'app-local-ocr-settings', standalone: true, templateUrl: './local-ocr-settings.html',
})
export class LocalOcrSettings {
	readonly active: InputSignal<boolean> = input.required<boolean>();
	readonly status: WritableSignal<LocalOcrStatus | null> = signal<LocalOcrStatus | null>(null);
	readonly changing: WritableSignal<boolean> = signal(false);
	readonly cancelling: WritableSignal<boolean> = signal(false);
	readonly error: WritableSignal<string | null> = signal<string | null>(null);
	readonly descriptions: Record<LocalOcrModel, string> = {
		'pp-ocrv6-medium': 'Smaller model for everyday scans and photos.',
		'paddleocr-vl-1.6': 'Larger, slower model for difficult scans, photos, and complex layouts.',
	};
	private revision: number = 0;
	private refreshId: number = 0;
	private disposed: boolean = false;
	private cancellationRequested: boolean = false;

	constructor() {
		effect((onCleanup: EffectCleanupRegisterFn): void => {
			if (!this.active()) {
				return;
			}
			void this.refresh();
			const timer: number = window.setInterval((): void => {
				if (this.changing() || this.status()?.download) {
					void this.refresh();
				}
			}, 500);
			onCleanup((): void => window.clearInterval(timer));
		});

		inject(DestroyRef).onDestroy((): void => {
			this.disposed = true;
		});
	}

	size(bytes: number): string {
		const unit: "gigabyte" | "megabyte" = bytes >= 1_000_000_000 ? 'gigabyte' : 'megabyte';
		return new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 2 })
			.format(bytes / (unit === 'gigabyte' ? 1_000_000_000 : 1_000_000));
	}

	async refresh(): Promise<void> {
		const revision: number = this.revision;
		const id: number = ++this.refreshId;
		try {
			const status: LocalOcrStatus = await window.receiptmatch.localOcr({ type: 'status' });
			if (!this.disposed && revision === this.revision && id === this.refreshId) {
				this.status.set(status);
				if (this.error() === 'OCR settings could not be loaded.') {
					this.error.set(null);
				}
			}
		} catch {
			if (!this.disposed && revision === this.revision && id === this.refreshId && !this.status()) {
				this.error.set('OCR settings could not be loaded.');
			}
		}
	}

	async change(request: Extract<LocalOcrRequest, { type: 'install' | 'select' }>, event: Event): Promise<void> {
		if (this.changing() || this.status()?.download) {
			return;
		}
		this.revision++;
		this.cancellationRequested = false;
		this.changing.set(true);
		this.error.set(null);
		const trigger: EventTarget | null = event.currentTarget;
		const selection: "standard" | "pp-ocrv6-medium" | "paddleocr-vl-1.6" = request.type === 'install' ? request.model : request.selection;
		try {
			const status: LocalOcrStatus = await window.receiptmatch.localOcr(request);
			if (!this.disposed) {
				this.status.set(status);
			}
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

	async cancel(event: Event): Promise<void> {
		const download: { model: LocalOcrModel; receivedBytes: number; totalBytes: number; } | null | undefined = this.status()?.download;
		if (this.cancelling() || !download) {
			return;
		}
		const trigger: EventTarget | null = event.currentTarget;
		this.revision++;
		this.cancellationRequested = true;
		this.cancelling.set(true);
		try {
			const status: LocalOcrStatus = await window.receiptmatch.localOcr({ type: 'cancel' });
			if (!this.disposed) {
				this.status.set(status); this.error.set(null);
			}
		} catch {
			if (!this.disposed) {
				this.error.set('The download could not be cancelled. Try again.');
			}
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.cancelling.set(false);
				this.restoreFocus(trigger, download.model);
			}
		}
	}

	private restoreFocus(trigger: EventTarget | null, selection: string): void {
		requestAnimationFrame((): void => {
			if (this.disposed || !this.active() || (document.activeElement !== document.body && document.activeElement !== trigger)) {
				return;
			}
			const heading: HTMLElement | null = document.getElementById('ocr-option-' + selection);
			(heading?.parentElement?.parentElement?.querySelector<HTMLElement>('button:not(:disabled)') ?? heading)?.focus();
		});
	}
}
