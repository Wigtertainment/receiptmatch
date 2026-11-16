import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { PDF_EXTRACTION_LIMITS } from "../../src/shared/pdf-extraction.js";
import { imageInputDimensions } from "./image-input.js";

export interface NuExtractRuntimeFiles {
	executable: string;
	model: string;
	projector: string;
	gpuDevice?: string;
}

export class NuExtractGpuUnavailableError extends Error {}
export class NuExtractGpuCheckCancelledError extends Error {}

export interface NuExtractRequest {
	images: readonly Uint8Array[];
	template: Readonly<Record<string, unknown>>;
	instructions: string;
	maxTokens?: number;
	jsonObject?: true;
}

type RuntimeProcess = ChildProcessByStdio<null, Readable, Readable>;
type RuntimeEndpoint = "/health" | "/v1/chat/completions";

const host: string = "127.0.0.1";
const modelAlias: string = "NuExtract3";
const startupMs: number = 90_000;
const inferenceMs: number = 240_000;
const maxImages: number = 16;
const maxImageBytes: number = 48 * 1024 * 1024;
const maxTemplateBytes: number = 8 * 1024;
const maxResponseBytes: number = 128 * 1024;
const vulkanDevice: RegExp = /^Vulkan\d{1,3}$/;
const listening: RegExp = /\blistening on http:\/\/127\.0\.0\.1:(\d{1,5})\b/;
const offload: RegExp = /\bload_tensors: offloaded (\d+)\/(\d+) layers to GPU\b/;
const cpuModelBuffer: RegExp = /\bload_tensors:\s+CPU(?:_[a-z0-9]+)? model buffer size\s*=/i;

function localPath(value: string): boolean {
	return path.isAbsolute(value) && (process.platform !== "win32" || /^[a-z]:[\\/]/i.test(value));
}

function runtimeOptions(executable: string, signal: AbortSignal, key?: string): SpawnOptionsWithoutStdio {
	const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]: [string, string | undefined]): boolean => /^(systemroot|windir)$/i.test(name)));
	if (key) {
		env.LLAMA_API_KEY = key;
	}
	return { cwd: path.dirname(executable), env, shell: false, windowsHide: true, signal, killSignal: "SIGKILL" };
}

