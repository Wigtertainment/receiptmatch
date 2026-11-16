import assert from 'node:assert/strict';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFPage } from 'pdf-lib';
import {
	expect, test, type ElectronApplication, type Locator, type Page, type PlaywrightTestArgs, type PlaywrightTestOptions, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions
} from '@playwright/test';
import { NUEXTRACT_ASSETS } from '../../electron/local-ocr-assets.js';
import type { LocalOcrStatus } from '../../src/shared/local-ocr-settings.js';
import type { WorkspaceState } from '../../src/shared/protocol.js';
import type { StoredBankImport } from '../../src/shared/workspace-import.js';

const bookings: readonly (readonly string[])[] = [
	['2026-02-02', 'Juniper Supplies', '-118.05', '1,681.95'],
	['2026-02-03', 'Cedar Studio', '+250.00', '1,931.95'],
	['2026-02-04', 'Oak Transit', '-5.90', '1,926.05'],
	['2026-02-05', 'Maple Books', '-42.17', '1,883.88'],
	['2026-02-06', 'Elm Workshop', '84.12', '1,968.00']
];

async function unknownStatement(file: string): Promise<void> {
	const pdf: PDFDocument = await PDFDocument.create();
	const plain: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);
	const bold: PDFFont = await pdf.embedFont(StandardFonts.HelveticaBold);
	const page: PDFPage = pdf.addPage([595, 510]);
	const x: number[] = [46, 166, 365, 463];
	const gray: Color = rgb(0.82, 0.82, 0.82);
	page.drawText('Fir Valley Credit Union', { x: 42, y: 460, font: bold, size: 21 });
	page.drawText('Account statement / Currency: USD', { x: 42, y: 430, font: plain, size: 13 });
	page.drawText('Page 1 of 1', { x: 42, y: 45, font: plain, size: 10 });
	['Booking date', 'Description', 'Amount', 'Balance'].forEach((label: string, column: number): void => page.drawText(label, { x: x[column], y: 384, font: bold, size: 11 }));
	bookings.forEach((row: readonly string[], index: number): void => row.forEach((cell: string, column: number): void => {
		page.drawText(cell, { x: x[column], y: 352 - 30 * index, font: plain, size: 12 });
	}));
	for (let row: number = 0; row <= bookings.length + 1; row++) {
		const y: number = 404 - 30 * row;
		page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.8, color: gray });
	}
	for (const column of [40, 159, 358, 456, 555]) {
		page.drawLine({ start: { x: column, y: 404 }, end: { x: column, y: 224 }, thickness: 0.8, color: gray });
	}
	await writeFile(file, await pdf.save());
}

async function stageModel(assets: string, profile: string): Promise<void> {
	const install: string = path.join(profile, 'local-ocr', 'nuextract3-' + NUEXTRACT_ASSETS[0].sha256.slice(0, 16));
	await mkdir(install, { recursive: true });
	for (const asset of NUEXTRACT_ASSETS) {
		const file: string = path.join(assets, asset.file);
		const digest: Hash = createHash('sha256');
		for await (const chunk of createReadStream(file)) {
			digest.update(chunk as Buffer);
		}
		assert.equal(digest.digest('hex'), asset.sha256, `The test asset ${asset.file} must match the pinned model.`);
		const target: string = path.join(install, asset.file);
		try {
			await link(file, target);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
				throw error;
			}
			await cp(file, target);
		}
	}
}

async function launch(playwright: PlaywrightWorkerArgs['playwright'], profile: string): Promise<{
	application: ElectronApplication; page: Page;
}> {
	const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
	const application: ElectronApplication = await playwright._electron.launch({
		executablePath,
		args: ['--hidden', '--disable-gpu', `--user-data-dir=${profile}`],
		env: { ...process.env, ELECTRON_START_URL: '' }, chromiumSandbox: true, timeout: 30_000
	});
	try {
		const page: Page = await application.firstWindow({ timeout: 30_000 });
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
		await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
		return { application, page };
	} catch (error: unknown) {
		await application.close();
		throw error;
	}
}

