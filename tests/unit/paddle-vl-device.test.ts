import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test, vi, type Mock } from 'vitest';
import { listPaddleVlGpuDevices, recognizePaddleVl, type PaddleVlFiles } from '../../electron/extraction/paddle-vl.js';

vi.mock('node:child_process', async (original: () => Promise<typeof import('node:child_process')>): Promise<{ ChildProcess: typeof ChildProcess; spawn: Mock<typeof spawn>; }> =>
    ({ ChildProcess: (await original()).ChildProcess, spawn: vi.fn<typeof spawn>() }));


afterEach((): void => {
    vi.mocked(spawn).mockReset();
});

function mockRuntime(stdout: string, stderr: string): void {
    const child: ChildProcess & { stdout: PassThrough; stderr: PassThrough } = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
    vi.mocked(spawn).mockImplementationOnce((): ChildProcess => {
        setImmediate((): void => {
            child.stdout.end(stdout);
            child.stderr.end(stderr);
            child.emit('close', 0);
        });
        return child;
    });
}

test('lists only Vulkan device identifiers reported by the local runtime', async (): Promise<void> => {
    mockRuntime('Available devices:\r\n  Vulkan0: GPU 1\r\n  CUDA1: GPU 2\r\n  Vulkan2: GPU 3\r\n', '  Vulkan0: duplicate\nother text mentioning Vulkan9:');
    const devices: string[] = await listPaddleVlGpuDevices(path.resolve('runtime'), new AbortController().signal);
    assert.deepEqual(devices, ['Vulkan0', 'Vulkan2']);
});

test('requires both model and image encoder offloading for GPU OCR', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-paddle-device-'));
    try {
        const files: PaddleVlFiles = { executable: path.join(root, 'runtime'), model: path.join(root, 'model'), projector: path.join(root, 'projector'),
            template: path.join(root, 'template'), gpuDevice: 'Vulkan2' };
        await writeFile(files.template, 'template');
        const stdout: string = 'Total 48.75<|LOC_0|><|LOC_0|><|LOC_100|><|LOC_0|><|LOC_100|><|LOC_100|><|LOC_0|><|LOC_100|>';
        const recognize: () => ReturnType<typeof recognizePaddleVl> = (): ReturnType<typeof recognizePaddleVl> =>
            recognizePaddleVl(files, new Uint8Array(), 100, 100, new AbortController().signal);
        mockRuntime(stdout, 'load_tensors: offloaded 19/19 layers to GPU\nmtmd_backends: using CPU backend\n');
        await assert.rejects(recognize(), /on the selected GPU/);
        mockRuntime(stdout, 'load_tensors: offloaded 18/19 layers to GPU\nmtmd_backends: using Vulkan2 backend\n');
        await assert.rejects(recognize(), /on the selected GPU/);
        mockRuntime(stdout, 'load_tensors: offloaded 19/19 layers to GPU\nmtmd_backends: using Vulkan2 backend\n');
        assert.equal((await recognize())[0].text, 'Total 48.75');
        assert.deepEqual(vi.mocked(spawn).mock.calls[2][1]?.slice(14, 21), ['--device', 'Vulkan2', '-ngl', 'all', '--mmproj-offload', '--log-verbosity', '4']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
