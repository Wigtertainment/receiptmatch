import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

test('shows the same current receipt total in Sources and Match suggestions', async ({ playwright }, testInfo) => {
	const root = testInfo.outputPath('document-workspace');
	await mkdir(root, { recursive: true });
	const file = path.join(root, 'test.receiptmatch');
	const bank = retainedBank(root);
	bank.result.transactions[0].accountAmount.value.coefficient = '-11890';
	const receipt = retainedDocument(root, 'Orchard-Workshop.pdf');
	const input = receipt.result.input!;
	const ocr = (text: string, x: number, y: number, width = 30) => ({ text, region: { x, y, width, height: 16 }, method: 'local-ocr' as const });
	input.pages[0].spans = [
		ocr('Receipt', 40, 40),
		ocr('2', 35, 104), ocr('Lunch', 75, 103, 75), ocr('29.50', 400, 105, 46),
		ocr('1', 35, 127), ocr('Drinks', 75, 126, 75), ocr('19.20', 402, 129, 44),
		ocr('1', 35, 150), ocr('Dessert', 75, 150, 75), ocr('59.50', 402, 151, 44),
		ocr('Total', 90, 187, 50), ocr('08.20', 371, 189, 75),
		ocr('Food 9% 4.50', 90, 216, 190), ocr('All Taxes are Included', 90, 259, 220),
	];
	receipt.result = interpretSupportingDocument(input);
	const section = receipt.result.sections[0];
	const total = section.amounts.find(field => field.role === 'billed-total')!;
	total.candidates = [{ coefficient: '820', currency: null, scale: 2 }];
	receipt.result.issues = [{ code: 'missing-currency', severity: 'warning', message: 'Missing currency', sectionId: section.sectionId,
		fieldId: total.id, field: total.role, evidence: total.evidence }];
	section.amounts = [total];
	await createWorkspace(file, newMetadata(), [bank], [documentRun(root, [receipt])], new Map([[bank.transactions[0].transactionId, receipt.id]]));

	const executablePath: unknown = (await import('electron')).default;
	if (typeof executablePath !== 'string') throw new Error('Electron is unavailable.');
	const app = await playwright._electron.launch({
		executablePath, args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')],
		env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true,
	});
	try {
		await app.evaluate(({ dialog, BrowserWindow }, workspace) => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		}, file);
		const page = await app.firstWindow();
		await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
		const sources = page.getByRole('region', { name: 'Supporting documents' });
		const sourceRow = sources.getByRole('row', { name: /Orchard-Workshop/ });
		await expect(sourceRow).toContainText(/108[.,]20/);
		const nav = page.getByRole('navigation', { name: 'Workspace views' });
		const matches = page.getByRole('region', { name: 'Manual review' });
		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(matches.getByText(/Document total.*108[.,]20/)).toBeVisible();
		await nav.getByRole('button', { name: 'Sources' }).click();

		await sourceRow.getByRole('button', { name: 'Show details for Orchard-Workshop.pdf' }).click();
		const drawer = page.getByRole('dialog', { name: 'Orchard-Workshop.pdf' });
		const summary = drawer.locator('summary').filter({ hasText: 'Billed total' });
		await expect(summary).toContainText(/108[.,]20/);
		await summary.click();
		await expect(drawer.getByText('Original values', { exact: true })).toBeVisible();
		await drawer.getByRole('button', { name: 'Correct value' }).click();
		const editor = drawer.getByRole('region', { name: 'Correct document field' });
		const decimal = await page.evaluate(() => new Intl.NumberFormat().formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.');
		await editor.getByLabel('Amount', { exact: true }).fill('118' + decimal + '90');
		await editor.getByRole('button', { name: 'Apply correction' }).click();
		await expect(summary).toContainText(/118[.,]90.*Corrected/);
		await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
		await expect(sourceRow).toContainText(/118[.,]90/);
		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(matches.getByText(/Document total.*118[.,]90/)).toBeVisible();
		const stale = await page.evaluate(async () => {
			const { workspace } = await window.receiptmatch.command({ type: 'get-state' });
			return window.receiptmatch.documentSnapshot({ loadRevision: workspace!.loadRevision, revision: workspace!.matchRevision - 1 });
		});
		expect(stale).toBeNull();
	} finally {
		await app.close();
	}
});
