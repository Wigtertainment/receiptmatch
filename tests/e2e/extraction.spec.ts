import type { BankImportInput, ImportIssue, PositionedSpan } from "../../src/shared/bank-import.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument, StandardFonts, degrees, type PDFPage, type PDFFont } from "pdf-lib";
import { test as base, type ElectronApplication, type Page, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs, type TestType } from "@playwright/test";
import type * as extractionHost from "../../electron/extraction/host.js";
import { bankImportInputSchema, type ImportPage } from "../../src/shared/bank-import.js";
import type { ExtractionJob, ExtractionProgress, ExtractionResult } from "../../src/shared/pdf-extraction.js";
import type Module from 'node:module';

interface ExtractionReport {
	runId: string;
	startedAt: string;
	status: "running" | "passed" | "failed";
	platform: NodeJS.Platform;
	syntheticOnly: boolean;
	root: string;
	checks: { name: string; status: "passed"; milliseconds: number; detail?: unknown }[];
	limits?: string[];
	error?: string;
	stack?: string;
	finishedAt?: string;
}

interface ExtractionTestScope {
	extractionTestSessions: { created: number; sessions: Set<Electron.Session> };
}

interface ExtractionFixture {
	report: ExtractionReport;
	check: <Detail>(name: string, action: () => Promise<Detail>) => Promise<void>;
	launch: () => Promise<ElectronApplication>;
}

const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & { extraction: ExtractionFixture; }, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<{ extraction: ExtractionFixture }>({
	extraction: async ({ playwright }: { extraction: ExtractionFixture; } & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, use: (r: ExtractionFixture) => Promise<void>, testInfo: TestInfo): Promise<void> => {
		await mkdir("artifacts", { recursive: true });
		const root: string = await mkdtemp(path.resolve("artifacts/extraction-"));
		const reportPath: string = path.resolve(`artifacts/extraction-${process.platform}.json`);
		const report: ExtractionReport = {
			runId: randomUUID(),
			startedAt: new Date().toISOString(),
			status: "running",
			platform: process.platform,
			syntheticOnly: true,
			root,
			checks: [],
		};
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		let application: ElectronApplication | undefined;

		async function check<Detail>(name: string, action: () => Promise<Detail>): Promise<void> {
			const started: number = performance.now();
			const detail: Awaited<Detail> = await test.step(name, action);
			report.checks.push({ name, status: "passed", milliseconds: Math.round(performance.now() - started), ...(detail === undefined ? {} : { detail }) });
		}

		async function launch(): Promise<ElectronApplication> {
			application = await playwright._electron.launch({
				executablePath: path.resolve(process.platform === "win32" ? "release/win-unpacked/ReceiptMatch.exe" : "release/linux-unpacked/receiptmatch"),
				args: ["--hidden", "--disable-gpu", `--user-data-dir=${path.join(root, "fresh-profile")}`],
				timeout: 30000,
				env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
			});
			return application;
		}

		await use({ report, check, launch });

		let cleanupError: unknown;
		try {
			if (application) {
				await application.close();
			}
		} catch (error: unknown) {
			cleanupError = error;
		}
		report.status = testInfo.status === "passed" && cleanupError === undefined ? "passed" : "failed";
		report.error = testInfo.error?.message ?? testInfo.error?.value ?? (cleanupError === undefined ? undefined : (cleanupError instanceof Error ? cleanupError.message : JSON.stringify(cleanupError)));
		report.stack = testInfo.error?.stack ?? (cleanupError instanceof Error ? cleanupError.stack : undefined);
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		if (cleanupError !== undefined) {
			throw cleanupError instanceof Error ? cleanupError : new Error('Test cleanup failed.', { cause: cleanupError });
		}
	},
});

async function pdfFixture(kinds: string[], png?: Uint8Array): Promise<Uint8Array<ArrayBufferLike>> {
	const document: PDFDocument = await PDFDocument.create();
	const font: PDFFont = await document.embedFont(StandardFonts.Helvetica);
	const pageSizes: Map<string, [number, number]> = new Map([["large", [4000, 4000]], ["rotated", [600, 500]], ["scan-long", [600, 800]]]);
	for (const kind of kinds) {
		const sheet: PDFPage = document.addPage(pageSizes.get(kind) ?? [600, 180]);
		if (["text", "same-page"].includes(kind)) {
			sheet.drawText("POSITIONCHECK TOTAL EUR 123.45", { x: 40, y: 100, size: 20, font });
		}
		if (kind === "rotated") {
			sheet.setCropBox(30, 40, 400, 300);
			sheet.setRotation(degrees(90));
			sheet.drawText("ROTATEDMARK", { x: 80, y: 100, size: 20, font });
		}
		if (kind === "scan" || kind === "same-page" || kind === "scan-long") {
			assert.ok(png);
			const size: { width: number; height: number; } = kind === "scan" ? { width: 600, height: 180 } : kind === "same-page" ? { width: 300, height: 90 } : { width: 600, height: 800 };
			sheet.drawImage(await document.embedPng(png), { x: 0, y: 0, ...size });
		}
	}
	return document.save();
}

function inputOf(result: ExtractionResult, expected: string = "complete"): BankImportInput {
	assert.equal(result.status, expected, JSON.stringify(result));
	assert.ok("input" in result);
	return bankImportInputSchema.parse(result.input);
}

