import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from '@playwright/test';

test('packaged OCR runs with installed local models and switches to standard recognition', async ({ playwright }) => {
	const profile = process.env.RECEIPTMATCH_OCR_TEST_PROFILE;
	test.skip(!profile, 'Requires a dedicated profile for model installation and offline verification.');
	assert.ok(profile && path.isAbsolute(profile));
	test.setTimeout(600_000);
	const executablePath = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
	const application = await playwright._electron.launch({
		executablePath, args: ['--hidden', '--disable-gpu', `--user-data-dir=${profile}`], timeout: 30_000
	});
	try {
		const page = await application.firstWindow();
		await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
		const images = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 690;
			canvas.height = 560;
			const context = canvas.getContext('2d')!;
			context.fillStyle = 'white';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = 'black';
			context.font = '30px monospace';
			['INVOICE', 'Cedar Workshop', 'Invoice Date: 2026-10-12', 'Subtotal EUR 40.75', 'Tax EUR 8.00', 'Grand Total EUR 48.75'].forEach((line, index) => {
				context.fillText(line, 54, 62 + 62 * index);
			});
			// Give each engine a distinct source for the importer's duplicate detection.
			return [0, 1, 2].map(offset => {
				context.fillRect(offset, canvas.height - 1, 1, 1);
				return canvas.toDataURL('image/png').split(',')[1];
			});
		});
		const models = ['pp-ocrv6-medium', 'paddleocr-vl-1.6'] as const;
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const initial = await page.evaluate(() => window.receiptmatch.localOcr({ type: 'status' }));
		assert.ok(initial.models.every(model => model.runtimeAvailable), 'Both runtimes must be shipped in the package.');
		if (process.env.RECEIPTMATCH_OCR_TEST_INSTALL === '1') {
			assert.equal(initial.selection, 'standard');
			assert.ok(initial.models.every(model => !model.installed), 'Install mode requires a fresh test profile.');
			await application.evaluate(({ dialog }) => {
				dialog.showMessageBox = async (windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions) => {
					if ((options ?? (windowOrOptions as Electron.MessageBoxOptions)).title !== 'Download OCR model') throw new Error('Unexpected model installation prompt.');
					return { response: 0, checkboxChecked: false };
				};
			});
			for (const model of models) {
				const result = await page.evaluate(model => window.receiptmatch.localOcr({ type: 'install', model }), model);
				assert.equal(result.selection, model);
				assert.equal(result.models.find(entry => entry.model === model)?.installed, true);
			}
			return;
		}
		assert.ok(initial.models.every(model => model.installed), 'Install models with RECEIPTMATCH_OCR_TEST_INSTALL=1 first.');
		await application.evaluate(() => {
			globalThis.fetch = async () => { throw new Error('Network fetch is disabled in this offline test.'); };
		});
		await page.getByRole('button', { name: 'Back', exact: true }).click();
		await page.getByRole('button', { name: 'Create workspace' }).click();
		for (const [index, model] of ([...models, 'standard'] as const).entries()) {
			const selection = await page.evaluate(selection => window.receiptmatch.localOcr({ type: 'select', selection }), model);
			assert.equal(selection.selection, model);
			const folder = path.join(profile, 'fixtures', model);
			await mkdir(folder, { recursive: true });
			const sample = path.join(folder, 'receipt.png');
			await writeFile(sample, Buffer.from(images[index], 'base64'));
			await application.evaluate(({ dialog }, folder) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
			}, folder);
			await page.evaluate(() => window.receiptmatch.command({ type: 'import-documents' }));
			await page.waitForFunction(async () => !(await window.receiptmatch.command({ type: 'get-state' })).busy, undefined, { timeout: 150_000 });
			const imports = await page.evaluate(() => window.receiptmatch.documentImports());
			const record = imports.flatMap(run => run.files).find(file => file.status === 'imported' && file.record.filePath === sample);
			assert.ok(record?.status === 'imported', JSON.stringify(imports.at(-1)?.files));
			assert.ok(record.record.result.input?.extraction.version.includes(model === 'standard' ? 'tesseract' : model));
			assert.ok(record.record.result.sections.some(section => section.amounts.some(field => field.role === 'billed-total' &&
				field.evidence.length && field.candidates.some(amount => amount.currency === 'EUR' && amount.coefficient === '4875' && amount.scale === 2))));
		}
	} finally {
		await application.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		});
		await application.close();
	}
});
