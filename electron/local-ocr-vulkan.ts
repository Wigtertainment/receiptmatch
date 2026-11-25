import { spawn, type ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IModelAsset } from './local-ocr-assets.js';
import { downloadModelAssets, vulkanRuntimeArchiveUrl, vulkanRuntimeLicenseUrl } from './local-ocr-transfer.js';

export const vulkanRuntimeAsset: IModelAsset = {
    file: 'llama-vulkan.zip', url: vulkanRuntimeArchiveUrl, bytes: 38_022_362,
    sha256: '58c3426f7473bc08135c83333259366521fc940e4ad7bc6ad2b26755cc42cb03'
};
const licenseAsset: IModelAsset = {
    file: 'LICENSE', url: vulkanRuntimeLicenseUrl, bytes: 1_078,
    sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
};
const assets: readonly IModelAsset[] = [vulkanRuntimeAsset, licenseAsset];
export const vulkanRuntimeDownloadBytes: number = vulkanRuntimeAsset.bytes + licenseAsset.bytes;

const installationName: string = 'llama-server-vulkan-b12283-win-x64';
const recoveryInstallation: RegExp = new RegExp(`^${installationName}-[1-9][0-9]*$`);
const executableName: string = 'llama-server.exe';
const requiredFiles: readonly string[] = [executableName, 'llama-server-impl.dll', 'llama.dll', 'llama-common.dll', 'mtmd.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll',
    'ggml-cpu-x64.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP', licenseAsset.file];
const optionalFiles: RegExp = /^(?:ggml-cpu-[\w-]+\.dll|LICENSE.*)$/;

export function supportsVulkanRuntime(): boolean {
    return process.platform === 'win32' && process.arch === 'x64';
}

async function completeRuntime(directory: string): Promise<boolean> {
    try {
        if (!(await lstat(directory)).isDirectory()) {
            return false;
        }
        const complete: boolean[] = await Promise.all(requiredFiles.map(async (name: string): Promise<boolean> => {
            const entry: Stats = await lstat(path.join(directory, name));
            return entry.isFile() && entry.size > 0;
        }));
        return complete.every(Boolean);
    } catch (error: unknown) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            return false;
        }
        throw error;
    }
}

export async function vulkanRuntimeExecutable(root: string): Promise<string | undefined> {
    if (!supportsVulkanRuntime()) {
        return undefined;
    }
    const directory: string = path.join(root, installationName);
    if (await completeRuntime(directory)) {
        return path.join(directory, executableName);
    }
    const entries: string[] = await readdir(root).catch((error: unknown): string[] => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    for (const name of entries) {
        const candidate: string = path.join(root, name);
        if (recoveryInstallation.test(name) && await completeRuntime(candidate)) {
            return path.join(candidate, executableName);
        }
    }
    return undefined;
}

function extractArchive(archive: string, destination: string, signal: AbortSignal): Promise<void> {
    const systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows';
    const tar: string = path.join(systemRoot, 'System32', 'tar.exe');
    return new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
        const child: ChildProcess = spawn(tar, ['-xf', archive, '-C', destination], {
            cwd: destination, env: { SystemRoot: systemRoot }, shell: false, windowsHide: true, stdio: 'ignore',
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        });
        let extractionError: Error | undefined;
        child.once('error', (error: Error): void => {
            extractionError = error;
        });

        child.once('close', (code: number | null): void => {
            if (signal.aborted) {
                return reject(signal.reason instanceof Error ? signal.reason : new Error('Vulkan runtime installation cancelled.', { cause: signal.reason }));
            }
            if (extractionError || code !== 0) {
                return reject(new Error('The Vulkan runtime archive could not be extracted.', { cause: extractionError }));
            }
            resolve();
        });
    });
}

async function stageRuntime(staging: string, signal: AbortSignal): Promise<string> {
    const unpacked: string = path.join(staging, 'archive');
    const runtime: string = path.join(staging, 'runtime');
    await mkdir(unpacked);
    await extractArchive(path.join(staging, vulkanRuntimeAsset.file), unpacked, signal);
    await copyFile(path.join(staging, licenseAsset.file), path.join(unpacked, licenseAsset.file));
    if (!await completeRuntime(unpacked)) {
        throw new Error('The Vulkan runtime archive is incomplete.');
    }
    await mkdir(runtime);
    for (const entry of await readdir(unpacked, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (entry.isFile() && (requiredFiles.includes(entry.name) || optionalFiles.test(entry.name))) {
            await copyFile(path.join(unpacked, entry.name), path.join(runtime, entry.name));
        }
    }
    return runtime;
}

async function publishRuntime(root: string, runtime: string, signal: AbortSignal): Promise<void> {
    // A damaged installation can be in use by another process. Publish into the next free generation.
    for (let generation: number = 0; ; generation++) {
        const destination: string = path.join(root, generation ? `${installationName}-${generation}` : installationName);
        if (await completeRuntime(destination)) {
            return;
        }
        signal.throwIfAborted();
        try {
            await rename(runtime, destination);
            return;
        } catch (error: unknown) {
            if (!await lstat(destination).catch((): undefined => undefined)) {
                throw error;
            }
            if (await completeRuntime(destination)) {
                return;
            }
        }
    }
}

export async function installVulkanRuntime(root: string, signal: AbortSignal, onBytes: (bytes: number) => void,
    transfer: typeof downloadModelAssets = downloadModelAssets): Promise<void> {
    if (!supportsVulkanRuntime()) {
        throw new Error('The Vulkan OCR runtime is available on Windows x64.');
    }
    signal.throwIfAborted();
    if (await vulkanRuntimeExecutable(root)) {
        return;
    }
    await mkdir(root, { recursive: true });
    const staging: string = await mkdtemp(path.join(root, '.download-vulkan-'));
    try {
        await transfer(assets, staging, signal, onBytes);
        signal.throwIfAborted();
        const runtime: string = await stageRuntime(staging, signal);
        await publishRuntime(root, runtime, signal);
    } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 3 });
    }
}
