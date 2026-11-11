import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { statement, row } from '../unit/bank-fixtures.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import { createWorkspace, newMetadata, SCHEMA_VERSION } from '../../electron/store.js';
import type { extractPdfBytes } from '../../electron/extraction/host.js';
import type { WorkspaceCommand, WorkspaceState } from '../../src/shared/protocol.js';

type SingletonProbe = typeof globalThis & { importSingletonProbe?: ReturnType<typeof extractPdfBytes> };
interface DialogPlan {
	opens?: (string | null)[];
	saves?: (string | null)[];
	choices?: number[];
}
interface ImportReport {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: 'running' | 'passed' | 'failed';
	platform: NodeJS.Platform;
	syntheticOnly: true;
	checks: { name: string; status: 'passed'; milliseconds: number }[];
	limits?: string[];
	error?: string;
	stack?: string;
}
interface BankImportTest {
	root: string;
	report: ImportReport;
	launch(): Promise<{ application: ElectronApplication; page: Page }>;
	close(): Promise<void>;
	check(name: string, action: () => Promise<void>): Promise<void>;
}
async function mockDialogs(application: ElectronApplication, { opens = [], saves = [], choices = [] }: DialogPlan) {
	await application.evaluate(
		({ dialog }, plan) => {
			dialog.showOpenDialog = async () => {
				const selected = plan.opens.shift();
				return { canceled: !selected, filePaths: selected ? [selected] : [] };
			};
			dialog.showSaveDialog = async () => {
				const selected = plan.saves.shift() ?? '';
				return { canceled: !selected, filePath: selected };
			};
			dialog.showMessageBox = async () => ({ response: plan.choices.shift() ?? 2, checkboxChecked: false });
		},
		{ opens, saves, choices }
	);
}

const test = base.extend<{ bankImport: BankImportTest }>({
	bankImport: async ({ playwright }, use, testInfo) => {
		await mkdir('artifacts', { recursive: true });
		const root = await mkdtemp(path.resolve('artifacts/import-'));
		const reportPath = path.resolve(`artifacts/import-${process.platform}.json`);
		const report: ImportReport = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', platform: process.platform, syntheticOnly: true, checks: [] };
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		let activeApplication: ElectronApplication | undefined;

		async function launch() {
			const application = await playwright._electron.launch({
				executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
				args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
				timeout: 30_000
			});
			activeApplication = application;
			application.on('close', () => {
				if (activeApplication === application) activeApplication = undefined;
			});
			const page = await application.firstWindow({ timeout: 30_000 });
			page.setDefaultTimeout(30_000);
			await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
			return { application, page };
		}
		async function close() {
			const application = activeApplication;
			if (application) {
				try {
					await mockDialogs(application, { choices: [1] });
				} finally {
					await application.close();
				}
			}
		}
		async function check(name: string, action: () => Promise<void>) {
			const start = performance.now();
			await test.step(name, action);
			report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) });
		}

		await use({ root, report, launch, close, check });
		let cleanupError: unknown;
		try {
			await close();
		} catch (error) {
			cleanupError = error;
		}
		report.status = testInfo.status === 'passed' && cleanupError === undefined ? 'passed' : 'failed';
		report.error = testInfo.error?.message ?? (cleanupError === undefined ? undefined : String(cleanupError));
		report.stack = testInfo.error?.stack ?? (cleanupError instanceof Error ? cleanupError.stack : undefined);
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		if (cleanupError !== undefined) throw cleanupError;
	}
});

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(file: string) {
	return sha(await readFile(file));
}

async function fixture(file: string, partial = false, title = 'Independently invented statement') {
	const input = statement();
	if (partial) input.pages[0].spans.push(...row(335, '26 Feb 2032', 'To: Cedar Tools', null, null));
	const pdf = await PDFDocument.create();
	pdf.setTitle(title);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const item of input.pages) {
		const sheet = pdf.addPage([item.width, item.height]);
		for (const span of item.spans) sheet.drawText(span.text, { x: span.region.x, y: item.height - span.region.y - 10, size: 10, font });
	}
	await writeFile(file, await pdf.save());
}
test.describe.configure({ timeout: 180_000 });

