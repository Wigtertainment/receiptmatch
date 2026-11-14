import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi, type Mock } from 'vitest';
import { downloadModelAssets } from '../../electron/local-ocr-transfer.js';

const url: "https://huggingface.co/PaddlePaddle/model/resolve/revision/model.onnx" = 'https://huggingface.co/PaddlePaddle/model/resolve/revision/model.onnx';
const data: Buffer<ArrayBuffer> = Buffer.from('model bytes');
const asset: { file: string; url: string; bytes: number; sha256: string; } = { file: 'medium-det/model.onnx', url, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };

async function withStaging(run: (staging: string) => Promise<void>): Promise<void> {
    const staging: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-transfer-test-'));
    try {
        await run(staging);
    } finally {
        vi.unstubAllGlobals();
        await rm(staging, { recursive: true, force: true });
    }
}

test('streams a verified model file through an approved redirect and reports cumulative bytes', (): Promise<void> => withStaging(async (staging: string): Promise<void> => {
    const cdn: "https://us.aws.cdn.hf.co/asset?signature=example" = 'https://us.aws.cdn.hf.co/asset?signature=example';
    const fetchModel: Mock<{ (input: RequestInfo | URL, init?: RequestInit): Promise<Response>; (input: string | URL | Request, init?: RequestInit): Promise<Response>; }> = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } }))
        .mockResolvedValueOnce(new Response(new Uint8Array(data)))
        .mockResolvedValueOnce(new Response(new Uint8Array(data)));
    vi.stubGlobal('fetch', fetchModel);
    const progress: number[] = [];
    const second: { file: string; url: string; bytes: number; sha256: string; } = { ...asset, file: 'medium-rec/model.onnx' };
    await downloadModelAssets([asset, second], staging, new AbortController().signal, (bytes: number): number => progress.push(bytes));
    assert.deepEqual(await readFile(path.join(staging, asset.file)), data);
    assert.deepEqual(await readFile(path.join(staging, second.file)), data);
    assert.deepEqual(progress, [data.length, data.length * 2]);
    assert.deepEqual(fetchModel.mock.calls.map(([source]: [input: string | URL | Request, init?: RequestInit | undefined]): string => typeof source === "string" ? source : source instanceof URL ? source.href : source.url), [url, cdn, url]);
    assert.ok(fetchModel.mock.calls.every(([, options]: [input: string | URL | Request, init?: RequestInit | undefined]): boolean => options?.redirect === 'manual' && options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
}));

test('rejects an unapproved redirect and a corrupt payload', (): Promise<void> => withStaging(async (staging: string): Promise<void> => {
    const fetchModel: Mock<{ (input: RequestInfo | URL, init?: RequestInit): Promise<Response>; (input: string | URL | Request, init?: RequestInit): Promise<Response>; }> = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://huggingface.co.example.com/asset' } }))
        .mockResolvedValueOnce(new Response(new Uint8Array(data).fill(0)));
    vi.stubGlobal('fetch', fetchModel);
    const signal: AbortSignal = new AbortController().signal;
    await assert.rejects(downloadModelAssets([asset], staging, signal, (): undefined => undefined), /untrusted source/);
    assert.equal(fetchModel.mock.calls.length, 1);
    await assert.rejects(downloadModelAssets([asset], staging, signal, (): undefined => undefined), /integrity check failed/);
}));

test('aborts a stalled response body when the caller cancels', (): Promise<void> => withStaging(async (staging: string): Promise<void> => {
    const controller: AbortController = new AbortController();
    let cancelled: boolean = false;
    const stream: ReadableStream<Uint8Array<ArrayBufferLike>> = new ReadableStream<Uint8Array>({
        start(target: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>): void {
            target.enqueue(new Uint8Array(data.subarray(0, 2)));
        },
        cancel(): void {
            cancelled = true;
        }
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)));
    await assert.rejects(downloadModelAssets([asset], staging, controller.signal, (): void => controller.abort()), { name: 'AbortError' });
    assert.equal(cancelled, true);
}));
