import type { BankImportInput, ImportIssue, ImportPage, PositionedSpan } from "../../src/shared/bank-import.js";
import { app, BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bankImportInputSchema, importIssue } from '../../src/shared/bank-import.js';
import {
    EXTRACTION_CHANNELS,
    extractionEventSchema,
    LOCAL_OCR_VERSIONS,
    OCR_RASTER_BYTES,
    ocrRasterSchema,
    ocrRegionsSchema,
    PDF_EXTRACTION_LIMITS,
    PDF_EXTRACTION_VERSION,
    type ExtractionJob,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';
import { imageInputDimensions, ImageInputError } from './image-input.js';
import { recognizePaddleMedium, type PaddleMediumFiles } from './paddle-medium.js';
import { PaddleVlCleanupError, recognizePaddleVl, type PaddleVlFiles } from './paddle-vl.js';

export type LocalDocumentOcr = { model: 'pp-ocrv6-medium'; files: PaddleMediumFiles } | { model: 'paddleocr-vl-1.6'; files: PaddleVlFiles };
interface ExtractionOptions {
    signal?: AbortSignal;
    onProgress?: (progress: ExtractionProgress) => void;
}

export const EXTRACTION_URL: "receiptmatch-extraction://engine/index.html" = 'receiptmatch-extraction://engine/index.html';
export const EXTRACTION_SCHEME_DESCRIPTOR: { scheme: string; privileges: { standard: boolean; secure: boolean; supportFetchAPI: boolean; corsEnabled: boolean; stream: boolean; }; } = {
    scheme: 'receiptmatch-extraction',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
};
const csp: string =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; style-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const readySchema: z.ZodObject<{ jobId: z.ZodUUID; }, z.core.$strict> = z.strictObject({ jobId: z.uuid() });
let active: boolean = false;
let cleanupFailed: boolean = false;

function failure(code: string, message: string, status: 'failed' | 'cancelled' = 'failed'): ExtractionResult {
    return { status, issues: [importIssue(code, message)] };
}

async function assetFiles(): Promise<Map<string, string>> {
    const root: string = path.join(__dirname, 'extraction');
    const files: Map<string, string> = new Map<string, string>();
    async function collect(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file: string = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await collect(file);
            } else if (entry.isFile()) {
                files.set('/' + path.relative(root, file).split(path.sep).join('/'), file);
            }
        }
    }
    for (const filename of ['index.html', 'renderer.js']) {
        files.set('/' + filename, path.join(root, filename));
    }
    await collect(path.join(root, 'pdf'));
    await collect(path.join(root, 'ocr'));
    return files;
}

function allowedAsset(value: string, files: Map<string, string>): string | undefined {
    try {
        const url: URL = new URL(value);
        if (url.protocol !== 'receiptmatch-extraction:' || url.hostname !== 'engine' || url.port || url.username || url.password || url.search || url.hash) {
            return undefined;
        }
        return files.get(url.pathname);
    } catch {
        return undefined;
    }
}

