import { Component, computed, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { WigButtonComponent, WigDropdownComponent } from '@wigtertainment-ltd/comp-lib';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { OriginalPreviewData } from '../../src/shared/original-preview.js';
import { PDF_EXTRACTION_LIMITS } from '../../src/shared/pdf-extraction.js';

declare global {
    interface Window {
        receiptmatchOriginal: { read(): Promise<OriginalPreviewData> };
    }
}

const name = document.querySelector<HTMLHeadingElement>('#document-name')!;
const loading = document.querySelector<HTMLParagraphElement>('#loading')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;
const viewport = document.querySelector<HTMLElement>('#viewport')!;
const canvas = document.querySelector<HTMLCanvasElement>('#pdf-page')!;
const image = document.querySelector<HTMLImageElement>('#source-image')!;

const asset = (file: string) => new URL(`./pdf/${file}`, location.href).href;
GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

let pdf: PDFDocumentProxy | undefined;
let loadingTask: ReturnType<typeof getDocument> | undefined;
const selectedPage = signal(1);
const pageCount = signal(0);
const ready = signal(false);
const zoom = signal('fit');
const zoomPresets = [75, 100, 125, 150, 200];
const minimumZoom = 25;
const maximumZoom = 400;
let renderedScale = 1;
let renderTask: RenderTask | undefined;
let renderQueue = Promise.resolve();
let revision = 0;

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
    readonly page = selectedPage;
    readonly pageCount = pageCount;
    readonly ready = ready;
    readonly zoom = zoom;
    readonly zoomOptions = computed(() => {
        const current = zoom();
        const percentages = current === 'fit' ? zoomPresets : [...new Set([...zoomPresets, Math.round(Number(current) * 100)])].sort((a, b) => a - b);
        return [{ value: 'fit', label: 'Fit to window' }, ...percentages.map(percent => ({ value: String(percent / 100), label: `${percent}%` }))];
    });

    movePage(offset: number) {
        const page = selectedPage() + offset;
        if (page < 1 || page > pageCount()) return;
        selectedPage.set(page);
        showPage(true);
    }

    changeZoom(value: string | null) {
        changeZoom(value ?? 'fit');
    }
}

function setError(message: string) {
    error.textContent = message;
    error.hidden = !message;
}

function displayScale(width: number, height: number) {
    if (zoom() !== 'fit') return Number(zoom());
    const { paddingInlineStart, paddingInlineEnd, paddingBlockStart, paddingBlockEnd } = getComputedStyle(viewport);
    const availableWidth = viewport.clientWidth - parseFloat(paddingInlineStart) - parseFloat(paddingInlineEnd);
    const availableHeight = viewport.clientHeight - parseFloat(paddingBlockStart) - parseFloat(paddingBlockEnd);
    return Math.max(0.01, Math.min(availableWidth / width, availableHeight / height));
}

function changeZoom(value: string, restorePosition?: () => void) {
    if (zoom() === value) return;
    zoom.set(value);
    if (pdf) showPage(false, restorePosition);
    else {
        resizeImage();
        restorePosition?.();
    }
}

function zoomWithWheel(event: WheelEvent) {
    if (!event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    const page = pdf ? canvas : image;
    if (!ready() || page.hidden) return;
    const current = zoom() === 'fit' ? renderedScale : Number(zoom());
    const percent = Math.round(current * 100);
    const next = event.deltaY < 0 ? Math.min(maximumZoom, percent + 10) : Math.max(minimumZoom, percent - 10);
    if (event.deltaY < 0 ? next <= percent : next >= percent) return;

    const before = page.getBoundingClientRect();
    const x = (event.clientX - before.left) / before.width;
    const y = (event.clientY - before.top) / before.height;
    changeZoom(String(next / 100), () => {
        const after = page.getBoundingClientRect();
        viewport.scrollBy(after.left + x * after.width - event.clientX, after.top + y * after.height - event.clientY);
    });
}

function showPage(resetScroll = false, restorePosition?: () => void) {
    const document = pdf;
    if (!document) return;
    const page = selectedPage();
    const current = ++revision;
    if (resetScroll) viewport.scrollTo(0, 0);
    setError('');
    renderTask?.cancel();
    renderQueue = renderQueue.then(async () => {
        if (current !== revision) return;
        try {
            const source = await document.getPage(page);
            if (current !== revision) return;
            const { width, height } = source.getViewport({ scale: 1 });
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid page dimensions');
            const maxScale = Math.min(Math.sqrt(PDF_EXTRACTION_LIMITS.pixelsPerPage / width / height), 8192 / width, 8192 / height);
            renderedScale = Math.min(displayScale(width, height), maxScale);
            const pageViewport = source.getViewport({ scale: renderedScale });
            canvas.width = Math.max(1, Math.floor(pageViewport.width));
            canvas.height = Math.max(1, Math.floor(pageViewport.height));
            const task = source.render({ canvas, viewport: pageViewport });
            renderTask = task;
            await task.promise;
            if (current !== revision) return;
            canvas.setAttribute('aria-label', `Page ${page} of ${document.numPages}`);
            canvas.hidden = false;
            restorePosition?.();
        } catch {
            if (current !== revision) return;
            canvas.hidden = true;
            setError(`Page ${page} could not be displayed.`);
        } finally {
            renderTask = undefined;
            if (current === revision) loading.hidden = true;
        }
    });
}

function resizeImage() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scale = displayScale(image.naturalWidth, image.naturalHeight);
    renderedScale = scale;
    image.width = Math.max(1, Math.floor(image.naturalWidth * scale));
    image.height = Math.max(1, Math.floor(image.naturalHeight * scale));
}

async function openDocument() {
    const source = await window.receiptmatchOriginal.read();
    name.textContent = source.name;
    document.title = `${source.name} — ReceiptMatch`;
    if (source.format === 'pdf') {
        loadingTask = getDocument({
            data: new Uint8Array(source.bytes), cMapUrl: asset('cmaps/'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'),
            useSystemFonts: false, enableXfa: false, maxImageSize: PDF_EXTRACTION_LIMITS.pixelsPerPage, canvasMaxAreaInBytes: PDF_EXTRACTION_LIMITS.pixelsPerPage * 4,
        });
        const document = await loadingTask.promise;
        pdf = document;
        pageCount.set(document.numPages);
        ready.set(true);
        showPage();
        return;
    }

    const url = URL.createObjectURL(new Blob([new Uint8Array(source.bytes)], { type: source.format === 'png' ? 'image/png' : 'image/jpeg' }));
    try {
        image.src = url;
        image.alt = source.name;
        await image.decode();
        resizeImage();
        image.hidden = false;
        ready.set(true);
        loading.hidden = true;
    } finally { URL.revokeObjectURL(url); }
}

const observer = new ResizeObserver(() => {
    if (zoom() !== 'fit' || !error.hidden) return;
    if (pdf) showPage(); else resizeImage();
});
observer.observe(viewport);
viewport.addEventListener('wheel', zoomWithWheel, { passive: false });
window.addEventListener('pagehide', () => {
    observer.disconnect();
    revision++;
    renderTask?.cancel();
    void loadingTask?.destroy().catch(() => undefined);
}, { once: true });
void bootstrapApplication(PreviewControls).then(() => openDocument()).catch(() => {
    loading.hidden = true;
    setError('The original document could not be displayed.');
});
