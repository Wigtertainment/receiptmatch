import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { localOcrModelSchema, type LocalOcrModel } from '../src/shared/pdf-extraction.js';
import { localOcrSelectionSchema, type LocalOcrSelection, type LocalOcrStatus } from '../src/shared/local-ocr-settings.js';
import type { LocalDocumentOcr } from './extraction/host.js';
import { LOCAL_OCR_ASSETS, type ModelAsset } from './local-ocr-assets.js';
import { downloadModelAssets } from './local-ocr-transfer.js';
import type { ZodSafeParseResult } from 'zod';

const names: Record<LocalOcrModel, string> = { 'pp-ocrv6-medium': 'PP-OCRv6 Medium', 'paddleocr-vl-1.6': 'PaddleOCR-VL 1.6' };
const installationNames: Record<"pp-ocrv6-medium" | "paddleocr-vl-1.6", string> = Object.fromEntries(localOcrModelSchema.options.map((model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"): ["pp-ocrv6-medium" | "paddleocr-vl-1.6", string] => {
    const hash: string = createHash('sha256').update(LOCAL_OCR_ASSETS[model].map((asset: ModelAsset): string => asset.sha256).join('')).digest('hex');
    return [model, model + '-' + hash];
})) as Record<LocalOcrModel, string>;

async function regularFile(file: string, bytes?: number): Promise<boolean> {
    try {
        const entry: Stats = await lstat(file);
        return entry.isFile() && (bytes === undefined || entry.size === bytes);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function runtimeAvailable(executable: string): Promise<boolean> {
    try {
        await access(executable, constants.X_OK);
        return (await stat(executable)).isFile();
    } catch (error: unknown) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            return false;
        }
        throw error;
    }
}

async function runtimeIssue(model: LocalOcrModel, executable: string): Promise<string | undefined> {
    if (!await runtimeAvailable(executable)) {
        return 'The OCR runtime is unavailable on this installation.';
    }
    if (process.platform === 'win32') {
        const systemRoot: string | undefined = process.env.SystemRoot;
        const libraries: string[] = model === 'pp-ocrv6-medium' ? ['msvcp140.dll', 'msvcp140_1.dll'] : ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
        if (!systemRoot || !(await Promise.all(libraries.map((file: string): Promise<boolean> => regularFile(path.join(systemRoot, 'System32', file))))).every(Boolean)) {
            return 'Requires the Microsoft Visual C++ Redistributable (x64).';
        }
    }
    return undefined;
}

export class LocalOcrSettings {
    private operation?: { controller: AbortController; download: LocalOcrStatus['download']; done: Promise<void> };
    private failedDownload: LocalOcrModel | null = null;

    constructor(private readonly root: string, private readonly runtimes: Record<LocalOcrModel, string>, private readonly transfer: (assets: readonly ModelAsset[], staging: string, signal: AbortSignal, onBytes: (bytes: number) => void) => Promise<void> = downloadModelAssets) {}

    private async read(): Promise<LocalOcrSelection> {
        try {
            const checked: ZodSafeParseResult<"pp-ocrv6-medium" | "paddleocr-vl-1.6" | "standard"> = localOcrSelectionSchema.safeParse(JSON.parse(await readFile(path.join(this.root, 'selection.json'), 'utf8')));
            if (checked.success) {
                return checked.data;
            }
        } catch (error: unknown) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        return 'standard';
    }

    private async write(selection: LocalOcrSelection, signal: AbortSignal): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const temporary: string = path.join(this.root, '.settings-' + randomUUID());
        try {
            await writeFile(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
            signal.throwIfAborted();
            await rename(temporary, path.join(this.root, 'selection.json'));
        } finally {
            await rm(temporary, { force: true });
        }
    }

    private async installed(model: LocalOcrModel): Promise<string | undefined> {
        const directory: string = path.join(this.root, installationNames[model]);
        const files: boolean[] = await Promise.all(LOCAL_OCR_ASSETS[model].map((asset: ModelAsset): Promise<boolean> => regularFile(path.join(directory, asset.file), asset.bytes)));
        return files.every(Boolean) ? directory : undefined;
    }

