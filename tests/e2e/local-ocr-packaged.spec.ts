import type { StoredDocumentImport, StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { ImportIssue, SourceEvidence } from "../../src/shared/bank-import.js";
import type { DocumentSection, SupportingDocument } from "../../src/shared/supporting-document.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type { LocalOcrModel } from "../../src/shared/pdf-extraction.js";
import type { LocalOcrStatus } from "../../src/shared/local-ocr-settings.js";
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type Page, type ElectronApplication, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs } from '@playwright/test';

test('packaged OCR runs with installed local models and switches to standard recognition', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	const profile: string | undefined = process.env.RECEIPTMATCH_OCR_TEST_PROFILE;
	test.skip(!profile, 'Requires a dedicated profile for model installation and offline verification.');
	assert.ok(profile && path.isAbsolute(profile));
	test.setTimeout(600_000);
	const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
	const application: ElectronApplication = await playwright._electron.launch({
		executablePath, args: ['--hidden', '--disable-gpu', `--user-data-dir=${profile}`], timeout: 30_000
	});
	try {
		const page: Page = await application.firstWindow();
		await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
		const images: string[] = await page.evaluate((): string[] => {
			const canvas: HTMLCanvasElement = document.createElement('canvas');
			canvas.width = 690;
			canvas.height = 560;
			const context: CanvasRenderingContext2D = canvas.getContext('2d')!;
			context.fillStyle = 'white';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = 'black';
			context.font = '30px monospace';
			['INVOICE', 'Cedar Workshop', 'Invoice Date: 2026-10-12', 'Subtotal EUR 40.75', 'Tax EUR 8.00', 'Grand Total EUR 48.75'].forEach((line: string, index: number): void => {
				context.fillText(line, 54, 62 + 62 * index);
			});
			// Give each engine a distinct source for the importer's duplicate detection.
			return [0, 1, 2].map((offset: number): string => {
				context.fillRect(offset, canvas.height - 1, 1, 1);
				return canvas.toDataURL('image/png').split(',')[1];
			});
		});
		const models: readonly ["pp-ocrv6-medium", "paddleocr-vl-1.6"] = ['pp-ocrv6-medium', 'paddleocr-vl-1.6'] as const;
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const initial: LocalOcrStatus = await page.evaluate((): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'status' }));
		assert.ok(initial.models.every((model: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; }): boolean => model.runtimeAvailable), 'Both runtimes must be shipped in the package.');
		if (process.env.RECEIPTMATCH_OCR_TEST_INSTALL === '1') {
			assert.equal(initial.selection, 'standard');
			assert.ok(initial.models.every((model: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; }): boolean => !model.installed), 'Install mode requires a fresh test profile.');
			await application.evaluate(({ dialog }: typeof Electron.CrossProcessExports): void => {
				dialog.showMessageBox = async (windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions): Promise<{ response: number; checkboxChecked: false; }> => {
					if ((options ?? (windowOrOptions as Electron.MessageBoxOptions)).title !== 'Download OCR model') {
						throw new Error('Unexpected model installation prompt.');
					}
					return Promise.resolve({ response: 0, checkboxChecked: false });
				};
			});
			for (const model of models) {
				const result: LocalOcrStatus = await page.evaluate((model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'install', model }), model);
				assert.equal(result.selection, model);
				assert.equal(result.models.find((entry: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; }): boolean => entry.model === model)?.installed, true);
			}
			return;
		}
		assert.ok(initial.models.every((model: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; }): boolean => model.installed), 'Install models with RECEIPTMATCH_OCR_TEST_INSTALL=1 first.');
		await application.evaluate((): void => {
			globalThis.fetch = async (): Promise<never> => {
				return Promise.reject(new Error('Network fetch is disabled in this offline test.'));
			};
		});
		await page.getByRole('button', { name: 'Back', exact: true }).click();
		await page.getByRole('button', { name: 'Create workspace' }).click();
		for (const [index, model] of ([...models, 'standard'] as const).entries()) {
			const selection: LocalOcrStatus = await page.evaluate((selection: "pp-ocrv6-medium" | "paddleocr-vl-1.6" | "standard"): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'select', selection }), model);
			assert.equal(selection.selection, model);
			const folder: string = path.join(profile, 'fixtures', model);
			await mkdir(folder, { recursive: true });
			const sample: string = path.join(folder, 'receipt.png');
			await writeFile(sample, Buffer.from(images[index], 'base64'));
			await application.evaluate(({ dialog }: typeof Electron.CrossProcessExports, folder: string): void => {
				dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[]; }> => Promise.resolve(({ canceled: false, filePaths: [folder] }));
			}, folder);
			await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'import-documents' }));
			await page.waitForFunction(async (): Promise<boolean> => !(await window.receiptmatch.command({ type: 'get-state' })).busy, undefined, { timeout: 150_000 });
			const imports: StoredDocumentImport[] = await page.evaluate((): Promise<StoredDocumentImport[]> => window.receiptmatch.documentImports());
			const record: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; } | undefined = imports.flatMap((run: StoredDocumentImport): ({ status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; })[] => run.files).find((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "pdf" | "jpeg" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): boolean => file.status === 'imported' && file.record.filePath === sample);
			assert.ok(record?.status === 'imported', JSON.stringify(imports.at(-1)?.files));
			assert.ok(record.record.result.input?.extraction.version.includes(model === 'standard' ? 'tesseract' : model));
			assert.ok(record.record.result.sections.some((section: DocumentSection): boolean => section.amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean | 0 => field.role === 'billed-total' &&
				field.evidence.length && field.candidates.some((amount: { coefficient: string; scale: number; currency: string | null; }): boolean => amount.currency === 'EUR' && amount.coefficient === '4875' && amount.scale === 2))));
		}
	} finally {
		await application.evaluate(({ dialog }: typeof Electron.CrossProcessExports): void => {
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: 1, checkboxChecked: false }));
		});
		await application.close();
	}
});