async function dialogs(application: ElectronApplication, open?: string, save?: string): Promise<void> {
	await application.evaluate(({ dialog }: typeof Electron.CrossProcessExports, plan: { open: string | undefined; save: string | undefined }): void => {
		dialog.showOpenDialog = (): Promise<{ canceled: boolean; filePaths: string[] }> => {
			const selected: string | undefined = plan.open;
			plan.open = undefined;
			return Promise.resolve({ canceled: !selected, filePaths: selected ? [selected] : [] });
		};
		dialog.showSaveDialog = (): Promise<{ canceled: boolean; filePath: string }> => Promise.resolve({ canceled: !plan.save, filePath: plan.save ?? '' });
		dialog.showMessageBox = (): Promise<{ response: number; checkboxChecked: boolean }> => Promise.resolve({ response: 1, checkboxChecked: false });
	}, { open, save });
}

async function state(page: Page): Promise<WorkspaceState> {
	return page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'get-state' }));
}

async function reports(page: Page): Promise<StoredBankImport[]> {
	return page.evaluate((): Promise<StoredBankImport[]> => window.receiptmatch.bankImports());
}

async function openOffer(application: ElectronApplication, page: Page, file: string): Promise<void> {
	await dialogs(application, file);
	await page.getByRole('button', { name: 'Import statement', exact: true }).click();
	await expect(page.getByTestId('statement-ai-offer')).toBeVisible();
}

async function reviewAndConfirm(page: Page): Promise<string> {
	const review: Locator = page.getByTestId('statement-ai-review');
	await expect(review).toBeVisible({ timeout: 270_000 });
	await expect(review.getByRole('heading', { name: 'Unresolved drafts' })).toBeVisible();
	const proposed: Locator = review.getByTestId('statement-ai-row').filter({ hasText: 'Juniper Supplies' });
	await expect(proposed).toContainText('Page 1');
	await proposed.locator('summary').click();
	await expect(proposed).toContainText('Source evidence');
	await expect(proposed).toContainText('-118.05');
	assert.deepEqual(await reports(page), [], 'The preview must not retain a statement.');
	assert.equal((await state(page)).workspace?.matchReviewCounts.open, 0);
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(page.getByTestId('import-outcome')).toContainText('Statement imported');
	await expect(page.getByRole('button', { name: 'Import statement', exact: true })).toBeFocused();
	const retained: StoredBankImport[] = await reports(page);
	assert.equal(retained.length, 1);
	assert.equal(retained[0].result.localRecognition?.model, 'nuextract3');
	assert.deepEqual(
		retained[0].result.transactions.map((row: StoredBankImport['result']['transactions'][number]): string => row.accountAmount.value.coefficient),
		['-11805', '25000', '-590', '-4217']
	);
	assert.equal(retained[0].result.unresolvedDrafts[0]?.description?.value, 'Elm Workshop');
	assert.equal((await state(page)).workspace?.matchReviewCounts.open, 4);
	return retained[0].id;
}