    async status(): Promise<LocalOcrStatus> {
        const operation: { controller: AbortController; download: LocalOcrStatus["download"]; done: Promise<void>; } | undefined = this.operation;
        const selection: "pp-ocrv6-medium" | "paddleocr-vl-1.6" | "standard" = await this.read();
        const models: { model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue: string | undefined; }[] = await Promise.all(localOcrModelSchema.options.map(async (model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"): Promise<{ model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue: string | undefined; }> => {
            const issue: string | undefined = await runtimeIssue(model, this.runtimes[model]);
            return {
                model, name: names[model],
                downloadBytes: LOCAL_OCR_ASSETS[model].reduce((total: number, asset: ModelAsset): number => total + asset.bytes, 0),
                installed: !!(await this.installed(model)), runtimeAvailable: !issue, runtimeIssue: issue
            };
        }));
        if (operation !== this.operation) {
            return this.status();
        }
        const download: { model: LocalOcrModel; receivedBytes: number; totalBytes: number; } | null | undefined = operation?.download;
        const effective: boolean = models.some((model: { model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue: string | undefined; }): boolean => model.model === selection && model.installed && model.runtimeAvailable);
        return { selection: effective ? selection : 'standard', models, download: download ? { ...download } : null, failedDownload: this.failedDownload };
    }

    async selected(): Promise<LocalDocumentOcr | undefined> {
        const model: "pp-ocrv6-medium" | "paddleocr-vl-1.6" | "standard" = await this.read();
        if (model === 'standard') {
            return undefined;
        }
        const directory: string | undefined = await this.installed(model);
        const executable: string = this.runtimes[model];
        if (!directory || await runtimeIssue(model, executable)) {
            return undefined;
        }
        if (model === 'pp-ocrv6-medium') {
            return { model, files: { executable, detection: path.join(directory, 'medium-det'), recognition: path.join(directory, 'medium-rec') } };
        }
        return { model, files: { executable, model: path.join(directory, 'model.gguf'), projector: path.join(directory, 'mmproj.gguf'),
            template: path.join(directory, 'chat_template.jinja') } };
    }

    private run(action: (signal: AbortSignal) => Promise<void>, download: LocalOcrStatus['download'] = null): Promise<void> {
        if (this.operation) {
            throw new Error('A local OCR settings operation is already running.');
        }
        const controller: AbortController = new AbortController();
        this.failedDownload = null;
        const done: Promise<void> = Promise.resolve().then((): Promise<void> => action(controller.signal)).catch((error: unknown): never => {
            if (download && !controller.signal.aborted) {
                this.failedDownload = download.model;
            }
            throw error;
        }).finally((): void => {
            this.operation = undefined;
        });
        this.operation = { controller, download, done };
        return done;
    }

    select(selection: LocalOcrSelection): Promise<void> {
        return this.run(async (signal: AbortSignal): Promise<void> => {
            if (selection !== 'standard' &&
                (!await this.installed(selection) || await runtimeIssue(selection, this.runtimes[selection]))) {
                throw new Error('The selected local OCR model is unavailable.');
            }
            await this.write(selection, signal);
        });
    }

    install(model: LocalOcrModel): Promise<void> {
        const assets: readonly ModelAsset[] = LOCAL_OCR_ASSETS[model];
        const download: { model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"; receivedBytes: number; totalBytes: number; } = { model, receivedBytes: 0, totalBytes: assets.reduce((total: number, asset: ModelAsset): number => total + asset.bytes, 0) };
        return this.run(async (signal: AbortSignal): Promise<void> => {
            const issue: string | undefined = await runtimeIssue(model, this.runtimes[model]);
            if (issue) {
                throw new Error(issue);
            }
            signal.throwIfAborted();
            if (await this.installed(model)) {
                await this.write(model, signal);
                return;
            }
            await mkdir(this.root, { recursive: true });
            const staging: string = await mkdtemp(path.join(this.root, '.download-'));
            const directory: string = path.join(this.root, installationNames[model]);
            try {
                await this.transfer(assets, staging, signal, (bytes: number): void => {
                    download.receivedBytes = bytes;
                });
                signal.throwIfAborted();
                try {
                    await rename(staging, directory);
                } catch (error: unknown) {
                    if (!await this.installed(model)) {
                        throw error;
                    }
                }
                await this.write(model, signal);
            } finally {
                await rm(staging, { recursive: true, force: true, maxRetries: 3 });
            }
        }, download);
    }

    async cancel(): Promise<void> {
        const operation: { controller: AbortController; download: LocalOcrStatus["download"]; done: Promise<void>; } | undefined = this.operation;
        if (operation?.download) {
            operation.controller.abort();
        }
        await operation?.done.catch((): undefined => undefined);
    }
}
