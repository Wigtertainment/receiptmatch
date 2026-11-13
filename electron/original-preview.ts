import { BrowserWindow, ipcMain, session, type Session, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { originalSourceExtensions, type OriginalPreviewData, type OriginalPreviewResult } from '../src/shared/original-preview.js';
import { imageInputDimensions } from './extraction/image-input.js';
import { readSourceSnapshot } from './import/source.js';

const origin = 'receiptmatch-extraction://preview';
const previewUrl = `${origin}/index.html`;
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm' };
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export interface OriginalSource {
    filePath: string;
    sha256: string;
    format: OriginalPreviewData['format'];
}

async function createPreviewSession(): Promise<Session> {
    const root = path.join(__dirname, 'preview');
    const pdf = path.join(__dirname, 'extraction', 'pdf');
    const files = new Map(['index.html', 'viewer.css', 'viewer.js'].map(name => [`${origin}/${name}`, path.join(root, name)]));
    async function collect(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await collect(file);
            else if (entry.isFile()) files.set(`${origin}/pdf/${path.relative(pdf, file).split(path.sep).map(encodeURIComponent).join('/')}`, file);
        }
    }
    await collect(pdf);
    const isolated = session.fromPartition('receiptmatch-preview', { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !files.has(details.url) && !details.url.startsWith(`blob:${origin}/`) }));
    isolated.protocol.handle('receiptmatch-extraction', async request => {
        const file = request.method === 'GET' ? files.get(request.url) : undefined;
        if (!file) return new Response('Not found', { status: 404 });
        try {
            return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
                'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff' } });
        } catch {
            return new Response('Preview resource unavailable', { status: 404 });
        }
    });
    return isolated;
}

export class OriginalPreviewWindows {
    private readonly windows = new Map<string, BrowserWindow>();
    private readonly payloads = new Map<WebContents, OriginalPreviewData>();
    private previewSession?: Promise<Session>;
    private generation = 0;

    constructor(private readonly hidden: boolean) {
        ipcMain.handle('preview:read', (event, ...args: unknown[]) => {
            const data = this.payloads.get(event.sender);
            if (!data || args.length || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== previewUrl) throw new Error('Preview request denied.');
            this.payloads.delete(event.sender);
            return data;
        });
    }

    closeAll() {
        this.generation++;
        for (const preview of this.windows.values()) if (!preview.isDestroyed()) preview.destroy();
        this.windows.clear();
        this.payloads.clear();
    }

    async open(key: string, source: OriginalSource): Promise<OriginalPreviewResult> {
        const generation = this.generation;
        let bytes: Uint8Array;
        try {
            bytes = await readSourceSnapshot(source.filePath, originalSourceExtensions[source.format]);
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing', error: 'The original file is no longer at its imported location or its last linked path.' };
            if (code === 'source-changed') return { status: 'changed', error: 'The file at the linked location changed while it was being read.' };
            return { status: 'unreadable', error: 'The original file could not be read.' };
        }
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) return { status: 'changed', error: 'The file at the linked location has changed. Locate an identical copy of the original.' };
        if (source.format !== 'pdf') {
            try { imageInputDimensions(bytes, source.format); }
            catch { return { error: 'The original image could not be read within the preview limits.' }; }
        }
        if (generation !== this.generation) return { error: 'The workspace changed before the preview opened.' };
        let preview: BrowserWindow | undefined;
        try {
            this.previewSession ??= createPreviewSession().catch(error => { this.previewSession = undefined; throw error; });
            const isolated = await this.previewSession;
            if (generation !== this.generation) return { error: 'The workspace changed before the preview opened.' };
            if (this.focusExisting(key)) return { error: null };
            const name = path.basename(source.filePath);
            preview = new BrowserWindow({ title: `${name} — ReceiptMatch`, width: 860, height: 760, minWidth: 360, minHeight: 300,
                show: false, webPreferences: { session: isolated, preload: path.join(__dirname, 'preview-preload.cjs'), sandbox: true, contextIsolation: true,
                    nodeIntegration: false, spellcheck: false } });
            preview.setMenu(null);
            const contents = preview.webContents;
            this.windows.set(key, preview);
            this.payloads.set(contents, { name, bytes, format: source.format });
            preview.once('closed', () => {
                if (this.windows.get(key) === preview) this.windows.delete(key);
                this.payloads.delete(contents);
            });
            contents.setWindowOpenHandler(() => ({ action: 'deny' }));
            contents.on('will-frame-navigate', event => event.preventDefault());
            contents.on('will-redirect', event => event.preventDefault());
            contents.on('will-attach-webview', event => event.preventDefault());
            await preview.loadURL(previewUrl);
            if (!this.hidden && !preview.isDestroyed()) preview.show();
            return { error: null };
        } catch {
            if (preview && !preview.isDestroyed()) preview.destroy();
            return { error: 'The document preview could not be opened.' };
        }
    }

    private focusExisting(key: string): boolean {
        const existing = this.windows.get(key);
        if (!existing || existing.isDestroyed()) return false;
        if (!this.hidden) {
            if (existing.isMinimized()) existing.restore();
            existing.focus();
        }
        return true;
    }
}