function codes(result: ExtractionResult): string[] {
	return ("input" in result ? result.input.issues : result.issues).map((issue: ImportIssue): string => issue.code);
}

async function invoke(application: ElectronApplication, bytes: Uint8Array, mode: string = "normal", format: string = "pdf"): Promise<{ result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }; concurrent: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } | undefined; progress: ExtractionProgress[]; windows: (Pick<Electron.WebPreferences, "sandbox" | "contextIsolation" | "nodeIntegration"> & { persistent: boolean; })[]; networkProbes: (string | number)[]; storageProbes: (string | null)[]; elapsedMilliseconds: number; abortedWhilePending: boolean; extractionWindowsAfter: number; }> {
	return application.evaluate(
		async ({ app, BrowserWindow, ipcMain }: typeof Electron.CrossProcessExports, request: { base64: string; mode: string; format: string; }): Promise<{ result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }; concurrent: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } | undefined; progress: ExtractionProgress[]; windows: (Pick<Electron.WebPreferences, "sandbox" | "contextIsolation" | "nodeIntegration"> & { persistent: boolean; })[]; networkProbes: (string | number)[]; storageProbes: (string | null)[]; elapsedMilliseconds: number; abortedWhilePending: boolean; extractionWindowsAfter: number; }> => {
			const { createRequire }: typeof Module = process.getBuiltinModule("module");
			const { join }: typeof path = process.getBuiltinModule("path");
			const { performance }: typeof import("perf_hooks") = process.getBuiltinModule("perf_hooks");
			const require: NodeJS.Require = createRequire(join(app.getAppPath(), "package.json"));
			const host: typeof extractionHost = require(join(app.getAppPath(), ".build/extraction-host.cjs")) as typeof extractionHost;
			const fileSystem: typeof import("node:fs/promises") = require("node:fs/promises") as typeof import("node:fs/promises");
			const bytes: Buffer<ArrayBuffer> | Uint8Array<ArrayBuffer> = request.mode === "over-byte-limit" ? new Uint8Array(25 * 1024 * 1024 + 1) : Buffer.from(request.base64, "base64");
			const controller: AbortController = new AbortController();
			const progress: ExtractionProgress[] = [];
			const windows: (Pick<Electron.WebPreferences, "sandbox" | "contextIsolation" | "nodeIntegration"> & { persistent: boolean })[] = [];
			const networkProbes: (string | number)[] = [];
			const storageProbes: (string | null)[] = [];
			const originalRead: typeof fileSystem.readFile = fileSystem.readFile;
			const originalTimeout: typeof setTimeout = globalThis.setTimeout;
			const originalEmit: typeof ipcMain.emit = Reflect.get(ipcMain, 'emit');
			let activeWindow: Electron.BrowserWindow | undefined;
			let injected: boolean = false;
			let abortTimer: NodeJS.Timeout | undefined;
			let finished: boolean = false;
			let abortedWhilePending: boolean = false;
			if (request.mode === "preabort") {
				controller.abort();
			}
			if (request.mode === "missing-language") {
				fileSystem.readFile = new Proxy(originalRead, {
					async apply(readFile: typeof fileSystem.readFile, receiver: unknown, args: unknown[]): Promise<string | Buffer> {
						if (String(args[0]).endsWith("eng.traineddata.gz")) {
							throw Object.assign(new Error("Controlled missing English resource"), { code: "ENOENT" });
						}
						return Reflect.apply(readFile, receiver, args) as ReturnType<typeof fileSystem.readFile>;
					},
				});
			}
			if (request.mode === "timeout") {
				globalThis.setTimeout = new Proxy(originalTimeout, {
					apply(setTimeout: typeof globalThis.setTimeout, receiver: unknown, args: unknown[]): ReturnType<typeof globalThis.setTimeout> {
						if (args[1] === 120000) {
							args[1] = 250;
						}
						return Reflect.apply(setTimeout, receiver, args) as ReturnType<typeof globalThis.setTimeout>;
					},
				});
			}
			const created: (_event: Electron.Event, window: Electron.BrowserWindow) => void = (_event: Electron.Event, window: Electron.BrowserWindow): void => {
				activeWindow = window;
				(globalThis as typeof globalThis & ExtractionTestScope).extractionTestSessions.sessions.add(window.webContents.session);
				const contents: Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences; } = window.webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences };
				const preferences: Electron.WebPreferences = contents.getLastWebPreferences();
				windows.push({
					sandbox: preferences.sandbox,
					contextIsolation: preferences.contextIsolation,
					nodeIntegration: preferences.nodeIntegration,
					persistent: window.webContents.session.isPersistent(),
				});
				window.webContents.setBackgroundThrottling(false);
				const send: (channel: string, ...args: unknown[]) => void = window.webContents.send.bind(window.webContents);

				function instrumentImageResult(job: ExtractionJob): void {
					const sheet: ImportPage = { pageId: "page-1", pageNumber: 1, width: 1200, height: 360, status: "complete", spans: [] };
					const input: { source: { sourceId: string; sha256: string; }; extraction: { runId: string; version: string; }; pages: ImportPage[]; issues: never[]; } = { source: { sourceId: job.sourceId, sha256: job.sha256 }, extraction: { runId: job.jobId, version: "" }, pages: [sheet], issues: [] };
					if (request.mode === "image-forged-pages") {
						input.pages.push({ ...sheet, pageId: "page-2", pageNumber: 2 });
					}
					if (request.mode === "image-forged-dimensions") {
						sheet.width = 600;
					}
					if (request.mode === "image-forged-method") {
						sheet.spans.push({ text: "forged", method: "embedded-text", region: { x: 1, y: 1, width: 10, height: 10 } });
					}
					// Use the engine's real version, then mutate only the image contract being tested.
					ipcMain.emit = function (eventName: string | symbol, ...eventArgs: unknown[]): boolean {
						const payload: { jobId: string; event: import("../../src/shared/pdf-extraction.js").ExtractionEvent } | undefined =
							eventName === "extraction:event" ? eventArgs[1] as { jobId: string; event: import("../../src/shared/pdf-extraction.js").ExtractionEvent } | undefined : undefined;
						if (payload?.event.type === "result") {
							const result: ExtractionResult = payload.event.result;
							if ("input" in result) {
								input.extraction.version = result.input.extraction.version;
								eventArgs[1] = { ...payload, event: { type: "result", result: { status: "complete", input } } };
							}
							ipcMain.emit = originalEmit;
						}
						return originalEmit.call(this, eventName, ...eventArgs);
					};
				}

				function emitMismatchedResult(job: ExtractionJob): boolean {
					const bogus: { jobId: string; event: { type: string; result: { status: string; issues: { code: string; severity: string; message: string; pageId: null; rowId: null; field: null; evidence: never[]; }[]; }; }; } = {
						jobId: job.jobId,
						event: {
							type: "result",
							result: {
								status: "failed",
								issues: [{ code: "spoofed", severity: "error", message: "Spoof must be ignored.", pageId: null, rowId: null, field: null, evidence: [] }],
							},
						},
					};
					if (request.mode === "wrong-job") {
						ipcMain.emit(
							"extraction:event",
							{ sender: window.webContents, senderFrame: window.webContents.mainFrame },
							{ ...bogus, jobId: "00000000-0000-4000-8000-000000000001" },
						);
						return false;
					}
					const ui: Electron.BrowserWindow | undefined = BrowserWindow.getAllWindows().find((candidate: Electron.BrowserWindow): boolean => candidate !== window);
					if (!ui) {
						throw new Error("The workspace window is missing.");
					}
					ipcMain.emit("extraction:event", { sender: ui.webContents, senderFrame: window.webContents.mainFrame }, bogus);
					ipcMain.emit("extraction:event", { sender: window.webContents, senderFrame: { url: "receiptmatch-extraction://engine/index.html" } }, bogus);
					return true;
				}

				window.webContents.send = (channel: string, ...args: unknown[]): void => {
					if (channel !== "extraction:job") {
						send(channel, ...args);
						return;
					}
					if (request.mode === "timeout") {
						return;
					}
					if (request.mode.startsWith("image-forged-") && !injected) {
						injected = true;
						instrumentImageResult(args[0] as ExtractionJob);
					}
					if (["storage-write", "storage-read"].includes(request.mode) && !injected) {
						injected = true;
						const script: "(() => { const previous = localStorage.getItem('extraction-canary'); localStorage.setItem('extraction-canary', 'synthetic-canary'); return [previous, localStorage.getItem('extraction-canary')]; })()" | "[localStorage.getItem('extraction-canary')]" =
							request.mode === "storage-write"
								? "(() => { const previous = localStorage.getItem('extraction-canary'); localStorage.setItem('extraction-canary', 'synthetic-canary'); return [previous, localStorage.getItem('extraction-canary')]; })()"
								: "[localStorage.getItem('extraction-canary')]";
						void window.webContents.executeJavaScript(script).then((values: unknown): void => {
							storageProbes.push(...(values as (string | null)[]));
							send(channel, ...args);
						});
						return;
					}
					if (request.mode === "probe" && !injected) {
						injected = true;
						void window.webContents
							.executeJavaScript(
								`Promise.all([
                        fetch('https://example.invalid/').then(() => 'allowed', () => 'denied'),
                        fetch('file:///receiptmatch-forbidden').then(() => 'allowed', () => 'denied'),
                        fetch('receiptmatch://app/index.html').then(() => 'allowed', () => 'denied'),
                        fetch('receiptmatch-extraction://engine/main.cjs').then(response => response.status, () => 'denied'),
                        Promise.resolve(typeof globalThis.require)
                    ])`,
							)
							.then((values: unknown): void => {
								networkProbes.push(...(values as (string | number)[]));
								send(channel, ...args);
							});
						return;
					}
					if (["spoof", "wrong-job"].includes(request.mode) && !injected) {
						injected = true;
						if (!emitMismatchedResult(args[0] as ExtractionJob)) {
							return;
						}
					}
					send(channel, ...args);
				};
			};
			app.on("browser-window-created", created);
			const started: number = performance.now();
			try {
				const onProgress: (value: ExtractionProgress) => void = (value: ExtractionProgress): void => {
					progress.push(value);
					if (value.phase === "ocr" && request.mode === "abort-ocr" && !abortTimer) {
						abortTimer = originalTimeout((): void => {
							abortedWhilePending = !finished;
							if (!finished) {
								controller.abort();
							}
						}, 100);
					}
					if (value.phase === "ocr" && request.mode === "crash-ocr" && activeWindow && !activeWindow.isDestroyed()) {
						activeWindow.webContents.forcefullyCrashRenderer();
					}
				};
				// The format-rejection check intentionally sends an unsupported format.
				const pending: Promise<{ status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; }> =
					request.format === "pdf" && request.mode !== "common-api"
						? host.extractPdfBytes(bytes, "synthetic-source", { signal: controller.signal, onProgress })
						: host.extractDocumentBytes(bytes, "synthetic-source", request.format as ExtractionJob["format"], { signal: controller.signal, onProgress });
				let concurrent: ExtractionResult | undefined;
				if (request.mode === "concurrent") {
					concurrent = await host.extractPdfBytes(bytes, "concurrent-source");
				}
				if (request.mode === "mutate-source") {
					bytes.fill(0);
				}
				const result: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = await pending;
				finished = true;
				return {
					result,
					concurrent,
					progress,
					windows,
					networkProbes,
					storageProbes,
					elapsedMilliseconds: Math.round(performance.now() - started),
					abortedWhilePending,
					extractionWindowsAfter: BrowserWindow.getAllWindows().filter((window: Electron.BrowserWindow): boolean => window.webContents.getURL().startsWith("receiptmatch-extraction:")).length,
				};
			} finally {
				clearTimeout(abortTimer);
				app.removeListener("browser-window-created", created);
				fileSystem.readFile = originalRead;
				globalThis.setTimeout = originalTimeout;
				ipcMain.emit = originalEmit;
			}
		},
		{ base64: Buffer.from(bytes).toString("base64"), mode, format },
	);
}

