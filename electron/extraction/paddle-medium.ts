import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ocrRegionsSchema, type OcrRegion } from '../../src/shared/pdf-extraction.js';
import type Stream from 'node:stream';

export interface PaddleMediumFiles {
    executable: string;
    detection: string;
    recognition: string;
}

const maxOutputBytes: number = 16 * 1024 * 1024;

export async function recognizePaddleMedium(config: PaddleMediumFiles, png: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<OcrRegion[]> {
    const { executable, detection, recognition }: PaddleMediumFiles = config;
    const localAbsolute: RegExp = process.platform === 'win32' ? /^[a-z]:[\\/]/i : /^\/(?!\/)/;
    if (![executable, detection, recognition].every((file: string): boolean => localAbsolute.test(file))) {
        throw new Error('PP-OCRv6 requires absolute local paths.');
    }
    signal.throwIfAborted();
    const script: string = await readFile(path.join(__dirname, 'extraction', 'paddle-medium.py'), 'utf8');
    const cwd: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-ocr-'));
    try {
        signal.throwIfAborted();
        const env: { SystemRoot: string | undefined; USERPROFILE: string; TEMP: string; TMP: string; TMPDIR: string; XDG_CACHE_HOME: string; HF_HOME: string; HF_HUB_OFFLINE: string; HF_HUB_DISABLE_TELEMETRY: string; TRANSFORMERS_OFFLINE: string; PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: string; PADDLE_PDX_CACHE_HOME: string; } = {
            SystemRoot: process.env.SystemRoot,
            // Resolve dependency defaults to the private cache even on systems where pathlib uses USERPROFILE.
            USERPROFILE: cwd,
            TEMP: cwd,
            TMP: cwd,
            TMPDIR: cwd,
            XDG_CACHE_HOME: cwd,
            HF_HOME: cwd,
            HF_HUB_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
            TRANSFORMERS_OFFLINE: '1',
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
            PADDLE_PDX_CACHE_HOME: cwd
        };
        const output: string = await new Promise<string>((resolve: (value: string | PromiseLike<string>) => void, reject: (reason?: unknown) => void): void => {
            const child: ChildProcessByStdio<Stream.Writable, Stream.Readable, null> = spawn(executable, ['-I', '-B', '-X', 'utf8', '-c', script, detection, recognition, String(width), String(height)], {
                cwd, env, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
            });
            let failure: Error | undefined;
            let bytes: number = 0;
            const chunks: Buffer[] = [];
            child.on('error', (error: Error): void => {
                failure ??= error;
            });

            child.stdin.on('error', (error: Error): void => {
                failure ??= error;
            });

            child.stdout.on('data', (chunk: Buffer): void => {
                if (failure) {
                    return;
                }
                bytes += chunk.length;
                if (bytes > maxOutputBytes) {
                    failure = new Error('PP-OCRv6 exceeded its output limit.');
                    child.kill('SIGKILL');
                    return;
                }
                chunks.push(chunk);
            });

            child.once('close', (code: number | null): void => {
                if (failure) {
                    reject(failure);
                } else if (code !== 0) {
                    reject(new Error('PP-OCRv6 did not complete.'));
                } else {
                    resolve(Buffer.concat(chunks, bytes).toString('utf8'));
                }
            });
            child.stdin.end(png);
        });
        signal.throwIfAborted();
        return ocrRegionsSchema.parse(JSON.parse(output));
    } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
    }
}
