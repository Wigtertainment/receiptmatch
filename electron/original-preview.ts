import { BrowserWindow, ipcMain, session, type Session, type WebContents } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { originalSourceExtensions, type OriginalPreviewData, type OriginalPreviewResult } from '../src/shared/original-preview.js';
import { imageInputDimensions } from './extraction/image-input.js';
import { readSourceSnapshot } from './import/source.js';

const origin: "receiptmatch-extraction://preview" = 'receiptmatch-extraction://preview';
const previewUrl: "receiptmatch-extraction://preview/index.html" = `${origin}/index.html`;
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm' };
const policy: string = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'__STYLE_NONCE__; img-src 'self' blob: data:; font-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export interface OriginalSource {
    filePath: string;
    sha256: string;
    format: OriginalPreviewData['format'];
}

function previewReadFailure(error: unknown): OriginalPreviewResult {
    const code: unknown = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { status: 'missing', error: 'The original file is no longer at its imported location or its last linked path.' };
    }
    if (code === 'source-changed') {
        return { status: 'changed', error: 'The file at the linked location changed while it was being read.' };
    }
    return { status: 'unreadable', error: 'The original file could not be read.' };
}

async function createPreviewSession(): Promise<Session> {
    const root: string = path.join(__dirname, 'preview', 'browser');
    const pdf: string = path.join(__dirname, 'extraction', 'pdf');
    const files: Map<string, string> = new Map<string, string>();
    async function collect(directory: string, prefix: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file: string = path.join(directory, entry.name);
            const url: string = `${prefix}/${encodeURIComponent(entry.name)}`;
            if (entry.isDirectory()) {
                await collect(file, url);
            } else if (entry.isFile()) {
                files.set(url, file);
            }
        }
    }
    await collect(root, origin);
    await collect(pdf, `${origin}/pdf`);
    const isolated: Electron.Session = session.fromPartition('receiptmatch-preview', { cache: false });
    isolated.setPermissionRequestHandler((_contents: Electron.WebContents, _permission: "ar" | "automatic-fullscreen" | "background-fetch" | "background-sync" | "captured-surface-control" | "clipboard-read" | "clipboard-sanitized-write" | "deprecated-sync-clipboard-read" | "display-capture" | "fileSystem" | "fullscreen" | "geolocation" | "geolocation-approximate" | "hand-tracking" | "hid" | "idle-detection" | "keyboardLock" | "local-fonts" | "local-network" | "local-network-access" | "loopback-network" | "media" | "mediaKeySystem" | "midi" | "midiSysex" | "nfc" | "notifications" | "openExternal" | "payment-handler" | "periodic-background-sync" | "persistent-storage" | "pointerLock" | "screen-wake-lock" | "sensors" | "serial" | "smart-card" | "speaker-selection" | "storage-access" | "system-wake-lock" | "top-level-storage-access" | "usb" | "vr" | "web-app-installation" | "web-printing" | "window-management" | "unknown", callback: (permissionGranted: boolean) => void): void => callback(false));
    isolated.setPermissionCheckHandler((): false => false);
    isolated.webRequest.onBeforeRequest((details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => callback({ cancel: !files.has(details.url) && !details.url.startsWith(`blob:${origin}/`) }));
    isolated.protocol.handle('receiptmatch-extraction', async (request: Request): Promise<Response> => {
        const file: string | undefined = request.method === 'GET' ? files.get(request.url) : undefined;
        if (!file) {
            return new Response('Not found', { status: 404 });
        }
        try {
            const nonce: string | null = request.url === previewUrl ? randomBytes(18).toString('base64') : null;
            const body: string | NonSharedBuffer = nonce ? (await readFile(file, 'utf8')).replaceAll('__RECEIPTMATCH_STYLE_NONCE__', nonce) : await readFile(file);
            return new Response(body, { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
                'Content-Security-Policy': policy.replace('__STYLE_NONCE__', nonce ? ` 'nonce-${nonce}'` : ''), 'X-Content-Type-Options': 'nosniff',
                ...(nonce && { 'Cache-Control': 'no-store' }) } });
        } catch {
            return new Response('Preview resource unavailable', { status: 404 });
        }
    });
    return isolated;
}

