import { Component, DestroyRef, computed, effect, inject, input, signal, type EffectCleanupRegisterFn, type WritableSignal, type InputSignal, type Signal } from '@angular/core';
import type { LocalOcrModel } from '../shared/pdf-extraction.js';
import type { LocalOcrGpuStatus, LocalOcrRequest, LocalOcrStatus } from '../shared/local-ocr-settings.js';

type SettingsChange = Exclude<LocalOcrRequest, { type: 'status' | 'cancel' }>;

const gpuMessages: Record<LocalOcrGpuStatus['state'], string> = {
	unsupported: 'GPU acceleration is unavailable on this platform.',
	'download-required': 'Install the Vulkan runtime to check GPU compatibility.',
	'model-required': 'Install a GPU-capable OCR model to check GPU compatibility.',
	unchecked: 'GPU compatibility has not been checked in this session.',
	checking: 'Checking GPU compatibility…',
	available: 'GPU available.',
	unavailable: 'The GPU check did not pass.'
};

const changeErrors: Record<SettingsChange['type'], string> = {
	install: 'The model could not be downloaded or installed. Try again.',
	select: 'The OCR selection could not be saved. Try again.',
	'select-device': 'The preferred device could not be saved. Try again.',
	'install-gpu-runtime': 'The Vulkan runtime could not be downloaded or installed. Try again.',
	'check-gpu': 'The GPU check could not complete. Try again.'
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
	readonly busy: Signal<boolean> = computed((): boolean => {
		const current: LocalOcrStatus | null = this.status();
		return this.changing() || this.cancelling() || !!current?.download || !!current?.gpu.download || this.cancellableGpuCheck() ||
			current?.gpu.state === 'checking';
	});
	readonly cancellableGpuCheck: Signal<boolean> = computed((): boolean => this.status()?.gpu.cancellableCheck ?? false);
	readonly descriptions: Record<LocalOcrModel, string> = {
		'pp-ocrv6-medium': 'Smaller model for everyday scans and photos.',
		'paddleocr-vl-1.6': 'Larger model for difficult scans, photos, and complex layouts.',
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

	gpuMessage(gpu: LocalOcrGpuStatus): string {
		return gpu.cancellableCheck ? gpuMessages.checking : gpu.issue ?? gpuMessages[gpu.state];
	}

	deviceMessage(current: LocalOcrStatus): string {
		if (current.selection === 'standard') {
			return 'Standard OCR uses CPU.';
		}
		const model: LocalOcrStatus['models'][number] | undefined = current.models.find(
			(item: LocalOcrStatus['models'][number]): boolean => item.model === current.selection
		);
		if (current.device === 'cpu') {
			return `${model?.name ?? 'The selected model'} can run on CPU.`;
		}
		if (!model?.gpuSupported) {
			return `${model?.name ?? 'The selected model'} requires CPU. Select CPU to use this model.`;
		}
		switch (current.gpu.state) {
			case 'available':
				return `${model.name} can run on GPU.`;
			case 'unchecked':
				return `ReceiptMatch will check GPU compatibility when ${model.name} needs to read a scan.`;
			case 'checking':
				return `${model.name} is waiting for the GPU check.`;
			default:
				return `Select CPU to use ${model.name} while GPU is unavailable.`;
		}
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
		const option: string = request.type === 'install' ? request.model : request.type === 'select' ? request.selection : 'device';
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
				this.restoreFocus(trigger, option);
			}
		}
	}

	async cancel(event: Event): Promise<void> {
		const current: LocalOcrStatus | null = this.status();
		const checkingGpu: boolean = this.cancellableGpuCheck();
		if (this.cancelling() || (!current?.download && !current?.gpu.download && !checkingGpu)) {
			return;
		}
		const option: string = current?.download?.model ?? 'device';
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
				this.error.set(checkingGpu ? 'The GPU check could not be cancelled. Try again.' : 'The download could not be cancelled. Try again.');
			}
		} finally {
			this.revision++;
			if (!this.disposed) {
				this.cancelling.set(false);
				this.restoreFocus(trigger, option);
			}
		}
	}

	private restoreFocus(trigger: EventTarget | null, option: string): void {
		requestAnimationFrame((): void => {
			if (this.disposed || !this.active() || (document.activeElement !== document.body && document.activeElement !== trigger)) {
				return;
			}
			if (trigger instanceof HTMLButtonElement && trigger.isConnected && !trigger.disabled) {
				trigger.focus();
				return;
			}
			const heading: HTMLElement | null = document.getElementById('ocr-option-' + option);
			const row: HTMLElement | null | undefined = heading?.parentElement?.parentElement;
			(row?.querySelector<HTMLElement>('button[aria-pressed="true"]:not(:disabled)') ??
				row?.querySelector<HTMLElement>('button:not(:disabled)') ?? heading)?.focus();
		});
	}
}
