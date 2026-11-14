import type { TransformCallback } from 'node:stream';
import { createHash, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModelAsset } from './local-ocr-assets.js';

const publisher: "huggingface.co" = 'huggingface.co';
const downloadHosts: Set<string> = new Set([publisher, 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co']);
const redirects: Set<number> = new Set([301, 302, 303, 307, 308]);
const maxRedirects: number = 4;
const inactivityMs: 60000 = 60_000;

function trustedUrl(url: URL): boolean {
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash && downloadHosts.has(url.hostname);
}

async function fetchAsset(source: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let url: URL = new URL(source);
    if (!trustedUrl(url) || url.hostname !== publisher || !url.pathname.startsWith('/PaddlePaddle/')) {
        throw new Error('Invalid model source.');
    }
    for (let hop: number = 0; hop <= maxRedirects; hop++) {
        const response: Response = await fetch(url, {
            method: 'GET', signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Accept-Encoding': 'identity' }
        });
        if (response.status === 200 && response.body) {
            return response.body;
        }
        const location: string | null = response.headers.get('location');
        await response.body?.cancel();
        if (!redirects.has(response.status) || !location || hop === maxRedirects) {
            throw new Error('Model download returned an unexpected response.');
        }
        url = new URL(location, url);
        if (!trustedUrl(url)) {
            throw new Error('Model download redirected to an untrusted source.');
        }
    }
    throw new Error('Model download exceeded its redirect limit.');
}

export async function downloadModelAssets(assets: readonly ModelAsset[], staging: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<void> {
    let totalBytes: number = 0;
    for (const asset of assets) {
        signal.throwIfAborted();
        if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(asset.file) || asset.file.split('/').some((part: string): part is "." | ".." => part === '.' || part === '..')) {
            throw new Error('Invalid model asset path.');
        }
        const destination: string = path.join(staging, asset.file);
        await mkdir(path.dirname(destination), { recursive: true });
        const transfer: AbortController = new AbortController();
        const timeout: NodeJS.Timeout = setTimeout((): void => transfer.abort(new Error('Model download stopped receiving data.')), inactivityMs);
        const transferSignal: AbortSignal = AbortSignal.any([signal, transfer.signal]);
        try {
            const body: ReadableStream<Uint8Array<ArrayBufferLike>> = await fetchAsset(asset.url, transferSignal);
            const hash: Hash = createHash('sha256');
            let fileBytes: number = 0;
            const verify: Transform = new Transform({
                transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
                    timeout.refresh();
                    fileBytes += chunk.length;
                    if (fileBytes > asset.bytes) {
                        return done(new Error('Model file exceeded its expected size.'));
                    }
                    hash.update(chunk);
                    totalBytes += chunk.length;
                    try {
                        onBytes(totalBytes);
                    } catch (error: unknown) {
                        return done(error instanceof Error ? error : new Error('Model download progress could not be reported.', { cause: error }));
                    }
                    done(null, chunk);
                }
            });
            await pipeline(body, verify, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: transferSignal });
            signal.throwIfAborted();
            if (fileBytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
                throw new Error('Model file integrity check failed.');
            }
        } finally {
            clearTimeout(timeout);
            transfer.abort();
        }
    }
}
