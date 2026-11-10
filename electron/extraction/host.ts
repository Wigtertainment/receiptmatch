import { app, BrowserWindow, ipcMain, session, type IpcMainEvent, type Session } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bankImportInputSchema, importIssue } from '../../src/shared/bank-import.js';
import {
    EXTRACTION_CHANNELS,
    extractionEventSchema,
    PDF_EXTRACTION_LIMITS,
    PDF_EXTRACTION_VERSION,
    type ExtractionJob,
    type ExtractionProgress,
    type ExtractionResult
} from '../../src/shared/pdf-extraction.js';

export const EXTRACTION_URL = 'receiptmatch-extraction://engine/index.html';
export const EXTRACTION_SCHEME_DESCRIPTOR = {
    scheme: 'receiptmatch-extraction',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
};
const csp =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; style-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const readySchema = z.strictObject({ jobId: z.uuid() });
let active = false;
let cleanupFailed = false;

function failure(code: string, message: string, status: 'failed' | 'cancelled' = 'failed'): ExtractionResult {
    return { status, issues: [importIssue(code, message)] };
}
async function assetFiles() {
    const root = path.join(__dirname, 'extraction');
    const files = new Map<string, string>();
    async function collect(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await collect(file);
            else if (entry.isFile()) files.set('/' + path.relative(root, file).split(path.sep).join('/'), file);
        }
    }
    for (const filename of ['index.html', 'renderer.js']) files.set('/' + filename, path.join(root, filename));
    await collect(path.join(root, 'pdf'));
    await collect(path.join(root, 'ocr'));
    return files;
}
function allowedAsset(value: string, files: Map<string, string>): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== 'receiptmatch-extraction:' || url.hostname !== 'engine' || url.port || url.username || url.password || url.search || url.hash) return undefined;
        return files.get(url.pathname);
    } catch {
        return undefined;
    }
}
async function cleanupSession(value: Session, handled: boolean): Promise<boolean> {
    try {
        value.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
        if (handled) value.protocol.unhandle('receiptmatch-extraction');
        return await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 2000);
            void Promise.allSettled([value.closeAllConnections(), value.clearStorageData(), value.clearCache()]).then((results) => {
                clearTimeout(timeout);
                resolve(results.every((result) => result.status === 'fulfilled'));
            });
        });
    } catch {
        return false;
    }
}
export async function extractPdfBytes(
    bytes: Uint8Array,
    sourceId: string,
    options: { signal?: AbortSignal; onProgress?: (progress: ExtractionProgress) => void } = {}
): Promise<ExtractionResult> {
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > PDF_EXTRACTION_LIMITS.bytes ||
        !z
            .string()
            .min(1)
            .max(128)
            .refine((value) => value.trim().length > 0)
            .safeParse(sourceId).success
    ) {
        return failure('invalid-input', 'Choose a nonempty PDF within the local extraction byte limit and provide a valid source identity.');
    }
    if (options.signal?.aborted) return failure('cancelled', 'PDF extraction was cancelled.', 'cancelled');
    if (active) return failure('busy', 'Another PDF extraction is already running.');
    if (cleanupFailed) return failure('engine-cleanup', 'The extraction session could not be cleared safely. Restart ReceiptMatch before another extraction.');
    if (!app.isReady()) return failure('engine-not-ready', 'The desktop extraction runtime is not ready.');
    active = true;
    const snapshot = Uint8Array.from(bytes);
    const jobId = randomUUID();
    const job: ExtractionJob = { jobId, sourceId, sha256: createHash('sha256').update(snapshot).digest('hex'), bytes: snapshot };
    return new Promise<ExtractionResult>((resolve) => {
        let window: BrowserWindow | undefined;
        let isolatedSession: Session | undefined;
        let settled = false;
        let started = false;
        let handled = false;
        const finish = (result: ExtractionResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            ipcMain.removeListener(EXTRACTION_CHANNELS.ready, ready);
            ipcMain.removeListener(EXTRACTION_CHANNELS.event, event);
            try {
                if (window && !window.isDestroyed()) window.destroy();
            } catch {
                cleanupFailed = true;
            }
            void (isolatedSession ? cleanupSession(isolatedSession, handled) : Promise.resolve(true)).then((clean) => {
                cleanupFailed ||= !clean;
                active = false;
                resolve(cleanupFailed ? failure('engine-cleanup', 'The extraction session could not be cleared safely. Restart ReceiptMatch before another extraction.') : result);
            });
        };
        const abort = () => finish(failure('cancelled', 'PDF extraction was cancelled.', 'cancelled'));
        const timeout = setTimeout(() => finish(failure('timeout', 'PDF extraction exceeded its local execution time limit.')), PDF_EXTRACTION_LIMITS.timeoutMs);
        const authorized = (event: IpcMainEvent) =>
            window &&
            !window.isDestroyed() &&
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame &&
            event.senderFrame?.url === EXTRACTION_URL;
        const ready = (event: IpcMainEvent, payload: unknown) => {
            if (!authorized(event) || settled) return;
            const parsed = readySchema.safeParse(payload);
            if (!parsed.success || parsed.data.jobId !== jobId || started) return;
            started = true;
            window!.webContents.send(EXTRACTION_CHANNELS.job, job);
        };
        const event = (event: IpcMainEvent, payload: unknown) => {
            if (!authorized(event) || settled) return;
            const parsed = extractionEventSchema.safeParse(payload);
            if (!parsed.success || parsed.data.jobId !== jobId || !started) {
                finish(failure('engine-result', 'The extraction engine returned an invalid message.'));
                return;
            }
            const message = parsed.data.event;
            if (message.type === 'progress') {
                try {
                    options.onProgress?.(message.progress);
                } catch {
                    finish(failure('progress-handler', 'The extraction progress consumer failed.'));
                }
                return;
            }
            const result = message.result;
            if (result.status === 'complete' || result.status === 'partial') {
                const checked = bankImportInputSchema.safeParse(result.input);
                if (
                    !checked.success ||
                    checked.data.source.sourceId !== sourceId ||
                    checked.data.source.sha256 !== job.sha256 ||
                    checked.data.extraction.runId !== jobId ||
                    checked.data.extraction.version !== PDF_EXTRACTION_VERSION ||
                    checked.data.pages.some((page, index) => page.pageNumber !== index + 1)
                ) {
                    finish(failure('engine-result', 'The extraction result does not match the authorized source and execution.'));
                    return;
                }
                finish({ status: result.status, input: checked.data });
            } else finish(result);
        };
        ipcMain.on(EXTRACTION_CHANNELS.ready, ready);
        ipcMain.on(EXTRACTION_CHANNELS.event, event);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
            abort();
            return;
        }
        void (async () => {
            try {
                const files = await assetFiles();
                if (settled) return;
                isolatedSession = session.fromPartition('receiptmatch-extraction', { cache: false });
                isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
                isolatedSession.setPermissionCheckHandler(() => false);
                isolatedSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedAsset(details.url, files) }));
                isolatedSession.protocol.handle('receiptmatch-extraction', async (request) => {
                    const file = allowedAsset(request.url, files);
                    if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
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
                window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                window.webContents.on('will-navigate', (event) => event.preventDefault());
                window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
                window.webContents.on('will-redirect', (event) => event.preventDefault());
                window.webContents.on('will-attach-webview', (event) => event.preventDefault());
                window.webContents.once('render-process-gone', () => finish(failure('engine-crashed', 'The isolated PDF extraction process stopped.')));
                window.once('closed', () => finish(failure('engine-crashed', 'The isolated PDF extraction window closed.')));
                await window.loadURL(EXTRACTION_URL);
            } catch {
                finish(failure('engine-load', 'The local PDF extraction engine could not start.'));
            }
        })();
    });
}
