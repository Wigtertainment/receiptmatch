import type { MatchApprovalSelection } from "../../src/shared/match-approvals.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { ImportIssue, ImportPage, PositionedSpan, SourceEvidence } from "../../src/shared/bank-import.js";
import type { SupportingDocument } from "../../src/shared/supporting-document.js";
import type { DocumentImportSummary } from "../../src/shared/protocol.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFPage, type PDFFont } from "pdf-lib";
import { expect, test as base, type ElectronApplication, type Locator, type Page, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs, type TestType } from "@playwright/test";
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
	launch: () => Promise<{ application: ElectronApplication; page: Page }>;
}

const rawNote: "<img src=x onerror=\"window.documentTestInjection=1\">" = '<img src=x onerror="window.documentTestInjection=1">';

async function pdfFixture(reference: string): Promise<Uint8Array<ArrayBufferLike>> {
	const pdf: PDFDocument = await PDFDocument.create(),
		font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica),
		page: PDFPage = pdf.addPage([600, 800]);
	const lines: string[] = [
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

async function mockDialogs(application: ElectronApplication, opens: (string | null)[] = [], saves: string[] = [], choices: number[] = []): Promise<void> {
	await application.evaluate(
		({ dialog }: typeof Electron.CrossProcessExports, plan: { opens: (string | null)[]; saves: string[]; choices: number[]; }): void => {
			dialog.showOpenDialog = async (_window: BrowserWindow | OpenDialogOptions, options?: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[]; }> => {
				(globalThis as DocumentTestMainGlobals).documentTestDialogProperties = options?.properties;
				const selected: string | null | undefined = plan.opens.shift();
				return Promise.resolve({ canceled: !selected, filePaths: selected ? [selected] : [] });
			};
			dialog.showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string; }> => {
				const selected: string | undefined = plan.saves.shift();
				return Promise.resolve({ canceled: !selected, filePath: selected ?? "" });
			};
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: plan.choices.shift() ?? 2, checkboxChecked: false }));
		},
		{ opens, saves, choices },
	);
}

async function imageFixture(page: Page, format: "png" | "jpeg", long: boolean = false): Promise<Buffer<ArrayBuffer>> {
	return Buffer.from(
		await page.evaluate(
			({ format, long }: { format: "png" | "jpeg"; long: boolean; }): string => {
				const canvas: HTMLCanvasElement = document.createElement("canvas");
				canvas.width = 1200;
				canvas.height = long ? 1800 : 450;
				const context: CanvasRenderingContext2D | null = canvas.getContext("2d");
				if (!context) {
					throw new Error("Unable to create the synthetic document image");
				}
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
				].entries()) {
						context.fillText(text, 40, 60 + index * 60);
					}
				if (long) {
					for (let index: number = 0; index < 28; index++) {
						context.fillText(`SYNTHETIC DESCRIPTION LINE ${index + 1}`, 40, 390 + index * 45);
					}
				}
				return canvas.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.95).split(",")[1];
			},
			{ format, long },
		),
		"base64",
	);
}

