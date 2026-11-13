import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import { downloadModelAssets } from '../../electron/local-ocr-transfer.js';

const url = 'https://huggingface.co/PaddlePaddle/model/resolve/revision/model.onnx';
const data = Buffer.from('model bytes');
const asset = { file: 'medium-det/model.onnx', url, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };

async function withStaging(run: (staging: string) => Promise<void>) {
    const staging = await mkdtemp(path.join(tmpdir(), 'receiptmatch-transfer-test-'));
    try {
        await run(staging);
    } finally {
        vi.unstubAllGlobals();
        await rm(staging, { recursive: true, force: true });
    }
}

test('streams a verified model file through an approved redirect and reports cumulative bytes', () => withStaging(async staging => {
    const cdn = 'https://us.aws.cdn.hf.co/asset?signature=example';
    const fetchModel = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } }))
        .mockResolvedValueOnce(new Response(new Uint8Array(data)))
        .mockResolvedValueOnce(new Response(new Uint8Array(data)));
    vi.stubGlobal('fetch', fetchModel);
    const progress: number[] = [];
    const second = { ...asset, file: 'medium-rec/model.onnx' };
    await downloadModelAssets([asset, second], staging, new AbortController().signal, bytes => progress.push(bytes));
    assert.deepEqual(await readFile(path.join(staging, asset.file)), data);
    assert.deepEqual(await readFile(path.join(staging, second.file)), data);
    assert.deepEqual(progress, [data.length, data.length * 2]);
    assert.deepEqual(fetchModel.mock.calls.map(([source]) => String(source)), [url, cdn, url]);
    assert.ok(fetchModel.mock.calls.every(([, options]) => options?.redirect === 'manual' && options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
}));

test('rejects an unapproved redirect and a corrupt payload', () => withStaging(async staging => {
    const fetchModel = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://huggingface.co.example.com/asset' } }))
        .mockResolvedValueOnce(new Response(new Uint8Array(data).fill(0)));
    vi.stubGlobal('fetch', fetchModel);
    const signal = new AbortController().signal;
    await assert.rejects(downloadModelAssets([asset], staging, signal, () => undefined), /untrusted source/);
    assert.equal(fetchModel.mock.calls.length, 1);
    await assert.rejects(downloadModelAssets([asset], staging, signal, () => undefined), /integrity check failed/);
}));

test('aborts a stalled response body when the caller cancels', () => withStaging(async staging => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(target) { target.enqueue(new Uint8Array(data.subarray(0, 2))); },
        cancel() { cancelled = true; }
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)));
    await assert.rejects(downloadModelAssets([asset], staging, controller.signal, () => controller.abort()), { name: 'AbortError' });
    assert.equal(cancelled, true);
}));
