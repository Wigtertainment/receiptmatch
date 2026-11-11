import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { statement } from '../unit/bank-fixtures.js';

async function statementPdf(file: string) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const input of statement().pages) {
		const page = pdf.addPage([input.width, input.height]);
		for (const span of input.spans) page.drawText(span.text, { x: span.region.x, y: input.height - span.region.y - 10, size: 10, font });
	}
	await writeFile(file, await pdf.save());
}

async function invoicePdf(file: string, total: string) {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([600, 800]);
	const lines = ['Invoice', 'Merchant: Orchard Workshop', 'Invoice Number: SYNTHETIC-A', 'Invoice Date: 2032-03-06', `Invoice Total: ${total}`];
	for (const [index, text] of lines.entries()) page.drawText(text, { x: 40, y: 740 - index * 30, size: 14, font });
	await writeFile(file, await pdf.save());
}

async function dialogs(app: ElectronApplication, opens: string[], save = '') {
	await app.evaluate(({ dialog, BrowserWindow }, plan) => {
		BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
		dialog.showOpenDialog = async () => {
			const file = plan.opens.shift();
			return { canceled: !file, filePaths: file ? [file] : [] };
		};
		dialog.showSaveDialog = async () => ({ canceled: !plan.save, filePath: plan.save });
		dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
	}, { opens, save });
}

test('packaged match suggestions from import through keyboard review and reopening', async ({ playwright }, testInfo) => {
	test.setTimeout(120_000);
	const root = testInfo.outputPath('workspace');
	const first = path.join(root, 'documents');
	const second = path.join(root, 'more-documents');
	const bankFile = path.join(root, 'statement.pdf');
	const workspaceFile = path.join(root, 'reconciliation.receiptmatch');
	await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
	await Promise.all([statementPdf(bankFile), invoicePdf(path.join(first, 'account-invoice.pdf'), 'EUR 1,234.56'),
		invoicePdf(path.join(second, 'original-invoice.pdf'), 'USD 1,500.01')]);
	async function launch(profile: string) {
		return playwright._electron.launch({
			executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
			args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, profile)}`],
		});
	}
	let app = await launch('first-profile');
	try {
		const page = await app.firstWindow();
		await dialogs(app, [bankFile, first, second], workspaceFile);
		await page.getByRole('button', { name: 'Create workspace' }).click();
		const matches = page.getByRole('region', { name: 'Match suggestions' });
		await expect(matches.getByText('Import a bank statement', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Import statement' }).click();
		await expect(matches.getByText('0 reliable · 0 uncertain · 2 unmatched')).toBeVisible();
		await page.getByRole('button', { name: 'Choose folder' }).click();
		await expect(matches.getByText('1 reliable · 0 uncertain · 1 unmatched')).toBeVisible();
		const statements = page.getByRole('region', { name: 'Bank statements' });
		const documents = page.getByRole('region', { name: 'Supporting documents' });
		const resize = (width: number) => app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
		const importBounds = async () => {
			const [bank, receipts] = await Promise.all([statements.boundingBox(), documents.boundingBox()]);
			return { leftToRight: bank!.x + bank!.width < receipts!.x && bank!.y === receipts!.y, topToBottom: bank!.y + bank!.height < receipts!.y };
		};
		await resize(1120);
		await expect.poll(async () => (await importBounds()).leftToRight).toBe(true);
		await expect.poll(() => statements.getByRole('region', { name: 'Transactions table, horizontally scrollable' }).evaluate(table => table.scrollWidth <= table.clientWidth)).toBe(true);
		await resize(680);
		await expect.poll(async () => (await importBounds()).topToBottom).toBe(true);
		await resize(1120);
		const disclosure = matches.getByRole('button', { name: 'View 1 candidate for', exact: false });
		await disclosure.focus();
		await disclosure.press('Enter');
		await expect(disclosure).not.toBeVisible();
		await expect(matches.getByRole('button', { name: 'Hide 1 candidate for', exact: false })).toHaveAttribute('aria-expanded', 'true');
		await expect(matches.getByRole('heading', { name: 'account-invoice.pdf' })).toBeVisible();
		await expect(matches.getByText('7 days apart (within 7 days)', { exact: false })).toBeVisible();
		await matches.locator('summary').filter({ hasText: 'Source evidence' }).press('Enter');
		await expect(matches.getByText('Invoice Number: SYNTHETIC-A')).toBeVisible();

		await page.getByRole('button', { name: 'Choose folder' }).click();
		await expect(matches.getByText('0 reliable · 1 uncertain · 1 unmatched')).toBeVisible();
		const filter = matches.getByRole('combobox', { name: 'Result', exact: true });
		await filter.selectOption('unmatched');
		await expect(matches.getByRole('row', { name: /River Studio/ })).toBeVisible();
		await expect(matches.getByRole('row', { name: /Orchard Workshop/ })).toHaveCount(0);
		await filter.selectOption('uncertain');
		await matches.getByRole('button', { name: 'View 2 candidates for', exact: false }).click();
		await expect(matches.getByRole('heading', { name: 'original-invoice.pdf' })).toBeVisible();
		await expect(matches.getByText('Reported original payment amount', { exact: true })).toBeVisible();
		await expect(matches.getByText('Another possible match is supported by a reference.')).toHaveCount(2);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await app.close();

		app = await launch('second-profile');
		const reopened = await app.firstWindow();
		await dialogs(app, [workspaceFile]);
		await reopened.getByRole('button', { name: 'Open workspace', exact: false }).click();
		const restored = reopened.getByRole('region', { name: 'Match suggestions' });
		await expect(restored.getByText('0 reliable · 1 uncertain · 1 unmatched')).toBeVisible();
		await restored.getByRole('button', { name: 'View 2 candidates for', exact: false }).click();
		await expect(restored.getByRole('heading', { name: 'original-invoice.pdf' })).toBeVisible();
		await expect(restored.getByText('Matching reference', { exact: true })).toHaveCount(2);
	} finally { await app.close(); }
});