export class OriginalPreviewWindows {
    private readonly windows: Map<string, BrowserWindow> = new Map<string, BrowserWindow>();
    private readonly payloads: Map<Electron.WebContents, OriginalPreviewData> = new Map<WebContents, OriginalPreviewData>();
    private previewSession?: Promise<Session>;
    private generation: number = 0;

    constructor(private readonly hidden: boolean) {
        ipcMain.handle('preview:read', (event: Electron.IpcMainInvokeEvent, ...args: unknown[]): OriginalPreviewData => {
            const data: OriginalPreviewData | undefined = this.payloads.get(event.sender);
            if (!data || args.length || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== previewUrl) {
                throw new Error('Preview request denied.');
            }
            this.payloads.delete(event.sender);
            return data;
        });
    }

    closeAll(): void {
        this.generation++;
        for (const preview of this.windows.values()) {
            if (!preview.isDestroyed()) {
                preview.destroy();
            }
        }
        this.windows.clear();
        this.payloads.clear();
    }

    async open(key: string, source: OriginalSource): Promise<OriginalPreviewResult> {
        const generation: number = this.generation;
        let bytes: Uint8Array;
        try {
            bytes = await readSourceSnapshot(source.filePath, originalSourceExtensions[source.format]);
        } catch (error: unknown) {
            return previewReadFailure(error);
        }
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
            return { status: 'changed', error: 'The file at the linked location has changed. Locate an identical copy of the original.' };
        }
        if (source.format !== 'pdf') {
            try {
                imageInputDimensions(bytes, source.format);
            } catch {
                return { error: 'The original image could not be read within the preview limits.' };
            }
        }
        if (generation !== this.generation) {
            return { error: 'The workspace changed before the preview opened.' };
        }
        let preview: BrowserWindow | undefined;
        try {
            this.previewSession ??= createPreviewSession().catch((error: unknown): never => {
                this.previewSession = undefined; throw error;
            });
            const isolated: Electron.Session = await this.previewSession;
            if (generation !== this.generation) {
                return { error: 'The workspace changed before the preview opened.' };
            }
            if (this.focusExisting(key)) {
                return { error: null };
            }
            const name: string = path.basename(source.filePath);
            preview = new BrowserWindow({ title: `${name} — ReceiptMatch`, width: 860, height: 760, minWidth: 360, minHeight: 300,
                show: false, webPreferences: { session: isolated, preload: path.join(__dirname, 'preview-preload.cjs'), sandbox: true, contextIsolation: true,
                    nodeIntegration: false, spellcheck: false } });
            preview.setMenu(null);
            const contents: Electron.WebContents = preview.webContents;
            this.windows.set(key, preview);
            this.payloads.set(contents, { name, bytes, format: source.format });
            preview.once('closed', (): void => {
                if (this.windows.get(key) === preview) {
                    this.windows.delete(key);
                }
                this.payloads.delete(contents);
            });
            contents.setWindowOpenHandler((): { action: "deny"; } => ({ action: 'deny' }));
            contents.on('will-frame-navigate', (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => event.preventDefault());
            contents.on('will-redirect', (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>): void => event.preventDefault());
            contents.on('will-attach-webview', (event: { preventDefault: () => void; readonly defaultPrevented: boolean; }): void => event.preventDefault());
            await preview.loadURL(previewUrl);
            if (!this.hidden && !preview.isDestroyed()) {
                preview.show();
            }
            return { error: null };
        } catch {
            if (preview && !preview.isDestroyed()) {
                preview.destroy();
            }
            return { error: 'The document preview could not be opened.' };
        }
    }

    private focusExisting(key: string): boolean {
        const existing: BrowserWindow | undefined = this.windows.get(key);
        if (!existing || existing.isDestroyed()) {
            return false;
        }
        if (!this.hidden) {
            if (existing.isMinimized()) {
                existing.restore();
            }
            existing.focus();
        }
        return true;
    }
}
