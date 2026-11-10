import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { _electron as electron } from "playwright";
import { bankImportInputSchema } from "../.build/node/src/shared/bank-import.js";

await mkdir("artifacts", { recursive: true });
const root = await mkdtemp(path.resolve("artifacts/extraction-"));
const reportPath = path.resolve(`artifacts/extraction-${process.platform}.json`);
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), status: "running", platform: process.platform, syntheticOnly: true, root, checks: [] };
await writeFile(reportPath, JSON.stringify(report, null, 2));
let application;
let page;

async function check(name, action) {
	const started = performance.now();
	const detail = await action();
	report.checks.push({ name, status: "passed", milliseconds: Math.round(performance.now() - started), ...(detail === undefined ? {} : { detail }) });
	console.log(`PASS ${name}`);
}
async function pdfFixture(kinds, png) {
	const document = await PDFDocument.create();
	const font = await document.embedFont(StandardFonts.Helvetica);
	for (const kind of kinds) {
		const sheet = document.addPage(kind === "large" ? [4000, 4000] : kind === "rotated" ? [600, 500] : kind === "scan-long" ? [600, 800] : [600, 180]);
		if (["text", "same-page"].includes(kind)) sheet.drawText("POSITIONCHECK TOTAL EUR 123.45", { x: 40, y: 100, size: 20, font });
		if (kind === "rotated") {
			sheet.setCropBox(30, 40, 400, 300);
			sheet.setRotation(degrees(90));
			sheet.drawText("ROTATEDMARK", { x: 80, y: 100, size: 20, font });
		}
		if (kind === "scan") sheet.drawImage(await document.embedPng(png), { x: 0, y: 0, width: 600, height: 180 });
		if (kind === "same-page") sheet.drawImage(await document.embedPng(png), { x: 0, y: 0, width: 300, height: 90 });
		if (kind === "scan-long") sheet.drawImage(await document.embedPng(png), { x: 0, y: 0, width: 600, height: 800 });
	}
	return document.save();
}
function inputOf(result, expected = "complete") {
	assert.equal(result.status, expected, JSON.stringify(result));
	return bankImportInputSchema.parse(result.input);
}
function codes(result) {
	return (result.input?.issues ?? result.issues ?? []).map((issue) => issue.code);
}

