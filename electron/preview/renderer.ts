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
const pagination = document.querySelector<HTMLElement>('#pagination')!;
const pageNumber = document.querySelector<HTMLOutputElement>('#page-number')!;
const previous = document.querySelector<HTMLButtonElement>('#previous-page')!;
const next = document.querySelector<HTMLButtonElement>('#next-page')!;
const zoom = document.querySelector<HTMLSelectElement>('#zoom')!;
const viewport = document.querySelector<HTMLElement>('#viewport')!;
const canvas = document.querySelector<HTMLCanvasElement>('#pdf-page')!;
const image = document.querySelector<HTMLImageElement>('#source-image')!;

const asset = (file: string) => new URL(`./pdf/${file}`, location.href).href;
GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

let pdf: PDFDocumentProxy | undefined;
let loadingTask: ReturnType<typeof getDocument> | undefined;
let selectedPage = 1;
let renderTask: RenderTask | undefined;
let renderQueue = Promise.resolve();
let revision = 0;

function setError(message: string) {
    error.textContent = message;
    error.hidden = !message;
}

function displayScale(width: number, height: number) {
    if (zoom.value !== 'fit') return Number(zoom.value);
    const { paddingInlineStart, paddingInlineEnd, paddingBlockStart, paddingBlockEnd } = getComputedStyle(viewport);
    const availableWidth = viewport.clientWidth - parseFloat(paddingInlineStart) - parseFloat(paddingInlineEnd);
    const availableHeight = viewport.clientHeight - parseFloat(paddingBlockStart) - parseFloat(paddingBlockEnd);
    return Math.max(0.01, Math.min(availableWidth / width, availableHeight / height));
}

function showPage(resetScroll = false) {
    const document = pdf;
    if (!document) return;
    const page = selectedPage;
    const current = ++revision;
    previous.disabled = page === 1;
    next.disabled = page === document.numPages;
    pageNumber.textContent = `Page ${page} of ${document.numPages}`;
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
            const pageViewport = source.getViewport({ scale: Math.min(displayScale(width, height), maxScale) });
            canvas.width = Math.max(1, Math.floor(pageViewport.width));
            canvas.height = Math.max(1, Math.floor(pageViewport.height));
            const task = source.render({ canvas, viewport: pageViewport });
            renderTask = task;
            await task.promise;
            if (current !== revision) return;
            canvas.setAttribute('aria-label', `Page ${page} of ${document.numPages}`);
            canvas.hidden = false;
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
        pagination.hidden = false;
        zoom.disabled = false;
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
        zoom.disabled = false;
        loading.hidden = true;
    } finally { URL.revokeObjectURL(url); }
}

previous.addEventListener('click', () => { if (selectedPage > 1) { selectedPage--; showPage(true); } });
next.addEventListener('click', () => { if (pdf && selectedPage < pdf.numPages) { selectedPage++; showPage(true); } });
zoom.addEventListener('change', () => { if (pdf) showPage(); else resizeImage(); });
const observer = new ResizeObserver(() => {
    if (zoom.value !== 'fit' || !error.hidden) return;
    if (pdf) showPage(); else resizeImage();
});
observer.observe(viewport);
window.addEventListener('pagehide', () => {
    observer.disconnect();
    revision++;
    renderTask?.cancel();
    void loadingTask?.destroy().catch(() => undefined);
}, { once: true });
void openDocument().catch(() => {
    loading.hidden = true;
    setError('The original document could not be displayed.');
});
