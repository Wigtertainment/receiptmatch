import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { readExportFilenamePattern, saveExportFilenamePattern } from '../../electron/export-settings.js';
import { defaultExportFilenamePattern, exportFilenameExample, renderExportFilename } from '../../src/shared/export-filename.js';

test('renders a configurable filename with the exact signed booking amount and original extension', (): void => {
	assert.deepEqual(renderExportFilename(defaultExportFilenamePattern, exportFilenameExample), { filename: '2026-10-21_Example-Merchant_EUR_-176.77.pdf' });
	assert.deepEqual(renderExportFilename('{amount} {counterparty}', {
		...exportFilenameExample, counterparty: 'Café / Café', extension: 'jpeg', amount: { currency: 'EUR', coefficient: '-900719925474099327', scale: 2 },
	}), { filename: '-9007199254740993.27 Café-Café.jpeg' });
	assert.deepEqual(renderExportFilename('{counterparty}', { ...exportFilenameExample, counterparty: 'NUL' }), { filename: '_NUL.pdf' });
	assert.deepEqual(renderExportFilename('{counterparty}', { ...exportFilenameExample, counterparty: null }), { filename: 'Unknown.pdf' });
});

test('rejects path syntax, unsupported placeholders, reserved names and overlong filenames', (): void => {
	for (const pattern of [' ', '../{date}', 'C:\\Exports\\{date}', 'receipt\0', '{date', '{transactionId}', 'LPT1.backup', '{date}.', 'é'.repeat(130)]) {
		assert.ok(renderExportFilename(pattern, exportFilenameExample).error, pattern);
	}
});

test('persists a validated pattern independently of workspaces', async (context: TestContext & object): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-export-settings-'));
	context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
	const file: string = path.join(root, 'export-settings.json');
	assert.equal(await readExportFilenamePattern(file), defaultExportFilenamePattern);
	await writeFile(file, '{malformed', 'utf8');
	assert.equal(await readExportFilenamePattern(file), defaultExportFilenamePattern);
	assert.equal(await saveExportFilenamePattern(file, '  {counterparty}_{date}  '), '{counterparty}_{date}');
	await assert.rejects(saveExportFilenamePattern(file, '../{date}'), /Invalid export filename pattern/);
	assert.equal(await readExportFilenamePattern(file), '{counterparty}_{date}');
	assert.equal(await saveExportFilenamePattern(file, defaultExportFilenamePattern), defaultExportFilenamePattern);
	assert.equal(await readExportFilenamePattern(file), defaultExportFilenamePattern);
});