async function imageFixture(page: Page, format: "png" | "jpeg", { transparent = false, blank = false, rotated = false, long = false }: { transparent?: boolean | undefined; blank?: boolean | undefined; rotated?: boolean | undefined; long?: boolean | undefined; } = {}): Promise<Buffer<ArrayBuffer>> {
	return Buffer.from(
		await page.evaluate(
			({ format, transparent, blank, rotated, long }: { format: "png" | "jpeg"; transparent: boolean; blank: boolean; rotated: boolean; long: boolean; }): string => {
				const canvas: HTMLCanvasElement = document.createElement("canvas");
				canvas.width = rotated ? 360 : 1200;
				canvas.height = rotated ? 1200 : long ? 1600 : 360;
				const context: CanvasRenderingContext2D | null = canvas.getContext("2d");
				if (!context) {
					throw new Error("Could not create the fixture canvas.");
				}
				if (!transparent) {
					context.fillStyle = "white";
					context.fillRect(0, 0, canvas.width, canvas.height);
				}
				if (rotated) {
					context.translate(0, 1200);
					context.rotate(-Math.PI / 2);
				}
				if (!blank) {
					context.fillStyle = "black";
					context.font = "40px monospace";
					context.fillText("RECEIPTMATCH EXTRACTION", 50, 90);
					context.fillText("TOTAL EUR 123.45", 50, 175);
					context.fillText("REFERENCE ENGLISH OCR", 50, 260);
					if (long) {
						for (let row: number = 0; row < 25; row++) {
							context.fillText(`SYNTHETIC OCR ROW ${row + 1}`, 50, 310 + row * 45);
						}
					}
				}
				return canvas.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.95).split(",")[1];
			},
			{ format, transparent, blank, rotated, long },
		),
		"base64",
	);
}