function readRuntimeOutput(executable: string, args: string[], signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const child: RuntimeProcess = spawn(executable, args, { ...runtimeOptions(executable, signal), stdio: ["ignore", "pipe", "pipe"] });
	return new Promise((resolve: (value: string) => void, reject: (reason: unknown) => void): void => {
		let output: string = "";
		let failed: boolean = false;
		const collect: (chunk: Buffer) => void = (chunk: Buffer): void => {
			if (output.length + chunk.length <= maxResponseBytes) {
				output += chunk.toString("utf8");
			} else {
				failed = true;
				child.kill("SIGKILL");
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (): void => {
			failed = true;
		});

		child.once("close", (code: number | null): void => {
			if (signal.aborted || failed || code !== 0) {
				const reason: unknown = signal.reason;
				reject(reason instanceof Error ? reason : new Error("The local NuExtract3 runtime could not check available devices."));
			} else {
				resolve(output);
			}
		});
	});
}

export async function listNuExtractVulkanDevices(executable: string, signal?: AbortSignal): Promise<string[]> {
	if (!localPath(executable)) {
		throw new Error("NuExtract3 requires an absolute local runtime path.");
	}
	const timeout: AbortSignal = AbortSignal.timeout(15_000);
	const output: string = await readRuntimeOutput(executable, ["--list-devices"], signal ? AbortSignal.any([signal, timeout]) : timeout);
	const devices: string[] = [...output.matchAll(/^[\t ]*(Vulkan\d{1,3}):[\t ]/gm)].map((match: RegExpMatchArray): string => match[1]);
	return [...new Set(devices)];
}

function argumentsFor(files: NuExtractRuntimeFiles): string[] {
	// Load the CPU weights into RAM as in the verified CPU benchmark.
	const device: string[] = files.gpuDevice
		? ["--device", files.gpuDevice, "-ngl", "all", "--mmproj-offload"]
		: ["--device", "none", "-ngl", "0", "--no-mmproj-offload", "--load-mode", "none"];
	return [
		"--host",
		host,
		"--port",
		"0",
		"--alias",
		modelAlias,
		"--no-webui",
		"--no-slots",
		"--jinja",
		"--reasoning",
		"off",
		"--parallel",
		"1",
		"--ctx-size",
		"32768",
		"--cache-ram",
		"0",
		"--no-cache-prompt",
		"--log-verbosity",
		"4",
		"-m",
		files.model,
		"--mmproj",
		files.projector,
		...device,
	];
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readResponse(response: IncomingMessage, resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
	let length: number = 0;
	const chunks: Buffer[] = [];
	response.on("data", (chunk: Buffer): void => {
		length += chunk.length;
		if (length > maxResponseBytes) {
			response.destroy(new Error("NuExtract3 exceeded its local response limit."));
		} else {
			chunks.push(chunk);
		}
	});
	response.once("error", reject);
	response.once("end", (): void => {
		if (response.statusCode !== 200) {
			reject(new Error("NuExtract3 rejected the local request."));
			return;
		}
		try {
			resolve(JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown);
		} catch {
			reject(new Error("NuExtract3 returned an invalid response."));
		}
	});
}

function requestLocal(port: number, endpoint: RuntimeEndpoint, key: string, signal: AbortSignal, body?: string): Promise<unknown> {
	signal.throwIfAborted();
	return new Promise((resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
		const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
		if (body) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = String(Buffer.byteLength(body));
		}
		const pending: ClientRequest = request(
			{ hostname: host, port, path: endpoint, method: body ? "POST" : "GET", agent: false, headers, signal },
			(response: IncomingMessage): void => readResponse(response, resolve, reject),
		);
		pending.once("error", reject);
		pending.end(body);
	});
}

function requestBody(input: NuExtractRequest): string {
	const template: string = JSON.stringify(input.template);
	const maxTokens: number = input.maxTokens ?? 512;
	if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
		throw new Error("NuExtract3 exceeded its local generation limit.");
	}
	if (!input.images.length || input.images.length > maxImages || Buffer.byteLength(template) > maxTemplateBytes || Buffer.byteLength(input.instructions) > maxTemplateBytes) {
		throw new Error("NuExtract3 exceeded its local request limit.");
	}
	let bytes: number = 0;
	let pixels: number = 0;
	for (const image of input.images) {
		const size: { width: number; height: number } = imageInputDimensions(image, "png", maxImageBytes);
		bytes += image.byteLength;
		pixels += size.width * size.height;
		if (bytes > maxImageBytes || pixels > PDF_EXTRACTION_LIMITS.pixelsTotal) {
			throw new Error("NuExtract3 exceeded its local image limit.");
		}
	}
	const content: { type: string; image_url: { url: string } }[] = input.images.map((png: Uint8Array): { type: string; image_url: { url: string } } => ({
		type: "image_url",
		image_url: { url: `data:image/png;base64,${Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64")}` },
	}));
	return JSON.stringify({
		model: modelAlias,
		messages: [{ role: "user", content }],
		temperature: 0,
		seed: 42,
		max_tokens: maxTokens,
		cache_prompt: false,
		...(input.jsonObject ? { response_format: { type: "json_object" } } : {}),
		chat_template_kwargs: { template, instructions: input.instructions, enable_thinking: false },
	});
}

