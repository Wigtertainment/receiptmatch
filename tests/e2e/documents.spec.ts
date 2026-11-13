import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test as base, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import type { WorkspaceCommand, WorkspaceState } from "../../src/shared/protocol.js";
import type { StoredDocumentImport } from "../../src/shared/workspace-documents.js";

declare global {
	interface Window {
		documentTestInjection?: number;
		documentTestState?: WorkspaceState | null;
		unsubscribeDocumentTest?: () => void;
	}
}

type DocumentTestMainGlobals = typeof globalThis & { documentTestDialogProperties?: OpenDialogOptions["properties"] };

interface DocumentImportFixture {
	root: string;
	launch(): Promise<{ application: ElectronApplication; page: Page }>;
}

const rawNote = '<img src=x onerror="window.documentTestInjection=1">';

async function pdfFixture(reference: string) {
	const pdf = await PDFDocument.create(),
		font = await pdf.embedFont(StandardFonts.Helvetica),
		page = pdf.addPage([600, 800]);
	const lines = [
		"Invoice",
		"Merchant: Cedar Workshop",
		`Invoice Number: ${reference}`,
		"Invoice Date: 2032-05-20",
		"Invoice Total: EUR 73.25",
		"Due Date: 05/06/2032",
		"Order Number:",
		rawNote,
	];
	for (const [index, text] of lines.entries()) {
		page.drawText(text, { x: 40, y: 740 - index * 30, size: 14, font });
	}
	return pdf.save();
}

async function mockDialogs(application: ElectronApplication, opens: (string | null)[] = [], saves: string[] = [], choices: number[] = []) {
	await application.evaluate(
		({ dialog }, plan) => {
			dialog.showOpenDialog = async (_window: BrowserWindow | OpenDialogOptions, options?: OpenDialogOptions) => {
				(globalThis as DocumentTestMainGlobals).documentTestDialogProperties = options?.properties;
				const selected = plan.opens.shift();
				return { canceled: !selected, filePaths: selected ? [selected] : [] };
			};
			dialog.showSaveDialog = async () => {
				const selected = plan.saves.shift();
				return { canceled: !selected, filePath: selected ?? "" };
			};
			dialog.showMessageBox = async () => ({ response: plan.choices.shift() ?? 2, checkboxChecked: false });
		},
		{ opens, saves, choices },
	);
}

async function imageFixture(page: Page, format: "png" | "jpeg", long = false) {
	return Buffer.from(
		await page.evaluate(
			({ format, long }) => {
				const canvas = document.createElement("canvas");
				canvas.width = 1200;
				canvas.height = long ? 1800 : 450;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Unable to create the synthetic document image");
				context.fillStyle = "white";
				context.fillRect(0, 0, canvas.width, canvas.height);
				context.fillStyle = "black";
				context.font = "34px monospace";
				for (const [index, text] of [
					"Invoice",
					"Merchant: Fern Workshop",
					`Invoice Number: SYNTHETIC-${format}`,
					"Invoice Date: 2032-05-20",
					"Invoice Total: EUR 84.50",
				].entries())
					context.fillText(text, 40, 60 + index * 60);
				if (long) for (let index = 0; index < 28; index++) context.fillText(`SYNTHETIC DESCRIPTION LINE ${index + 1}`, 40, 390 + index * 45);
				return canvas.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.95).split(",")[1];
			},
			{ format, long },
		),
		"base64",
	);
}

