import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi, type MockInstance } from 'vitest';
import { NuExtractSettings } from '../../electron/nuextract-settings.js';
import * as runtime from '../../electron/extraction/nuextract-runtime.js';
import type { NuExtractRuntime, NuExtractRuntimeFiles } from '../../electron/extraction/nuextract-runtime.js';
import { NUEXTRACT_ASSETS, type ModelAsset } from '../../electron/local-ocr-assets.js';
import * as vulkan from '../../electron/local-ocr-vulkan.js';
import { localOcrRequestSchema, type NuExtractSettingsStatus } from '../../src/shared/local-ocr-settings.js';

vi.mock('../../electron/local-ocr-assets.js', async (load: <T>() => Promise<T>): Promise<{ NUEXTRACT_ASSETS: ModelAsset[] }> => {
    const actual: typeof import('../../electron/local-ocr-assets.js') = await load();
    return { NUEXTRACT_ASSETS: actual.NUEXTRACT_ASSETS.map((asset: ModelAsset): ModelAsset => ({ ...asset, bytes: 1 })) };
});
vi.mock('../../electron/local-ocr-vulkan.js', { spy: true });
vi.mock('../../electron/extraction/nuextract-runtime.js', { spy: true });
afterEach((): void => {
    vi.restoreAllMocks();
});

async function installedModel(root: string): Promise<void> {
    const model: string = path.join(root, 'nuextract3-' + NUEXTRACT_ASSETS[0].sha256.slice(0, 16));
    await mkdir(model);
    await Promise.all(NUEXTRACT_ASSETS.map((asset: ModelAsset): Promise<void> => writeFile(path.join(model, asset.file), 'x')));
    await writeFile(path.join(root, 'probe.png'), 'x');
}

