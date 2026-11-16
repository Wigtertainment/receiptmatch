import { Component, DestroyRef, computed, effect, inject, input, signal, type EffectCleanupRegisterFn, type WritableSignal, type InputSignal, type Signal } from '@angular/core';
import type { LocalOcrRequest, LocalOcrStatus } from '../shared/local-ocr-settings.js';

type SettingsChange = Exclude<LocalOcrRequest, { type: 'status' | 'cancel-nuextract' }>;

const changeErrors: Record<SettingsChange['type'], string> = {
	'install-nuextract': 'NuExtract3 could not be downloaded or installed. Try again.',
	'install-nuextract-vulkan': 'The Vulkan runtime could not be downloaded or installed. Try again.',
	'check-nuextract-gpu': 'The GPU check could not complete. Try again.',
	'select-nuextract-device': 'The preferred device could not be saved. Try again.'
};

const gpuMessages: Record<LocalOcrStatus['gpu'], string> = {
	unsupported: 'GPU acceleration is unavailable on this platform.',
	'download-required': 'Install the Vulkan runtime to check GPU compatibility.',
	unchecked: 'Check GPU compatibility before selecting GPU.',
	checking: 'Checking GPU compatibility…',
	available: 'GPU available.',
	unavailable: 'The GPU check did not pass.'
};

@Component({
	selector: 'app-local-ocr-settings', standalone: true, templateUrl: './local-ocr-settings.html',
})
export class LocalOcrSettings {
	readonly active: InputSignal<boolean> = input.required<boolean>();
	readonly status: WritableSignal<LocalOcrStatus | null> = signal<LocalOcrStatus | null>(null);
	private readonly changing: WritableSignal<boolean> = signal(false);
	readonly cancelling: WritableSignal<boolean> = signal(false);
	readonly error: WritableSignal<string | null> = signal<string | null>(null);
	readonly busy: Signal<boolean> = computed((): boolean => this.changing() || this.cancelling() || this.status()?.busy === true);
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
				if (this.busy()) {
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

	gpuMessage(status: LocalOcrStatus): string {
		return status.gpuIssue ?? gpuMessages[status.gpu];
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

	async change(request: SettingsChange, event: Event): Promise<void> {
		if (this.busy()) {
			return;
		}
		this.revision++;
		this.cancellationRequested = false;
		this.changing.set(true);
		this.error.set(null);
		const trigger: EventTarget | null = event.currentTarget;
		try {
			const status: LocalOcrStatus = await window.receiptmatch.localOcr(request);
			if (!this.disposed) {
				this.status.set(status);
			}
		} catch {
			if (!this.disposed && !this.cancellationRequested) {
				this.error.set(changeErrors[request.type]);
			}
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.changing.set(false);
				void this.refresh();
				this.restoreFocus(trigger);
			}
		}
	}

	async cancel(event: Event): Promise<void> {
		const current: LocalOcrStatus | null = this.status();
		const checkingGpu: boolean = current?.gpu === 'checking';
		const canCancel: boolean = !!current?.download || checkingGpu;
		if (this.cancelling() || !canCancel) {
			return;
		}
		const trigger: EventTarget | null = event.currentTarget;
		this.revision++;
		this.cancellationRequested = true;
		this.cancelling.set(true);
		try {
			const status: LocalOcrStatus = await window.receiptmatch.localOcr({ type: 'cancel-nuextract' });
			if (!this.disposed) {
				this.status.set(status);
				this.error.set(null);
			}
		} catch {
			if (!this.disposed) {
				this.error.set(checkingGpu ? 'The GPU check could not be cancelled. Try again.' : 'The download could not be cancelled. Try again.');
			}
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.cancelling.set(false);
				void this.refresh();
				this.restoreFocus(trigger);
			}
		}
	}

	private restoreFocus(trigger: EventTarget | null): void {
		requestAnimationFrame((): void => {
			if (this.disposed || !this.active() || (document.activeElement !== document.body && document.activeElement !== trigger)) {
				return;
			}
			if (trigger instanceof HTMLButtonElement && trigger.isConnected && !trigger.disabled) {
				trigger.focus();
			} else {
				(document.querySelector<HTMLElement>('#nuextract-settings button:not(:disabled)') ?? document.getElementById('ocr-option-nuextract'))?.focus();
			}
		});
	}
}