const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & { documentImport: DocumentImportFixture; }, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<{ documentImport: DocumentImportFixture }>({
	documentImport: async ({ playwright }: { documentImport: DocumentImportFixture; } & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, use: (r: DocumentImportFixture) => Promise<void>): Promise<void> => {
		await mkdir("artifacts", { recursive: true });
		const root: string = await mkdtemp(path.resolve("artifacts/document-import-"));
		let activeApplication: ElectronApplication | undefined;

		async function launch(): Promise<{ application: ElectronApplication; page: Page; }> {
			const application: ElectronApplication = await playwright._electron.launch({
				executablePath: path.resolve(process.platform === "win32" ? "release/win-unpacked/ReceiptMatch.exe" : "release/linux-unpacked/receiptmatch"),
				args: ["--hidden", "--disable-gpu", `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
				timeout: 30_000
			});
			activeApplication = application;
			application.on("close", (): void => {
				if (activeApplication === application) {
					activeApplication = undefined;
				}
			});
			const page: Page = await application.firstWindow({ timeout: 30_000 });
			page.setDefaultTimeout(20_000);
			await page.getByRole("heading", { name: "ReceiptMatch", exact: true }).waitFor();
			await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
			return { application, page };
		}

		await use({ root, launch });

		const application: ElectronApplication | undefined = activeApplication;
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

test("packaged supporting document import", async ({ documentImport: { root, launch } }: PlaywrightTestArgs & PlaywrightTestOptions & { documentImport: DocumentImportFixture; } & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	let { application, page }: { application: ElectronApplication; page: Page; } = await launch();
	let completedChecks: number = 0;
	const sha: (bytes: Buffer) => string = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

	async function check(name: string, action: () => Promise<void>): Promise<void> {
		await test.step(name, action);
		completedChecks++;
	}

	function dialogs(opens: (string | null)[] = [], saves: string[] = [], choices: number[] = []): Promise<void> {
		return mockDialogs(application, opens, saves, choices);
	}

	const folder: string = path.join(root, "mixed"),
		nested: string = path.join(folder, "nested");
	await mkdir(nested, { recursive: true });
	const files: string[] = [
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
	const originalHashes: string[] = await Promise.all(files.map(async (file: string): Promise<string> => sha(await readFile(file))));
	const command: (value: WorkspaceCommand) => Promise<WorkspaceState> = (value: WorkspaceCommand): Promise<WorkspaceState> => page.evaluate((value: { type: "get-state"; } | { type: "new"; } | { type: "open"; } | { type: "save"; } | { type: "import-statement"; } | { type: "import-documents"; } | { type: "cancel-import"; } | { type: "rename"; name: string; } | { type: "set-transaction-ignored"; revision: number; transactionId: string; ignored: boolean; remember?: true | undefined; } | { type: "review-match"; revision: number; transactionId: string; review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; }; } | { type: "set-duplicate-decision"; revision: number; transactionId: string; otherTransactionId: string; decision: "separate" | "keep-first" | "keep-second" | "clear"; } | { type: "correct-bank-row"; revision: number; rowId: string; changes: { bookingDate?: string | undefined; accountAmount?: { coefficient: string; currency: string; scale: number; } | undefined; }; } | { change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; fieldId: string | null; type: "correct-document-field"; revision: number; } | { type: "approve-matches"; loadRevision: number; selections: MatchApprovalSelection[]; }): Promise<WorkspaceState> => window.receiptmatch.command(value), value);

	const records: () => Promise<StoredDocumentImport[]> = (): Promise<StoredDocumentImport[]> => page.evaluate((): Promise<StoredDocumentImport[]> => window.receiptmatch.documentImports());

	const documents: () => Locator = (): Locator => page.getByRole("region", { name: "Supporting documents" });

	const chooseFolder: () => Locator = (): Locator => documents().getByRole("button", { name: "Choose folder" });

	async function openDetails(scope: Locator, label: string | RegExp): Promise<Locator> {
		const summary: Locator = scope.locator("summary").filter({ hasText: label });
		const details: Locator = summary.locator("..");
		if ((await details.getAttribute("open")) === null) {
			await summary.press("Enter");
		}
		assert.notEqual(await details.getAttribute("open"), null);
		return details;
	}

	async function openFile(report: Locator, name: string): Promise<Locator> {
		await report.getByRole("button", { name: "Show details for " + name, exact: true }).click();
		const details: Locator = page.getByRole("dialog", { name, exact: true });
		await expect(details).toBeVisible();
		return details;
	}

	async function closeFile(details: Locator): Promise<void> {
		await details.getByRole("button", { name: "Close document details", exact: true }).click();
		await expect(details).toBeHidden();
	}
	await check("document-command-is-path-free-and-readonly-data-is-restricted-to-the-active-frame", async (): Promise<void> => {
		assert.equal((await command({ type: "import-documents", path: folder } as unknown as WorkspaceCommand)).workspace, null);
		const probes: unknown = await application.evaluate(async ({ app, BrowserWindow }: typeof Electron.CrossProcessExports): Promise<unknown> => {
			const { join }: typeof path = process.getBuiltinModule("path");
			const active: Electron.BrowserWindow = BrowserWindow.getAllWindows()[0];
			const extra: BrowserWindow = new BrowserWindow({
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
	const workspaceFile: string = path.join(root, "documents.receiptmatch");
	await check("native-folder-analysis-retains-real-PDF-PNG-JPEG-results-duplicates-and-file-failures", async (): Promise<void> => {
		await page.getByRole("button", { name: "Create workspace" }).click();
		await dialogs([folder]);
		await chooseFolder().press("Enter");
		await documents().getByRole("button", { name: /^mixed ·/ }).waitFor();
		await documents().getByRole("table", { name: "Files in mixed", exact: true }).waitFor();
		assert.deepEqual(await application.evaluate((): ("openDirectory" | "openFile" | "multiSelections" | "showHiddenFiles" | "createDirectory" | "promptToCreate" | "noResolveAliases" | "treatPackageAsDirectory" | "dontAddToRecent")[] | undefined => (globalThis as DocumentTestMainGlobals).documentTestDialogProperties), ["openDirectory"]);
		const state: WorkspaceState = await command({ type: "get-state" });
		assert.equal(state.documentOutcome?.status, "finished");
		assert.equal(state.workspace?.dirty, true);
		const summary: DocumentImportSummary = state.workspace?.documentImports[0];
		assert.equal(summary?.imported, 3);
		assert.equal(summary?.skipped, 1);
		assert.equal(summary?.failed, 1);
		assert.equal(summary?.unsupported, 1);
		expected = await records();
		assert.equal(expected[0].files.length, 6);
		const imported: StoredSupportingDocument[] = expected[0].files.filter((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "imported"; record: StoredSupportingDocument; } => file.status === "imported").map((file: { status: "imported"; record: StoredSupportingDocument; }): StoredSupportingDocument => file.record);
		assert.deepEqual(new Set(imported.map((record: StoredSupportingDocument): "png" | "pdf" | "jpeg" => record.format)), new Set(["pdf", "png", "jpeg"]));
		assert.ok(imported.every((record: StoredSupportingDocument): number | undefined => record.result.input?.pages.flatMap((page: ImportPage): PositionedSpan[] => page.spans).length));
		const pdf: StoredSupportingDocument | undefined = imported.find((record: StoredSupportingDocument): boolean => record.format === "pdf");
		const billedTotal: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } | undefined = pdf?.result.sections[0]?.amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === "billed-total");
		assert.equal(billedTotal?.candidates[0]?.coefficient, "7325");
		assert.deepEqual(await Promise.all(files.map(async (file: string): Promise<string> => sha(await readFile(file)))), originalHashes);
	});
	await check("document-results-show-file-statuses-candidates-and-literal-source-text-with-keyboard-access", async (): Promise<void> => {
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].setContentSize(680, 860));
		await page.waitForFunction((): boolean => window.innerWidth <= 700, undefined, { polling: 50 });
		const report: Locator = documents().locator("wig-accordion.report-details");
		await expect(report.getByRole("button", { name: /^mixed ·/ })).toHaveAttribute("aria-expanded", "true");
		for (const [file, status] of [
			["a.PDF", "Imported"],
			["b.PNG", "Imported"],
			["c.jpeg", "Imported"],
			["d-copy.pdf", "Skipped"],
			["e-broken.pdf", "Failed"],
			["notes.txt", "Unsupported"],
		]) {
			const row: Locator = report.getByRole("row").filter({ has: page.getByRole("cell", { name: file, exact: true }) });
			await row.getByText(status, { exact: false }).waitFor();
		}
		const pdfRow: Locator = report.getByRole("row").filter({ has: page.getByRole("cell", { name: "a.PDF", exact: true }) });
		await pdfRow.getByText(/EUR\s*73[.,]25|73[.,]25\s*EUR/).waitFor();
		const failedRow: Locator = report.getByRole("row").filter({ has: page.getByRole("cell", { name: "e-broken.pdf", exact: true }) });
		await failedRow.getByText("No single billed total", { exact: true }).waitFor();
		const pdf: Locator = await openFile(report, "a.PDF");
		await pdf.getByRole("heading", { name: "Extracted fields" }).waitFor();
		const total: Locator = await openDetails(pdf, /Billed total/i);
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
		const raw: Locator = await openDetails(pdf, /^Source text/);
		await raw.getByText(rawNote, { exact: false }).first().waitFor();
		assert.equal(await raw.locator("img, script").count(), 0);
		assert.equal(await page.evaluate((): number | undefined => window.documentTestInjection), undefined);
		await closeFile(pdf);
		const image: Locator = await openFile(report, "b.PNG");
		const imageSource: Locator = await openDetails(image, /^Source text/);
		await imageSource.getByText("Local OCR", { exact: true }).first().waitFor();
		await imageSource
			.getByText(/Region in pixels/i)
			.first()
			.waitFor();
		assert.equal(await page.evaluate((): boolean => document.documentElement.scrollWidth <= window.innerWidth), true);
		await closeFile(image);
	});
	await check("explicit-save-and-process-restart-preserve-document-ids-evidence-and-failures", async (): Promise<void> => {
		await dialogs([], [workspaceFile]);
		await page.getByRole("button", { name: "Save", exact: true }).press("Enter");
		await page.getByText("All changes saved", { exact: true }).waitFor();
		await application.close();
		({ application, page } = await launch());
		await dialogs([workspaceFile]);
		await page.getByRole("button", { name: "Open workspace", exact: true }).press("Enter");
		const report: Locator = documents().locator("wig-accordion.report-details");
		const summary: Locator = report.getByRole("button", { name: /^mixed ·/ });
		await expect(summary).toHaveAttribute("aria-expanded", "true");
		const pdfButton: Locator = report.getByRole("button", { name: "Show details for a.PDF", exact: true });
		await expect(report.locator("wig-table")).toHaveCount(1);
		await expect(report.getByRole("button", { name: "a.PDF", exact: true })).toHaveCount(0);
		await pdfButton.press("Enter");
		const drawer: Locator = page.getByRole("dialog", { name: "a.PDF", exact: true });
		await expect(drawer).toBeVisible();
		const edge: { right: number; viewport: number; } = await drawer.evaluate((element: HTMLElement | SVGElement): { right: number; viewport: number; } => ({ right: element.getBoundingClientRect().right, viewport: document.documentElement.clientWidth }));
		assert.ok(Math.abs(edge.right - edge.viewport) < 2, JSON.stringify(edge));
		await page.keyboard.press("Escape");
		await expect(drawer).toBeHidden();
		await expect(pdfButton).toBeFocused();
		await summary.press("Enter");
		await expect(summary).toHaveAttribute("aria-expanded", "false");
		await expect(report.locator("table")).toBeHidden();
		await summary.press("Enter");
		await expect(summary).toHaveAttribute("aria-expanded", "true");
		await expect(drawer).toBeHidden();
		const broken: Locator = await openFile(report, "e-broken.pdf");
		await broken.getByText(/PDF engine could not open/i).waitFor();
		await closeFile(broken);
		const pdf: Locator = await openFile(report, "a.PDF");
		await pdf
			.locator("summary")
			.filter({ hasText: /Invoice reference.*SYNTHETIC-PDF/ })
			.waitFor();
		await closeFile(pdf);
		const state: WorkspaceState = await command({ type: "get-state" });
		assert.equal(state.workspace?.dirty, false);
		assert.deepEqual(await records(), expected);
	});
	await check("sources-share-the-width-on-wide-windows-and-stack-on-narrow-windows", async (): Promise<void> => {
		const columns: () => Promise<string[]> = (): Promise<string[]> => page.locator(".workspace-imports").evaluate((element: HTMLElement | SVGElement): string[] => getComputedStyle(element).gridTemplateColumns.split(" "));
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].setContentSize(1440, 860));
		await expect.poll(async (): Promise<number> => (await columns()).length).toBe(2);
		const [statements, supporting]: string[] = await columns();
		assert.ok(Math.abs(parseFloat(statements) - parseFloat(supporting)) < 1);
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].setContentSize(680, 860));
		await expect.poll(async (): Promise<number> => (await columns()).length).toBe(1);
	});
	await check("repeated-folder-skips-successful-bytes-retries-failures-and-can-save-its-new-report", async (): Promise<void> => {
		const originalReport: Locator = documents().getByRole("button", { name: /^mixed · Finished · 3 imported/ });
		await originalReport.press("Enter");
		await expect(originalReport).toHaveAttribute("aria-expanded", "false");
		await dialogs([folder]);
		const state: WorkspaceState = await command({ type: "import-documents" });
		const summary: DocumentImportSummary | undefined = state.workspace?.documentImports.at(-1);
		assert.equal(summary?.imported, 0);
		assert.equal(summary?.skipped, 4);
		assert.equal(summary?.failed, 1);
		await expect(documents().getByRole("button", { name: /^mixed · Finished · 0 imported/ })).toHaveAttribute("aria-expanded", "true");
		await expect(originalReport).toHaveAttribute("aria-expanded", "false");
		await command({ type: "save" });
		const clean: WorkspaceState = await command({ type: "get-state" });
		assert.equal(clean.workspace?.dirty, false);
		await dialogs([files[0]]);
		const bankSkip: WorkspaceState = await command({ type: "import-statement" });
		assert.equal(bankSkip.importOutcome?.status, "skipped");
		assert.equal(bankSkip.importOutcome?.importId, null);
		assert.equal(bankSkip.workspace?.dirty, false);
		await dialogs([null]);
		assert.equal((await command({ type: "import-documents" })).workspace?.dirty, false);
	});
	await check("cancelling-real-image-OCR-keeps-prior-completed-documents-and-can-be-saved", async (): Promise<void> => {
		const cancellationFolder: string = path.join(root, "cancel");
		await mkdir(cancellationFolder);
		await writeFile(path.join(cancellationFolder, "a.pdf"), await pdfFixture("SYNTHETIC-CANCEL"));
		await writeFile(path.join(cancellationFolder, "b-long.png"), await imageFixture(page, "png", true));
		await dialogs([cancellationFolder]);
		await page.evaluate((): void => {
			window.documentTestState = null;
			window.unsubscribeDocumentTest = window.receiptmatch.subscribe((state: WorkspaceState): void => {
				window.documentTestState = state;
			});
		});
		await chooseFolder().press("Enter");
		await documents()
			.getByRole("status")
			.filter({ hasText: /Reading with local OCR.*b-long\.png/i })
			.waitFor();
		await documents().getByRole("button", { name: "Cancel analysis" }).press("Enter");
		await page.waitForFunction((): boolean => window.documentTestState?.documentOutcome?.status === "cancelled", undefined, { polling: 50 });
		const state: WorkspaceState = await command({ type: "get-state" });
		await page.evaluate((): void => {
			if (!window.unsubscribeDocumentTest) {
				throw new Error("Document test subscription is missing");
			}
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