async function invoke(bytes, mode = "normal") {
	return application.evaluate(
		async ({ app, BrowserWindow, ipcMain }, request) => {
			const { createRequire } = process.getBuiltinModule("module");
			const { join } = process.getBuiltinModule("path");
			const { performance } = process.getBuiltinModule("perf_hooks");
			const require = createRequire(join(app.getAppPath(), "package.json"));
			const host = require(join(app.getAppPath(), ".build/extraction-host.cjs"));
			const fileSystem = require("node:fs/promises");
			const bytes = request.mode === "over-byte-limit" ? new Uint8Array(25 * 1024 * 1024 + 1) : Buffer.from(request.base64, "base64");
			const controller = new AbortController();
			const progress = [];
			const windows = [];
			const networkProbes = [];
			const storageProbes = [];
			const originalRead = fileSystem.readFile;
			const originalTimeout = globalThis.setTimeout;
			let activeWindow;
			let injected = false;
			let abortTimer;
			let finished = false;
			let abortedWhilePending = false;
			if (request.mode === "preabort") controller.abort();
			if (request.mode === "missing-language") {
				fileSystem.readFile = async function (file, ...args) {
					if (String(file).endsWith("eng.traineddata.gz")) throw Object.assign(new Error("Controlled missing English resource"), { code: "ENOENT" });
					return originalRead.call(this, file, ...args);
				};
			}
			if (request.mode === "timeout") {
				globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 120000 ? 250 : delay, ...args);
			}
			const created = (_event, window) => {
				activeWindow = window;
				globalThis.extractionTestSessions.sessions.add(window.webContents.session);
				const preferences = window.webContents.getLastWebPreferences();
				windows.push({
					sandbox: preferences.sandbox,
					contextIsolation: preferences.contextIsolation,
					nodeIntegration: preferences.nodeIntegration,
					persistent: window.webContents.session.isPersistent(),
				});
				window.webContents.setBackgroundThrottling(false);
				const send = window.webContents.send.bind(window.webContents);
				window.webContents.send = (channel, ...args) => {
					if (channel === "extraction:job" && request.mode === "timeout") return;
					if (channel === "extraction:job" && ["storage-write", "storage-read"].includes(request.mode) && !injected) {
						injected = true;
						const script =
							request.mode === "storage-write"
								? "(() => { const previous = localStorage.getItem('extraction-canary'); localStorage.setItem('extraction-canary', 'synthetic-canary'); return [previous, localStorage.getItem('extraction-canary')]; })()"
								: "[localStorage.getItem('extraction-canary')]";
						void window.webContents.executeJavaScript(script).then((values) => {
							storageProbes.push(...values);
							send(channel, ...args);
						});
						return;
					}
					if (channel === "extraction:job" && request.mode === "probe" && !injected) {
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
							.then((values) => {
								networkProbes.push(...values);
								send(channel, ...args);
							});
						return;
					}
					if (channel === "extraction:job" && ["spoof", "wrong-job"].includes(request.mode) && !injected) {
						injected = true;
						const job = args[0];
						const ui = BrowserWindow.getAllWindows().find((candidate) => candidate !== window);
						const bogus = {
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
							return;
						}
						ipcMain.emit("extraction:event", { sender: ui.webContents, senderFrame: window.webContents.mainFrame }, bogus);
						ipcMain.emit("extraction:event", { sender: window.webContents, senderFrame: { url: "receiptmatch-extraction://engine/index.html" } }, bogus);
					}
					send(channel, ...args);
				};
			};
			app.on("browser-window-created", created);
			const started = performance.now();
			try {
				const onProgress = (value) => {
					progress.push(value);
					if (value.phase === "ocr" && request.mode === "abort-ocr" && !abortTimer) {
						abortTimer = originalTimeout(() => {
							abortedWhilePending = !finished;
							if (!finished) controller.abort();
						}, 100);
					}
					if (value.phase === "ocr" && request.mode === "crash-ocr" && activeWindow && !activeWindow.isDestroyed()) activeWindow.webContents.forcefullyCrashRenderer();
				};
				const pending = host.extractPdfBytes(bytes, "synthetic-source", { signal: controller.signal, onProgress });
				let concurrent;
				if (request.mode === "concurrent") concurrent = await host.extractPdfBytes(bytes, "concurrent-source");
				if (request.mode === "mutate-source") bytes.fill(0);
				const result = await pending;
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
					extractionWindowsAfter: BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith("receiptmatch-extraction:")).length,
				};
			} finally {
				clearTimeout(abortTimer);
				app.removeListener("browser-window-created", created);
				fileSystem.readFile = originalRead;
				globalThis.setTimeout = originalTimeout;
			}
		},
		{ base64: Buffer.from(bytes).toString("base64"), mode },
	);
}

