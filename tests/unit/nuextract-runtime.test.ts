import { EventEmitter } from "node:events";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { RequestOptions } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { listNuExtractVulkanDevices, NuExtractRuntime, type INuExtractRuntimeFiles } from "../../electron/extraction/nuextract-runtime.js";

type FakeChild = EventEmitter & Record<'stdout' | 'stderr', PassThrough>;
type FakeResponse = PassThrough & Record<'statusCode', number>;
type FakeRequest = EventEmitter & Record<'end', (body?: string) => void>;

interface IRuntimeMocks {
	spawn: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => FakeChild;
	request: (options: RequestOptions, receive: (response: FakeResponse) => void) => FakeRequest;
}

const mocks: IRuntimeMocks = vi.hoisted((): IRuntimeMocks => ({ spawn: vi.fn(), request: vi.fn() }));
vi.mock("node:child_process", (): object => ({ spawn: mocks.spawn }));
vi.mock("node:http", (): object => ({ request: mocks.request }));

const files: INuExtractRuntimeFiles = { executable: path.resolve("llama-server"), model: path.resolve("model.gguf"), projector: path.resolve("mmproj.gguf") };
const png: Buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1x8AAAAASUVORK5CYII=", "base64");

function mockChild(log: string): FakeChild {
	const child: FakeChild = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
	vi.mocked(mocks.spawn).mockImplementation((_exe: string, _args: string[], options: SpawnOptionsWithoutStdio): FakeChild => {
		options.signal?.addEventListener(
			"abort",
			(): void => {
				child.emit("close", null);
			},
			{ once: true },
		);
		queueMicrotask((): void => {
			child.stderr.write(log.slice(0, 24));
			child.stderr.write(log.slice(24));
		});
		return child;
	});
	return child;
}

function mockRequests(content: string): void {
	vi.mocked(mocks.request).mockImplementation((options: RequestOptions, receive: (response: FakeResponse) => void): FakeRequest => {
		const pending: FakeRequest = Object.assign(new EventEmitter(), {
			end: (): void => {
				const response: FakeResponse = Object.assign(new PassThrough(), { statusCode: 200 });
				receive(response);
				response.end(JSON.stringify(options.path === "/health" ? { status: "ok" } : { choices: [{ finish_reason: "stop", message: { content } }] }));
			},
		});
		return pending;
	});
}

afterEach((): void => {
	vi.resetAllMocks();
});

describe("NuExtract3 runtime", (): void => {
	it("starts one authenticated loopback GPU process and uses it for multiple image requests", async (): Promise<void> => {
		const child: FakeChild = mockChild("load_tensors: offloaded 34/34 layers to GPU\nmtmd_backends: using Vulkan0 backend\nlistening on http://127.0.0.1:43210\n");
		const stopped: Mock<() => void> = vi.fn();
		child.on("close", stopped);
		mockRequests('{"value":"sample"}');
		const runtime: NuExtractRuntime = await NuExtractRuntime.start({ ...files, gpuDevice: "Vulkan0" });
		try {
			await expect(runtime.extract({ images: [png], template: { value: "verbatim-string" }, instructions: "Read the image" })).resolves.toEqual({ value: "sample" });
			await expect(runtime.extract({ images: [png], template: { value: "verbatim-string" }, instructions: "Read the image" })).resolves.toEqual({ value: "sample" });
			expect(mocks.spawn).toHaveBeenCalledOnce();
			const startup: Parameters<typeof mocks.spawn> | undefined = vi.mocked(mocks.spawn).mock.calls[0];
			const key: string | undefined = startup?.[2].env?.LLAMA_API_KEY;
			expect(key).toMatch(/^[a-f0-9]{64}$/);
			expect(startup?.[1]).not.toContain(key);
			expect(startup?.[1]).toEqual(expect.arrayContaining(["--port", "0", "--device", "Vulkan0", "-ngl", "all", "--mmproj-offload"]));
			for (const [options] of vi.mocked(mocks.request).mock.calls) {
				expect(options).toMatchObject({ hostname: "127.0.0.1", port: 43210, agent: false, headers: { Authorization: `Bearer ${key ?? ""}` } });
			}
		} finally {
			await runtime.close();
		}
		expect(stopped).toHaveBeenCalledOnce();
	});

	it("does not send an image when the Vulkan image encoder was not verified", async (): Promise<void> => {
		mockChild("load_tensors: offloaded 34/34 layers to GPU\nmtmd_backends: using CPU backend\nlistening on http://127.0.0.1:43210\n");
		await expect(NuExtractRuntime.start({ ...files, gpuDevice: "Vulkan0" })).rejects.toThrow("did not verify");
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it("verifies the CPU model and encoder using the pinned runtime diagnostic", async (): Promise<void> => {
		mockChild("load_tensors: CPU model buffer size = 1001.37 MiB\nmtmd_backends: using CPU backend\nlistening on http://127.0.0.1:43210\n");
		mockRequests('{"value":null}');
		const runtime: NuExtractRuntime = await NuExtractRuntime.start(files);
		try {
			const args: string[] | undefined = vi.mocked(mocks.spawn).mock.calls[0]?.[1];
			expect(args).toEqual(expect.arrayContaining(["--device", "none", "-ngl", "0", "--no-mmproj-offload", "--load-mode"]));
			expect(args?.slice(-2)).toEqual(["--load-mode", "none"]);
			await expect(runtime.extract({ images: [png], template: { value: "verbatim-string" }, instructions: "Read the image" })).resolves.toEqual({ value: null });
		} finally {
			await runtime.close();
		}
	});

	it("rejects GPU layer placement when the CPU device is selected", async (): Promise<void> => {
		mockChild(
			"load_tensors: CPU model buffer size = 1001.37 MiB\nload_tensors: offloaded 1/34 layers to GPU\nmtmd_backends: using CPU backend\nlistening on http://127.0.0.1:43210\n",
		);
		await expect(NuExtractRuntime.start(files)).rejects.toThrow("did not verify");
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it("reports only unique Vulkan device IDs", async (): Promise<void> => {
		const child: FakeChild = mockChild("Available devices:\n  Vulkan0: GPU A\n  Vulkan2: GPU B\n  Vulkan0: GPU A\n  CUDA0: GPU A\n");
		queueMicrotask((): void =>
			queueMicrotask((): void => {
				child.emit("close", 0);
			}),
		);
		await expect(listNuExtractVulkanDevices(files.executable)).resolves.toEqual(["Vulkan0", "Vulkan2"]);
	});
});