const test = base.extend<{ documentImport: DocumentImportFixture }>({
	documentImport: async ({ playwright }, use) => {
		await mkdir("artifacts", { recursive: true });
		const root = await mkdtemp(path.resolve("artifacts/document-import-"));
		let activeApplication: ElectronApplication | undefined;

		async function launch() {
			const application = await playwright._electron.launch({
				executablePath: path.resolve(process.platform === "win32" ? "release/win-unpacked/ReceiptMatch.exe" : "release/linux-unpacked/receiptmatch"),
				args: ["--hidden", "--disable-gpu", `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
				timeout: 30_000
			});
			activeApplication = application;
			application.on("close", () => {
				if (activeApplication === application) activeApplication = undefined;
			});
			const page = await application.firstWindow({ timeout: 30_000 });
			page.setDefaultTimeout(20_000);
			await page.getByRole("heading", { name: "ReceiptMatch", exact: true }).waitFor();
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
			return { application, page };
		}

		await use({ root, launch });

		const application = activeApplication;
		if (application) {
			try {
				await mockDialogs(application, [], [], [1]);
			} finally {
				await application.close();
			}
		}
	}
});

test.describe.configure({ timeout: 240_000 });

test("packaged supporting document import", async ({ documentImport: { root, launch } }) => {
	let { application, page } = await launch();
	let completedChecks = 0;
	const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

	async function check(name: string, action: () => Promise<void>) {
		await test.step(name, action);
		completedChecks++;
	}

	function dialogs(opens: (string | null)[] = [], saves: string[] = [], choices: number[] = []) {
		return mockDialogs(application, opens, saves, choices);
	}

	const folder = path.join(root, "mixed"),
		nested = path.join(folder, "nested");
	await mkdir(nested, { recursive: true });
	const files = [
		path.join(folder, "a.PDF"),
		path.join(folder, "b.PNG"),
		path.join(nested, "c.jpeg"),
		path.join(folder, "d-copy.pdf"),
		path.join(folder, "e-broken.pdf"),
		path.join(folder, "notes.txt"),
	];
	await writeFile(files[0], await pdfFixture("SYNTHETIC-PDF"));
	await writeFile(files[1], await imageFixture(page, "png"));
	await writeFile(files[2], await imageFixture(page, "jpeg"));
	await copyFile(files[0], files[3]);
	await writeFile(files[4], "Synthetic unreadable PDF");
	await writeFile(files[5], "Unsupported synthetic note");
	const originalHashes = await Promise.all(files.map(async (file) => sha(await readFile(file))));
	const command = (value: WorkspaceCommand) => page.evaluate((value) => window.receiptmatch.command(value), value);
	const records = () => page.evaluate(() => window.receiptmatch.documentImports());
	const documents = () => page.getByRole("region", { name: "Supporting documents" });
	const chooseFolder = () => documents().getByRole("button", { name: "Choose folder" });
	async function openDetails(scope: Locator, label: string | RegExp) {
		const summary = scope.locator("summary").filter({ hasText: label });
		const details = summary.locator("..");
		if ((await details.getAttribute("open")) === null) await summary.press("Enter");
		assert.notEqual(await details.getAttribute("open"), null);
		return details;
	}
	async function openFile(report: Locator, name: string) {
		const button = report.getByRole("button", { name, exact: true });
		if ((await button.getAttribute("aria-expanded")) !== "true") await button.press("Enter");
		const details = report.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
		await details.waitFor();
		return details;
	}
	await check("document-command-is-path-free-and-readonly-data-is-restricted-to-the-active-frame", async () => {
		assert.equal((await command({ type: "import-documents", path: folder } as unknown as WorkspaceCommand)).workspace, null);
		const probes = await application.evaluate(async ({ app, BrowserWindow }) => {
			const { join } = process.getBuiltinModule("path")!;
			const active = BrowserWindow.getAllWindows()[0];
			const extra = new BrowserWindow({
				show: false,
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(app.getAppPath(), ".build/preload.cjs") },
			});
			try {
				await extra.loadURL(active.webContents.getURL());
				return await extra.webContents.executeJavaScript(
					"Promise.all([window.receiptmatch.documentImports(),window.receiptmatch.command({type:'import-documents'})].map(value=>value.then(()=> 'allowed',()=> 'denied')))",
				);
			} finally {
				extra.destroy();
			}
		});
		assert.deepEqual(probes, ["denied", "denied"]);
	});
	let expected: StoredDocumentImport[];
	const workspaceFile = path.join(root, "documents.receiptmatch");
	await check("native-folder-analysis-retains-real-PDF-PNG-JPEG-results-duplicates-and-file-failures", async () => {
		await page.getByRole("button", { name: "Create workspace" }).click();
		await dialogs([folder]);
		await chooseFolder().press("Enter");
		await documents().locator("summary").filter({ hasText: "mixed" }).first().waitFor();
		await documents().getByRole("table", { name: "Files in mixed", exact: true }).waitFor();
		assert.deepEqual(await application.evaluate(() => (globalThis as DocumentTestMainGlobals).documentTestDialogProperties), ["openDirectory"]);
		const state = await command({ type: "get-state" });
		assert.equal(state.documentOutcome?.status, "finished");
		assert.equal(state.workspace?.dirty, true);
		const summary = state.workspace?.documentImports[0];
		assert.equal(summary?.imported, 3);
		assert.equal(summary?.skipped, 1);
		assert.equal(summary?.failed, 1);
		assert.equal(summary?.unsupported, 1);
		expected = await records();
		assert.equal(expected[0].files.length, 6);
		const imported = expected[0].files.filter((file) => file.status === "imported").map((file) => file.record);
		assert.deepEqual(new Set(imported.map((record) => record.format)), new Set(["pdf", "png", "jpeg"]));
		assert.ok(imported.every((record) => record.result.input?.pages.flatMap((page) => page.spans).length));
		const pdf = imported.find((record) => record.format === "pdf");
		const billedTotal = pdf?.result.sections[0]?.amounts.find((field) => field.role === "billed-total");
		assert.equal(billedTotal?.candidates[0]?.coefficient, "7325");
		assert.deepEqual(await Promise.all(files.map(async (file) => sha(await readFile(file)))), originalHashes);
	});
	await check("document-results-show-file-statuses-candidates-and-literal-source-text-with-keyboard-access", async () => {
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 860));
		await page.waitForFunction(() => window.innerWidth <= 700, undefined, { polling: 50 });
		const report = await openDetails(documents(), /^\s*mixed/i);
		assert.equal(await report.evaluate((element) => getComputedStyle(element).borderTopStyle), "solid");
		for (const [file, status] of [
			["a.PDF", "Imported"],
			["b.PNG", "Imported"],
			["c.jpeg", "Imported"],
			["d-copy.pdf", "Skipped"],
			["e-broken.pdf", "Failed"],
			["notes.txt", "Unsupported"],
		]) {
			const row = report.getByRole("row").filter({ has: page.getByRole("button", { name: file, exact: true }) });
			await row.getByText(status, { exact: false }).waitFor();
		}
		const pdfRow = report.getByRole("row").filter({ has: page.getByRole("button", { name: "a.PDF", exact: true }) });
		await pdfRow.getByText(/EUR\s*73[.,]25|73[.,]25\s*EUR/).waitFor();
		const failedRow = report.getByRole("row").filter({ has: page.getByRole("button", { name: "e-broken.pdf", exact: true }) });
		await failedRow.getByText("No single billed total", { exact: true }).waitFor();
		const pdf = await openFile(report, "a.PDF");
		await pdf.getByRole("heading", { name: "Extracted fields" }).waitFor();
		const total = await openDetails(pdf, /Billed total/i);
		await total
			.getByText(/EUR\s*73[.,]25|73[.,]25\s*EUR/)
			.first()
			.waitFor();
		await total
			.getByText(/Page 1.*Embedded text/i)
			.first()
			.waitFor();
		await total
			.getByText(/Region.*PDF points/i)
			.first()
			.waitFor();
		await pdf
			.locator("summary")
			.filter({ hasText: /Due date.*Ambiguous/i })
			.waitFor();
		await pdf
			.locator("summary")
			.filter({ hasText: /Order reference.*No value found/i })
			.waitFor();
		const raw = await openDetails(pdf, /^Source text/);
		await raw.getByText(rawNote, { exact: false }).first().waitFor();
		assert.equal(await raw.locator("img, script").count(), 0);
		assert.equal(await page.evaluate(() => window.documentTestInjection), undefined);
		const image = await openFile(report, "b.PNG");
		const imageSource = await openDetails(image, /^Source text/);
		await imageSource.getByText("Local OCR", { exact: true }).first().waitFor();
		await imageSource
			.getByText(/Region in pixels/i)
			.first()
			.waitFor();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	});
	await check("explicit-save-and-process-restart-preserve-document-ids-evidence-and-failures", async () => {
		await dialogs([], [workspaceFile]);
		await page.getByRole("button", { name: "Save", exact: true }).press("Enter");
		await page.getByText("All changes saved", { exact: true }).waitFor();
		await application.close();
		({ application, page } = await launch());
		await dialogs([workspaceFile]);
		await page.getByRole("button", { name: "Open workspace", exact: true }).press("Enter");
		const report = await openDetails(documents(), /^\s*mixed/i);
		const broken = await openFile(report, "e-broken.pdf");
		await broken.getByText(/PDF engine could not open/i).waitFor();
		const pdf = await openFile(report, "a.PDF");
		await pdf
			.locator("summary")
			.filter({ hasText: /Invoice reference.*SYNTHETIC-PDF/ })
			.waitFor();
		const state = await command({ type: "get-state" });
		assert.equal(state.workspace?.dirty, false);
		assert.deepEqual(await records(), expected);
	});
	await check("repeated-folder-skips-successful-bytes-retries-failures-and-can-save-its-new-report", async () => {
		await dialogs([folder]);
		const state = await command({ type: "import-documents" });
		const summary = state.workspace?.documentImports.at(-1);
		assert.equal(summary?.imported, 0);
		assert.equal(summary?.skipped, 4);
		assert.equal(summary?.failed, 1);
		await command({ type: "save" });
		const clean = await command({ type: "get-state" });
		assert.equal(clean.workspace?.dirty, false);
		await dialogs([files[0]]);
		const bankSkip = await command({ type: "import-statement" });
		assert.equal(bankSkip.importOutcome?.status, "skipped");
		assert.equal(bankSkip.importOutcome?.importId, null);
		assert.equal(bankSkip.workspace?.dirty, false);
		await dialogs([null]);
		assert.equal((await command({ type: "import-documents" })).workspace?.dirty, false);
	});
	await check("cancelling-real-image-OCR-keeps-prior-completed-documents-and-can-be-saved", async () => {
		const cancellationFolder = path.join(root, "cancel");
		await mkdir(cancellationFolder);
		await writeFile(path.join(cancellationFolder, "a.pdf"), await pdfFixture("SYNTHETIC-CANCEL"));
		await writeFile(path.join(cancellationFolder, "b-long.png"), await imageFixture(page, "png", true));
		await dialogs([cancellationFolder]);
		await page.evaluate(() => {
			window.documentTestState = null;
			window.unsubscribeDocumentTest = window.receiptmatch.subscribe((state) => {
				window.documentTestState = state;
			});
		});
		await chooseFolder().press("Enter");
		await documents()
			.getByRole("status")
			.filter({ hasText: /Reading with local OCR.*b-long\.png/i })
			.waitFor();
		await documents().getByRole("button", { name: "Cancel analysis" }).press("Enter");
		await page.waitForFunction(() => window.documentTestState?.documentOutcome?.status === "cancelled", undefined, { polling: 50 });
		const state = await command({ type: "get-state" });
		await page.evaluate(() => {
			if (!window.unsubscribeDocumentTest) throw new Error("Document test subscription is missing");
			window.unsubscribeDocumentTest();
			delete window.unsubscribeDocumentTest;
			delete window.documentTestState;
		});
		assert.equal(state.documentOutcome?.status, "cancelled");
		assert.equal(state.workspace?.documentImports.at(-1)?.imported, 1, JSON.stringify((await records()).at(-1)));
		await command({ type: "save" });
		assert.equal((await command({ type: "get-state" })).workspace?.dirty, false);
	});
	console.log(JSON.stringify({ status: "passed", checks: completedChecks, platform: process.platform }));
});
