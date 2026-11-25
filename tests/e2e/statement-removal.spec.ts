import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';

interface IWorkspaceDialogPlan { openFiles: string[]; saveFile: string }

async function launch(playwright: PlaywrightWorkerArgs['playwright'], profile: string, openFiles: string[], saveFile: string): Promise<ElectronApplication> {
	const application: ElectronApplication = await playwright._electron.launch({
		executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
		args: ['--hidden', '--disable-gpu', `--user-data-dir=${profile}`],
		env: { ...process.env, ELECTRON_START_URL: '' },
		chromiumSandbox: true,
		timeout: 30_000
	});
	try {
		await application.firstWindow({ timeout: 30_000 });
		await application.evaluate(({ BrowserWindow, dialog }: typeof Electron.CrossProcessExports, plan: IWorkspaceDialogPlan): void => {
			BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
			dialog.showOpenDialog = (): Promise<Electron.OpenDialogReturnValue> => {
				const selected: string | undefined = plan.openFiles.shift();
				return Promise.resolve({ canceled: !selected, filePaths: selected ? [selected] : [] });
			};
			dialog.showSaveDialog = (): Promise<Electron.SaveDialogReturnValue> => Promise.resolve({ canceled: false, filePath: plan.saveFile });
			dialog.showMessageBox = (): Promise<Electron.MessageBoxReturnValue> => Promise.resolve({ response: 1, checkboxChecked: false });
		}, { openFiles, saveFile });
		return application;
	} catch (error: unknown) {
		await application.close();
		throw error;
	}
}

test('removes only the confirmed statement and permits reimport after reopening the workspace', async ({ playwright }: PlaywrightWorkerArgs): Promise<void> => {
	test.setTimeout(120_000);
	await mkdir(path.resolve('tmp'), { recursive: true });
	const temporary: string = await realpath(path.resolve('tmp'));
	const root: string = await mkdtemp(path.join(temporary, 'statement-removal-ui-'));
	const removed: string = path.join(root, 'remove-me.pdf');
	const retained: string = path.join(root, 'keep-me.pdf');
	const workspace: string = path.join(root, 'statement-removal.receiptmatch');
	let application: ElectronApplication | undefined;
	try {
		await copyFile(path.resolve('tests/fixtures/revolut-synthetic-scan.pdf'), removed);
		await copyFile(path.resolve('tests/fixtures/airwallex-synthetic-scan.pdf'), retained);
		const original: NonSharedBuffer = await readFile(removed);

		application = await launch(playwright, path.join(root, 'profile'), [removed, retained], workspace);
		const page: Page = await application.firstWindow();
		page.setDefaultTimeout(15_000);
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByRole('button', { name: 'Sources', exact: true }).click();
		const statements: Locator = page.getByRole('region', { name: 'Bank statements', exact: true });
		const importStatement: Locator = statements.getByRole('button', { name: 'Import statement', exact: true });
		await test.step('imports and saves two different statements, then selects the first', async (): Promise<void> => {
			for (const file of [removed, retained]) {
				await importStatement.click();
				await expect(statements.getByRole('heading', { name: path.basename(file), exact: true })).toBeVisible({ timeout: 30_000 });
			}
			await expect(statements.getByText('2 statements', { exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
			await statements.getByRole('combobox', { name: 'Statement', exact: true }).click();
			await page.getByRole('option').filter({ hasText: path.basename(removed) + ' ·' }).click();
			await expect(statements.getByRole('heading', { name: path.basename(removed), exact: true })).toBeVisible();
		});

		const removeAction: Locator = statements.locator('.statement-summary').getByRole('button', { name: 'Remove statement', exact: true });
		const dialog: Locator = page.getByRole('dialog', { name: 'Remove statement?', exact: true });
		const cancel: Locator = dialog.getByRole('button', { name: 'Cancel', exact: true });
		await test.step('names the selected statement and preserves it on Escape or Cancel', async (): Promise<void> => {
			await removeAction.click();
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText(path.basename(removed));
			await expect(dialog).toContainText(/transactions|bookings/i);
			await expect(cancel).toBeFocused();
			await cancel.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(removeAction).toBeFocused();
			await removeAction.click();
			await cancel.click();
			await expect(dialog).toBeHidden();
			await expect(statements.getByText('2 statements', { exact: true })).toBeVisible();
			await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		});

		await test.step('removes only the confirmed statement and saves the workspace', async (): Promise<void> => {
			await removeAction.click();
			await dialog.getByRole('button', { name: 'Remove statement', exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(statements.getByRole('heading', { name: path.basename(retained), exact: true })).toBeVisible();
			await expect(statements.getByText('1 statement', { exact: true })).toBeVisible();
			await expect(importStatement).toBeFocused();
			await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		});
		await application.close();
		application = undefined;

		application = await launch(playwright, path.join(root, 'reopened-profile'), [workspace, removed], workspace);
		const reopened: Page = await application.firstWindow();
		reopened.setDefaultTimeout(15_000);
		const reopenedStatements: Locator = reopened.getByRole('region', { name: 'Bank statements', exact: true });
		await test.step('reopens the saved workspace and imports the same original PDF', async (): Promise<void> => {
			await reopened.getByRole('button', { name: 'Open workspace', exact: true }).click();
			await reopened.getByRole('button', { name: 'Sources', exact: true }).click();
			await expect(reopenedStatements.getByText('1 statement', { exact: true })).toBeVisible();
			await expect(reopenedStatements.getByRole('heading', { name: path.basename(retained), exact: true })).toBeVisible();
			assert.deepEqual(await readFile(removed), original);
			await reopenedStatements.getByRole('button', { name: 'Import statement', exact: true }).click();
			await expect(reopenedStatements.getByRole('heading', { name: path.basename(removed), exact: true })).toBeVisible({ timeout: 30_000 });
			await expect(reopenedStatements.getByText('2 statements', { exact: true })).toBeVisible();
		});
		await test.step('shows the empty state after removing the last statement', async (): Promise<void> => {
			const remove: Locator = reopenedStatements.locator('.statement-summary').getByRole('button', { name: 'Remove statement', exact: true });
			const confirmation: Locator = reopened.getByRole('dialog', { name: 'Remove statement?', exact: true });
			for (const file of [removed, retained]) {
				await expect(reopenedStatements.getByRole('heading', { name: path.basename(file), exact: true })).toBeVisible();
				await remove.click();
				await confirmation.getByRole('button', { name: 'Remove statement', exact: true }).click();
			}
			await expect(reopenedStatements.getByText('0 statements', { exact: true })).toBeVisible();
			await expect(reopenedStatements.getByText('Import a PDF bank statement to read its transactions here.', { exact: true })).toBeVisible();
			await expect(reopenedStatements.getByRole('button', { name: 'Import statement', exact: true })).toBeFocused();
		});
	} finally {
		await application?.close();
		assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('statement-removal-ui-'));
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
});
