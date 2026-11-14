import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
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
			const exportNav = page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Export', exact: true });
			await exportNav.press('Enter');
			await expect(exportNav).toHaveAttribute('aria-current', 'page');
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
		await first.input.press('Enter');
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

test('exports copies and the saved reconciliation CSV and shows mixed outcomes and collisions', async ({ playwright }, testInfo) => {
	test.setTimeout(90_000);
	const root = testInfo.outputPath('document-export');
	const originals = path.join(root, 'originals');
	const destination = path.join(root, 'destination');
	const reportOnly = path.join(root, 'report-only');
	const combined = path.join(root, 'combined');
	const workspacePath = path.join(root, 'workspace.receiptmatch');
	const profile = path.join(root, 'profile');
	const firstFolder = path.join(originals, 'first');
	const secondFolder = path.join(originals, 'second');
	await Promise.all([firstFolder, secondFolder, destination, reportOnly, combined].map(folder => mkdir(folder, { recursive: true })));
	const bank = retainedBank(root);
	const [first, second] = bank.transactions;
	const approved = retainedDocument(firstFolder, 'receipt.pdf', 'verified original');
	const missing = retainedDocument(secondFolder, 'receipt.pdf');
	await writeFile(approved.filePath, 'verified original');
	await createWorkspace(workspacePath, newMetadata(), [bank], [documentRun(originals, [approved, missing])],
		new Map([[first.transactionId, approved.id], [second.transactionId, missing.id]]));
	const database = new Database(workspacePath);
	try { database.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; PRAGMA user_version = 7;'); }
	finally { database.close(); }
	const app = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + profile] });
	try {
		const page = await app.firstWindow();
		expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(profile);
		await app.evaluate(({ BrowserWindow, dialog }, { workspacePath, destination, reportOnly, combined }) => {
			const paths = [workspacePath, null, destination, destination, reportOnly, combined, combined];
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async () => {
				const file = paths.shift();
				return { canceled: !file, filePaths: file ? [file] : [] };
			};
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		}, { workspacePath, destination, reportOnly, combined });
		await page.getByRole('button', { name: 'Open workspace' }).click();
		const nav = page.getByRole('navigation', { name: 'Workspace views' });
		const exportNav = nav.getByRole('button', { name: 'Export', exact: true });
		const choose = page.getByRole('button', { name: 'Export copies only' });
		const chooseCombined = page.getByRole('button', { name: 'Export CSV and copies' });
		await exportNav.click();
		await expect(choose).toBeDisabled();
		await expect(page.getByText('0 approved documents in the open workspace', { exact: true })).toBeVisible();

		await nav.getByRole('button', { name: 'Match suggestions' }).click();
		await page.getByRole('checkbox', { name: /Orchard Workshop/ }).check();
		await page.getByRole('checkbox', { name: /River Studio/ }).check();
		await page.getByRole('button', { name: 'Approve selected' }).click();
		await expect(page.getByText('Selected transactions approved.', { exact: true })).toBeVisible();
		await exportNav.click();
		await expect(page.getByText('2 approved documents in the open workspace', { exact: true })).toBeVisible();
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

		await expect(page.getByText('The CSV export uses the last saved workspace. Save your changes to include them.')).toBeVisible();
		await chooseCombined.click();
		await expect(page.getByText('CSV report written.', { exact: true })).toBeVisible();
		await expect(page.getByText('No approved documents in the saved workspace.', { exact: true })).toBeVisible();
		expect(await readdir(reportOnly)).toEqual(['reconciliation.csv']);
		expect(await readFile(path.join(reportOnly, 'reconciliation.csv'), 'utf8')).toContain(',not-eligible,');

		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		await expect(page.getByText('The CSV export uses the saved workspace.', { exact: true })).toBeVisible();
		await chooseCombined.click();
		await expect(page.getByText('CSV report written.', { exact: true })).toBeVisible();
		await expect(page.getByText('1 copied · 0 skipped · 1 failed', { exact: true })).toBeVisible();
		await expect(failed.getByText('The original file is missing.')).toBeVisible();
		const csvPath = path.join(combined, 'reconciliation.csv');
		await expect(page.getByText(csvPath, { exact: true })).toBeVisible();
		const csv = await readFile(csvPath, 'utf8');
		expect(csv).toMatch(/^\uFEFFrow_type,transaction_id,/u);
		expect(csv).toContain(',copied,documents/' + filename + ',');
		expect(csv).toContain(',failed,,source-missing,');
		expect(await readFile(path.join(combined, 'documents', filename), 'utf8')).toBe('verified original');

		await chooseCombined.click();
		await expect(page.getByRole('alert')).toHaveText('reconciliation.csv already exists. Choose another export folder.');
		expect(await readFile(csvPath, 'utf8')).toBe(csv);
		expect(await readdir(path.join(combined, 'documents'))).toEqual([filename]);
	} finally { await app.close(); }
});
