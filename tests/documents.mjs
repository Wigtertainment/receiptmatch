import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { _electron as electron } from "playwright";

await mkdir("artifacts", { recursive: true });
const root = await mkdtemp(path.resolve("artifacts/document-import-"));
let application;
const checks = [];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function check(name, action) {
	await action();
	checks.push(name);
	console.log(`PASS ${name}`);
}
async function pdfFixture(reference) {
	const pdf = await PDFDocument.create(),
		font = await pdf.embedFont(StandardFonts.Helvetica),
		page = pdf.addPage([600, 800]);
	for (const [index, text] of ["Invoice", "Merchant: Cedar Workshop", `Invoice Number: ${reference}`, "Invoice Date: 2032-05-20", "Invoice Total: EUR 73.25"].entries()) {
		page.drawText(text, { x: 40, y: 740 - index * 30, size: 14, font });
	}
	return pdf.save();
}
async function launch() {
	application = await electron.launch({
		executablePath: path.resolve(process.platform === "win32" ? "release/win-unpacked/ReceiptMatch.exe" : "release/linux-unpacked/receiptmatch"),
		args: ["--hidden", "--disable-gpu", `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
		timeout: 30000,
	});
	const page = await application.firstWindow();
	await page.getByRole("heading", { name: "Your records. Your workspace." }).waitFor();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
	return page;
}
async function dialogs(opens = [], saves = [], choices = []) {
	await application.evaluate(
		({ dialog }, plan) => {
			dialog.showOpenDialog = async () => {
				const selected = plan.opens.shift();
				return { canceled: !selected, filePaths: selected ? [selected] : [] };
			};
			dialog.showSaveDialog = async () => {
				const selected = plan.saves.shift();
				return { canceled: !selected, filePath: selected };
			};
			dialog.showMessageBox = async () => ({ response: plan.choices.shift() ?? 2, checkboxChecked: false });
		},
		{ opens, saves, choices },
	);
}
async function imageFixture(page, format, long = false) {
	return Buffer.from(
		await page.evaluate(
			({ format, long }) => {
				const canvas = document.createElement("canvas");
				canvas.width = 1200;
				canvas.height = long ? 1800 : 450;
				const context = canvas.getContext("2d");
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
try {
	let page = await launch();
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
	const command = (value) => page.evaluate((value) => window.receiptmatch.command(value), value);
	const records = () => page.evaluate(() => window.receiptmatch.documentImports());
	await check("document-command-is-path-free-and-readonly-data-is-restricted-to-the-active-frame", async () => {
		assert.equal((await command({ type: "import-documents", path: folder })).workspace, null);
		const probes = await application.evaluate(async ({ app, BrowserWindow }) => {
			const { join } = process.getBuiltinModule("path"),
				active = BrowserWindow.getAllWindows()[0];
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
	let expected;
	const workspaceFile = path.join(root, "documents.receiptmatch");
	await check("native-folder-analysis-retains-real-PDF-PNG-JPEG-results-duplicates-and-file-failures", async () => {
		await command({ type: "new" });
		await dialogs([folder]);
		const state = await command({ type: "import-documents" });
		assert.equal(state.documentOutcome.status, "finished");
		assert.equal(state.workspace.dirty, true);
		assert.equal(state.workspace.documentImports[0].imported, 3);
		assert.equal(state.workspace.documentImports[0].skipped, 1);
		assert.equal(state.workspace.documentImports[0].failed, 1);
		assert.equal(state.workspace.documentImports[0].unsupported, 1);
		expected = await records();
		assert.equal(expected[0].files.length, 6);
		const imported = expected[0].files.filter((file) => file.status === "imported").map((file) => file.record);
		assert.deepEqual(new Set(imported.map((record) => record.format)), new Set(["pdf", "png", "jpeg"]));
		assert.ok(imported.every((record) => record.result.input.pages.flatMap((page) => page.spans).length));
		assert.equal(
			imported.find((record) => record.format === "pdf").result.sections[0].amounts.find((field) => field.role === "billed-total").candidates[0].coefficient,
			"7325",
		);
		assert.deepEqual(await Promise.all(files.map(async (file) => sha(await readFile(file)))), originalHashes);
	});
	await check("explicit-save-and-process-restart-preserve-document-ids-evidence-and-failures", async () => {
		await dialogs([], [workspaceFile]);
		assert.equal((await command({ type: "save" })).workspace.dirty, false);
		await application.close();
		application = undefined;
		page = await launch();
		await dialogs([workspaceFile]);
		const state = await command({ type: "open" });
		assert.equal(state.workspace.dirty, false);
		assert.deepEqual(await records(), expected);
	});
	await check("repeated-folder-skips-successful-bytes-retries-failures-and-can-save-its-new-report", async () => {
		await dialogs([folder]);
		const state = await command({ type: "import-documents" });
		const summary = state.workspace.documentImports.at(-1);
		assert.equal(summary.imported, 0);
		assert.equal(summary.skipped, 4);
		assert.equal(summary.failed, 1);
		await command({ type: "save" });
		const clean = await command({ type: "get-state" });
		assert.equal(clean.workspace.dirty, false);
		await dialogs([files[0]]);
		const bankSkip = await command({ type: "import-statement" });
		assert.equal(bankSkip.importOutcome.status, "skipped");
		assert.equal(bankSkip.importOutcome.importId, null);
		assert.equal(bankSkip.workspace.dirty, false);
		await dialogs([null]);
		assert.equal((await command({ type: "import-documents" })).workspace.dirty, false);
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
		const running = command({ type: "import-documents" });
		await page.waitForFunction(
			() => {
				const progress = window.documentTestState?.documentImport?.progress;
				return progress?.filePath?.endsWith("b-long.png") && progress.extraction?.phase === "ocr";
			},
			undefined,
			{
				polling: 50,
				timeout: 15000,
			},
		);
		await command({ type: "cancel-import" });
		const state = await running;
		await page.evaluate(() => {
			window.unsubscribeDocumentTest();
			delete window.unsubscribeDocumentTest;
			delete window.documentTestState;
		});
		assert.equal(state.documentOutcome.status, "cancelled");
		assert.equal(state.workspace.documentImports.at(-1).imported, 1, JSON.stringify((await records()).at(-1)));
		await command({ type: "save" });
		assert.equal((await command({ type: "get-state" })).workspace.dirty, false);
	});
	console.log(JSON.stringify({ status: "passed", checks: checks.length, platform: process.platform }));
} finally {
	if (application) {
		await dialogs([], [], [1]);
		await application.close();
	}
}
