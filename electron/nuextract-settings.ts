import { constants, type Dirent, type Stats } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { nuExtractDeviceSchema, type NuExtractDevice, type NuExtractDownload, type NuExtractSettingsStatus } from '../src/shared/local-ocr-settings.js';
import { listNuExtractVulkanDevices, NuExtractGpuCheckCancelledError, NuExtractGpuUnavailableError, NuExtractRuntime, type NuExtractRuntimeFiles } from './extraction/nuextract-runtime.js';
import { NUEXTRACT_ASSETS, type ModelAsset } from './local-ocr-assets.js';
import { downloadModelAssets } from './local-ocr-transfer.js';
import { installVulkanRuntime, supportsVulkanRuntime, vulkanRuntimeDownloadBytes, vulkanRuntimeExecutable } from './local-ocr-vulkan.js';

const modelDownloadBytes: number = NUEXTRACT_ASSETS.reduce((total: number, asset: ModelAsset): number => total + asset.bytes, 0);
const modelDirectory: string = 'nuextract3-' + NUEXTRACT_ASSETS[0].sha256.slice(0, 16);
type PreferenceFile = 'selection.json' | 'nuextract-device.json' | 'nuextract-gpu-check.json';
const gpuCheckFile: PreferenceFile = 'nuextract-gpu-check.json';
const modelFingerprint: string = NUEXTRACT_ASSETS.map(({ sha256 }: ModelAsset): string => sha256).join(':');
const savedGpuCheckSchema: z.ZodType<SavedGpuCheck> = z.strictObject({ runtime: z.string(), model: z.string(), device: z.string().regex(/^Vulkan\d{1,3}$/) });

interface SavedGpuCheck {
    runtime: string;
    model: string;
    device: string;
}

interface Operation {
    controller: AbortController;
    download: NuExtractDownload | null;
    checkingGpu: boolean;
    done: Promise<void>;
}

interface GpuCheck {
    executable: string;
    device?: string;
    issue?: string;
}

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

async function runtimeIssue(executable: string): Promise<string | undefined> {
    if (!await runtimeAvailable(executable)) {
        return 'The NuExtract3 CPU runtime is unavailable on this installation.';
    }
    if (process.platform === 'win32') {
        const systemRoot: string | undefined = process.env.SystemRoot;
        const libraries: string[] = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
        if (!systemRoot || !(await Promise.all(libraries.map((file: string): Promise<boolean> => regularFile(path.join(systemRoot, 'System32', file))))).every(Boolean)) {
            return 'Requires the Microsoft Visual C++ Redistributable (x64).';
        }
    }
    return undefined;
}

export class NuExtractSettings {
    private operation?: Operation;
    private gpuCheck?: GpuCheck;
    private failedDownload: NuExtractDownload['kind'] | null = null;

    constructor(private readonly root: string, private readonly cpuExecutable: string, private readonly probeImage: string) {}

    private async readPreference(name: PreferenceFile): Promise<unknown> {
        try {
            return JSON.parse(await readFile(path.join(this.root, name), 'utf8')) as unknown;
        } catch (error: unknown) {
            if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }

    async resetLegacySelection(): Promise<void> {
        const previous: unknown = await this.readPreference('selection.json');
        if (previous === 'pp-ocrv6-medium' || previous === 'paddleocr-vl-1.6') {
            await this.writePreference('selection.json', 'standard');
        }
    }

    private async writePreference(name: PreferenceFile, value: 'standard' | NuExtractDevice | SavedGpuCheck, signal?: AbortSignal): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const staging: string = path.join(this.root, '.nuextract-setting-' + randomUUID());
        try {
            await writeFile(staging, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
            signal?.throwIfAborted();
            await rename(staging, path.join(this.root, name));
        } finally {
            await rm(staging, { force: true });
        }
    }

    private async installedDirectory(): Promise<string | undefined> {
        const entries: Dirent[] = await readdir(this.root, { withFileTypes: true }).catch((error: unknown): Dirent[] => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw error;
        });
        const prefix: string = modelDirectory + '-';
        for (const entry of entries) {
            if (!entry.isDirectory() || (entry.name !== modelDirectory && !(entry.name.startsWith(prefix) && /^[\da-f]{12}$/.test(entry.name.slice(prefix.length))))) {
                continue;
            }
            const directory: string = path.join(this.root, entry.name);
            const files: boolean[] = await Promise.all(NUEXTRACT_ASSETS.map((asset: ModelAsset): Promise<boolean> => regularFile(path.join(directory, asset.file), asset.bytes)));
            if (files.every(Boolean)) {
                return directory;
            }
        }
        return undefined;
    }

    private async readDevice(): Promise<NuExtractDevice> {
        return nuExtractDeviceSchema.safeParse(await this.readPreference('nuextract-device.json')).data ?? 'cpu';
    }

