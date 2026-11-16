import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { localOcrModelSchema, type LocalOcrModel } from '../src/shared/pdf-extraction.js';
import { localOcrDeviceSchema, localOcrSelectionSchema, type LocalOcrDevice, type LocalOcrDownload, type LocalOcrGpuStatus, type LocalOcrSelection,
    type LocalOcrStatus } from '../src/shared/local-ocr-settings.js';
import type { LocalDocumentOcr } from './extraction/host.js';
import { listPaddleVlGpuDevices, probePaddleVlGpu, type PaddleVlFiles } from './extraction/paddle-vl.js';
import { LOCAL_OCR_ASSETS, type ModelAsset } from './local-ocr-assets.js';
import { downloadModelAssets } from './local-ocr-transfer.js';
import { installVulkanRuntime, supportsVulkanRuntime, vulkanRuntimeDownloadBytes, vulkanRuntimeExecutable } from './local-ocr-vulkan.js';
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
    private operation?: { controller: AbortController; download: LocalOcrStatus['download']; gpuDownload: LocalOcrDownload | null; checkingGpu: boolean; done: Promise<void> };
    private failedDownload: LocalOcrModel | null = null;
    private failedGpuDownload: boolean = false;
    private gpuCheck?: Promise<string>;
    private verifiedGpu?: { executable: string; device: string };
    private gpuIssue?: string;

    constructor(private readonly root: string, private readonly runtimes: Record<LocalOcrModel, string>, private readonly transfer: (assets: readonly ModelAsset[], staging: string, signal: AbortSignal, onBytes: (bytes: number) => void) => Promise<void> = downloadModelAssets) {}

    private async read(file: 'selection.json' | 'device.json'): Promise<unknown> {
        try {
            return JSON.parse(await readFile(path.join(this.root, file), 'utf8')) as unknown;
        } catch (error: unknown) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        return undefined;
    }

    private async savedSelection(): Promise<LocalOcrSelection> {
        const checked: ZodSafeParseResult<LocalOcrSelection> = localOcrSelectionSchema.safeParse(await this.read('selection.json'));
        return checked.success ? checked.data : 'standard';
    }

    private async savedDevice(): Promise<LocalOcrDevice> {
        const checked: ZodSafeParseResult<LocalOcrDevice> = localOcrDeviceSchema.safeParse(await this.read('device.json'));
        return checked.success ? checked.data : 'cpu';
    }

    private async write(file: 'selection.json' | 'device.json', selection: LocalOcrSelection | LocalOcrDevice, signal: AbortSignal): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const temporary: string = path.join(this.root, '.settings-' + randomUUID());
        try {
            await writeFile(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
            signal.throwIfAborted();
            await rename(temporary, path.join(this.root, file));
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
        const operation: LocalOcrSettings['operation'] = this.operation;
        const [selection, device, gpu]: [LocalOcrSelection, LocalOcrDevice, LocalOcrGpuStatus] = await Promise.all([this.savedSelection(), this.savedDevice(), this.gpuStatus()]);
        const models: LocalOcrStatus['models'] = await Promise.all(localOcrModelSchema.options.map(async (model: LocalOcrModel): Promise<LocalOcrStatus['models'][number]> => {
            const issue: string | undefined = await runtimeIssue(model, this.runtimes[model]);
            return {
                model, name: names[model], gpuSupported: model === 'paddleocr-vl-1.6',
                downloadBytes: LOCAL_OCR_ASSETS[model].reduce((bytes: number, asset: ModelAsset): number => bytes + asset.bytes, 0),
                installed: !!(await this.installed(model)), runtimeAvailable: !issue, runtimeIssue: issue
            };
        }));
        if (operation !== this.operation) {
            return this.status();
        }
        const effective: boolean = models.some((model: LocalOcrStatus['models'][number]): boolean => model.model === selection && model.installed && model.runtimeAvailable);
        return { selection: effective ? selection : 'standard', device, gpu, models, download: operation?.download ? { ...operation.download } : null,
            failedDownload: this.failedDownload };
    }

    async selected(): Promise<LocalDocumentOcr | undefined> {
        const model: LocalOcrSelection = await this.savedSelection();
        if (model === 'standard') {
            return undefined;
        }
        const directory: string | undefined = await this.installed(model);
        if (!directory) {
            return undefined;
        }
        if (await this.savedDevice() === 'gpu') {
            return { model, prepare: async (signal: AbortSignal): Promise<{ model: 'paddleocr-vl-1.6'; files: PaddleVlFiles }> => {
                if (model === 'pp-ocrv6-medium') {
                    throw new Error('PP-OCRv6 Medium runs on CPU. Choose CPU or select a GPU-compatible model.');
                }
                return { model, files: await this.gpuFiles(directory, signal) };
            } };
        }
        const executable: string = this.runtimes[model];
        if (await runtimeIssue(model, executable)) {
            return undefined;
        }
        return model === 'pp-ocrv6-medium'
            ? { model, files: { executable, detection: path.join(directory, 'medium-det'), recognition: path.join(directory, 'medium-rec') } }
            : { model, files: this.paddleFiles(directory, executable) };
    }

    private paddleFiles(directory: string, executable: string): PaddleVlFiles {
        return { executable, model: path.join(directory, 'model.gguf'), projector: path.join(directory, 'mmproj.gguf'),
            template: path.join(directory, 'chat_template.jinja') };
    }

    private async gpuStatus(): Promise<LocalOcrGpuStatus> {
        const download: LocalOcrDownload | null | undefined = this.operation?.gpuDownload;
        const base: Pick<LocalOcrGpuStatus, 'download' | 'downloadBytes' | 'failedDownload' | 'cancellableCheck'> = {
            download: download ? { ...download } : null, downloadBytes: vulkanRuntimeDownloadBytes, failedDownload: this.failedGpuDownload,
            cancellableCheck: this.operation?.checkingGpu === true
        };
        if (!supportsVulkanRuntime()) {
            return { ...base, state: 'unsupported', issue: 'GPU acceleration is currently available on Windows x64.' };
        }
        const executable: string | undefined = await vulkanRuntimeExecutable(this.root);
        if (!executable) {
            return { ...base, state: 'download-required' };
        }
        if (!await this.installed('paddleocr-vl-1.6')) {
            return { ...base, state: 'model-required' };
        }
        if (this.gpuCheck) {
            return { ...base, state: 'checking' };
        }
        if (this.verifiedGpu?.executable === executable) {
            return { ...base, state: 'available' };
        }
        return this.gpuIssue ? { ...base, state: 'unavailable', issue: this.gpuIssue } : { ...base, state: 'unchecked' };
    }

    private async gpuFiles(directory: string, signal?: AbortSignal, recheck: boolean = false): Promise<PaddleVlFiles> {
        const executable: string | undefined = await vulkanRuntimeExecutable(this.root);
        if (!executable) {
            throw new Error('GPU acceleration is unavailable. Choose CPU or install the Vulkan runtime in Settings.');
        }
        signal?.throwIfAborted();
        const files: PaddleVlFiles = this.paddleFiles(directory, executable);
        const verified: string | undefined = this.verifiedGpu?.executable === executable ? this.verifiedGpu.device : undefined;
        if (!recheck && verified && await this.hasGpuDevice(executable, verified, signal)) {
            return { ...files, gpuDevice: verified };
        }
        if (this.gpuCheck) {
            throw new Error('A GPU compatibility check is already running. Try again when it is complete.');
        }
        this.gpuCheck = this.verifyGpu(files, signal).finally((): void => {
            this.gpuCheck = undefined;
        });
        const gpuDevice: string = await this.gpuCheck;
        signal?.throwIfAborted();
        return { ...files, gpuDevice };
    }

    private async hasGpuDevice(executable: string, device: string, signal?: AbortSignal): Promise<boolean> {
        try {
            const timeout: AbortSignal = AbortSignal.timeout(10_000);
            const devices: string[] = await listPaddleVlGpuDevices(executable, signal ? AbortSignal.any([signal, timeout]) : timeout);
            return devices.includes(device);
        } catch {
            signal?.throwIfAborted();
            return false;
        }
    }

    private async verifyGpu(files: PaddleVlFiles, signal?: AbortSignal): Promise<string> {
        this.verifiedGpu = undefined;
        this.gpuIssue = undefined;
        const timeout: AbortSignal = AbortSignal.timeout(120_000);
        const check: AbortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const devices: string[] = await listPaddleVlGpuDevices(files.executable, AbortSignal.any([check, AbortSignal.timeout(10_000)]));
            for (const device of devices) {
                check.throwIfAborted();
                try {
                    await probePaddleVlGpu({ ...files, gpuDevice: device }, check);
                    this.verifiedGpu = { executable: files.executable, device };
                    return device;
                } catch {
                    check.throwIfAborted();
                }
            }
            this.gpuIssue = devices.length ? 'PaddleOCR-VL could not run on an available Vulkan device.' : 'No compatible Vulkan device was detected.';
        } catch {
            signal?.throwIfAborted();
            this.gpuIssue = timeout.aborted ? 'The GPU compatibility check timed out.' : 'The Vulkan runtime could not detect a usable GPU.';
        }
        throw new Error(this.gpuIssue + ' Choose CPU in Settings to run recognition.');
    }

    private async validateGpu(signal: AbortSignal, recheck: boolean): Promise<void> {
        const directory: string | undefined = await this.installed('paddleocr-vl-1.6');
        if (!directory) {
            throw new Error('Install PaddleOCR-VL 1.6 before checking GPU acceleration.');
        }
        await this.gpuFiles(directory, signal, recheck);
    }

    selectDevice(device: LocalOcrDevice): Promise<void> {
        return this.run(async (signal: AbortSignal): Promise<void> => {
            if (device === 'gpu') {
                await this.validateGpu(signal, false);
            }
            await this.write('device.json', device, signal);
        }, null, null, device === 'gpu');
    }

    checkGpu(): Promise<void> {
        return this.run((signal: AbortSignal): Promise<void> => this.validateGpu(signal, true), null, null, true);
    }

    installGpuRuntime(): Promise<void> {
        const download: LocalOcrDownload = { receivedBytes: 0, totalBytes: vulkanRuntimeDownloadBytes };
        return this.run((signal: AbortSignal): Promise<void> => installVulkanRuntime(this.root, signal, (bytes: number): void => {
            download.receivedBytes = bytes;
        }, this.transfer), null, download);
    }

    private run(action: (signal: AbortSignal) => Promise<void>, download: LocalOcrStatus['download'] = null, gpuDownload: LocalOcrDownload | null = null,
        checkingGpu: boolean = false): Promise<void> {
        if (this.operation) {
            throw new Error('A local OCR settings operation is already running.');
        }
        const controller: AbortController = new AbortController();
        this.failedDownload = null;
        this.failedGpuDownload = false;
        const done: Promise<void> = Promise.resolve().then((): Promise<void> => action(controller.signal)).catch((error: unknown): never => {
            if (download && !controller.signal.aborted) {
                this.failedDownload = download.model;
            }
            if (gpuDownload && !controller.signal.aborted) {
                this.failedGpuDownload = true;
            }
            throw error;
        }).finally((): void => {
            this.operation = undefined;
        });
        this.operation = { controller, download, gpuDownload, checkingGpu, done };
        return done;
    }

    select(selection: LocalOcrSelection): Promise<void> {
        return this.run(async (signal: AbortSignal): Promise<void> => {
            if (selection !== 'standard' &&
                (!await this.installed(selection) || await runtimeIssue(selection, this.runtimes[selection]))) {
                throw new Error('The selected local OCR model is unavailable.');
            }
            await this.write('selection.json', selection, signal);
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
                await this.write('selection.json', model, signal);
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
                await this.write('selection.json', model, signal);
            } finally {
                await rm(staging, { recursive: true, force: true, maxRetries: 3 });
            }
        }, download);
    }

    async cancel(): Promise<void> {
        const operation: LocalOcrSettings['operation'] = this.operation;
        operation?.controller.abort();
        await operation?.done.catch((): undefined => undefined);
    }
}
