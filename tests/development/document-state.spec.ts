import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { BankImportInput, SourceEvidence } from "../../src/shared/bank-import.js";
import type { DocumentSection } from "../../src/shared/supporting-document.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import type { DocumentSnapshot } from "../../src/shared/protocol.js";
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page, type ElectronApplication, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs } from '@playwright/test';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

test('shows the same current receipt total in Sources and Match suggestions', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
	const root: string = testInfo.outputPath('document-workspace');
	await mkdir(root, { recursive: true });
	const file: string = path.join(root, 'test.receiptmatch');
	const bank: StoredBankImport = retainedBank(root);
	bank.result.transactions[0].accountAmount.value.coefficient = '-11890';
	const receipt: StoredSupportingDocument = retainedDocument(root, 'Orchard-Workshop.pdf');
	const input: BankImportInput = receipt.result.input!;
	const ocr: (text: string, x: number, y: number, width?: number) => { text: string; region: { x: number; y: number; width: number; height: number; }; method: "local-ocr"; } = (text: string, x: number, y: number, width: number = 30): { text: string; region: { x: number; y: number; width: number; height: number; }; method: "local-ocr"; } => ({ text, region: { x, y, width, height: 16 }, method: 'local-ocr' as const });
	input.pages[0].spans = [
		ocr('Receipt', 40, 40),
		ocr('2', 35, 104), ocr('Lunch', 75, 103, 75), ocr('29.50', 400, 105, 46),
		ocr('1', 35, 127), ocr('Drinks', 75, 126, 75), ocr('19.20', 402, 129, 44),
		ocr('1', 35, 150), ocr('Dessert', 75, 150, 75), ocr('59.50', 402, 151, 44),
		ocr('Total', 90, 187, 50), ocr('08.20', 371, 189, 75),
		ocr('Food 9% 4.50', 90, 216, 190), ocr('All Taxes are Included', 90, 259, 220),
	];
	receipt.result = interpretSupportingDocument(input);
	const section: DocumentSection = receipt.result.sections[0];
	const total: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; } = section.amounts.find((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.role === 'billed-total')!;
	total.candidates = [{ coefficient: '820', currency: null, scale: 2 }];
	receipt.result.issues = [{ code: 'missing-currency', severity: 'warning', message: 'Missing currency', sectionId: section.sectionId,
		fieldId: total.id, field: total.role, evidence: total.evidence }];
	section.amounts = [total];
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt])], new Map([[bank.transactions[0].transactionId, receipt.id]]));

	const executablePath: unknown = (await import('electron')).default;
	if (typeof executablePath !== 'string') {
		throw new Error('Electron is unavailable.');
	}
	const app: ElectronApplication = await playwright._electron.launch({
		executablePath, args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')],
		env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true,
	});
	try {
		await app.evaluate(({ dialog, BrowserWindow }: typeof Electron.CrossProcessExports, workspace: string): void => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[]; }> => Promise.resolve(({ canceled: false, filePaths: [workspace] }));
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: 1, checkboxChecked: false }));
		}, file);
		const page: Page = await app.firstWindow();
		await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
		const sources: Locator = page.getByRole('region', { name: 'Supporting documents' });
		const sourceRow: Locator = sources.getByRole('row', { name: /Orchard-Workshop/ });
		await expect(sourceRow).toContainText(/108[.,]20/);
		const nav: Locator = page.getByRole('navigation', { name: 'Workspace views' });
		const matches: Locator = page.getByRole('region', { name: 'Manual review' });
		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(matches.getByText(/Document total.*108[.,]20/)).toBeVisible();
		await nav.getByRole('button', { name: 'Sources' }).click();

		await sourceRow.getByRole('button', { name: 'Show details for Orchard-Workshop.pdf' }).click();
		const drawer: Locator = page.getByRole('dialog', { name: 'Orchard-Workshop.pdf' });
		const summary: Locator = drawer.locator('summary').filter({ hasText: 'Billed total' });
		await expect(summary).toContainText(/108[.,]20/);
		await summary.click();
		await expect(drawer.getByText('Original values', { exact: true })).toBeVisible();
		await drawer.getByRole('button', { name: 'Correct value' }).click();
		const editor: Locator = drawer.getByRole('region', { name: 'Correct document field' });
		const decimal: string = await page.evaluate((): string => new Intl.NumberFormat().formatToParts(1.1).find((part: Intl.NumberFormatPart): boolean => part.type === 'decimal')?.value ?? '.');
		await editor.getByLabel('Amount', { exact: true }).fill('118' + decimal + '90');
		await editor.getByRole('button', { name: 'Apply correction' }).click();
		await expect(summary).toContainText(/118[.,]90.*Corrected/);
		await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
		await expect(sourceRow).toContainText(/118[.,]90/);
		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(matches.getByText(/Document total.*118[.,]90/)).toBeVisible();
		const stale: DocumentSnapshot | null = await page.evaluate(async (): Promise<DocumentSnapshot | null> => {
			const { workspace }: WorkspaceState = await window.receiptmatch.command({ type: 'get-state' });
			return window.receiptmatch.documentSnapshot({ loadRevision: workspace!.loadRevision, revision: workspace!.matchRevision - 1 });
		});
		expect(stale).toBeNull();
	} finally {
		await app.close();
	}
});
