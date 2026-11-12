import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

const executablePath = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');

test('previews, validates and saves an export filename pattern across Electron restarts', async ({ playwright }, testInfo) => {
	const root = testInfo.outputPath('export-settings');
	await mkdir(root, { recursive: true });
	const workspacePath = path.join(root, 'workspace.receiptmatch');
	await createWorkspace(workspacePath, newMetadata());
	const profile = path.join(root, 'profile');
	const launch = async () => {
		const app = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + profile] });
		try {
			const page = await app.firstWindow();
			expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(profile);
			await app.evaluate(({ BrowserWindow, dialog }, filePath) => {
				BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
			}, workspacePath);
			await page.getByRole('button', { name: 'Open workspace' }).click();
			await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Export', exact: true }).press('Enter');
			await expect(page.getByRole('heading', { name: 'Export', exact: true })).toBeFocused();
			const input = page.getByRole('textbox', { name: 'Filename pattern' });
			await expect(input).toBeEnabled();
			return { app, page, input, preview: page.locator('#export-pattern-preview'), save: page.getByRole('button', { name: 'Save pattern' }) };
		} catch (error) {
			await app.close();
			throw error;
		}
	};

	const first = await launch();
	try {
		await expect(first.preview).toHaveText('2026-10-21_Example-Merchant_EUR_-176.77.pdf');
		await first.input.fill('../{date}');
		await expect(first.input).toHaveAttribute('aria-invalid', 'true');
		await expect(first.save).toBeDisabled();
		await first.input.fill('{counterparty} - {date}');
		await expect(first.preview).toHaveText('Example-Merchant - 2026-10-21.pdf');
		await first.save.click();
		await expect(first.page.getByText('Pattern saved.', { exact: true })).toBeVisible();
		await expect(first.page.getByText('All changes saved', { exact: true })).toBeVisible();
	} finally { await first.app.close(); }

	const second = await launch();
	try {
		await expect(second.input).toHaveValue('{counterparty} - {date}');
		await second.page.getByRole('button', { name: 'Use default' }).click();
		await expect(second.preview).toHaveText('2026-10-21_Example-Merchant_EUR_-176.77.pdf');
		await second.save.click();
		await expect(second.page.getByText('Pattern saved.', { exact: true })).toBeVisible();
	} finally { await second.app.close(); }
});

test('exports a reviewed batch with the saved pattern and shows mixed outcomes and collisions', async ({ playwright }, testInfo) => {
	test.setTimeout(90_000);
	const root = testInfo.outputPath('document-export');
	const originals = path.join(root, 'originals');
	const destination = path.join(root, 'destination');
	const workspacePath = path.join(root, 'workspace.receiptmatch');
	const profile = path.join(root, 'profile');
	const firstFolder = path.join(originals, 'first');
	const secondFolder = path.join(originals, 'second');
	await Promise.all([mkdir(firstFolder, { recursive: true }), mkdir(secondFolder, { recursive: true }), mkdir(destination, { recursive: true })]);
	const bank = retainedBank(root);
	const [first, second] = bank.transactions;
	const approved = retainedDocument(firstFolder, 'receipt.pdf', 'verified original');
	const missing = retainedDocument(secondFolder, 'receipt.pdf');
	await writeFile(approved.filePath, 'verified original');
	await createWorkspace(workspacePath, newMetadata(), [bank], [documentRun(originals, [approved, missing])],
		new Map([[first.transactionId, approved.id], [second.transactionId, missing.id]]));
	const app = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + profile] });
	try {
		const page = await app.firstWindow();
		expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(profile);
		await app.evaluate(({ BrowserWindow, dialog }, { workspacePath, destination }) => {
			const paths = [workspacePath, null, destination, destination];
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async () => {
				const file = paths.shift();
				return { canceled: !file, filePaths: file ? [file] : [] };
			};
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		}, { workspacePath, destination });
		await page.getByRole('button', { name: 'Open workspace' }).click();
		const nav = page.getByRole('navigation', { name: 'Workspace views' });
		const exportNav = nav.getByRole('button', { name: 'Export', exact: true });
		const choose = page.getByRole('button', { name: 'Choose folder and export' });
		await exportNav.click();
		await expect(choose).toBeDisabled();
		await expect(page.getByText('0 approved documents', { exact: true })).toBeVisible();

		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await page.getByRole('checkbox', { name: /Orchard Workshop/ }).check();
		await page.getByRole('checkbox', { name: /River Studio/ }).check();
		await page.getByRole('button', { name: 'Approve selected' }).click();
		await expect(page.getByText('Selected transactions approved.', { exact: true })).toBeVisible();
		await exportNav.click();
		await expect(page.getByText('2 approved documents', { exact: true })).toBeVisible();
		await page.getByRole('textbox', { name: 'Filename pattern' }).fill('{counterparty}_{amount}');
		await page.getByRole('button', { name: 'Save pattern' }).click();
		await expect(page.getByText('Pattern saved.', { exact: true })).toBeVisible();

		await choose.click();
		await expect(page.getByText('Export cancelled.', { exact: true })).toBeVisible();
		expect(await readdir(destination)).toEqual([]);
		await choose.click();
		await expect(page.getByText('1 copied · 0 skipped · 1 failed', { exact: true })).toBeVisible();
		const results = page.getByRole('region', { name: 'Export results' });
		const filename = 'Orchard-Workshop_-1234.56.pdf';
		const copied = results.getByRole('row').filter({ has: page.getByText(approved.filePath, { exact: true }) });
		await expect(copied.getByText(filename)).toBeVisible();
		await expect(copied.getByText('Copied', { exact: true })).toBeVisible();
		const failed = results.getByRole('row').filter({ has: page.getByText(missing.filePath, { exact: true }) });
		await expect(failed.getByText('The original file is missing.')).toBeVisible();
		const output = path.join(destination, 'documents');
		expect(await readdir(output)).toEqual([filename]);
		expect(await readFile(path.join(output, filename), 'utf8')).toBe('verified original');

		await choose.click();
		await expect(page.getByText('0 copied · 1 skipped · 1 failed', { exact: true })).toBeVisible();
		await expect(copied.getByText('A file with this name already exists.')).toBeVisible();
		expect(await readdir(output)).toEqual([filename]);
		expect(await readFile(path.join(output, filename), 'utf8')).toBe('verified original');
		expect(await readFile(approved.filePath, 'utf8')).toBe('verified original');
	} finally { await app.close(); }
});