test('packaged Electron bank import', async ({ bankImport: { root, report, launch, close, check } }) => {
	let application: ElectronApplication;
	let page: Page;
	async function dialogs(plan: DialogPlan) {
		await mockDialogs(application, plan);
	}
	async function command(value: WorkspaceCommand) {
		return page.evaluate((payload) => window.receiptmatch.command(payload), value);
	}
	async function records() {
		return page.evaluate(() => window.receiptmatch.bankImports());
	}
	async function reopen(file: string) {
		await close();
		({ application, page } = await launch());
		await dialogs({ opens: [file] });
		const state = await command({ type: 'open' });
		assert.equal(state.error, null);
		assert.equal(state.workspace?.filePath, file);
		return state;
	}

	const original = path.join(root, 'invented-statement.pdf');
	await fixture(original);
	const duplicate = path.join(root, 'same-bytes-different-name.pdf');
	await copyFile(original, duplicate);
	const partial = path.join(root, 'invented-partial.pdf');
	await fixture(partial, true, 'Explicit unresolved payment');
	const independent = path.join(root, 'independent-same-amounts.pdf');
	await fixture(independent, false, 'Different source with equal transaction amounts');
	const invalid = path.join(root, 'malformed.pdf');
	await writeFile(invalid, 'Not a PDF.');
	const unknown = path.join(root, 'unknown-bank.pdf');
	const unknownPdf = await PDFDocument.create();
	const unknownFont = await unknownPdf.embedFont(StandardFonts.Helvetica);
	unknownPdf.addPage().drawText('Unsupported synthetic bank layout', { font: unknownFont });
	await writeFile(unknown, await unknownPdf.save());
	const file = path.join(root, 'records.receiptmatch');
	const originalHash = await fingerprint(original);
	({ application, page } = await launch());
	await check('only-active-workspace-frame-can-use-path-free-import-api', async () => {
		assert.deepEqual(await records(), []);
		assert.equal((await command({ type: 'import-statement' })).workspace, null);
		const unsupportedCommand = { type: 'import-statement', filePath: original } as const;
		const denied = await command(unsupportedCommand);
		assert.match(denied.error ?? '', /not supported/);
		const probe = await application.evaluate(async ({ app, BrowserWindow }) => {
			const extra = new BrowserWindow({
				show: false,
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: `${app.getAppPath()}/.build/preload.cjs` }
			});
			try {
				await extra.loadURL('receiptmatch://app/index.html');
				return await extra.webContents.executeJavaScript(
					"Promise.all([window.receiptmatch.bankImports(), window.receiptmatch.command({type:'import-statement'})].map(value => value.then(() => 'allowed', () => 'denied')))"
				);
			} finally {
				extra.destroy();
			}
		});
		assert.deepEqual(probe, ['denied', 'denied']);
	});
	await command({ type: 'new' });
	await command({ type: 'rename', name: 'Synthetic import records' });
	await dialogs({ saves: [file] });
	await command({ type: 'save' });
	let imported: StoredBankImport;
	await check('native-import-uses-shared-engine-and-remains-unsaved-until-explicit-save', async () => {
		const before = await fingerprint(file);
		await application.evaluate(
			({ app }, base64) => {
				const require = process.getBuiltinModule('node:module')!.createRequire(`${app.getAppPath()}/package.json`);
				const host: typeof import('../../electron/extraction/host.js') = require(`${app.getAppPath()}/.build/extraction-host.cjs`);
				app.once('browser-window-created', () => {
					(globalThis as SingletonProbe).importSingletonProbe = host.extractPdfBytes(Buffer.from(base64, 'base64'), 'independent-singleton-probe');
				});
			},
			(await readFile(original)).toString('base64')
		);
		await dialogs({ opens: [original] });
		const state = await command({ type: 'import-statement' });
		assert.equal(state.error, null);
		assert.equal(state.importOutcome?.status, 'imported');
		assert.equal(state.workspace?.dirty, true);
		assert.equal(await fingerprint(file), before);
		assert.equal(await fingerprint(original), originalHash);
		[imported] = await records();
		storedBankImportSchema.parse(imported);
		assert.equal(imported.result.transactions.length, 2);
		assert.equal(imported.result.unresolvedDrafts.length, 0);
		assert.equal(imported.result.transactions[0].accountAmount?.value.coefficient, '-123456');
		assert.equal(imported.result.transactions[0].reportedOriginalAmount?.value.coefficient, '-150001');
		assert.equal(imported.result.transactions[1].accountAmount?.value.coefficient, '2507');
		assert.equal(imported.result.sourceProvenance?.sha256, originalHash);
		const singleton = await application.evaluate(() => (globalThis as SingletonProbe).importSingletonProbe);
		assert.equal(singleton?.status, 'failed');
		assert.equal(singleton.issues[0].code, 'busy');
	});
	await check('identical-unsaved-source-is-skipped-without-adding-records', async () => {
		await dialogs({ opens: [duplicate] });
		const state = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'skipped');
		assert.equal(state.workspace?.dirty, true);
		assert.deepEqual(await records(), [imported]);
	});
	await command({ type: 'save' });
	await check('explicit-save-restart-and-duplicate-skip-preserve-full-import-and-clean-state', async () => {
		await reopen(file);
		assert.deepEqual(await records(), [imported]);
		const before = await fingerprint(file);
		await dialogs({ opens: [duplicate] });
		const state = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'skipped');
		assert.equal(state.workspace?.dirty, false);
		assert.equal(await fingerprint(file), before);
	});
	let retained: StoredBankImport[];
	await check('partial-import-preserves-unresolved-fields-evidence-and-exact-values-after-restart', async () => {
		await dialogs({ opens: [partial] });
		const state = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'imported');
		assert.equal(state.workspace?.dirty, true);
		retained = await records();
		const record = retained.at(-1);
		assert.ok(record);
		assert.equal(record.result.status, 'partial');
		assert.equal(record.result.transactions.length, 2);
		assert.equal(record.result.unresolvedDrafts.length, 1);
		assert.equal(record.result.unresolvedDrafts[0].accountAmount, null);
		assert.equal(record.drafts.length, 1);
		assert.ok(record.result.unresolvedDrafts[0].evidence.length);
		assert.ok(record.result.unresolvedDrafts[0].issues.length);
		await command({ type: 'save' });
		await reopen(file);
		assert.deepEqual(await records(), retained);
	});
	await check('unsupported-unreadable-password-and-cancelled-selection-preserve-current-work', async () => {
		const before = await fingerprint(file);
		for (const [selected, outcome] of [
			[unknown, 'unsupported'],
			[invalid, 'failed'],
			[path.resolve('tests/fixtures/password-required.pdf'), 'failed'],
			[null, 'cancelled']
		] as const) {
			await dialogs({ opens: [selected] });
			const state = await command({ type: 'import-statement' });
			assert.equal(state.importOutcome?.status, outcome);
			assert.equal(state.workspace?.dirty, false);
			assert.deepEqual(await records(), retained);
			assert.equal(await fingerprint(file), before);
		}
	});
	await check('equal-amounts-in-different-sources-are-kept-and-failed-save-retains-unsaved-work', async () => {
		await dialogs({ opens: [independent] });
		const state = await command({ type: 'import-statement' });
		assert.equal(state.importOutcome?.status, 'imported');
		const pending = await records();
		assert.equal(pending.length, 3);
		assert.notEqual(pending[0].transactions[0].transactionId, pending[2].transactions[0].transactionId);
		const before = await fingerprint(file);
		await rename(file, `${file}.away`);
		try {
			const failed = await command({ type: 'save' });
			assert.ok(failed.error);
			assert.equal(failed.workspace?.dirty, true);
			assert.deepEqual(await records(), pending);
		} finally {
			await rename(`${file}.away`, file);
		}
		assert.equal(await fingerprint(file), before);
		const saved = await command({ type: 'save' });
		assert.equal(saved.workspace?.dirty, false);
		await reopen(file);
		retained = pending;
		assert.deepEqual(await records(), retained);
		const db = new Database(file, { readonly: true });
		try {
			assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM transactions').get()?.n, 6);
			assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bank_imports').get()?.n, 3);
		} finally {
			db.close();
		}
	});
	await check('active-import-cancels-through-renderer-ipc-and-cannot-replace-workspace', async () => {
		const png = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 1200;
			canvas.height = 1600;
			const ctx = canvas.getContext('2d')!;
			ctx.fillStyle = 'white';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = 'black';
			ctx.font = '32px sans-serif';
			for (let line = 0; line < 35; line++) ctx.fillText(`Synthetic cancellation page line ${line + 1} TOTAL EUR 123.45`, 35, 60 + line * 42);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const scan = await PDFDocument.create();
		const image = await scan.embedPng(Buffer.from(png, 'base64'));
		scan.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
		const selected = path.join(root, 'synthetic-cancellation.pdf');
		await writeFile(selected, await scan.save());
		const before = await fingerprint(file);
		await dialogs({ opens: [selected] });
		const result = await page.evaluate(async () => {
			let guarded: Promise<WorkspaceState[]> | undefined;
			let cancelling: Promise<WorkspaceState> | undefined;
			const unsubscribe = window.receiptmatch.subscribe((state) => {
				if (state.statementImport?.progress?.phase === 'ocr' && !cancelling) {
					guarded = Promise.all((['new', 'open', 'save'] as const).map((type) => window.receiptmatch.command({ type })));
					cancelling = window.receiptmatch.command({ type: 'cancel-import' });
				}
			});
			try {
				const state = await window.receiptmatch.command({ type: 'import-statement' });
				return { state, guarded: await guarded, cancelled: Boolean(cancelling) };
			} finally {
				unsubscribe();
			}
		});
		assert.equal(result.cancelled, true);
		assert.ok(result.guarded?.length === 3 && result.guarded.every((state) => state.error));
		assert.equal(result.state.importOutcome?.status, 'cancelled');
		assert.equal(result.state.workspace?.filePath, file);
		assert.equal(result.state.workspace?.dirty, false);
		assert.deepEqual(await records(), retained);
		assert.equal(await fingerprint(file), before);
		await dialogs({ opens: [duplicate] });
		assert.equal((await command({ type: 'import-statement' })).importOutcome?.status, 'skipped');
	});
	await check('legacy-workspace-stays-read-only-until-save-and-preserves-manual-decisions-during-migration', async () => {
		const legacy = path.join(root, 'legacy.receiptmatch');
		await createWorkspace(legacy, { ...newMetadata(), name: 'Legacy decisions' });
		const seed = new Database(legacy);
		seed.pragma('foreign_keys=ON');
		try {
			// The seven original tables are unchanged; remove the additive manifest to reproduce format 1.
			seed.exec(`DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews; DROP TABLE match_results; DROP TABLE document_imports; DROP TABLE bank_imports; PRAGMA user_version=1;
                INSERT INTO sources VALUES('legacy-source','/synthetic/original.pdf',NULL);
                INSERT INTO accounts VALUES('legacy-account','Legacy account','EUR');
                INSERT INTO statements VALUES('legacy-statement','legacy-account','legacy-source');
                INSERT INTO transactions VALUES('legacy-transaction','legacy-statement','9007199254740993','EUR',2,1);
                INSERT INTO documents VALUES('legacy-document','legacy-source',1);
                INSERT INTO associations VALUES('legacy-association','legacy-transaction','legacy-document','uncertain',1,'1:1:1');`);
		} finally {
			seed.close();
		}
		const before = await fingerprint(legacy);
		const opened = await reopen(legacy);
		assert.equal(opened.workspace?.dirty, false);
		assert.equal(await fingerprint(legacy), before);
		await dialogs({ opens: [original] });
		const importedState = await command({ type: 'import-statement' });
		assert.equal(importedState.importOutcome?.status, 'imported');
		assert.equal(importedState.workspace?.dirty, true);
		assert.equal(await fingerprint(legacy), before);
		assert.equal((await command({ type: 'save' })).workspace?.dirty, false);
		const db = new Database(legacy, { readonly: true });
		try {
			assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
			assert.equal(
				db.prepare<[string], { coefficient: string }>('SELECT coefficient FROM transactions WHERE id=?').get('legacy-transaction')?.coefficient,
				'9007199254740993'
			);
			assert.deepEqual(db.prepare('SELECT confidence,approved_revision FROM associations WHERE id=?').get('legacy-association'), {
				confidence: 'uncertain',
				approved_revision: '1:1:1'
			});
		} finally {
			db.close();
		}
		await reopen(legacy);
		const savedImports = await records();
		assert.equal(savedImports.length, 1);
		assert.equal(savedImports[0].result.transactions.length, 2);
	});
	await check('booking-correction-promotes-a-draft-and-restores-original-evidence-after-reopening', async () => {
		const source = retained.find(record => record.filePath === partial);
		assert.ok(source);
		const file = path.join(root, 'booking-correction.receiptmatch');
		await createWorkspace(file, newMetadata(), [source]);
		await reopen(file);
		const before = await fingerprint(file);
		const draft = page.getByTestId('drafts-table').getByRole('row', { name: /Cedar Tools/ });
		await draft.getByRole('button', { name: 'Correct booking details' }).press('Enter');
		const editor = page.getByRole('region', { name: 'Correct booking details' });
		await expect(editor.getByRole('heading')).toBeFocused();
		await editor.getByLabel('Booking date', { exact: true }).fill('2032-02-25');
		const decimal = await page.evaluate(() => new Intl.NumberFormat().formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.');
		await editor.getByLabel('Account amount (EUR)').fill(`-256${decimal}20`);
		await editor.getByRole('button', { name: 'Apply correction' }).click();
		await expect(editor.getByText('Correction applied to this workspace.')).toBeVisible();
		await expect(draft).toHaveCount(0);
		const transaction = page.getByTestId('transactions-table').getByRole('row', { name: /Cedar Tools/ });
		await expect(transaction.getByText('Corrected', { exact: true })).toBeVisible();
		await expect(transaction.getByText(/256[.,]20/)).toBeVisible();
		await expect(editor.getByText('Unknown', { exact: true })).toBeVisible();
		assert.equal(await fingerprint(file), before);
		await page.getByRole('button', { name: 'Match suggestions' }).click();
		await expect(page.getByRole('row', { name: /Cedar Tools/ })).toBeVisible();
		await command({ type: 'save' });
		const reopened = await reopen(file);
		assert.deepEqual(await records(), [source]);
		assert.equal(reopened.workspace?.imports[0].drafts, 0);
		assert.deepEqual(reopened.workspace?.bankCorrections[0], {
			rowId: source.drafts[0].draftId, revision: 2, bookingDate: '2032-02-25', accountAmount: { currency: 'EUR', coefficient: '-25620', scale: 2 }
		});
		await expect(page.getByTestId('transactions-table').getByRole('row', { name: /Cedar Tools.*Corrected/ })).toBeVisible();
	});
	assert.equal(await fingerprint(original), originalHash);
	report.limits = [
		'Backend API workflow with synthetic PDF inputs and automation-supplied native dialog choices.',
		'Import controls and transaction views are subsequent work; no installer or sustained-workload certification.'
	];
});
