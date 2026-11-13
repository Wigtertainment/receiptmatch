import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { localOcrModelSchema, type LocalOcrModel } from '../src/shared/pdf-extraction.js';
import { localOcrSelectionSchema, type LocalOcrSelection, type LocalOcrStatus } from '../src/shared/local-ocr-settings.js';
import type { LocalDocumentOcr } from './extraction/host.js';
import { LOCAL_OCR_ASSETS } from './local-ocr-assets.js';
import { downloadModelAssets } from './local-ocr-transfer.js';

const names: Record<LocalOcrModel, string> = { 'pp-ocrv6-medium': 'PP-OCRv6 Medium', 'paddleocr-vl-1.6': 'PaddleOCR-VL 1.6' };
const installationNames = Object.fromEntries(localOcrModelSchema.options.map(model => {
    const hash = createHash('sha256').update(LOCAL_OCR_ASSETS[model].map(asset => asset.sha256).join('')).digest('hex');
    return [model, model + '-' + hash];
})) as Record<LocalOcrModel, string>;

async function regularFile(file: string, bytes?: number): Promise<boolean> {
    try {
        const entry = await lstat(file);
        return entry.isFile() && (bytes === undefined || entry.size === bytes);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

async function runtimeAvailable(executable: string): Promise<boolean> {
    try {
        await access(executable, constants.X_OK);
        return (await stat(executable)).isFile();
    } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
    }
}

async function runtimeIssue(model: LocalOcrModel, executable: string): Promise<string | undefined> {
    if (!await runtimeAvailable(executable)) return 'The OCR runtime is unavailable on this installation.';
    if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot;
        const libraries = model === 'pp-ocrv6-medium' ? ['msvcp140.dll', 'msvcp140_1.dll'] : ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
        if (!systemRoot || !(await Promise.all(libraries.map(file => regularFile(path.join(systemRoot, 'System32', file))))).every(Boolean)) {
            return 'Requires the Microsoft Visual C++ Redistributable (x64).';
        }
    }
    return undefined;
}

export class LocalOcrSettings {
    private operation?: { controller: AbortController; download: LocalOcrStatus['download']; done: Promise<void> };
    private failedDownload: LocalOcrModel | null = null;

    constructor(private readonly root: string, private readonly runtimes: Record<LocalOcrModel, string>, private readonly transfer = downloadModelAssets) {}

    private async read(): Promise<LocalOcrSelection> {
        try {
            const checked = localOcrSelectionSchema.safeParse(JSON.parse(await readFile(path.join(this.root, 'selection.json'), 'utf8')));
            if (checked.success) return checked.data;
        } catch (error) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return 'standard';
    }

    private async write(selection: LocalOcrSelection, signal: AbortSignal): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const temporary = path.join(this.root, '.settings-' + randomUUID());
        try {
            await writeFile(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
            signal.throwIfAborted();
            await rename(temporary, path.join(this.root, 'selection.json'));
        } finally {
            await rm(temporary, { force: true });
        }
    }

    private async installed(model: LocalOcrModel): Promise<string | undefined> {
        const directory = path.join(this.root, installationNames[model]);
        const files = await Promise.all(LOCAL_OCR_ASSETS[model].map(asset => regularFile(path.join(directory, asset.file), asset.bytes)));
        return files.every(Boolean) ? directory : undefined;
    }

    async status(): Promise<LocalOcrStatus> {
        const operation = this.operation;
        const selection = await this.read();
        const models = await Promise.all(localOcrModelSchema.options.map(async model => {
            const issue = await runtimeIssue(model, this.runtimes[model]);
            return {
                model, name: names[model],
                downloadBytes: LOCAL_OCR_ASSETS[model].reduce((total, asset) => total + asset.bytes, 0),
                installed: !!(await this.installed(model)), runtimeAvailable: !issue, runtimeIssue: issue
            };
        }));
        if (operation !== this.operation) return this.status();
        const download = operation?.download;
        const effective = models.some(model => model.model === selection && model.installed && model.runtimeAvailable);
        return { selection: effective ? selection : 'standard', models, download: download ? { ...download } : null, failedDownload: this.failedDownload };
    }

    async selected(): Promise<LocalDocumentOcr | undefined> {
        const model = await this.read();
        if (model === 'standard') return undefined;
        const directory = await this.installed(model);
        const executable = this.runtimes[model];
        if (!directory || await runtimeIssue(model, executable)) return undefined;
        if (model === 'pp-ocrv6-medium') {
            return { model, files: { executable, detection: path.join(directory, 'medium-det'), recognition: path.join(directory, 'medium-rec') } };
        }
        return { model, files: { executable, model: path.join(directory, 'model.gguf'), projector: path.join(directory, 'mmproj.gguf'),
            template: path.join(directory, 'chat_template.jinja') } };
    }

    private run(action: (signal: AbortSignal) => Promise<void>, download: LocalOcrStatus['download'] = null): Promise<void> {
        if (this.operation) throw new Error('A local OCR settings operation is already running.');
        const controller = new AbortController();
        this.failedDownload = null;
        const done = Promise.resolve().then(() => action(controller.signal)).catch((error: unknown) => {
            if (download && !controller.signal.aborted) this.failedDownload = download.model;
            throw error;
        }).finally(() => { this.operation = undefined; });
        this.operation = { controller, download, done };
        return done;
    }

    select(selection: LocalOcrSelection): Promise<void> {
        return this.run(async signal => {
            if (selection !== 'standard' &&
                (!await this.installed(selection) || await runtimeIssue(selection, this.runtimes[selection]))) {
                throw new Error('The selected local OCR model is unavailable.');
            }
            await this.write(selection, signal);
        });
    }

    install(model: LocalOcrModel): Promise<void> {
        const assets = LOCAL_OCR_ASSETS[model];
        const download = { model, receivedBytes: 0, totalBytes: assets.reduce((total, asset) => total + asset.bytes, 0) };
        return this.run(async signal => {
            const issue = await runtimeIssue(model, this.runtimes[model]);
            if (issue) throw new Error(issue);
            signal.throwIfAborted();
            if (await this.installed(model)) {
                await this.write(model, signal);
                return;
            }
            await mkdir(this.root, { recursive: true });
            const staging = await mkdtemp(path.join(this.root, '.download-'));
            const directory = path.join(this.root, installationNames[model]);
            try {
                await this.transfer(assets, staging, signal, bytes => { download.receivedBytes = bytes; });
                signal.throwIfAborted();
                try {
                    await rename(staging, directory);
                } catch (error) {
                    if (!await this.installed(model)) throw error;
                }
                await this.write(model, signal);
            } finally {
                await rm(staging, { recursive: true, force: true, maxRetries: 3 });
            }
        }, download);
    }

    async cancel(): Promise<void> {
        const operation = this.operation;
        if (operation?.download) operation.controller.abort();
        await operation?.done.catch(() => undefined);
    }
}
