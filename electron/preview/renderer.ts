import { Component, computed, signal, type Signal, type WritableSignal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { WigButtonComponent, WigDropdownComponent } from '@wigtertainment-ltd/comp-lib';
import { getDocument, GlobalWorkerOptions, type PageViewport, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { OriginalPreviewData } from '../../src/shared/original-preview.js';
import { PDF_EXTRACTION_LIMITS } from '../../src/shared/pdf-extraction.js';

declare global {
    interface Window {
        receiptmatchOriginal: { read(): Promise<OriginalPreviewData> };
    }
}

const name: HTMLHeadingElement = document.querySelector<HTMLHeadingElement>('#document-name')!;
const loading: HTMLParagraphElement = document.querySelector<HTMLParagraphElement>('#loading')!;
const error: HTMLParagraphElement = document.querySelector<HTMLParagraphElement>('#error')!;
const viewport: HTMLElement = document.querySelector<HTMLElement>('#viewport')!;
const canvas: HTMLCanvasElement = document.querySelector<HTMLCanvasElement>('#pdf-page')!;
const image: HTMLImageElement = document.querySelector<HTMLImageElement>('#source-image')!;

const asset: (file: string) => string = (file: string): string => new URL(`./pdf/${file}`, location.href).href;
GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

let pdf: PDFDocumentProxy | undefined;
let loadingTask: ReturnType<typeof getDocument> | undefined;
const selectedPage: WritableSignal<number> = signal(1);
const pageCount: WritableSignal<number> = signal(0);
const ready: WritableSignal<boolean> = signal(false);
const zoom: WritableSignal<string> = signal('fit');
const zoomPresets: number[] = [75, 100, 125, 150, 200];
const minimumZoom: number = 25;
const maximumZoom: number = 400;
let renderedScale: number = 1;
let renderTask: RenderTask | undefined;
let renderQueue: Promise<void> = Promise.resolve();
let revision: number = 0;

@Component({
    selector: 'app-preview-controls', imports: [WigButtonComponent, WigDropdownComponent],
    template: `
        <div class="controls">
            @if (pageCount()) {
                <div id="pagination" class="controls" role="group" aria-label="PDF pages">
                    <wig-button label="Previous page" severity="secondary" [disabled]="page() <= 1" (click)="movePage(-1)" />
                    <output id="page-number" aria-live="polite">Page {{ page() }} of {{ pageCount() }}</output>
                    <wig-button label="Next page" severity="secondary" [disabled]="page() >= pageCount()" (click)="movePage(1)" />
                </div>
            }
            <label for="zoom">Zoom</label>
            <wig-dropdown class="zoom-control" inputId="zoom" ariaLabel="Zoom" [options]="zoomOptions()" optionLabel="label" optionValue="value"
                [disabled]="!ready()" [selectedOption]="zoom()" (selectedOptionChange)="changeZoom($event)" />
        </div>
    `
})
class PreviewControls {
    readonly page: WritableSignal<number> = selectedPage;
    readonly pageCount: WritableSignal<number> = pageCount;
    readonly ready: WritableSignal<boolean> = ready;
    readonly zoom: WritableSignal<string> = zoom;
    readonly zoomOptions: Signal<{ value: string; label: string; }[]> = computed((): { value: string; label: string; }[] => {
        const current: string = zoom();
        const percentages: number[] = current === 'fit' ? zoomPresets : [...new Set([...zoomPresets, Math.round(Number(current) * 100)])].sort((a: number, b: number): number => a - b);
        return [{ value: 'fit', label: 'Fit to window' }, ...percentages.map((percent: number): { value: string; label: string; } => ({ value: String(percent / 100), label: `${percent}%` }))];
    });

    movePage(offset: number): void {
        const page: number = selectedPage() + offset;
        if (page < 1 || page > pageCount()) {
            return;
        }
        selectedPage.set(page);
        showPage(true);
    }

    changeZoom(value: string | null): void {
        changeZoom(value ?? 'fit');
    }
}

function setError(message: string): void {
    error.textContent = message;
    error.hidden = !message;
}

function displayScale(width: number, height: number): number {
    if (zoom() !== 'fit') {
        return Number(zoom());
    }
    const { paddingInlineStart, paddingInlineEnd, paddingBlockStart, paddingBlockEnd }: CSSStyleDeclaration = getComputedStyle(viewport);
    const availableWidth: number = viewport.clientWidth - parseFloat(paddingInlineStart) - parseFloat(paddingInlineEnd);
    const availableHeight: number = viewport.clientHeight - parseFloat(paddingBlockStart) - parseFloat(paddingBlockEnd);
    return Math.max(0.01, Math.min(availableWidth / width, availableHeight / height));
}

function changeZoom(value: string, restorePosition?: () => void): void {
    if (zoom() === value) {
        return;
    }
    zoom.set(value);
    if (pdf) {
        showPage(false, restorePosition);
    } else {
        resizeImage();
        restorePosition?.();
    }
}

function zoomWithWheel(event: WheelEvent): void {
    if (!event.ctrlKey || !event.deltaY) {
        return;
    }
    event.preventDefault();
    const page: HTMLCanvasElement | HTMLImageElement = pdf ? canvas : image;
    if (!ready() || page.hidden) {
        return;
    }
    const current: number = zoom() === 'fit' ? renderedScale : Number(zoom());
    const percent: number = Math.round(current * 100);
    const next: number = event.deltaY < 0 ? Math.min(maximumZoom, percent + 10) : Math.max(minimumZoom, percent - 10);
    if (event.deltaY < 0 ? next <= percent : next >= percent) {
        return;
    }

    const before: DOMRect = page.getBoundingClientRect();
    const x: number = (event.clientX - before.left) / before.width;
    const y: number = (event.clientY - before.top) / before.height;
    changeZoom(String(next / 100), (): void => {
        const after: DOMRect = page.getBoundingClientRect();
        viewport.scrollBy(after.left + x * after.width - event.clientX, after.top + y * after.height - event.clientY);
    });
}

function showPage(resetScroll: boolean = false, restorePosition?: () => void): void {
    const document: PDFDocumentProxy | undefined = pdf;
    if (!document) {
        return;
    }
    const page: number = selectedPage();
    const current: number = ++revision;
    if (resetScroll) {
        viewport.scrollTo(0, 0);
    }
    setError('');
    renderTask?.cancel();
    renderQueue = renderQueue.then(async (): Promise<void> => {
        if (current !== revision) {
            return;
        }
        try {
            const source: PDFPageProxy = await document.getPage(page);
            if (current !== revision) {
                return;
            }
            const { width, height }: PageViewport = source.getViewport({ scale: 1 });
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                throw new Error('Invalid page dimensions');
            }
            const maxScale: number = Math.min(Math.sqrt(PDF_EXTRACTION_LIMITS.pixelsPerPage / width / height), 8192 / width, 8192 / height);
            renderedScale = Math.min(displayScale(width, height), maxScale);
            const pageViewport: PageViewport = source.getViewport({ scale: renderedScale });
            canvas.width = Math.max(1, Math.floor(pageViewport.width));
            canvas.height = Math.max(1, Math.floor(pageViewport.height));
            const task: RenderTask = source.render({ canvas, viewport: pageViewport });
            renderTask = task;
            await task.promise;
            if (current !== revision) {
                return;
            }
            canvas.setAttribute('aria-label', `Page ${page} of ${document.numPages}`);
            canvas.hidden = false;
            restorePosition?.();
        } catch {
            if (current !== revision) {
                return;
            }
            canvas.hidden = true;
            setError(`Page ${page} could not be displayed.`);
        } finally {
            renderTask = undefined;
            if (current === revision) {
                loading.hidden = true;
            }
        }
    });
}

function resizeImage(): void {
    if (!image.naturalWidth || !image.naturalHeight) {
        return;
    }
    const scale: number = displayScale(image.naturalWidth, image.naturalHeight);
    renderedScale = scale;
    image.width = Math.max(1, Math.floor(image.naturalWidth * scale));
    image.height = Math.max(1, Math.floor(image.naturalHeight * scale));
}

async function openDocument(): Promise<void> {
    const source: OriginalPreviewData = await window.receiptmatchOriginal.read();
    name.textContent = source.name;
    document.title = `${source.name} — ReceiptMatch`;
    if (source.format === 'pdf') {
        loadingTask = getDocument({
            data: new Uint8Array(source.bytes), cMapUrl: asset('cmaps/'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'),
            useSystemFonts: false, enableXfa: false, maxImageSize: PDF_EXTRACTION_LIMITS.pixelsPerPage, canvasMaxAreaInBytes: PDF_EXTRACTION_LIMITS.pixelsPerPage * 4,
        });
        const document: PDFDocumentProxy = await loadingTask.promise;
        pdf = document;
        pageCount.set(document.numPages);
        ready.set(true);
        showPage();
        return;
    }

    const url: string = URL.createObjectURL(new Blob([new Uint8Array(source.bytes)], { type: source.format === 'png' ? 'image/png' : 'image/jpeg' }));
    try {
        image.src = url;
        image.alt = source.name;
        await image.decode();
        resizeImage();
        image.hidden = false;
        ready.set(true);
        loading.hidden = true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

const observer: ResizeObserver = new ResizeObserver((): void => {
    if (zoom() !== 'fit' || !error.hidden) {
        return;
    }
    if (pdf) {
        showPage();
    } else {
        resizeImage();
    }
});
observer.observe(viewport);
viewport.addEventListener('wheel', zoomWithWheel, { passive: false });
window.addEventListener('pagehide', (): void => {
    observer.disconnect();
    revision++;
    renderTask?.cancel();
    void loadingTask?.destroy().catch((): undefined => undefined);
}, { once: true });
void bootstrapApplication(PreviewControls).then((): Promise<void> => openDocument()).catch((): void => {
    loading.hidden = true;
    setError('The original document could not be displayed.');
});