test('resets previous model preferences without treating old downloaded files as NuExtract3', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-upgrade-'));
    const settings: NuExtractSettings = new NuExtractSettings(root, path.join(root, 'missing-runtime'), path.join(root, 'probe.png'));
    try {
        for (const model of ['pp-ocrv6-medium', 'paddleocr-vl-1.6']) {
            const directory: string = path.join(root, model);
            const weights: string = path.join(directory, 'cached-model');
            await mkdir(directory);
            await writeFile(weights, 'legacy cache');
            await writeFile(path.join(root, 'selection.json'), JSON.stringify(model));
            await settings.resetLegacySelection();
            assert.equal(await readFile(path.join(root, 'selection.json'), 'utf8'), JSON.stringify('standard'));
            assert.equal(await readFile(weights, 'utf8'), 'legacy cache');
        }
        const status: NuExtractSettingsStatus = await settings.status();
        assert.equal(status.installed, false);
        assert.equal(status.device, 'cpu');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps a new profile free of old settings and rejects retired model commands', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-new-'));
    try {
        const settings: NuExtractSettings = new NuExtractSettings(root, path.join(root, 'missing-runtime'), path.join(root, 'probe.png'));
        await settings.resetLegacySelection();
        await assert.rejects(stat(path.join(root, 'selection.json')), { code: 'ENOENT' });
        assert.equal(localOcrRequestSchema.safeParse({ type: 'install', model: 'pp-ocrv6-medium' }).success, false);
        assert.equal(localOcrRequestSchema.safeParse({ type: 'select', selection: 'paddleocr-vl-1.6' }).success, false);
        assert.equal(localOcrRequestSchema.safeParse({ type: 'install-nuextract' }).success, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps GPU selected after reopening and automatically verifies it before the first analysis', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-gpu-'));
    const executable: string = path.join(root, 'vulkan-server');
    const probe: string = path.join(root, 'probe.png');
    try {
        await installedModel(root);
        vi.spyOn(vulkan, 'supportsVulkanRuntime').mockReturnValue(true);
        vi.spyOn(vulkan, 'vulkanRuntimeExecutable').mockResolvedValue(executable);
        const list: MockInstance<typeof runtime.listNuExtractVulkanDevices> = vi.spyOn(runtime, 'listNuExtractVulkanDevices').mockResolvedValue(['Vulkan0']);
        const probeRuntime: Pick<NuExtractRuntime, 'extract' | 'close'> = {
            extract: (): Promise<Record<string, unknown>> => Promise.resolve({ invoice_number: 'RM-2047' }),
            close: (): Promise<void> => Promise.resolve()
        };
        const start: MockInstance<typeof runtime.NuExtractRuntime.start> = vi.spyOn(runtime.NuExtractRuntime, 'start').mockResolvedValue(probeRuntime as NuExtractRuntime);

        await new NuExtractSettings(root, process.execPath, probe).selectDevice('gpu');
        const reopened: NuExtractSettings = new NuExtractSettings(root, process.execPath, probe);
        const pending: NuExtractSettingsStatus = await reopened.status();
        assert.equal(pending.device, 'gpu');
        assert.equal(pending.effectiveDevice, null);
        assert.equal(pending.gpu, 'unchecked');
        assert.equal(list.mock.calls.length, 0);

        const files: NuExtractRuntimeFiles | undefined = await reopened.runtimeFiles();
        assert.equal(files?.gpuDevice, 'Vulkan0');
        assert.equal(files.executable, executable);
        assert.equal((await reopened.status()).effectiveDevice, 'gpu');
        assert.deepEqual(await reopened.runtimeFiles(), files);
        assert.equal(list.mock.calls.length, 1);

        start.mockRejectedValueOnce(new Error('GPU no longer available'));
        await assert.rejects(reopened.startRuntime(files), runtime.NuExtractGpuUnavailableError);
        assert.equal((await reopened.status()).device, 'gpu');
        assert.equal((await reopened.status()).effectiveDevice, null);
        assert.deepEqual(await reopened.runtimeFiles(), files);
        assert.equal(list.mock.calls.length, 2);

        await reopened.selectDevice('cpu');
        assert.equal((await new NuExtractSettings(root, process.execPath, probe).status()).device, 'cpu');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cancels an automatic GPU check from Settings without clearing the preferred device', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-gpu-cancel-'));
    try {
        await installedModel(root);
        vi.spyOn(vulkan, 'supportsVulkanRuntime').mockReturnValue(true);
        vi.spyOn(vulkan, 'vulkanRuntimeExecutable').mockResolvedValue(path.join(root, 'vulkan-server'));
        let markStarted: (() => void) | undefined;
        const started: Promise<void> = new Promise((resolve: () => void): void => {
            markStarted = resolve;
        });
        vi.spyOn(runtime, 'listNuExtractVulkanDevices').mockImplementation((_file: string, signal?: AbortSignal): Promise<string[]> =>
            new Promise((_resolve: (devices: string[]) => void, reject: (error: unknown) => void): void => {
                assert.ok(signal);
                signal.addEventListener('abort', (): void => reject(new DOMException('GPU check cancelled.', 'AbortError')), { once: true });
                markStarted?.();
            }));
        const settings: NuExtractSettings = new NuExtractSettings(root, process.execPath, path.join(root, 'probe.png'));
        await settings.selectDevice('gpu');
        const checked: Promise<void> = assert.rejects(settings.runtimeFiles(), runtime.NuExtractGpuCheckCancelledError);
        await started;
        await settings.cancel();
        await checked;
        const status: NuExtractSettingsStatus = await settings.status();
        assert.equal(status.device, 'gpu');
        assert.equal(status.effectiveDevice, null);
        assert.equal(status.busy, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps the saved GPU preference and reports an unavailable Vulkan runtime', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-gpu-missing-'));
    try {
        await installedModel(root);
        vi.spyOn(vulkan, 'supportsVulkanRuntime').mockReturnValue(true);
        vi.spyOn(vulkan, 'vulkanRuntimeExecutable').mockResolvedValue(undefined);
        const settings: NuExtractSettings = new NuExtractSettings(root, process.execPath, path.join(root, 'probe.png'));
        await settings.selectDevice('gpu');
        await assert.rejects(settings.runtimeFiles(), runtime.NuExtractGpuUnavailableError);
        const status: NuExtractSettingsStatus = await settings.status();
        assert.equal(status.device, 'gpu');
        assert.equal(status.effectiveDevice, null);
        assert.equal(status.gpu, 'download-required');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
