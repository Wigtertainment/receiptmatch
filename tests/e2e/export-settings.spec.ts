import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page, type ElectronApplication, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs } from '@playwright/test';
import Database from 'better-sqlite3';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { documentRun, retainedBank, retainedDocument } from '../unit/document-fixtures.js';

const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');

test('previews, validates and saves an export filename pattern across Electron restarts', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
	const root: string = testInfo.outputPath('export-settings');
	await mkdir(root, { recursive: true });
	const workspacePath: string = path.join(root, 'workspace.receiptmatch');
	await createWorkspace(workspacePath, newMetadata());
	const profile: string = path.join(root, 'profile');
	const launch: () => Promise<{ app: ElectronApplication; page: Page; input: Locator; preview: Locator; save: Locator; }> = async (): Promise<{ app: ElectronApplication; page: Page; input: Locator; preview: Locator; save: Locator; }> => {
		const app: ElectronApplication = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + profile] });
		try {
			const page: Page = await app.firstWindow();
			expect(await app.evaluate(({ app: electronApp }: typeof Electron.CrossProcessExports): string => electronApp.getPath('userData'))).toBe(profile);
			await app.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, filePath: string): void => {
				BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
				dialog.showOpenDialog = async (): Promise<{ canceled: false; filePaths: string[]; }> => Promise.resolve(({ canceled: false, filePaths: [filePath] }));
			}, workspacePath);
			await page.getByRole('button', { name: 'Open workspace' }).click();
			const exportNav: Locator = page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Export', exact: true });
			await exportNav.press('Enter');
			await expect(exportNav).toHaveAttribute('aria-current', 'page');
			await expect(page.getByRole('heading', { name: 'Export', exact: true })).toBeFocused();
			const input: Locator = page.getByRole('textbox', { name: 'Filename pattern' });
			await expect(input).toBeEnabled();
			return { app, page, input, preview: page.locator('#export-pattern-preview'), save: page.getByRole('button', { name: 'Save pattern' }) };
		} catch (error: unknown) {
			await app.close();
			throw error;
		}
	};

	const first: { app: ElectronApplication; page: Page; input: Locator; preview: Locator; save: Locator; } = await launch();
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
	} finally {
		await first.app.close();
	}

	const second: { app: ElectronApplication; page: Page; input: Locator; preview: Locator; save: Locator; } = await launch();
	try {
		await expect(second.input).toHaveValue('{counterparty} - {date}');
		await second.page.getByRole('button', { name: 'Use default' }).click();
		await expect(second.preview).toHaveText('2026-10-21_Example-Merchant_EUR_-176.77.pdf');
		await second.save.click();
		await expect(second.page.getByText('Pattern saved.', { exact: true })).toBeVisible();
	} finally {
		await second.app.close();
	}
});

test('exports copies and the saved reconciliation CSV and shows mixed outcomes and collisions', async ({ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo): Promise<void> => {
	test.setTimeout(90_000);
	const outputPath: string = testInfo.outputPath('document-export');
	await mkdir(outputPath, { recursive: true });
	const root: string = await realpath(outputPath);
	const originals: string = path.join(root, 'originals');
	const destination: string = path.join(root, 'destination');
	const reportOnly: string = path.join(root, 'report-only');
	const combined: string = path.join(root, 'combined');
	const workspacePath: string = path.join(root, 'workspace.receiptmatch');
	const profile: string = path.join(root, 'profile');
	const firstFolder: string = path.join(originals, 'first');
	const secondFolder: string = path.join(originals, 'second');
	await Promise.all([firstFolder, secondFolder, destination, reportOnly, combined].map((folder: string): Promise<string | undefined> => mkdir(folder, { recursive: true })));
	const bank: StoredBankImport = retainedBank(root);
	const [first, second]: { rowId: string; transactionId: string; }[] = bank.transactions;
	const approved: StoredSupportingDocument = retainedDocument(firstFolder, 'receipt.pdf', 'verified original');
	const missing: StoredSupportingDocument = retainedDocument(secondFolder, 'receipt.pdf');
	await writeFile(approved.filePath, 'verified original');
	await createWorkspace(workspacePath, newMetadata(), [bank], [documentRun(originals, [approved, missing])],
		new Map([[first.transactionId, approved.id], [second.transactionId, missing.id]]));
	const database: Database.Database = new Database(workspacePath);
	try {
		database.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; PRAGMA user_version = 7;');
	} finally {
		database.close();
	}
	const app: ElectronApplication = await playwright._electron.launch({ executablePath, args: ['--hidden', '--disable-gpu', '--user-data-dir=' + profile] });
	try {
		const page: Page = await app.firstWindow();
		expect(await app.evaluate(({ app: electronApp }: typeof Electron.CrossProcessExports): string => electronApp.getPath('userData'))).toBe(profile);
		await app.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, { workspacePath, destination, reportOnly, combined }: { workspacePath: string; destination: string; reportOnly: string; combined: string; }): void => {
			const paths: (string | null)[] = [workspacePath, null, destination, destination, reportOnly, combined, combined];
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[]; }> => {
				const file: string | null | undefined = paths.shift();
				return Promise.resolve({ canceled: !file, filePaths: file ? [file] : [] });
			};
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: 1, checkboxChecked: false }));
		}, { workspacePath, destination, reportOnly, combined });
		await page.getByRole('button', { name: 'Open workspace' }).click();
		const nav: Locator = page.getByRole('navigation', { name: 'Workspace views' });
		const exportNav: Locator = nav.getByRole('button', { name: 'Export', exact: true });
		const choose: Locator = page.getByRole('button', { name: 'Export copies only' });
		const chooseCombined: Locator = page.getByRole('button', { name: 'Export CSV and copies' });
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
		const results: Locator = page.getByRole('region', { name: 'Export results' });
		const filename: "Orchard-Workshop_-1234.56.pdf" = 'Orchard-Workshop_-1234.56.pdf';
		const copied: Locator = results.getByRole('row').filter({ has: page.getByText(approved.filePath, { exact: true }) });
		await expect(copied.getByText(filename)).toBeVisible();
		await expect(copied.getByText('Copied', { exact: true })).toBeVisible();
		const failed: Locator = results.getByRole('row').filter({ has: page.getByText(missing.filePath, { exact: true }) });
		await expect(failed.getByText('The original file is missing.')).toBeVisible();
		const output: string = path.join(destination, 'documents');
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
		const csvPath: string = path.join(combined, 'reconciliation.csv');
		await expect(page.getByText(csvPath, { exact: true })).toBeVisible();
		const csv: string = await readFile(csvPath, 'utf8');
		expect(csv).toMatch(/^\uFEFFrow_type,transaction_id,/u);
		expect(csv).toContain(',copied,documents/' + filename + ',');
		expect(csv).toContain(',failed,,source-missing,');
		expect(await readFile(path.join(combined, 'documents', filename), 'utf8')).toBe('verified original');

		await chooseCombined.click();
		await expect(page.getByRole('alert')).toHaveText('reconciliation.csv already exists. Choose another export folder.');
		expect(await readFile(csvPath, 'utf8')).toBe(csv);
		expect(await readdir(path.join(combined, 'documents'))).toEqual([filename]);
	} finally {
		await app.close();
	}
});
