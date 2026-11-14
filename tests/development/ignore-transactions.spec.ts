import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { retainedBank } from '../unit/document-fixtures.js';

test('ignores transactions once or by rule and restores them from the separate table', async ({ playwright }, testInfo) => {
	const root = testInfo.outputPath('ignore-workspace');
	await mkdir(root, { recursive: true });
	const file = path.join(root, 'test.receiptmatch');
	await createWorkspace(file, newMetadata(), [retainedBank(root)]);
	const executablePath: unknown = (await import('electron')).default;
	if (typeof executablePath !== 'string') throw new Error('Electron is unavailable.');
	const app = await playwright._electron.launch({
		executablePath, args: ['.', '--hidden', '--disable-gpu', '--user-data-dir=' + path.join(root, 'profile')],
		env: { ...process.env, ELECTRON_START_URL: '' },
		chromiumSandbox: true,
	});
	try {
		await app.evaluate(({ dialog, BrowserWindow }, workspace) => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
		}, file);
		const page = await app.firstWindow();
		await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
		await page.getByRole('button', { name: 'Match suggestions', exact: true }).click();
		const transactions = page.getByRole('region', { name: 'Transactions', exact: true });
		const ignored = page.getByRole('region', { name: 'Ignored transactions', exact: true });
		const manual = page.getByRole('region', { name: 'Manual review' });
		const options = manual.getByRole('group', { name: 'Ignore transaction options' });
		const ignore = manual.getByRole('button', { name: 'Ignore transaction', exact: true });

		await expect(transactions.getByRole('row', { name: /Orchard Workshop/ })).toBeVisible();
		await ignore.press('Enter');
		await expect(ignore).toHaveAttribute('aria-expanded', 'true');
		await options.getByRole('button', { name: 'Ignore once', exact: true }).press('Enter');
		await expect(ignored.getByRole('heading')).toBeFocused();
		await expect(transactions.getByRole('row', { name: /Orchard Workshop/ })).toHaveCount(0);
		await expect(ignored.getByRole('row', { name: /Orchard Workshop/ })).toContainText('This transaction only');

		await ignore.click();
		await options.getByRole('button', { name: 'Remember for future bookings' }).click();
		await expect(transactions.getByText('All transactions are ignored.')).toBeVisible();
		await expect(ignored.getByRole('row', { name: /River Studio/ })).toContainText('Remembered rule');
		await ignored.getByRole('button', { name: /Remove rule and restore .*River Studio/ }).press('Enter');
		await expect(transactions.getByRole('heading')).toBeFocused();
		await expect(transactions.getByRole('row', { name: /River Studio/ })).toBeVisible();
		await expect(ignored.getByRole('row', { name: /River Studio/ })).toHaveCount(0);
		await ignored.getByRole('button', { name: /Restore .*Orchard Workshop/ }).click();
		await expect(transactions.getByRole('row', { name: /Orchard Workshop/ })).toBeVisible();
		await expect(ignored).toHaveCount(0);
	} finally {
		await app.close();
	}
});
