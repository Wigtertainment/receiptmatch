import * as pdfjs from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import type { ExtractionJob, ExtractionPage } from './extraction-types.js';

declare global { interface Window { extraction: { onJob(listener: (job: ExtractionJob) => void): void; result(value: unknown): void; ready(): void }; } }
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf/pdf.worker.min.mjs', location.href).href;

async function execute(job: ExtractionJob) {
  if (job.operation === 'image') {
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 360;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black'; context.font = '40px monospace';
    context.fillText('RECEIPTMATCH VALIDATION', 50, 90);
    context.fillText('TOTAL USD 123.45', 50, 175);
    context.fillText('REFERENCE OCR TEST 123', 50, 260);
    return { image: canvas.toDataURL('image/png').split(',')[1] };
  }
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(job.bytes), cMapUrl: new URL('./pdf/cmaps/', location.href).href, cMapPacked: true, standardFontDataUrl: new URL('./pdf/standard_fonts/', location.href).href, wasmUrl: new URL('./pdf/wasm/', location.href).href, useSystemFonts: false });
  const pdfDocument = await loadingTask.promise;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    if (pdfDocument.numPages > job.maxPages) throw new Error('fixture page limit exceeded');
    const pages: ExtractionPage[] = [];
    for (let number = 1; number <= pdfDocument.numPages; number++) {
      const page = await pdfDocument.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').trim();
      if (text) { pages.push({ page: number, method: 'embedded-text', text }); continue; }
      const viewport = page.getViewport({ scale: 2 });
      if (viewport.width * viewport.height > job.maxPixels) throw new Error('fixture pixel limit exceeded');
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      window.extraction.result({ id: job.id, kind: 'progress', phase: 'ocr' });
      if (!worker) {
        worker = await createWorker('eng', 1, { workerPath: new URL('./ocr/worker.min.js', location.href).href, corePath: new URL('./ocr/core/', location.href).href, langPath: new URL(job.missingLanguage ? './ocr/missing/' : './ocr/', location.href).href, workerBlobURL: false, cacheMethod: 'none', errorHandler: error => window.extraction.result({ id: job.id, kind: 'error', error: String(error) }) });
      }
      const result = await worker.recognize(canvas);
      pages.push({ page: number, method: 'local-ocr', text: result.data.text, confidence: result.data.confidence });
      page.cleanup();
    }
    return { pages, nodeAvailable: typeof (globalThis as typeof globalThis & { require?: unknown }).require !== 'undefined', crossOriginIsolated: globalThis.crossOriginIsolated };
  } finally { if (worker) await worker.terminate(); await loadingTask.destroy(); }
}

window.extraction.onJob(job => {
  void execute(job).then(value => window.extraction.result({ id: job.id, kind: 'result', value }), error => window.extraction.result({ id: job.id, kind: 'error', error: String(error) }));
});
window.extraction.ready();