function withExifOrientation(bytes: Uint8Array, orientation: number): Buffer<ArrayBuffer> {
	const payload: Buffer<ArrayBuffer> = Buffer.from([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
	payload.writeUInt16LE(orientation, 24);
	return Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 225, 0, 34]), payload, bytes.subarray(2)]);
}

function jpegWithSofFirst(bytes: Uint8Array): Buffer<ArrayBuffer> {
	const jpeg: Buffer<ArrayBuffer> = Buffer.from(bytes),
		segments: { marker: number; bytes: Buffer<ArrayBuffer> }[] = [];
	let offset: number = 2;
	while (offset < jpeg.length && jpeg[offset + 1] !== 0xda) {
		const length: number = jpeg.readUInt16BE(offset + 2);
		segments.push({ marker: jpeg[offset + 1], bytes: jpeg.subarray(offset, offset + 2 + length) });
		offset += 2 + length;
	}
	const frame: { marker: number; bytes: Buffer<ArrayBuffer>; } | undefined = segments.find((segment: { marker: number; bytes: Buffer<ArrayBuffer>; }): boolean => [0xc0, 0xc1, 0xc2].includes(segment.marker));
	assert.ok(frame);
	return Buffer.concat([jpeg.subarray(0, 2), frame.bytes, ...segments.filter((segment: { marker: number; bytes: Buffer<ArrayBuffer>; }): boolean => segment !== frame).map((segment: { marker: number; bytes: Buffer<ArrayBuffer>; }): Buffer<ArrayBuffer> => segment.bytes), jpeg.subarray(offset)]);
}

test.describe.configure({ timeout: 600_000 });