async function cleanupSession(value: Session, handled: boolean): Promise<boolean> {
    try {
        value.webRequest.onBeforeRequest((_details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => callback({ cancel: true }));
        if (handled) {
            value.protocol.unhandle('receiptmatch-extraction');
        }
        return await new Promise<boolean>((resolve: (value: boolean | PromiseLike<boolean>) => void): void => {
            const timeout: NodeJS.Timeout = setTimeout((): void => resolve(false), 2000);
            void Promise.allSettled([value.closeAllConnections(), value.clearStorageData(), value.clearCache()]).then((results: [PromiseSettledResult<void>, PromiseSettledResult<void>, PromiseSettledResult<void>]): void => {
                clearTimeout(timeout);
                resolve(results.every((result: PromiseSettledResult<void>): result is PromiseFulfilledResult<void> => result.status === 'fulfilled'));
            });
        });
    } catch {
        return false;
    }
}

export async function extractPdfBytes(
    bytes: Uint8Array,
    sourceId: string,
    options: ExtractionOptions = {}
): Promise<ExtractionResult> {
    return extractDocumentBytes(bytes, sourceId, 'pdf', { signal: options.signal, onProgress: options.onProgress });
}

export async function extractDocumentBytes(
    bytes: Uint8Array,
    sourceId: string,
    format: 'pdf' | 'png' | 'jpeg',
    options: ExtractionOptions & { localOcr?: LocalDocumentOcr } = {}
): Promise<ExtractionResult> {
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > PDF_EXTRACTION_LIMITS.bytes ||
        !z
            .string()
            .min(1)
            .max(128)
            .refine((value: string): boolean => value.trim().length > 0)
            .safeParse(sourceId).success
    ) {
        return failure('invalid-input', 'Choose a nonempty document within the local extraction byte limit and provide a valid source identity.');
    }
    if (!['pdf', 'png', 'jpeg'].includes(format)) {
        return failure('image-format', 'Choose an authorized PDF, PNG or JPEG format.');
    }
    if (options.signal?.aborted) {
        return failure('cancelled', 'Document extraction was cancelled.', 'cancelled');
    }
    if (active) {
        return failure('busy', 'Another document extraction is already running.');
    }
    if (cleanupFailed) {
        return failure('engine-cleanup', 'The extraction session could not be cleared safely. Restart ReceiptMatch before another extraction.');
    }
    const snapshot: Uint8Array<ArrayBuffer> = Uint8Array.from(bytes);
    let imageDimensions: { width: number; height: number } | null = null;
    if (format !== 'pdf') {
        try {
            imageDimensions = imageInputDimensions(snapshot, format);
        } catch (error: unknown) {
            return failure(error instanceof ImageInputError ? error.code : 'image-invalid', error instanceof ImageInputError ? error.message : 'The image header could not be read safely.');
        }
    }
    if (!app.isReady()) {
        return failure('engine-not-ready', 'The desktop extraction runtime is not ready.');
    }
    active = true;
    const jobId: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
    const localOcr: LocalDocumentOcr | undefined = options.localOcr;
    const job: ExtractionJob = { jobId, sourceId, format, sha256: createHash('sha256').update(snapshot).digest('hex'), bytes: snapshot, ocrModel: localOcr?.model };
    return new Promise<ExtractionResult>((resolve: (value: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } | PromiseLike<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }>) => void): void => {
        let window: BrowserWindow | undefined;
        let isolatedSession: Session | undefined;
        let settled: boolean = false;
        let started: boolean = false;
        let handled: boolean = false;
        let recognition: Promise<unknown> | undefined;
        let lastOcrPage: number = 0;
        let ocrPixels: number = 0;
        let extractionVersion: string = PDF_EXTRACTION_VERSION;
        const modelAbort: AbortController = new AbortController();
        const finish: (result: ExtractionResult) => void = (result: ExtractionResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            ipcMain.removeListener(EXTRACTION_CHANNELS.ready, ready);
            ipcMain.removeListener(EXTRACTION_CHANNELS.event, event);
            if (localOcr) {
                ipcMain.removeHandler(EXTRACTION_CHANNELS.recognize);
            }
            modelAbort.abort();
            try {
                if (window && !window.isDestroyed()) {
                    window.destroy();
                }
            } catch {
                cleanupFailed = true;
            }
            void Promise.all([isolatedSession ? cleanupSession(isolatedSession, handled) : Promise.resolve(true), recognition?.catch((): undefined => undefined)]).then(([clean]: [boolean, unknown]): void => {
                cleanupFailed ||= !clean;
                active = false;
                resolve(cleanupFailed ? failure('engine-cleanup', 'The extraction session could not be cleared safely. Restart ReceiptMatch before another extraction.') : result);
            });
        };

        const abort: () => void = (): void => finish(failure('cancelled', 'Document extraction was cancelled.', 'cancelled'));
        const timeout: NodeJS.Timeout = setTimeout((): void => finish(failure('timeout', 'Document extraction exceeded its local execution time limit.')), PDF_EXTRACTION_LIMITS.timeoutMs);
        const authorized: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean | undefined = (event: IpcMainEvent | IpcMainInvokeEvent): boolean | undefined =>
            window &&
            !window.isDestroyed() &&
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame &&
            event.senderFrame?.url === EXTRACTION_URL;

        const recognize: (event: IpcMainInvokeEvent, requestJobId: unknown, payload: unknown) => Promise<{ text: string; x0: number; y0: number; x1: number; y1: number; }[]> = async (event: IpcMainInvokeEvent, requestJobId: unknown, payload: unknown): Promise<{ text: string; x0: number; y0: number; x1: number; y1: number; }[]> => {
            if (!localOcr || !authorized(event) || settled || !started || requestJobId !== jobId || recognition) {
                throw new Error('OCR request denied.');
            }
            const parsed: z.ZodSafeParseResult<{ pageNumber: number; width: number; height: number; png: Uint8Array<ArrayBuffer>; }> = ocrRasterSchema.safeParse(payload);
            if (!parsed.success) {
                throw new Error('Invalid OCR raster.');
            }
            const { pageNumber, width, height, png }: { pageNumber: number; width: number; height: number; png: Uint8Array<ArrayBuffer>; } = parsed.data;
            const dimensions: { width: number; height: number; } = imageInputDimensions(png, 'png', OCR_RASTER_BYTES);
            if (dimensions.width !== width || dimensions.height !== height || pageNumber <= lastOcrPage ||
                (format !== 'pdf' && pageNumber !== 1) || ocrPixels + width * height > PDF_EXTRACTION_LIMITS.pixelsTotal) {
                    throw new Error('Invalid OCR raster.');
                }
            lastOcrPage = pageNumber;
            ocrPixels += width * height;
            timeout.refresh();
            const pending: Promise<{ text: string; x0: number; y0: number; x1: number; y1: number; }[]> = localOcr.model === 'pp-ocrv6-medium'
                ? recognizePaddleMedium(localOcr.files, png, width, height, modelAbort.signal)
                : recognizePaddleVl(localOcr.files, png, width, height, modelAbort.signal);
            recognition = pending;
            try {
                const regions: { text: string; x0: number; y0: number; x1: number; y1: number; }[] = ocrRegionsSchema.parse(await pending);
                if (regions.some((region: { text: string; x0: number; y0: number; x1: number; y1: number; }): boolean => region.x1 > width || region.y1 > height)) {
                    throw new Error('Invalid OCR coordinates.');
                }
                extractionVersion = LOCAL_OCR_VERSIONS[localOcr.model];
                return regions;
            } catch (error: unknown) {
                if (error instanceof PaddleVlCleanupError) {
                    cleanupFailed = true;
                    finish(failure('engine-cleanup', 'The temporary local OCR image could not be removed.'));
                }
                throw new Error('The selected local OCR model could not read this page.', { cause: error });
            } finally {
                recognition = undefined;
                if (!settled) {
                    timeout.refresh();
                }
            }
        };

        const ready: (event: IpcMainEvent, payload: unknown) => void = (event: IpcMainEvent, payload: unknown): void => {
            if (!authorized(event) || settled) {
                return;
            }
            const parsed: z.ZodSafeParseResult<{ jobId: string; }> = readySchema.safeParse(payload);
            if (!parsed.success || parsed.data.jobId !== jobId || started) {
                return;
            }
            started = true;
            window!.webContents.send(EXTRACTION_CHANNELS.job, job);
        };

        const event: (event: IpcMainEvent, payload: unknown) => void = (event: IpcMainEvent, payload: unknown): void => {
            if (!authorized(event) || settled) {
                return;
            }
            const parsed: z.ZodSafeParseResult<{ jobId: string; event: { type: "progress"; progress: ExtractionProgress; } | { type: "result"; result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }; }; }> = extractionEventSchema.safeParse(payload);
            if (!parsed.success || parsed.data.jobId !== jobId || !started) {
                finish(failure('engine-result', 'The extraction engine returned an invalid message.'));
                return;
            }
            const message: { type: "progress"; progress: ExtractionProgress; } | { type: "result"; result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }; } = parsed.data.event;
            if (message.type === 'progress') {
                try {
                    options.onProgress?.(message.progress);
                } catch {
                    finish(failure('progress-handler', 'The extraction progress consumer failed.'));
                }
                return;
            }
            const result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = message.result;
            if (result.status === 'complete' || result.status === 'partial') {
                const checked: z.ZodSafeParseResult<BankImportInput> = bankImportInputSchema.safeParse(result.input);
                if (
                    !checked.success ||
                    checked.data.source.sourceId !== sourceId ||
                    checked.data.source.sha256 !== job.sha256 ||
                    checked.data.extraction.runId !== jobId ||
                    checked.data.extraction.version !== extractionVersion ||
                    recognition !== undefined ||
                    checked.data.pages.some((page: ImportPage, index: number): boolean => page.pageNumber !== index + 1) ||
                    (imageDimensions && (checked.data.pages.length !== 1 || checked.data.pages[0].status !== 'complete' ||
                        !((checked.data.pages[0].width === imageDimensions.width && checked.data.pages[0].height === imageDimensions.height) ||
                            (checked.data.pages[0].width === imageDimensions.height && checked.data.pages[0].height === imageDimensions.width)) ||
                        checked.data.pages[0].spans.some((span: PositionedSpan): boolean => span.method !== 'local-ocr')))
                ) {
                    finish(failure('engine-result', 'The extraction result does not match the authorized source and execution.'));
                    return;
                }
                finish({ status: result.status, input: checked.data });
            } else {
                finish(result);
            }
        };
        ipcMain.on(EXTRACTION_CHANNELS.ready, ready);
        ipcMain.on(EXTRACTION_CHANNELS.event, event);
        if (localOcr) {
            ipcMain.handle(EXTRACTION_CHANNELS.recognize, recognize);
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
            abort();
            return;
        }
        void (async (): Promise<void> => {
            try {
                const files: Map<string, string> = await assetFiles();
                if (settled) {
                    return;
                }
                isolatedSession = session.fromPartition('receiptmatch-extraction', { cache: false });
                isolatedSession.setPermissionRequestHandler((_contents: Electron.WebContents, _permission: "ar" | "automatic-fullscreen" | "background-fetch" | "background-sync" | "captured-surface-control" | "clipboard-read" | "clipboard-sanitized-write" | "deprecated-sync-clipboard-read" | "display-capture" | "fileSystem" | "fullscreen" | "geolocation" | "geolocation-approximate" | "hand-tracking" | "hid" | "idle-detection" | "keyboardLock" | "local-fonts" | "local-network" | "local-network-access" | "loopback-network" | "media" | "mediaKeySystem" | "midi" | "midiSysex" | "nfc" | "notifications" | "openExternal" | "payment-handler" | "periodic-background-sync" | "persistent-storage" | "pointerLock" | "screen-wake-lock" | "sensors" | "serial" | "smart-card" | "speaker-selection" | "storage-access" | "system-wake-lock" | "top-level-storage-access" | "usb" | "vr" | "web-app-installation" | "web-printing" | "window-management" | "unknown", callback: (permissionGranted: boolean) => void): void => callback(false));
                isolatedSession.setPermissionCheckHandler((): false => false);
                isolatedSession.webRequest.onBeforeRequest((details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => callback({ cancel: !allowedAsset(details.url, files) }));
                isolatedSession.protocol.handle('receiptmatch-extraction', async (request: Request): Promise<Response> => {
                    const file: string | undefined = allowedAsset(request.url, files);
                    if (!file || request.method !== 'GET') {
                        return new Response('Not found', { status: 404 });
                    }
                    const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm' };
                    try {
                        return new Response(await readFile(file), {
                            headers: {
                                'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
                                'Content-Security-Policy': csp,
                                'X-Content-Type-Options': 'nosniff'
                            }
                        });
                    } catch {
                        return new Response('Local extraction resource unavailable', { status: 404 });
                    }
                });
                handled = true;
                window = new BrowserWindow({
                    show: false,
                    webPreferences: {
                        session: isolatedSession,
                        preload: path.join(__dirname, 'extraction-preload.cjs'),
                        sandbox: true,
                        contextIsolation: true,
                        nodeIntegration: false,
                        nodeIntegrationInWorker: false,
                        backgroundThrottling: false,
                        spellcheck: false,
                        additionalArguments: [`--receiptmatch-extraction-job=${jobId}`]
                    }
                });
                window.webContents.setWindowOpenHandler((): { action: "deny"; } => ({ action: 'deny' }));
                window.webContents.on('will-navigate', (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => event.preventDefault());
                window.webContents.on('will-frame-navigate', (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => event.preventDefault());
                window.webContents.on('will-redirect', (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>): void => event.preventDefault());
                window.webContents.on('will-attach-webview', (event: { preventDefault: () => void; readonly defaultPrevented: boolean; }): void => event.preventDefault());
                window.webContents.once('render-process-gone', (): void => finish(failure('engine-crashed', 'The isolated document extraction process stopped.')));
                window.once('closed', (): void => finish(failure('engine-crashed', 'The isolated document extraction window closed.')));
                await window.loadURL(EXTRACTION_URL);
            } catch {
                finish(failure('engine-load', 'The local document extraction engine could not start.'));
            }
        })();
    });
}
