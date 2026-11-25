import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo, type PlaywrightTestArgs, type PlaywrightTestOptions,
	type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test';
import { interpretSupportingDocument } from '../../electron/documents/interpret.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import type { BankImportInput, PositionedSpan } from '../../src/shared/bank-import.js';
import type { DocumentSection } from '../../src/shared/supporting-document.js';
import type { StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

test('confirms document fields in both views, preserves evidence and persists withdrawal', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
	test.setTimeout(120_000);
	const root: string = testInfo.outputPath('confirmation-workspace');
	await mkdir(root, { recursive: true });
	const workspaceFile: string = path.join(root, 'review.receiptmatch');
	const receipt: StoredSupportingDocument = retainedDocument(root, 'review.pdf');
	const lines: string[] = ['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-02-28',
		'Invoice Total: EUR 73.25', 'Tax: $1.00', 'Due Date: 05/06/2032', 'Order Number:'];
	const pdf: PDFDocument = await PDFDocument.create();
	const font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);
	const pdfPage: PDFPage = pdf.addPage([600, 800]);
	for (const [index, line] of lines.entries()) {
		pdfPage.drawText(line, { x: 30, y: 760 - index * 25, size: 12, font });
	}
	const bytes: Uint8Array = await pdf.save();
	await writeFile(receipt.filePath, bytes);
	const input: BankImportInput = receipt.result.input!;
	input.source.sha256 = createHash('sha256').update(bytes).digest('hex');
	input.pages[0].spans = lines.map((text: string, index: number): PositionedSpan => ({
		text, region: { x: 30, y: 30 + index * 25, width: 540, height: 12 }, method: 'embedded-text',
	}));
	receipt.result = interpretSupportingDocument(input);
	const section: DocumentSection = receipt.result.sections[0];
	const merchant: DocumentSection['merchants'][number] = section.merchants[0];
	receipt.result.issues.push({ code: 'unconfirmed-merchant', severity: 'warning', message: 'Review the supplier name against the original document.',
		sectionId: section.sectionId, fieldId: merchant.id, field: 'merchant', evidence: merchant.evidence });
	await createWorkspace(workspaceFile, newMetadata(), [retainedBank(root)], [documentRun(root, [receipt])]);
	const executablePath: unknown = (await import('electron')).default;
	if (typeof executablePath !== 'string') {
		throw new Error('Electron is unavailable.');
	}
	let app: ElectronApplication | undefined;
	let page!: Page;

	async function launch(): Promise<void> {
		app = await playwright._electron.launch({ executablePath: executablePath as string,
			args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')],
			env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true });
		await app.evaluate(({ dialog, BrowserWindow }: typeof Electron.CrossProcessExports, file: string): void => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async (): Promise<Electron.OpenDialogReturnValue> => Promise.resolve({ canceled: false, filePaths: [file] });
			dialog.showMessageBox = async (): Promise<Electron.MessageBoxReturnValue> => Promise.resolve({ response: 1, checkboxChecked: false });
		}, workspaceFile);
		page = await app.firstWindow();
		await page.getByRole('button', { name: 'Open workspace', exact: true }).press('Enter');
	}

	async function openDocument(): Promise<Locator> {
		const open: Locator = page.getByRole('region', { name: 'Supporting documents' }).getByRole('button', { name: 'Show details for review.pdf', exact: true });
		await expect(open).toBeEnabled();
		await open.click();
		const drawer: Locator = page.getByRole('dialog', { name: 'review.pdf', exact: true });
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

	try {
		await launch();
		let drawer: Locator = await openDocument();
		let merchantField: Locator = await openField(drawer, 'Merchant');
		await expect(merchantField.locator('.field-warning')).toHaveText('Review needed');
		await merchantField.getByRole('button', { name: 'Confirm value', exact: true }).press('Enter');
		await expect(merchantField.locator('.source-status')).toHaveText('Confirmed by you');
		await expect(merchantField.locator('.field-warning')).toHaveCount(0);
		await expect(merchantField.getByRole('button', { name: 'Withdraw confirmation', exact: true })).toBeEnabled();
		await expect(merchantField.getByRole('button', { name: 'Withdraw confirmation', exact: true })).toBeFocused();
		const evidence: Locator = merchantField.locator('.field-evidence');
		await evidence.locator(':scope > summary').press('Enter');
		await expect(evidence.locator('.raw-text')).toHaveText('Merchant: Orchard Workshop');
		const tax: Locator = await openField(drawer, 'Tax');
		await expect(tax.getByRole('button', { name: 'Confirm value', exact: true })).toHaveCount(0);
		await expect(tax.locator('.field-confirmation-help')).toContainText('currency');
		const due: Locator = await openField(drawer, 'Due date');
		await expect(due.getByRole('button', { name: 'Confirm value', exact: true })).toHaveCount(0);
		await expect(due.locator('.field-confirmation-help')).toContainText('single value');
		const missing: Locator = await openField(drawer, 'Order reference');
		await expect(missing.getByRole('button', { name: 'Confirm value', exact: true })).toHaveCount(0);
		await expect(missing.locator('.field-confirmation-help')).toContainText('Add a value');
		const [preview]: [Page, Awaited<ReturnType<Locator['press']>>] = await Promise.all([
			app!.waitForEvent('window'), drawer.getByRole('button', { name: 'Open original review.pdf', exact: true }).press('Enter')
		]);
		await expect(preview.locator('canvas')).toBeVisible();
		await preview.close();
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).press('Enter');
		await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await app!.close();
		app = undefined;
		await launch();
		drawer = await openDocument();
		merchantField = await openField(drawer, 'Merchant');
		await expect(merchantField.locator('.source-status')).toHaveText('Confirmed by you');
		await drawer.getByRole('button', { name: 'Close document details', exact: true }).press('Enter');
		await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Match suggestions', exact: true }).press('Enter');
		const manual: Locator = page.getByRole('region', { name: 'Manual review' });
		await manual.getByRole('combobox', { name: 'Supporting document', exact: true }).click();
		await page.getByRole('option', { name: /^review\.pdf/ }).click();
		await manual.getByRole('button', { name: 'Document details for review.pdf', exact: true }).press('Enter');
		const manualMerchant: Locator = await openField(manual, 'Merchant');
		await expect(manualMerchant.locator('.source-status')).toHaveText('Confirmed by you');
		await manualMerchant.getByRole('button', { name: 'Withdraw confirmation', exact: true }).press('Enter');
		await expect(manualMerchant.locator('.source-status')).toHaveCount(0);
		await expect(manualMerchant.locator('.field-warning')).toHaveText('Review needed');
		await expect(manualMerchant.getByRole('button', { name: 'Confirm value', exact: true })).toBeEnabled();
		await expect(manual.getByRole('button', { name: 'Assign document', exact: true })).toBeVisible();
		await manual.getByRole('button', { name: 'Assign document', exact: true }).press('Enter');
		await expect(manual.getByRole('button', { name: 'Remove assignment', exact: true })).toBeVisible();
		const detailsButton: Locator = manual.getByRole('button', { name: 'Document details for review.pdf', exact: true });
		if (await detailsButton.getAttribute('aria-expanded') === 'false') {
			await detailsButton.press('Enter');
		}
		await openField(manual, 'Merchant');
		await manualMerchant.getByRole('button', { name: 'Confirm value', exact: true }).press('Enter');
		await expect(manualMerchant.locator('.source-status')).toHaveText('Confirmed by you');
		await expect(manualMerchant.getByRole('button', { name: 'Withdraw confirmation', exact: true })).toBeFocused();
		await manualMerchant.getByRole('button', { name: 'Withdraw confirmation', exact: true }).press('Enter');
		await expect(manualMerchant.getByRole('button', { name: 'Confirm value', exact: true })).toBeFocused();
		await expect(manualMerchant.locator('.field-warning')).toHaveText('Review needed');
		await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await app!.close();
		app = undefined;
		await launch();
		drawer = await openDocument();
		merchantField = await openField(drawer, 'Merchant');
		await expect(merchantField.locator('.source-status')).toHaveCount(0);
		await expect(merchantField.locator('.field-warning')).toHaveText('Review needed');
	} finally {
		await app?.close();
	}
});