    private async restoreGpuCheck(executable: string): Promise<void> {
        if (this.gpuCheck?.executable === executable) {
            return;
        }
        const saved: SavedGpuCheck | undefined = savedGpuCheckSchema.safeParse(await this.readPreference(gpuCheckFile)).data;
        if (saved?.runtime === path.relative(this.root, executable) && saved.model === modelFingerprint &&
            !this.operation?.checkingGpu && this.gpuCheck?.executable !== executable) {
            this.gpuCheck = { executable, device: saved.device };
        }
    }

    private modelFiles(executable: string, directory: string, gpuDevice?: string): NuExtractRuntimeFiles {
        return { executable, gpuDevice, model: path.join(directory, NUEXTRACT_ASSETS[0].file), projector: path.join(directory, NUEXTRACT_ASSETS[1].file) };
    }

    async runtimeFiles(signal?: AbortSignal): Promise<NuExtractRuntimeFiles | undefined> {
        const [directory, preferred, executable]: [string | undefined, NuExtractDevice, string | undefined] = await Promise.all([
            this.installedDirectory(), this.readDevice(), vulkanRuntimeExecutable(this.root)
        ]);
        signal?.throwIfAborted();
        if (!directory || this.operation) {
            return undefined;
        }
        if (preferred === 'cpu') {
            return await runtimeIssue(this.cpuExecutable) ? undefined : this.modelFiles(this.cpuExecutable, directory);
        }
        if (!executable) {
            throw new NuExtractGpuUnavailableError(supportsVulkanRuntime()
                ? 'GPU is selected. Download the Vulkan runtime in Settings → Document recognition, or select CPU.'
                : 'GPU acceleration is unavailable on this platform. Select CPU in Settings → Document recognition.');
        }
        await this.restoreGpuCheck(executable);
        signal?.throwIfAborted();
        if (this.operation) {
            return undefined;
        }
        if (this.gpuStatus(executable) !== 'available') {
            await this.checkGpu(signal).catch((error: unknown): never => {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new NuExtractGpuCheckCancelledError();
                }
                throw error;
            });
        }
        signal?.throwIfAborted();
        const checked: GpuCheck | undefined = this.gpuCheck;
        if (checked?.executable === executable && checked.device) {
            return this.modelFiles(executable, directory, checked.device);
        }
        throw new NuExtractGpuUnavailableError('NuExtract3 could not use the selected Vulkan GPU. Retry the analysis or select CPU in Settings → Document recognition.');
    }

    async startRuntime(files: NuExtractRuntimeFiles, signal?: AbortSignal): Promise<NuExtractRuntime> {
        try {
            return await NuExtractRuntime.start(files, signal);
        } catch (error: unknown) {
            if (files.gpuDevice && !signal?.aborted && this.gpuCheck?.executable === files.executable && this.gpuCheck.device === files.gpuDevice) {
                const issue: string = 'NuExtract3 could not start on the selected Vulkan GPU.';
                this.gpuCheck = { executable: files.executable, issue };
                await rm(path.join(this.root, gpuCheckFile), { force: true });
                throw new NuExtractGpuUnavailableError(issue + ' Retry the analysis or select CPU in Settings → Document recognition.');
            }
            throw error;
        }
    }

    private gpuStatus(executable: string | undefined): NuExtractSettingsStatus['gpu'] {
        if (!supportsVulkanRuntime()) {
            return 'unsupported';
        }
        if (!executable) {
            return 'download-required';
        }
        if (this.operation?.checkingGpu) {
            return 'checking';
        }
        if (this.gpuCheck?.executable !== executable) {
            return 'unchecked';
        }
        return this.gpuCheck.device ? 'available' : 'unavailable';
    }

    async status(): Promise<NuExtractSettingsStatus> {
        const operation: Operation | undefined = this.operation;
        const [directory, cpuIssue, executable, preferred]: [string | undefined, string | undefined, string | undefined, NuExtractDevice] = await Promise.all([
            this.installedDirectory(), runtimeIssue(this.cpuExecutable), vulkanRuntimeExecutable(this.root), this.readDevice()
        ]);
        if (directory && executable && !operation?.checkingGpu) {
            await this.restoreGpuCheck(executable);
        }
        if (operation !== this.operation) {
            return this.status();
        }
        const gpu: NuExtractSettingsStatus['gpu'] = this.gpuStatus(executable);
        const download: NuExtractDownload | null | undefined = operation?.download;
        const effectiveDevice: NuExtractDevice | null = directory && (preferred === 'gpu' ? gpu === 'available' : cpuIssue === undefined) ? preferred : null;
        return { installed: directory !== undefined, cpuAvailable: cpuIssue === undefined, cpuIssue, device: preferred, effectiveDevice,
            modelDownloadBytes, vulkanDownloadBytes: vulkanRuntimeDownloadBytes, gpu, gpuIssue: gpu === 'unavailable' ? this.gpuCheck?.issue : undefined,
            download: download ? { ...download } : null, busy: operation !== undefined, failedDownload: this.failedDownload };
    }

    private run(action: (signal: AbortSignal) => Promise<void>, download: NuExtractDownload | null = null, checkingGpu: boolean = false): Promise<void> {
        if (this.operation) {
            throw new Error('A NuExtract3 operation is already running.');
        }
        const controller: AbortController = new AbortController();
        this.failedDownload = null;
        const done: Promise<void> = Promise.resolve().then((): Promise<void> => action(controller.signal)).catch((error: unknown): never => {
            if (download && !controller.signal.aborted) {
                this.failedDownload = download.kind;
            }
            throw error;
        }).finally((): void => {
            this.operation = undefined;
        });
        this.operation = { controller, download, checkingGpu, done };
        return done;
    }

    install(): Promise<void> {
        const download: NuExtractDownload = { kind: 'model', receivedBytes: 0, totalBytes: modelDownloadBytes };
        return this.run(async (signal: AbortSignal): Promise<void> => {
            if (await runtimeIssue(this.cpuExecutable)) {
                throw new Error('The NuExtract3 CPU runtime is unavailable.');
            }
            if (await this.installedDirectory()) {
                return;
            }
            signal.throwIfAborted();
            await mkdir(this.root, { recursive: true });
            const staging: string = await mkdtemp(path.join(this.root, '.nuextract-download-'));
            try {
                await downloadModelAssets(NUEXTRACT_ASSETS, staging, signal, (bytes: number): void => {
 download.receivedBytes = bytes;
});
                signal.throwIfAborted();
                const directory: string = path.join(this.root, modelDirectory);
                try {
                    await rename(staging, directory);
                } catch (error: unknown) {
                    if (await this.installedDirectory()) {
                        return;
                    }
                    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                        throw error;
                    }
                    signal.throwIfAborted();
                    await rename(staging, directory + '-' + randomBytes(6).toString('hex'));
                }
            } finally {
                await rm(staging, { recursive: true, force: true, maxRetries: 3 });
            }
        }, download);
    }

    installVulkan(): Promise<void> {
        const download: NuExtractDownload = { kind: 'vulkan', receivedBytes: 0, totalBytes: vulkanRuntimeDownloadBytes };
        return this.run(async (signal: AbortSignal): Promise<void> => {
            await installVulkanRuntime(this.root, signal, (bytes: number): void => {
 download.receivedBytes = bytes;
});
            this.gpuCheck = undefined;
        }, download);
    }

    private async probeDevice(executable: string, directory: string, device: string, image: Uint8Array, signal: AbortSignal): Promise<boolean> {
        const runtime: NuExtractRuntime = await NuExtractRuntime.start(this.modelFiles(executable, directory, device), signal);
        try {
            const result: Record<string, unknown> = await runtime.extract({
                images: [image], template: { invoice_number: 'verbatim-string' }, instructions: 'Read the invoice number.'
            }, signal);
            return result.invoice_number === 'RM-2047';
        } finally {
            await runtime.close();
        }
    }

    checkGpu(requestSignal?: AbortSignal): Promise<void> {
        return this.run(async (operationSignal: AbortSignal): Promise<void> => {
            const parent: AbortSignal = requestSignal ? AbortSignal.any([operationSignal, requestSignal]) : operationSignal;
            parent.throwIfAborted();
            const executable: string | undefined = await vulkanRuntimeExecutable(this.root);
            const directory: string | undefined = await this.installedDirectory();
            if (!executable || !directory) {
                throw new Error('Download NuExtract3 and its Vulkan runtime first.');
            }
            const signal: AbortSignal = AbortSignal.any([parent, AbortSignal.timeout(90_000)]);
            const image: Buffer = await readFile(this.probeImage);
            let compatibleDevice: string | undefined;
            try {
                const devices: string[] = await listNuExtractVulkanDevices(executable, signal);
                for (const device of devices) {
                    if (await this.probeDevice(executable, directory, device, image, signal).catch((): false => false)) {
                        signal.throwIfAborted();
                        compatibleDevice = device;
                        break;
                    }
                    signal.throwIfAborted();
                }
            } catch (error: unknown) {
                parent.throwIfAborted();
                if (!(error instanceof Error)) {
                    throw error;
                }
            }
            parent.throwIfAborted();
            if (compatibleDevice) {
                await this.writePreference(gpuCheckFile, { runtime: path.relative(this.root, executable), model: modelFingerprint, device: compatibleDevice }, signal);
                this.gpuCheck = { executable, device: compatibleDevice };
            } else {
                this.gpuCheck = { executable, issue: 'NuExtract3 could not process the compatibility sample on a Vulkan GPU.' };
                await rm(path.join(this.root, gpuCheckFile), { force: true });
            }
        }, null, true);
    }

    selectDevice(device: NuExtractDevice): Promise<void> {
        return this.run(async (signal: AbortSignal): Promise<void> => {
            if (device === 'gpu' && !supportsVulkanRuntime()) {
                throw new Error('GPU acceleration is unavailable on this platform.');
            }
            await this.writePreference('nuextract-device.json', device, signal);
        });
    }

    async cancel(): Promise<void> {
        const operation: Operation | undefined = this.operation;
        operation?.controller.abort();
        await operation?.done.catch((): undefined => undefined);
    }
}
