import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ocrRegionsSchema, type OcrRegion } from '../../src/shared/pdf-extraction.js';

export interface PaddleMediumFiles {
    executable: string;
    detection: string;
    recognition: string;
}

const maxOutputBytes = 16 * 1024 * 1024;

export async function recognizePaddleMedium(config: PaddleMediumFiles, png: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<OcrRegion[]> {
    const { executable, detection, recognition } = config;
    const localAbsolute = process.platform === 'win32' ? /^[a-z]:[\\/]/i : /^\/(?!\/)/;
    if (![executable, detection, recognition].every(file => localAbsolute.test(file))) throw new Error('PP-OCRv6 requires absolute local paths.');
    signal.throwIfAborted();
    const script = await readFile(path.join(__dirname, 'extraction', 'paddle-medium.py'), 'utf8');
    const cwd = await mkdtemp(path.join(tmpdir(), 'receiptmatch-ocr-'));
    try {
        signal.throwIfAborted();
        const env = {
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
        const output = await new Promise<string>((resolve, reject) => {
            const child = spawn(executable, ['-I', '-B', '-X', 'utf8', '-c', script, detection, recognition, String(width), String(height)], {
                cwd, env, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
            });
            let failure: Error | undefined;
            let bytes = 0;
            const chunks: Buffer[] = [];
            child.on('error', error => { failure ??= error; });
            child.stdin.on('error', error => { failure ??= error; });
            child.stdout.on('data', (chunk: Buffer) => {
                if (failure) return;
                bytes += chunk.length;
                if (bytes > maxOutputBytes) {
                    failure = new Error('PP-OCRv6 exceeded its output limit.');
                    child.kill('SIGKILL');
                    return;
                }
                chunks.push(chunk);
            });
            child.once('close', code => {
                if (failure) reject(failure);
                else if (code !== 0) reject(new Error('PP-OCRv6 did not complete.'));
                else resolve(Buffer.concat(chunks, bytes).toString('utf8'));
            });
            child.stdin.end(png);
        });
        signal.throwIfAborted();
        return ocrRegionsSchema.parse(JSON.parse(output));
    } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
    }
}