try {
	application = await electron.launch({
		executablePath: path.resolve(process.platform === "win32" ? "release/win-unpacked/ReceiptMatch.exe" : "release/linux-unpacked/receiptmatch"),
		args: ["--hidden", "--disable-gpu", `--user-data-dir=${path.join(root, "fresh-profile")}`],
		timeout: 30000,
		env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
	});
	page = await application.firstWindow();
	await page.getByRole("heading", { name: "Your records. Your workspace." }).waitFor();
	await application.evaluate(({ app }) => {
		globalThis.extractionTestSessions = { created: 0, sessions: new Set() };
		app.on("session-created", () => {
			globalThis.extractionTestSessions.created++;
		});
	});
	const png = Buffer.from(
		await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 1200;
			canvas.height = 360;
			const context = canvas.getContext("2d");
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
	const text = await pdfFixture(["text"]);
	const scan = await pdfFixture(["scan"], png);
	const mixed = await pdfFixture(["text", "scan"], png);
	const longScanPng = Buffer.from(
		await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 1200;
			canvas.height = 1600;
			const context = canvas.getContext("2d");
			context.fillStyle = "white";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "black";
			context.font = "28px monospace";
			for (let row = 0; row < 35; row++) context.fillText(`SYNTHETIC OCR LINE ${row + 1} AMOUNT EUR 123.45 REFERENCE ABC123`, 25, 40 + row * 42);
			return canvas.toDataURL("image/png").split(",")[1];
		}),
		"base64",
	);
	const longScan = await pdfFixture(["scan-long"], longScanPng);
	await check("real-packaged-embedded-text-provenance-and-point-geometry", async () => {
		const value = await invoke(text);
		const input = inputOf(value.result);
		assert.equal(input.source.sourceId, "synthetic-source");
		assert.equal(input.source.sha256, createHash("sha256").update(text).digest("hex"));
		assert.ok(input.extraction.runId);
		assert.ok(input.extraction.version);
		assert.equal(input.pages.length, 1);
		const span = input.pages[0].spans.find((span) => span.text.includes("POSITIONCHECK"));
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
	await check("rotated-crop-page-uses-top-left-point-coordinates", async () => {
		const input = inputOf((await invoke(await pdfFixture(["rotated"]))).result);
		const sheet = input.pages[0];
		assert.equal(sheet.width, 300);
		assert.equal(sheet.height, 400);
		const span = sheet.spans.find((span) => span.text.includes("ROTATEDMARK"));
		assert.ok(span);
		assert.ok(span.region.height > span.region.width);
		assert.ok(span.region.x >= 40 && span.region.x <= 85);
		assert.ok(span.region.y >= 35 && span.region.y <= 70);
		return sheet;
	});
	await check("bundled-english-ocr-and-mixed-pages-have-positioned-words", async () => {
		const input = inputOf((await invoke(mixed)).result);
		assert.equal(input.pages.length, 2);
		assert.ok(input.pages[0].spans.every((span) => span.method === "embedded-text"));
		assert.ok(input.pages[1].spans.every((span) => span.method === "local-ocr"));
		const word = input.pages[1].spans.find((span) => span.text === "TOTAL");
		assert.ok(word);
		assert.ok(word.region.x >= 15 && word.region.x <= 50);
		assert.ok(word.region.y >= 50 && word.region.y <= 100);
		assert.ok(word.region.width < 150 && word.region.height < 40);
		assert.match(input.pages[1].spans.map((span) => span.text).join(" "), /EUR\s+123[.,]45/);
		return { pageCount: input.pages.length, ocrWord: word };
	});
	await check("same-page-text-and-image-is-explicitly-partial-without-pretend-ocr", async () => {
		const value = await invoke(await pdfFixture(["same-page"], png));
		const input = inputOf(value.result, "partial");
		assert.equal(input.pages.length, 1);
		assert.equal(input.pages[0].status, "complete");
		assert.ok(input.pages[0].spans.length > 0);
		assert.ok(input.pages[0].spans.every((span) => span.method === "embedded-text"));
		assert.ok(input.issues.some((issue) => issue.code === "mixed-content" && issue.pageId === input.pages[0].pageId));
		assert.ok(!value.progress.some((item) => item.phase === "ocr"));
		return { issues: input.issues, extractionMethods: [...new Set(input.pages[0].spans.map((span) => span.method))] };
	});
	await check("failed-page-retains-real-geometry-and-visible-partial-issue", async () => {
		const input = inputOf((await invoke(await pdfFixture(["text", "large"]))).result, "partial");
		assert.equal(input.pages.length, 2);
		assert.equal(input.pages[0].status, "complete");
		assert.deepEqual(input.pages[1], { pageId: input.pages[1].pageId, pageNumber: 2, width: 4000, height: 4000, status: "failed", spans: [] });
		assert.ok(input.issues.some((issue) => issue.pageId === input.pages[1].pageId));
		return { failedPage: input.pages[1], issues: input.issues };
	});
	await check("malformed-and-over-page-limit-inputs-fail-with-stable-issues", async () => {
		const malformed = (await invoke(Buffer.from("This is not a PDF."))).result;
		assert.equal(malformed.status, "failed");
		assert.ok(codes(malformed).includes("pdf-invalid"));
		const manyPages = (await invoke(await pdfFixture(Array(201).fill("blank")))).result;
		assert.equal(manyPages.status, "failed");
		assert.ok(codes(manyPages).includes("page-limit"));
	});
	await check("password-encrypted-and-over-byte-limit-inputs-fail-explicitly", async () => {
		const password = (await invoke(await readFile("tests/fixtures/password-required.pdf"))).result;
		assert.equal(password.status, "failed");
		assert.ok(codes(password).includes("pdf-password"));
		const oversized = await invoke(text, "over-byte-limit");
		assert.equal(oversized.result.status, "failed");
		assert.ok(codes(oversized.result).includes("invalid-input"));
		assert.equal(oversized.windows.length, 0);
	});
	await check("preabort-and-source-byte-snapshot-do-not-create-false-provenance", async () => {
		const cancelled = await invoke(text, "preabort");
		assert.equal(cancelled.result.status, "cancelled");
		assert.ok(codes(cancelled.result).includes("cancelled"));
		assert.equal(cancelled.windows.length, 0);
		const input = inputOf((await invoke(text, "mutate-source")).result);
		assert.equal(input.source.sha256, createHash("sha256").update(text).digest("hex"));
	});
	await check("single-flight-rejects-overlap-and-preserves-first-job", async () => {
		const value = await invoke(scan, "concurrent");
		inputOf(value.result);
		assert.equal(value.concurrent.status, "failed");
		assert.ok(codes(value.concurrent).includes("busy"));
	});
	await check("ocr-delayed-abort-destroys-pending-job-and-next-job-succeeds", async () => {
		const value = await invoke(longScan, "abort-ocr");
		assert.ok(value.progress.some((item) => item.phase === "ocr"));
		assert.equal(value.abortedWhilePending, true);
		assert.equal(value.result.status, "cancelled");
		assert.ok(codes(value.result).includes("cancelled"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(text)).result);
	});
	await check("renderer-crash-is-visible-and-next-job-succeeds", async () => {
		const value = await invoke(scan, "crash-ocr");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("engine-crashed"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(text)).result);
	});
	await check("controlled-timeout-cleans-up-and-next-job-succeeds", async () => {
		const value = await invoke(text, "timeout");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("timeout"));
		assert.ok(value.elapsedMilliseconds < 10000);
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(text)).result);
	});
	await check("missing-local-language-retains-healthy-pages-and-next-job-succeeds", async () => {
		const value = await invoke(await pdfFixture(["text", "scan", "text"], png), "missing-language");
		const input = inputOf(value.result, "partial");
		assert.deepEqual(
			input.pages.map((sheet) => sheet.status),
			["complete", "failed", "complete"],
		);
		assert.equal(input.pages[1].spans.length, 0);
		for (const index of [0, 2]) assert.ok(input.pages[index].spans.some((span) => span.text.includes("POSITIONCHECK")));
		assert.ok(input.issues.some((issue) => issue.code === "ocr-unavailable" && issue.pageId === input.pages[1].pageId));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(scan)).result);
		return { pageStatuses: input.pages.map((sheet) => sheet.status), issues: input.issues };
	});
	await check("unrelated-sender-frame-and-job-cannot-spoof-extraction", async () => {
		inputOf((await invoke(text, "spoof")).result);
		const value = await invoke(text, "wrong-job");
		assert.equal(value.result.status, "failed");
		assert.ok(codes(value.result).includes("engine-result"));
		assert.equal(value.extractionWindowsAfter, 0);
		inputOf((await invoke(text)).result);
	});
	await check("ephemeral-parser-cannot-fetch-network-files-app-or-host-code", async () => {
		const value = await invoke(text, "probe");
		inputOf(value.result);
		assert.deepEqual(value.networkProbes, ["denied", "denied", "denied", "denied", "undefined"]);
		return { probes: value.networkProbes, boundary: "Electron extraction session and CSP; not an OS-wide Windows egress test" };
	});
	await check("one-ephemeral-session-is-reused-and-storage-is-cleared-between-jobs", async () => {
		const written = await invoke(text, "storage-write");
		inputOf(written.result);
		assert.deepEqual(written.storageProbes, [null, "synthetic-canary"]);
		const read = await invoke(text, "storage-read");
		inputOf(read.result);
		assert.deepEqual(read.storageProbes, [null]);
		const evidence = await application.evaluate(() => ({
			createdSessions: globalThis.extractionTestSessions.created,
			usedSessions: globalThis.extractionTestSessions.sessions.size,
		}));
		assert.deepEqual(evidence, { createdSessions: 1, usedSessions: 1 });
		return evidence;
	});
	report.status = "passed";
	report.limits = [
		"Synthetic fixtures, English only; no bank parser or financial normalization.",
		"OCR abort is delayed 100ms after recognition-phase progress while the job is pending; process crash is deliberate host automation.",
		"Hidden software-rendered packaged application; not installer or physical-GPU certification.",
	];
} catch (error) {
	report.status = "failed";
	report.error = String(error);
	report.stack = error.stack;
	process.exitCode = 1;
} finally {
	try {
		if (application) await application.close();
	} finally {
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report, null, 2));
	}
}