function extractionResult(response: unknown, template: NuExtractRequest["template"]): Record<string, unknown> {
	const choice: unknown = record(response) && Array.isArray(response.choices) ? response.choices[0] : undefined;
	if (!record(choice) || choice.finish_reason !== "stop" || !record(choice.message) || typeof choice.message.content !== "string") {
		throw new Error("NuExtract3 returned an incomplete extraction.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(choice.message.content) as unknown;
	} catch {
		throw new Error("NuExtract3 returned invalid structured data.");
	}
	const fields: string[] = Object.keys(template);
	if (!record(parsed) || Object.keys(parsed).length !== fields.length || fields.some((field: string): boolean => !Object.hasOwn(parsed, field))) {
		throw new Error("NuExtract3 returned unexpected fields.");
	}
	return parsed;
}

export class NuExtractRuntime {
	private readonly stop: AbortController = new AbortController();
	private readonly key: string = randomBytes(32).toString("hex");
	private readonly signal: AbortSignal;
	private readonly closed: Promise<void>;
	private port: number = 0;
	private modelDevice: boolean = false;
	private unexpectedGpuOffload: boolean = false;
	private encoder: boolean = false;
	private busy: boolean = false;

	private constructor(files: NuExtractRuntimeFiles, signal?: AbortSignal) {
		this.signal = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal;
		const child: RuntimeProcess = spawn(files.executable, argumentsFor(files), {
			...runtimeOptions(files.executable, this.signal, this.key),
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.closed = new Promise((resolve: () => void): void => {
			child.once("error", (): void => this.stop.abort(new Error("The local NuExtract3 runtime could not run.")));
			child.once("close", (): void => {
				this.stop.abort(new Error("The local NuExtract3 runtime has stopped."));
				resolve();
			});
		});
		this.observe(child.stdout, files.gpuDevice);
		this.observe(child.stderr, files.gpuDevice);
	}

	static async start(files: NuExtractRuntimeFiles, signal?: AbortSignal): Promise<NuExtractRuntime> {
		if (![files.executable, files.model, files.projector].every(localPath) || (files.gpuDevice !== undefined && !vulkanDevice.test(files.gpuDevice))) {
			throw new Error("NuExtract3 requires absolute local paths and a valid compute device.");
		}
		signal?.throwIfAborted();
		const runtime: NuExtractRuntime = new NuExtractRuntime(files, signal);
		try {
			await runtime.ready();
			return runtime;
		} catch (error: unknown) {
			await runtime.close();
			throw error;
		}
	}

	async extract(input: NuExtractRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const timeout: AbortSignal = AbortSignal.timeout(inferenceMs);
		const requestSignal: AbortSignal = AbortSignal.any(signal ? [this.signal, signal, timeout] : [this.signal, timeout]);
		requestSignal.throwIfAborted();
		if (this.busy) {
			throw new Error("NuExtract3 is already processing a document.");
		}
		this.busy = true;
		try {
			const result: unknown = await requestLocal(this.port, "/v1/chat/completions", this.key, requestSignal, requestBody(input));
			return extractionResult(result, input.template);
		} finally {
			this.busy = false;
			if (requestSignal.aborted) {
				await this.close();
			}
		}
	}

	async close(): Promise<void> {
		this.stop.abort(new Error("The local NuExtract3 runtime has stopped."));
		await this.closed;
	}

	private observe(stream: Readable, gpuDevice?: string): void {
		let trailing: string = "";
		stream.on("data", (chunk: Buffer): void => {
			const lines: string[] = (trailing + chunk.toString("utf8")).split("\n");
			trailing = lines.pop()?.slice(-2048) ?? "";
			for (const line of lines) {
				this.inspectRuntimeLine(line, gpuDevice);
			}
		});
	}

	private inspectRuntimeLine(line: string, gpuDevice?: string): void {
		const address: RegExpExecArray | null = listening.exec(line);
		if (address && !this.port && Number(address[1]) <= 65_535) {
			this.port = Number(address[1]);
		}
		const loaded: RegExpExecArray | null = offload.exec(line);
		if (gpuDevice) {
			this.modelDevice ||= !!loaded && loaded[1] !== "0" && loaded[1] === loaded[2];
		} else {
			// The CPU-only build reports model buffers and can omit the GPU layer count.
			this.modelDevice ||= cpuModelBuffer.test(line);
			this.unexpectedGpuOffload ||= !!loaded && loaded[1] !== "0";
		}
		this.encoder ||= line.includes(`mtmd_backends: using ${gpuDevice ?? "CPU"} backend`);
	}

	private async ready(): Promise<void> {
		const signal: AbortSignal = AbortSignal.any([this.signal, AbortSignal.timeout(startupMs)]);
		while (!this.port) {
			await delay(100, undefined, { signal });
		}
		// b12283 reports the bound address after loading the model and the image encoder.
		if (!this.modelDevice || !this.encoder || this.unexpectedGpuOffload) {
			throw new Error("The local NuExtract3 runtime did not verify the requested model and image encoder device.");
		}
		const status: unknown = await requestLocal(this.port, "/health", this.key, signal);
		if (!record(status) || status.status !== "ok") {
			throw new Error("The local NuExtract3 runtime did not become ready.");
		}
	}
}
