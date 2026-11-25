import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import type { IModelAsset } from '../../electron/local-ocr-assets.js';
import { installVulkanRuntime, supportsVulkanRuntime, vulkanRuntimeAsset, vulkanRuntimeDownloadBytes, vulkanRuntimeExecutable } from '../../electron/local-ocr-vulkan.js';

const archiveFiles: string[] = ['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'llama-common.dll', 'mtmd.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll',
    'ggml-cpu-x64.dll', 'libomp.dll', 'ggml-cpu-haswell.dll', 'LICENSE-LLVM-OpenMP', 'llama-mtmd-cli.exe', 'ggml-rpc.dll'];

async function withFixture(run: (fixture: string) => Promise<void>): Promise<void> {
    const fixture: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-vulkan-test-'));
    try {
        await run(fixture);
    } finally {
        await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
}

test.skipIf(!supportsVulkanRuntime())('reuses a complete runtime and atomically replaces a damaged runtime during concurrent retries',
    (): Promise<void> => withFixture(async (fixture: string): Promise<void> => {
        const input: string = path.join(fixture, 'input');
        const archive: string = path.join(fixture, 'fixture.zip');
        const root: string = path.join(fixture, 'cache');
        const tar: string = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        const signal: AbortSignal = new AbortController().signal;
        const progress: number[] = [];
        let transfers: number = 0;
        await mkdir(input);
        await Promise.all(archiveFiles.map((file: string): Promise<void> => writeFile(path.join(input, file), 'fixture')));
        await promisify(execFile)(tar, ['-a', '-cf', archive, '-C', input, ...archiveFiles], { windowsHide: true });
        const transfer: NonNullable<Parameters<typeof installVulkanRuntime>[3]> = async (
            assets: readonly IModelAsset[], staging: string, receivedSignal: AbortSignal, onBytes: (bytes: number) => void
        ): Promise<void> => {
            transfers++;
            assert.equal(assets.length, 2);
            assert.deepEqual(assets[0], vulkanRuntimeAsset);
            assert.equal(assets[1].file, 'LICENSE');
            assert.equal(assets[0].bytes + assets[1].bytes, vulkanRuntimeDownloadBytes);
            assert.equal(receivedSignal, signal);
            await copyFile(archive, path.join(staging, assets[0].file));
            await writeFile(path.join(staging, assets[1].file), 'MIT license fixture');
            onBytes(123);
        };
        await installVulkanRuntime(root, signal, (bytes: number): number => progress.push(bytes), transfer);
        const executable: string | undefined = await vulkanRuntimeExecutable(root);
        assert.ok(executable);
        assert.equal(path.basename(executable), 'llama-server.exe');
        assert.deepEqual((await readdir(path.dirname(executable))).sort(), [...archiveFiles, 'LICENSE'].filter((file: string): boolean =>
            file !== 'llama-mtmd-cli.exe' && file !== 'ggml-rpc.dll').sort());
        assert.equal(await readFile(path.join(path.dirname(executable), 'LICENSE'), 'utf8'), 'MIT license fixture');
        await installVulkanRuntime(root, signal, (): undefined => undefined, transfer);
        assert.equal(transfers, 1);
        assert.deepEqual(progress, [123]);
        const damaged: string = path.dirname(executable);
        await rm(path.join(damaged, 'ggml-vulkan.dll'));
        await writeFile(path.join(damaged, 'ggml.dll'), 'existing file');
        assert.equal(await vulkanRuntimeExecutable(root), undefined);
        await Promise.all([installVulkanRuntime(root, signal, (): undefined => undefined, transfer),
            installVulkanRuntime(root, signal, (): undefined => undefined, transfer)]);
        const recovered: string | undefined = await vulkanRuntimeExecutable(root);
        assert.ok(recovered);
        assert.notEqual(recovered, executable);
        assert.equal(await readFile(path.join(damaged, 'ggml.dll'), 'utf8'), 'existing file');
        assert.equal(await readFile(path.join(path.dirname(recovered), 'ggml-vulkan.dll'), 'utf8'), 'fixture');
        assert.deepEqual((await readdir(root)).sort(), [path.basename(damaged), path.basename(path.dirname(recovered))].sort());
        await rename(damaged, path.join(fixture, 'damaged'));
        assert.equal(await vulkanRuntimeExecutable(root), recovered);
    }));

test.skipIf(!supportsVulkanRuntime())('cleans up a cancelled Vulkan download before an installation becomes visible',
    (): Promise<void> => withFixture(async (fixture: string): Promise<void> => {
        const root: string = path.join(fixture, 'cache');
        const controller: AbortController = new AbortController();
        await assert.rejects(installVulkanRuntime(root, controller.signal, (): void => controller.abort(), async (
            assets: readonly IModelAsset[], staging: string, _signal: AbortSignal, onBytes: (bytes: number) => void
        ): Promise<void> => {
            await writeFile(path.join(staging, assets[0].file), 'partial download');
            onBytes(123);
        }), { name: 'AbortError' });
        assert.equal(await vulkanRuntimeExecutable(root), undefined);
        assert.deepEqual(await readdir(root), []);
    }));