test('reviews and confirms a local AI bank statement, then skips duplicates and reopens saved data', async (
	{ playwright }: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions
): Promise<void> => {
	const assets: string | undefined = process.env.RECEIPTMATCH_STATEMENT_AI_ASSETS;
	test.skip(!assets, 'Requires a desktop package and the pinned NuExtract3 model files.');
	assert.ok(assets && path.isAbsolute(assets));
	test.setTimeout(360_000);
	await mkdir(path.resolve('tmp'), { recursive: true });
	const temporary: string = await realpath(path.resolve('tmp'));
	const root: string = await mkdtemp(path.join(temporary, 'statement-ai-ui-'));
	const profile: string = path.join(root, 'profile');
	const unknown: string = path.join(root, 'fir-valley.pdf');
	const workspace: string = path.join(root, 'ai-import.receiptmatch');
	let running: Awaited<ReturnType<typeof launch>> | undefined;
	try {
		await unknownStatement(unknown);
		running = await launch(playwright, profile);
		const { application, page }: Awaited<ReturnType<typeof launch>> = running;
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByRole('button', { name: 'Sources', exact: true }).click();
		const tryAi: Locator = page.getByRole('button', { name: 'Try with local AI', exact: true });
		await test.step('an unavailable model leaves the selected PDF available for retry', async (): Promise<void> => {
			await openOffer(application, page, unknown);
			await tryAi.click();
			await expect(page.getByTestId('import-outcome')).toContainText('NuExtract3');
			await expect(tryAi).toBeVisible();
			assert.deepEqual(await reports(page), []);
			const selected: string | undefined = (await state(page)).statementFallback?.token;
			assert.ok(selected);
			await page.getByRole('button', { name: 'Import statement', exact: true }).click();
			await expect(page.getByTestId('import-outcome')).toContainText('Import cancelled');
			assert.equal((await state(page)).statementFallback?.token, selected);
			await stageModel(assets, profile);
			const installed: LocalOcrStatus = await page.evaluate((): Promise<LocalOcrStatus> => window.receiptmatch.localOcr({ type: 'status' }));
			assert.equal(installed.device, 'cpu');
			assert.ok(installed.installed && installed.cpuAvailable);
		});
		await test.step('cancels a real recognition run before creating any transactions', async (): Promise<void> => {
			const selected: string | undefined = (await state(page)).statementFallback?.token;
			assert.ok(selected);
			await tryAi.click();
			await expect(page.getByTestId('import-progress')).toContainText('local AI');
			await expect.poll(async (): Promise<string | undefined> => (await state(page)).statementImport?.progress?.phase).toBe('ocr');
			await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
			await expect(page.getByTestId('import-outcome')).toContainText('Import cancelled');
			await expect(tryAi).toBeFocused();
			assert.deepEqual(await reports(page), []);
			assert.equal((await state(page)).statementFallback?.token, selected);
		});
		const imported: string = await test.step('reviews original evidence and makes verified rows available only after confirmation', async (): Promise<string> => {
			await tryAi.click();
			return reviewAndConfirm(page);
		});
		await test.step('skips the same PDF and saves the single retained import', async (): Promise<void> => {
			await dialogs(application, unknown, workspace);
			await page.getByRole('button', { name: 'Import statement', exact: true }).click();
			await expect(page.getByTestId('import-outcome')).toContainText('already in the workspace');
			await expect(tryAi).toHaveCount(0);
			assert.equal((await state(page)).importOutcome?.importId, imported);
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
		});
		await application.close();
		running = undefined;
		running = await launch(playwright, profile);
		const reopened: Page = running.page;
		const restarted: ElectronApplication = running.application;
		await test.step('reopens the AI import and still imports Revolut and Airwallex normally', async (): Promise<void> => {
			await dialogs(restarted, workspace);
			await reopened.getByRole('button', { name: 'Open workspace', exact: true }).click();
			await expect.poll(async (): Promise<string | null | undefined> => (await state(reopened)).workspace?.filePath).toBe(workspace);
			const retained: StoredBankImport[] = await reports(reopened);
			assert.deepEqual(retained.map((record: StoredBankImport): string => record.id), [imported]);
			assert.equal(retained[0].result.transactions.length, 4);
			assert.equal(retained[0].result.unresolvedDrafts.length, 1);
			await reopened.getByRole('button', { name: 'Sources', exact: true }).click();
			for (const [index, bankId] of ['revolut', 'airwallex'].entries()) {
				await dialogs(restarted, path.resolve(`tests/fixtures/${bankId}-synthetic-scan.pdf`));
				await reopened.getByRole('button', { name: 'Import statement', exact: true }).click();
				await expect.poll(async (): Promise<string | undefined> => (await reports(reopened))[index + 1]?.result.adapter?.bankId, { timeout: 30_000 }).toBe(bankId);
				await expect(reopened.getByTestId('import-outcome')).toContainText('Statement imported');
				await expect(reopened.getByTestId('statement-ai-offer')).toHaveCount(0);
			}
		});
	} finally {
		await running?.application.close();
		assert.ok(path.dirname(await realpath(root)) === temporary && path.basename(root).startsWith('statement-ai-ui-'));
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
});