test("packaged Electron PDF and image extraction", async ({ extraction: { report, check, launch } }: PlaywrightTestArgs & PlaywrightTestOptions & { extraction: ExtractionFixture; } & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	const application: ElectronApplication = await launch();
	const page: Page = await application.firstWindow({ timeout: 30_000 });
	page.setDefaultTimeout(30_000);
	await page.getByRole("heading", { name: "ReceiptMatch", exact: true }).waitFor();
	await application.evaluate(({ app }: typeof Electron.CrossProcessExports): void => {
		const sessions: { created: number; sessions: Set<Electron.Session>; } = { created: 0, sessions: new Set<Electron.Session>() };
		(globalThis as typeof globalThis & ExtractionTestScope).extractionTestSessions = sessions;
		app.on("session-created", (): void => {
			sessions.created++;
		});
	});
	const png: Buffer<ArrayBuffer> = Buffer.from(
		await page.evaluate((): string => {
			const canvas: HTMLCanvasElement = document.createElement("canvas");
			canvas.width = 1200;
			canvas.height = 360;
			const context: CanvasRenderingContext2D | null = canvas.getContext("2d");
			if (!context) {
				throw new Error("Could not create the fixture canvas.");
			}
			context.fillStyle = "white";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "black";
			context.font = "40px monospace";
			context.fillText("RECEIPTMATCH EXTRACTION", 50, 90);
			context.fillText("TOTAL EUR 123.45", 50, 175);
			context.fillText("REFERENCE ENGLISH OCR", 50, 260);
			return canvas.toDataURL("image/png").split(",")[1];
		}),
		"base64",
	);
	const text: Uint8Array<ArrayBufferLike> = await pdfFixture(["text"]);
	const scan: Uint8Array<ArrayBufferLike> = await pdfFixture(["scan"], png);
	const mixed: Uint8Array<ArrayBufferLike> = await pdfFixture(["text", "scan"], png);
	const longScanPng: Buffer<ArrayBuffer> = Buffer.from(
		await page.evaluate((): string => {
			const canvas: HTMLCanvasElement = document.createElement("canvas");
			canvas.width = 1200;
			canvas.height = 1600;
			const context: CanvasRenderingContext2D | null = canvas.getContext("2d");
			if (!context) {
				throw new Error("Could not create the fixture canvas.");
			}
			context.fillStyle = "white";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "black";
			context.font = "28px monospace";
			for (let row: number = 0; row < 35; row++) {
				context.fillText(`SYNTHETIC OCR LINE ${row + 1} AMOUNT EUR 123.45 REFERENCE ABC123`, 25, 40 + row * 42);
			}
			return canvas.toDataURL("image/png").split(",")[1];
		}),
		"base64",
	);
	const longScan: Uint8Array<ArrayBufferLike> = await pdfFixture(["scan-long"], longScanPng);
	await check("real-packaged-embedded-text-provenance-and-point-geometry", async (): Promise<{ runId: string; page: ImportPage; }> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, text);
		const input: ReturnType<typeof inputOf> = inputOf(value.result);
		assert.equal(input.source.sourceId, "synthetic-source");
		assert.equal(input.source.sha256, createHash("sha256").update(text).digest("hex"));
		assert.ok(input.extraction.runId);
		assert.ok(input.extraction.version);
		assert.equal(input.pages.length, 1);
		const span: PositionedSpan | undefined = input.pages[0].spans.find((span: PositionedSpan): boolean => span.text.includes("POSITIONCHECK"));
		assert.ok(span);
		assert.equal(span.method, "embedded-text");
		assert.ok(span.region.x >= 39 && span.region.x <= 41);
		assert.ok(span.region.y >= 55 && span.region.y <= 90);
		assert.ok(span.region.width > 100 && span.region.height > 5);
		assert.equal(input.pages[0].width, 600);
		assert.equal(input.pages[0].height, 180);
		assert.equal(value.extractionWindowsAfter, 0);
		assert.deepEqual(value.windows, [{ sandbox: true, contextIsolation: true, nodeIntegration: false, persistent: false }]);
		return { runId: input.extraction.runId, page: input.pages[0] };
	});
	await check("rotated-crop-page-uses-top-left-point-coordinates", async (): Promise<ImportPage> => {
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, await pdfFixture(["rotated"]))).result);
		const sheet: ImportPage = input.pages[0];
		assert.equal(sheet.width, 300);
		assert.equal(sheet.height, 400);
		const span: PositionedSpan | undefined = sheet.spans.find((span: PositionedSpan): boolean => span.text.includes("ROTATEDMARK"));
		assert.ok(span);
		assert.ok(span.region.height > span.region.width);
		assert.ok(span.region.x >= 40 && span.region.x <= 85);
		assert.ok(span.region.y >= 35 && span.region.y <= 70);
		return sheet;
	});
	await check("bundled-english-ocr-and-mixed-pages-have-positioned-words", async (): Promise<{ pageCount: number; ocrWord: PositionedSpan; }> => {
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, mixed)).result);
		assert.equal(input.pages.length, 2);
		assert.ok(input.pages[0].spans.every((span: PositionedSpan): boolean => span.method === "embedded-text"));
		assert.ok(input.pages[1].spans.every((span: PositionedSpan): boolean => span.method === "local-ocr"));
		const word: PositionedSpan | undefined = input.pages[1].spans.find((span: PositionedSpan): boolean => span.text === "TOTAL");
		assert.ok(word);
		assert.ok(word.region.x >= 15 && word.region.x <= 50);
		assert.ok(word.region.y >= 50 && word.region.y <= 100);
		assert.ok(word.region.width < 150 && word.region.height < 40);
		assert.match(input.pages[1].spans.map((span: PositionedSpan): string => span.text).join(" "), /EUR\s+123[.,]45/);
		return { pageCount: input.pages.length, ocrWord: word };
	});
	await check("same-page-text-and-image-is-explicitly-partial-without-pretend-ocr", async (): Promise<{ issues: ImportIssue[]; extractionMethods: ("embedded-text" | "local-ocr")[]; }> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, await pdfFixture(["same-page"], png));
		const input: ReturnType<typeof inputOf> = inputOf(value.result, "partial");
		assert.equal(input.pages.length, 1);
		assert.equal(input.pages[0].status, "complete");
		assert.ok(input.pages[0].spans.length > 0);
		assert.ok(input.pages[0].spans.every((span: PositionedSpan): boolean => span.method === "embedded-text"));
		assert.ok(input.issues.some((issue: ImportIssue): boolean => issue.code === "mixed-content" && issue.pageId === input.pages[0].pageId));
		assert.ok(!value.progress.some((item: ExtractionProgress): boolean => item.phase === "ocr"));
		return { issues: input.issues, extractionMethods: [...new Set(input.pages[0].spans.map((span: PositionedSpan): "embedded-text" | "local-ocr" => span.method))] };
	});
	await check("shared-document-api-preserves-PDF-text-and-provenance", async (): Promise<void> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "common-api");
		const input: ReturnType<typeof inputOf> = inputOf(value.result);
		assert.equal(input.source.sha256, createHash("sha256").update(text).digest("hex"));
		assert.ok(input.pages[0].spans.every((span: PositionedSpan): boolean => span.method === "embedded-text"));
		assert.ok(!value.progress.some((progress: ExtractionProgress): boolean => progress.phase === "ocr"));
	});
	const imagePng: Buffer<ArrayBuffer> = await imageFixture(page, "png");
	const imageJpeg: Buffer<ArrayBuffer> = await imageFixture(page, "jpeg");
	await check("packaged-PNG-and-JPEG-OCR-have-image-pixel-evidence-and-local-resources", async (): Promise<void> => {
		for (const [format, bytes] of [
			["png", imagePng],
			["jpeg", imageJpeg],
		] as const) {
			const original: Buffer<ArrayBuffer> = Buffer.from(bytes);
			const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, bytes, "normal", format);
			const input: ReturnType<typeof inputOf> = inputOf(value.result);
			assert.equal(input.source.sha256, createHash("sha256").update(original).digest("hex"));
			assert.deepEqual(bytes, original);
			assert.equal(input.pages.length, 1);
			const sheet: ImportPage = input.pages[0];
			assert.equal(sheet.width, 1200);
			assert.equal(sheet.height, 360);
			assert.ok(sheet.spans.length && sheet.spans.every((span: PositionedSpan): boolean => span.method === "local-ocr"));
			assert.match(sheet.spans.map((span: PositionedSpan): string => span.text).join(" "), /TOTAL\s+EUR\s+123[.,]45/);
			const total: PositionedSpan | undefined = sheet.spans.find((span: PositionedSpan): boolean => span.text === "TOTAL");
			assert.ok(total);
			assert.ok(total.region.x >= 40 && total.region.x <= 65);
			assert.ok(total.region.y >= 130 && total.region.y <= 180);
			assert.ok(value.progress.some((progress: ExtractionProgress): boolean => progress.phase === "ocr" && progress.pageCount === 1));
			assert.equal(value.extractionWindowsAfter, 0);
			assert.deepEqual(value.windows, [{ sandbox: true, contextIsolation: true, nodeIntegration: false, persistent: false }]);
		}
		const notice: string = await application.evaluate(({ app }: typeof Electron.CrossProcessExports): string => {
			const { readFileSync }: typeof import("node:fs") = process.getBuiltinModule("node:fs");
			const { join }: typeof path = process.getBuiltinModule("path");
			return readFileSync(join(app.getAppPath(), ".build/extraction/notices/image-size.txt"), "utf8");
		});
		assert.match(notice, /MIT License/);
	});
	await check("transparent-PNG-is-composited-for-OCR-and-blank-images-stay-unresolved", async (): Promise<void> => {
		const transparent: ReturnType<typeof inputOf> = inputOf((await invoke(application, await imageFixture(page, "png", { transparent: true }), "normal", "png")).result);
		assert.match(transparent.pages[0].spans.map((span: PositionedSpan): string => span.text).join(" "), /TOTAL\s+EUR\s+123[.,]45/);
		const blank: ReturnType<typeof inputOf> = inputOf((await invoke(application, await imageFixture(page, "png", { blank: true }), "normal", "png")).result, "partial");
		assert.equal(blank.pages[0].spans.length, 0);
		assert.ok(blank.issues.some((issue: ImportIssue): boolean => issue.code === "no-readable-text"));
	});
	await check("JPEG-EXIF-rotation-uses-actual-decoded-pixels-for-page-and-OCR-regions", async (): Promise<void> => {
		const bytes: Buffer<ArrayBuffer> = withExifOrientation(await imageFixture(page, "jpeg", { rotated: true }), 6);
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, bytes, "normal", "jpeg")).result);
		assert.equal(input.pages[0].width, 1200);
		assert.equal(input.pages[0].height, 360);
		assert.match(input.pages[0].spans.map((span: PositionedSpan): string => span.text).join(" "), /TOTAL\s+EUR\s+123[.,]45/);
	});
	await check("JPEG-with-frame-as-first-segment-keeps-its-original-bytes-and-OCR", async (): Promise<void> => {
		const bytes: Buffer<ArrayBuffer> = jpegWithSofFirst(imageJpeg),
			original: Buffer<ArrayBuffer> = Buffer.from(bytes);
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, bytes, "normal", "jpeg")).result);
		assert.equal(input.source.sha256, createHash("sha256").update(original).digest("hex"));
		assert.equal(input.pages[0].width, 1200);
		assert.equal(input.pages[0].height, 360);
		assert.match(input.pages[0].spans.map((span: PositionedSpan): string => span.text).join(" "), /TOTAL\s+EUR\s+123[.,]45/);
		assert.deepEqual(bytes, original);
	});
	await check("image-format-and-header-limits-reject-before-decoder-start-and-corruption-is-visible", async (): Promise<void> => {
		const huge: Buffer<ArrayBuffer> = Buffer.from(imagePng);
		huge.writeUInt32BE(100000, 16);
		for (const [bytes, format, code] of [
			[imagePng, "jpeg", "image-format"],
			[imageJpeg, "png", "image-format"],
			[huge, "png", "pixel-limit"],
			[Buffer.from("<svg width='100' height='100'/>"), "png", "image-format"],
			[imagePng, "svg", "image-format"],
		] as const) {
			const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, bytes, "normal", format);
			assert.equal(value.result.status, "failed");
			assert.ok(codes(value.result).includes(code), JSON.stringify(value.result));
			assert.equal(value.windows.length, 0);
		}
		const broken: Awaited<ReturnType<typeof invoke>> = await invoke(application, imagePng.subarray(0, 33), "normal", "png");
		assert.equal(broken.result.status, "failed");
		assert.ok(codes(broken.result).includes("image-invalid"));
		assert.equal(broken.extractionWindowsAfter, 0);
		inputOf((await invoke(application, imagePng, "normal", "png")).result);
	});
	await check("images-share-host-cancellation-single-flight-and-offline-boundaries-with-PDF", async (): Promise<void> => {
		const beforeStart: Awaited<ReturnType<typeof invoke>> = await invoke(application, imagePng, "preabort", "png");
		assert.equal(beforeStart.result.status, "cancelled");
		assert.equal(beforeStart.windows.length, 0);
		const cancelled: Awaited<ReturnType<typeof invoke>> = await invoke(application, await imageFixture(page, "png", { long: true }), "abort-ocr", "png");
		assert.equal(cancelled.abortedWhilePending, true);
		assert.equal(cancelled.result.status, "cancelled");
		assert.equal(cancelled.extractionWindowsAfter, 0);
		const overlap: Awaited<ReturnType<typeof invoke>> = await invoke(application, imageJpeg, "concurrent", "jpeg");
		inputOf(overlap.result);
		assert.ok(overlap.concurrent);
		assert.equal(overlap.concurrent.status, "failed");
		assert.ok(codes(overlap.concurrent).includes("busy"));
		const missing: Awaited<ReturnType<typeof invoke>> = await invoke(application, imagePng, "missing-language", "png");
		assert.equal(missing.result.status, "failed");
		assert.ok(codes(missing.result).includes("ocr-unavailable"));
		inputOf((await invoke(application, text)).result);
		const probe: Awaited<ReturnType<typeof invoke>> = await invoke(application, imagePng, "probe", "png");
		inputOf(probe.result);
		assert.deepEqual(probe.networkProbes, ["denied", "denied", "denied", "denied", "undefined"]);
	});
	await check("image-results-cannot-claim-extra-pages-different-dimensions-or-embedded-text", async (): Promise<void> => {
		for (const mode of ["image-forged-pages", "image-forged-dimensions", "image-forged-method"]) {
			const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, imagePng, mode, "png");
			assert.equal(value.result.status, "failed");
			assert.ok(codes(value.result).includes("engine-result"));
			assert.equal(value.extractionWindowsAfter, 0);
		}
		inputOf((await invoke(application, imagePng, "normal", "png")).result);
	});
	await check("failed-page-retains-real-geometry-and-visible-partial-issue", async (): Promise<{ failedPage: ImportPage & { pageId: string; pageNumber: number; width: number; height: number; status: string; spans: never[]; }; issues: ImportIssue[]; }> => {
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, await pdfFixture(["text", "large"]))).result, "partial");
		assert.equal(input.pages.length, 2);
		assert.equal(input.pages[0].status, "complete");
		assert.deepEqual(input.pages[1], { pageId: input.pages[1].pageId, pageNumber: 2, width: 4000, height: 4000, status: "failed", spans: [] });
		assert.ok(input.issues.some((issue: ImportIssue): boolean => issue.pageId === input.pages[1].pageId));
		return { failedPage: input.pages[1], issues: input.issues };
	});
	await check("malformed-and-over-page-limit-inputs-fail-with-stable-issues", async (): Promise<void> => {
		const malformed: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = (await invoke(application, Buffer.from("This is not a PDF."))).result;
		assert.equal(malformed.status, "failed");
		assert.ok(codes(malformed).includes("pdf-invalid"));
		const manyPages: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = (await invoke(application, await pdfFixture(Array.from({ length: 201 }, (): string => "blank")))).result;
		assert.equal(manyPages.status, "failed");
		assert.ok(codes(manyPages).includes("page-limit"));
	});
	await check("password-encrypted-and-over-byte-limit-inputs-fail-explicitly", async (): Promise<void> => {
		const password: { status: "complete"; input: BankImportInput; } | { status: "partial"; input: BankImportInput; } | { status: "failed"; issues: ImportIssue[]; } | { status: "cancelled"; issues: ImportIssue[]; } = (await invoke(application, await readFile("tests/fixtures/password-required.pdf"))).result;
		assert.equal(password.status, "failed");
		assert.ok(codes(password).includes("pdf-password"));
		const oversized: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "over-byte-limit");
		assert.equal(oversized.result.status, "failed");
		assert.ok(codes(oversized.result).includes("invalid-input"));
		assert.equal(oversized.windows.length, 0);
	});
	await check("preabort-and-source-byte-snapshot-do-not-create-false-provenance", async (): Promise<void> => {
		const cancelled: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "preabort");
		assert.equal(cancelled.result.status, "cancelled");
		assert.ok(codes(cancelled.result).includes("cancelled"));
		assert.equal(cancelled.windows.length, 0);
		const input: ReturnType<typeof inputOf> = inputOf((await invoke(application, text, "mutate-source")).result);
		assert.equal(input.source.sha256, createHash("sha256").update(text).digest("hex"));
	});
	await check("single-flight-rejects-overlap-and-preserves-first-job", async (): Promise<void> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, scan, "concurrent");
		inputOf(value.result);
		assert.ok(value.concurrent);
		assert.equal(value.concurrent.status, "failed");
		assert.ok(codes(value.concurrent).includes("busy"));
	});
	await check("ocr-delayed-abort-destroys-pending-job-and-next-job-succeeds", async (): Promise<void> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, longScan, "abort-ocr");
		assert.ok(value.progress.some((item: ExtractionProgress): boolean => item.phase === "ocr"));
		assert.equal(value.abortedWhilePending, true);
		assert.equal(value.result.status, "cancelled");
		assert.ok(codes(value.result).includes("cancelled"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(application, text)).result);
	});
	await check("renderer-crash-is-visible-and-next-job-succeeds", async (): Promise<void> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, scan, "crash-ocr");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("engine-crashed"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(application, text)).result);
	});
	await check("controlled-timeout-cleans-up-and-next-job-succeeds", async (): Promise<void> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "timeout");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("timeout"));
		assert.ok(value.elapsedMilliseconds < 10000);
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(application, text)).result);
	});
	await check("missing-local-language-retains-healthy-pages-and-next-job-succeeds", async (): Promise<{ pageStatuses: ("complete" | "failed")[]; issues: ImportIssue[]; }> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, await pdfFixture(["text", "scan", "text"], png), "missing-language");
		const input: ReturnType<typeof inputOf> = inputOf(value.result, "partial");
		assert.deepEqual(
			input.pages.map((sheet: ImportPage): "complete" | "failed" => sheet.status),
			["complete", "failed", "complete"],
		);
		assert.equal(input.pages[1].spans.length, 0);
		for (const index of [0, 2]) {
			assert.ok(input.pages[index].spans.some((span: PositionedSpan): boolean => span.text.includes("POSITIONCHECK")));
		}
		assert.ok(input.issues.some((issue: ImportIssue): boolean => issue.code === "ocr-unavailable" && issue.pageId === input.pages[1].pageId));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(application, scan)).result);
		return { pageStatuses: input.pages.map((sheet: ImportPage): "complete" | "failed" => sheet.status), issues: input.issues };
	});
	await check("unrelated-sender-frame-and-job-cannot-spoof-extraction", async (): Promise<void> => {
		inputOf((await invoke(application, text, "spoof")).result);
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "wrong-job");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("engine-result"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(application, text)).result);
	});
	await check("ephemeral-parser-cannot-fetch-network-files-app-or-host-code", async (): Promise<{ probes: string[]; boundary: string; }> => {
		const value: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "probe");
		inputOf(value.result);
		assert.deepEqual(value.networkProbes, ["denied", "denied", "denied", "denied", "undefined"]);
		return { probes: value.networkProbes, boundary: "Electron extraction session and CSP; not an OS-wide Windows egress test" };
	});
	await check("one-ephemeral-session-is-reused-and-storage-is-cleared-between-jobs", async (): Promise<{ createdSessions: number; usedSessions: number; }> => {
		const written: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "storage-write");
		inputOf(written.result);
		assert.deepEqual(written.storageProbes, [null, "synthetic-canary"]);
		const read: Awaited<ReturnType<typeof invoke>> = await invoke(application, text, "storage-read");
		inputOf(read.result);
		assert.deepEqual(read.storageProbes, [null]);
		const evidence: { createdSessions: number; usedSessions: number; } = await application.evaluate((): { createdSessions: number; usedSessions: number; } => {
			const { extractionTestSessions }: typeof globalThis & ExtractionTestScope = globalThis as typeof globalThis & ExtractionTestScope;
			return { createdSessions: extractionTestSessions.created, usedSessions: extractionTestSessions.sessions.size };
		});
		assert.deepEqual(evidence, { createdSessions: 1, usedSessions: 1 });
		return evidence;
	});
	report.limits = [
		"Synthetic fixtures, English only; no bank parser or financial normalization.",
		"OCR abort is delayed 100ms after recognition-phase progress while the job is pending; process crash is deliberate host automation.",
		"Hidden software-rendered packaged application; not installer or physical-GPU certification.",
	];
});
