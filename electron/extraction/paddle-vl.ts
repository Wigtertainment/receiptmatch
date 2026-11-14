import type { Readable } from 'node:stream';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, open, rm, writeFile, type FileReadResult, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OcrRegion } from '../../src/shared/pdf-extraction.js';

export interface PaddleVlFiles {
    executable: string;
    model: string;
    projector: string;
    template: string;
}
export class PaddleVlCleanupError extends Error {}

const maxOutputBytes: number = 256 * 1024;
const maxTemplateBytes: number = 16 * 1024;
const coordinate: RegExp = /<\|LOC_(\d{1,4})\|>/g;
const coordinates: string = String.raw`((?:<\|LOC_\d{1,4}\|>){8})`;
const framedSpotting: RegExp = new RegExp(String.raw`\s*<\|TEXT_START\|>([\s\S]*?)<\|TEXT_END\|>\s*<\|LOC_BEGIN\|>${coordinates}<\|LOC_END\|>`, 'y');
const plainSpotting: RegExp = new RegExp(String.raw`((?:(?!<\|)[\s\S])+?)${coordinates}`, 'y');

export function parsePaddleVlSpotting(output: string, width: number, height: number): OcrRegion[] {
    const regions: OcrRegion[] = [];
    const records: string = output.trim();
    const pattern: RegExp = records.startsWith('<|TEXT_START|>') ? framedSpotting : plainSpotting;
    let offset: number = 0;
    while (offset < records.length) {
        pattern.lastIndex = offset;
        const match: RegExpExecArray | null = pattern.exec(records);
        const text: string | undefined = match?.[1].trim();
        if (!match || !text) {
            throw new Error('PaddleOCR-VL returned an invalid spotting record.');
        }
        const tokens: string = match[2];
        offset = pattern.lastIndex;
        const values: number[] = [...tokens.matchAll(coordinate)].map((match: RegExpExecArray): number => Number(match[1]));
        if (values.some((value: number): boolean => value > 1000)) {
            throw new Error('PaddleOCR-VL returned coordinates outside the page.');
        }
        const xs: number[] = values.filter((_: number, index: number): boolean => index % 2 === 0);
        const ys: number[] = values.filter((_: number, index: number): boolean => index % 2 === 1);
        const signedArea: number = xs.reduce((sum: number, x: number, index: number): number => {
            const next: number = (index + 1) % xs.length;
            return sum + x * ys[next] - xs[next] * ys[index];
        }, 0);
        if (signedArea === 0) {
            throw new Error('PaddleOCR-VL returned an empty spotting region.');
        }
        regions.push({ text, x0: Math.min(...xs) / 1000 * width, y0: Math.min(...ys) / 1000 * height,
            x1: Math.max(...xs) / 1000 * width, y1: Math.max(...ys) / 1000 * height });
    }
    return regions;
}

function runSpotting(files: PaddleVlFiles, image: string, template: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    // The CLI exits successfully at a token cap, even mid-page. Bound the context, output bytes and job time instead.
    const args: string[] = ['-m', files.model, '--mmproj', files.projector, '--image', image, '-p', 'Spotting:', '-c', '4096', '-n', '-1', '-t', '4', '-ngl', '0',
        '--no-mmproj-offload', '--flash-attn', 'off', '--no-warmup', '--temp', '0', '--jinja', '--chat-template', template];
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([name]: [string, string | undefined]): boolean => /^(SystemRoot|windir)$/i.test(name)));
    return new Promise((resolve: (value: string | PromiseLike<string>) => void, reject: (reason?: unknown) => void): void => {
        const child: ChildProcessByStdio<null, Readable, null> = spawn(files.executable, args, { cwd: path.dirname(files.executable), env, shell: false, windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'], signal, killSignal: 'SIGKILL' });
        const chunks: Buffer[] = [];
        let bytes: number = 0;
        let error: Error | undefined;
        child.once('error', (value: Error): void => {
            error ??= value;
        });

        child.stdout.on('data', (chunk: Buffer): void => {
            if (error) {
                return;
            }
            bytes += chunk.length;
            if (bytes > maxOutputBytes) {
                error = new Error('PaddleOCR-VL exceeded the local output limit.');
                child.kill('SIGKILL');
                return;
            }
            chunks.push(chunk);
        });

        child.once('close', (code: number | null): void => {
            if (error || code !== 0) {
                reject(error ?? new Error('The local PaddleOCR-VL process did not complete text generation.'));
            } else {
                resolve(Buffer.concat(chunks, bytes).toString('utf8'));
            }
        });
    });
}

export async function recognizePaddleVl(files: PaddleVlFiles, png: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<OcrRegion[]> {
    signal.throwIfAborted();
    const filePaths: string[] = [files.executable, files.model, files.projector, files.template];
    if (filePaths.some((value: string): boolean => !path.isAbsolute(value) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)))) {
        throw new Error('PaddleOCR-VL requires absolute local runtime and model paths.');
    }
    const file: FileHandle = await open(files.template, 'r');
    let template: string;
    try {
        const buffer: Buffer<ArrayBuffer> = Buffer.alloc(maxTemplateBytes + 1);
        const { bytesRead }: FileReadResult<Buffer<ArrayBuffer>> = await file.read(buffer);
        if (!bytesRead || bytesRead > maxTemplateBytes) {
            throw new Error('The local PaddleOCR-VL template has an invalid size.');
        }
        template = buffer.toString('utf8', 0, bytesRead);
    } finally {
        await file.close();
    }
    signal.throwIfAborted();
    const directory: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-paddle-vl-'));
    const image: string = path.join(directory, 'page.png');
    try {
        await writeFile(image, png, { mode: 0o600, flag: 'wx', signal });
        const output: string = await runSpotting(files, image, template, signal);
        signal.throwIfAborted();
        return parsePaddleVlSpotting(output, width, height);
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch((): never => {
            throw new PaddleVlCleanupError('The temporary local OCR image could not be removed.');
        });
    }
}
