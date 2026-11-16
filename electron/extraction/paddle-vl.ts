import type { Readable } from 'node:stream';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile, type FileReadResult, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OcrRegion } from '../../src/shared/pdf-extraction.js';

export interface PaddleVlFiles {
    executable: string;
    model: string;
    projector: string;
    template: string;
    gpuDevice?: string;
}
export class PaddleVlCleanupError extends Error {}

const maxOutputBytes: number = 256 * 1024;
const maxDiagnosticBytes: number = 1024 * 1024;
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

interface RuntimeOutput {
    stdout: string;
    stderr: string;
}

interface OutputBuffer {
    chunks: Buffer[];
    bytes: number;
}

function localPath(file: string): boolean {
    return path.isAbsolute(file) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(file));
}

function runRuntime(executable: string, args: string[], signal: AbortSignal, diagnostics: boolean): Promise<RuntimeOutput> {
    signal.throwIfAborted();
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([name]: [string, string | undefined]): boolean => /^(SystemRoot|windir)$/i.test(name)));
    return new Promise((resolve: (value: RuntimeOutput) => void, reject: (reason?: unknown) => void): void => {
        const child: ChildProcessByStdio<null, Readable, Readable> = spawn(executable, args, { cwd: path.dirname(executable), env, shell: false,
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
        const stdout: OutputBuffer = { chunks: [], bytes: 0 };
        const stderr: OutputBuffer = { chunks: [], bytes: 0 };
        let error: Error | undefined;
        child.once('error', (value: Error): void => {
            error ??= value;
        });

        const collect: (output: OutputBuffer, limit: number, chunk: Buffer) => void = (output: OutputBuffer, limit: number, chunk: Buffer): void => {
            if (error) {
                return;
            }
            output.bytes += chunk.length;
            if (output.bytes > limit) {
                error = new Error('PaddleOCR-VL exceeded the local output limit.');
                child.kill('SIGKILL');
                return;
            }
            output.chunks.push(chunk);
        };
        child.stdout.on('data', (chunk: Buffer): void => collect(stdout, maxOutputBytes, chunk));
        if (diagnostics) {
            child.stderr.on('data', (chunk: Buffer): void => collect(stderr, maxDiagnosticBytes, chunk));
        } else {
            child.stderr.resume();
        }

        child.once('close', (code: number | null): void => {
            if (error || code !== 0) {
                reject(error ?? new Error('The local PaddleOCR-VL process did not complete text generation.'));
            } else {
                resolve({ stdout: Buffer.concat(stdout.chunks, stdout.bytes).toString('utf8'), stderr: Buffer.concat(stderr.chunks, stderr.bytes).toString('utf8') });
            }
        });
    });
}

export async function listPaddleVlGpuDevices(executable: string, signal: AbortSignal): Promise<string[]> {
    if (!localPath(executable)) {
        throw new Error('PaddleOCR-VL requires an absolute local runtime path.');
    }
    const output: RuntimeOutput = await runRuntime(executable, ['--list-devices'], signal, true);
    const devices: string[] = [...(output.stdout + '\n' + output.stderr).matchAll(/^[\t ]*(Vulkan\d{1,3}):[\t ]/gm)]
        .map((match: RegExpMatchArray): string => match[1]);
    return [...new Set(devices)];
}

async function runSpotting(files: PaddleVlFiles, image: string, template: string, signal: AbortSignal): Promise<string> {
    const gpuDevice: string | undefined = files.gpuDevice;
    if (gpuDevice !== undefined && !/^Vulkan\d{1,3}$/.test(gpuDevice)) {
        throw new Error('The selected PaddleOCR-VL GPU is invalid.');
    }
    const deviceArgs: string[] = gpuDevice ? ['--device', gpuDevice, '-ngl', 'all', '--mmproj-offload', '--log-verbosity', '4'] :
        ['--device', 'none', '-ngl', '0', '--no-mmproj-offload'];
    // The CLI exits successfully at a token cap, even mid-page. Bound the context, output bytes and job time instead.
    const args: string[] = ['-m', files.model, '--mmproj', files.projector, '--image', image, '-p', 'Spotting:', '-c', '4096', '-n', '-1', '-t', '4',
        ...deviceArgs, '--flash-attn', 'off', '--no-warmup', '--temp', '0', '--jinja', '--chat-template', template];
    const output: RuntimeOutput = await runRuntime(files.executable, args, signal, gpuDevice !== undefined);
    if (gpuDevice) {
        const layers: RegExpMatchArray | undefined = [...output.stderr.matchAll(/load_tensors: offloaded (\d+)\/(\d+) layers to GPU\b/g)].at(-1);
        if (!layers || layers[1] === '0' || layers[1] !== layers[2] || !output.stderr.includes(`mtmd_backends: using ${gpuDevice} backend`)) {
            throw new Error('PaddleOCR-VL could not run the model and image encoder on the selected GPU.');
        }
    }
    return output.stdout;
}

export async function recognizePaddleVl(files: PaddleVlFiles, png: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<OcrRegion[]> {
    signal.throwIfAborted();
    const filePaths: string[] = [files.executable, files.model, files.projector, files.template];
    if (!filePaths.every(localPath)) {
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

export async function probePaddleVlGpu(files: PaddleVlFiles, signal: AbortSignal): Promise<void> {
    if (!files.gpuDevice) {
        throw new Error('Choose a PaddleOCR-VL GPU before running its compatibility check.');
    }
    const png: Buffer = await readFile(path.join(__dirname, 'extraction', 'paddle-vl-probe.png'), { signal });
    const regions: OcrRegion[] = await recognizePaddleVl(files, png, 580, 320, signal);
    const text: string = regions.map((region: OcrRegion): string => region.text).join(' ');
    if (!/\bRM-2047\b/.test(text) || !/\b48\.75\b/.test(text)) {
        throw new Error('The selected GPU could not recognize the compatibility check sample.');
    }
}
