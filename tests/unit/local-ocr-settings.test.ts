import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { LocalOcrSettings } from '../../electron/local-ocr-settings.js';
import type { LocalDocumentOcr } from '../../electron/extraction/host.js';
import { localOcrRequestSchema } from '../../src/shared/local-ocr-settings.js';
import type { ModelAsset } from '../../electron/local-ocr-assets.js';

test('only known model IDs can be selected or installed through settings', (): void => {
    assert.ok(localOcrRequestSchema.safeParse({ type: 'install', model: 'pp-ocrv6-medium' }).success);
    assert.equal(localOcrRequestSchema.safeParse({ type: 'install', model: 'https://example.test/model' }).success, false);
    assert.equal(localOcrRequestSchema.safeParse({ type: 'select', selection: 'standard', path: '/tmp/model' }).success, false);
    assert.ok(localOcrRequestSchema.safeParse({ type: 'select-device', device: 'gpu' }).success);
    assert.equal(localOcrRequestSchema.safeParse({ type: 'select-device', device: 'Vulkan0' }).success, false);
    assert.equal(localOcrRequestSchema.safeParse({ type: 'install-gpu-runtime', url: 'https://example.test/runtime' }).success, false);
});

test('activation survives restart and keeps the previous selection during a failed or cancelled download', async (): Promise<void> => {
    await mkdir('artifacts', { recursive: true });
    const fixture: string = await mkdtemp(path.resolve('artifacts', 'local-ocr-'));
    try {
        const root: string = path.join(fixture, 'models');
        const executable: string = path.join(fixture, 'runtime');
        await writeFile(executable, '', { mode: 0o700 });
        const runtimes: { 'pp-ocrv6-medium': string; 'paddleocr-vl-1.6': string; } = { 'pp-ocrv6-medium': executable, 'paddleocr-vl-1.6': executable };
        let fail: boolean = false;
        let started!: () => void;
        const waiting: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => {
            started = resolve;
        });
        const settings: LocalOcrSettings = new LocalOcrSettings(root, runtimes, async (assets: readonly ModelAsset[], staging: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> => {
            if (assets[0].file === 'model.gguf') {
                progress(100);
                if (fail) {
                    throw new Error('Simulated download failure');
                }
                started();
                await new Promise<void>((_resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => signal.addEventListener('abort', (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.', { cause: signal.reason })), { once: true }));
                return;
            }
            for (const asset of assets) {
                const file: string = path.join(staging, asset.file);
                await mkdir(path.dirname(file), { recursive: true });
                await writeFile(file, '');
                await truncate(file, asset.bytes);
            }
        });
        assert.equal(await settings.selected(), undefined);
        await assert.rejects(settings.select('pp-ocrv6-medium'), /unavailable/);
        await settings.install('pp-ocrv6-medium');
        const restart: LocalOcrSettings = new LocalOcrSettings(root, runtimes);
        assert.equal((await restart.selected())?.model, 'pp-ocrv6-medium');
        assert.equal((await restart.status()).device, 'cpu');
        await assert.rejects(restart.selectDevice('gpu'), /Install PaddleOCR-VL/);
        assert.equal((await restart.status()).device, 'cpu');
        await writeFile(path.join(root, 'device.json'), JSON.stringify('gpu'));
        assert.equal((await settings.status()).device, 'gpu');
        const gpu: LocalDocumentOcr | undefined = await settings.selected();
        assert.ok(gpu && 'prepare' in gpu);
        await assert.rejects(gpu.prepare(new AbortController().signal), /runs on CPU/);
        await settings.selectDevice('cpu');
        assert.equal((await restart.status()).device, 'cpu');
        assert.equal((await restart.selected())?.model, 'pp-ocrv6-medium');
        const installedFiles: string[] = await readdir(root);
        fail = true;
        await assert.rejects(settings.install('paddleocr-vl-1.6'), /Simulated download failure/);
        assert.deepEqual(await readdir(root), installedFiles);
        fail = false;
        const install: Promise<void> = settings.install('paddleocr-vl-1.6');
        const aborted: Promise<void> = assert.rejects(install, { name: 'AbortError' });
        await waiting;
        assert.equal((await settings.status()).download?.receivedBytes, 100);
        assert.equal((await settings.selected())?.model, 'pp-ocrv6-medium');
        assert.throws((): Promise<void> => settings.select('standard'), /already running/);
        await settings.cancel();
        await aborted;
        assert.deepEqual(await readdir(root), installedFiles);
        assert.equal((await settings.status()).download, null);
        await settings.select('standard');
        assert.equal(await restart.selected(), undefined);
        assert.equal((await restart.status()).models[0].installed, true);
        await restart.select('pp-ocrv6-medium');
        await rm(executable);
        assert.equal((await restart.status()).selection, 'standard');
        assert.equal(await restart.selected(), undefined);
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
});

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('cancels the runtime download without changing the device preference', async (): Promise<void> => {
    await mkdir('artifacts', { recursive: true });
    const root: string = await mkdtemp(path.resolve('artifacts', 'local-ocr-device-'));
    try {
        let started!: () => void;
        const waiting: Promise<void> = new Promise<void>((resolve: () => void): void => {
            started = resolve;
        });
        const settings: LocalOcrSettings = new LocalOcrSettings(root, { 'pp-ocrv6-medium': '', 'paddleocr-vl-1.6': '' },
            async (_assets: readonly ModelAsset[], _staging: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> => {
                progress(100);
                started();
                await new Promise<void>((_resolve: () => void, reject: (reason?: unknown) => void): void => {
                    signal.addEventListener('abort', (): void => reject(new Error('Aborted', { cause: signal.reason })), { once: true });
                });
            });
        const result: Promise<void> = assert.rejects(settings.installGpuRuntime(), /Aborted/);
        await waiting;
        assert.equal((await settings.status()).gpu.download?.receivedBytes, 100);
        await settings.cancel();
        await result;
        const status: Awaited<ReturnType<LocalOcrSettings['status']>> = await settings.status();
        assert.equal(status.gpu.download, null);
        assert.equal(status.gpu.failedDownload, false);
        assert.equal(status.device, 'cpu');
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
