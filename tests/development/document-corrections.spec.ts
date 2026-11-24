import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo, type PlaywrightTestArgs, type PlaywrightTestOptions,
	type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { BankImportInput, PositionedSpan } from '../../src/shared/bank-import.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

test('corrects merchant, reference and currency values and supplies missing fields in both views', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
	test.setTimeout(180_000);
	const root: string = testInfo.outputPath('corrections-workspace');
	await mkdir(root, { recursive: true });
	const file: string = path.join(root, 'corrections.receiptmatch');

	function document(name: string, lines: string[]): StoredSupportingDocument {
		const record: StoredSupportingDocument = retainedDocument(root, name);
		const input: BankImportInput = record.result.input!;
		input.pages[0].spans = lines.map((text: string, index: number): PositionedSpan => ({
			text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text',
		}));
		record.result = interpretSupportingDocument(input);
		return record;
	}

	const existing: StoredSupportingDocument = document('existing.pdf', ['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: OLD-REF',
		'Invoice Date: 2032-02-28', 'Currency: GBP', 'Invoice Total: EUR 1234.56']);
	const missing: StoredSupportingDocument = document('missing.pdf', ['Invoice', 'Invoice Date: 2032-02-28', 'Total: $8.00']);
	await createWorkspace(file, newMetadata(), [retainedBank(root)], [documentRun(root, [existing, missing])]);
	const executablePath: unknown = (await import('electron')).default;
	if (typeof executablePath !== 'string') {
		throw new Error('Electron is unavailable.');
	}
	let app: ElectronApplication | undefined;
	let page!: Page;

	async function launch(): Promise<void> {
		app = await playwright._electron.launch({ executablePath: executablePath as string,
			args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')], env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true });
		await app.evaluate(({ dialog, BrowserWindow }: typeof Electron.CrossProcessExports, file: string): void => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[] }> => Promise.resolve({ canceled: false, filePaths: [file] });
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false }> => Promise.resolve({ response: 1, checkboxChecked: false });
		}, file);
		page = await app.firstWindow();
		await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
	}

	async function openDocument(name: string): Promise<Locator> {
		await page.getByRole('region', { name: 'Supporting documents' }).getByRole('button', { name: 'Show details for ' + name, exact: true }).click();
		const drawer: Locator = page.getByRole('dialog', { name, exact: true });
		await expect(drawer).toBeVisible();
		return drawer;
	}

	async function openField(scope: Locator, role: string): Promise<Locator> {
		const field: Locator = scope.locator('.document-field').filter({ has: page.getByText(role, { exact: true }) });
		if (await field.getAttribute('open') === null) {
			await field.locator(':scope > summary').press('Enter');
		}
		await expect(field.locator('.field-body')).toBeVisible();
		return field;
	}

	async function correctField(scope: Locator, role: string, value: string): Promise<Locator> {
		const field: Locator = await openField(scope, role);
		await field.getByRole('button', { name: 'Correct value', exact: true }).click();
		const editor: Locator = field.getByRole('region', { name: 'Correct document field' });
		await editor.getByLabel(role, { exact: true }).fill(value);
		await editor.getByRole('button', { name: 'Apply correction', exact: true }).click();
		await expect(field.locator('.field-value')).toHaveText(role === 'Settlement currency' ? value.toUpperCase() : value);
		await expect(editor.getByText('Correction applied to this workspace.', { exact: true })).toBeVisible();
		await editor.getByRole('button', { name: 'Close', exact: true }).click();
		return field;
	}

	async function supplyField(scope: Locator, role: string, value: string): Promise<void> {
		await scope.getByRole('button', { name: 'Add ' + role.toLowerCase(), exact: true }).click();
		const editor: Locator = scope.getByRole('region', { name: 'Correct document field' });
		await editor.getByLabel(role, { exact: true }).fill(value);
		await editor.getByRole('button', { name: 'Apply correction', exact: true }).click();
		await expect(editor.getByText('Correction applied to this workspace.', { exact: true })).toBeVisible();
		await editor.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(scope.getByRole('button', { name: 'Edit ' + role.toLowerCase(), exact: true })).toBeVisible();
	}

	try {
		await launch();
		let drawer: Locator = await openDocument('existing.pdf');
		const merchant: Locator = await openField(drawer, 'Merchant');
		await expect(merchant.getByRole('button', { name: 'Confirm value', exact: true })).toBeEnabled();
		await merchant.getByRole('button', { name: 'Confirm value', exact: true }).press('Enter');
		await expect(merchant.locator('.source-status')).toHaveText('Confirmed by you');
		await merchant.getByRole('button', { name: 'Correct value', exact: true }).click();
		const invalidEditor: Locator = merchant.getByRole('region', { name: 'Correct document field' });
		await invalidEditor.getByLabel('Merchant', { exact: true }).fill('   ');
		await invalidEditor.getByRole('button', { name: 'Apply correction', exact: true }).click();
		await expect(invalidEditor.getByRole('alert')).toContainText('Enter a value');
		await expect(merchant.locator('.field-value')).toHaveText('Orchard Workshop');
		await invalidEditor.getByRole('button', { name: 'Close', exact: true }).click();
		await correctField(drawer, 'Merchant', 'Cedar Workshop');
		await expect(merchant.locator('.source-status')).toHaveText('Corrected');
		await expect(merchant.locator('.field-original')).toContainText('Merchant: Orchard Workshop');
		await correctField(drawer, 'Invoice reference', 'SYNTHETIC-A');
		await correctField(drawer, 'Settlement currency', 'eur');
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
		await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Match suggestions', exact: true }).click();
		const manual: Locator = page.getByRole('region', { name: 'Manual review' });
		await manual.getByRole('combobox', { name: 'Supporting document', exact: true }).click();
		await page.getByRole('option', { name: /^existing\.pdf/ }).click();
		await manual.getByRole('button', { name: 'Document details for existing.pdf', exact: true }).press('Enter');
		await correctField(manual, 'Merchant', 'Orchard Workshop');
		const reference: Locator = await openField(manual, 'Invoice reference');
		await expect(reference.locator('.field-value')).toHaveText('SYNTHETIC-A');
		await expect(reference.locator('.field-original')).toContainText('OLD-REF');
		await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Sources', exact: true }).click();
		drawer = await openDocument('missing.pdf');
		await supplyField(drawer, 'Merchant', 'Harbor Services');
		await supplyField(drawer, 'Invoice reference', 'MISSING-001');
		await supplyField(drawer, 'Settlement currency', 'USD');
		const total: Locator = await openField(drawer, 'Billed total');
		await expect(total.locator('.field-value')).toContainText('USD');
		await expect(total.locator('.field-warning')).toHaveCount(0);
		await expect(total.locator('.field-original')).toContainText('currency unknown');
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await app!.close();
		app = undefined;
		await launch();
		drawer = await openDocument('missing.pdf');
		await expect(drawer.locator('.document-missing-field')).toContainText(['Harbor Services', 'MISSING-001', 'USD']);
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).click();
		drawer = await openDocument('existing.pdf');
		const restoredMerchant: Locator = await openField(drawer, 'Merchant');
		await expect(restoredMerchant.locator('.field-value')).toHaveText('Orchard Workshop');
		const restoredReference: Locator = await openField(drawer, 'Invoice reference');
		await expect(restoredReference.locator('.field-value')).toHaveText('SYNTHETIC-A');
		await expect(restoredReference.locator('.field-original')).toContainText('OLD-REF');
	} finally {
		await app?.close();
	}
});
