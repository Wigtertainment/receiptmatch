import type { BankCorrection } from "../../src/shared/bank-corrections.js";
import type { DocumentCorrection } from "../../src/shared/document-corrections.js";
import type { DuplicateDecision } from "../../src/shared/transaction-duplicates.js";
import type { MatchReviewCounts } from "../../src/shared/workspace-matching.js";
import type { DocumentImportSummary } from "../../src/shared/protocol.js";
import type { BankImportSummary } from "../../src/shared/workspace-import.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test as base, type ElectronApplication, type Page, type Locator, type TestInfo, type PlaywrightWorkerOptions, type PlaywrightWorkerArgs, type PlaywrightTestOptions, type PlaywrightTestArgs, type TestType } from '@playwright/test';
import Database from 'better-sqlite3';
import { createWorkspace, fingerprint, newMetadata } from '../../electron/store.js';
import type { WorkspaceCommand, WorkspaceView } from '../../src/shared/protocol.js';

interface DialogPlan {
	saves?: (string | null)[];
	opens?: (string | null)[];
	choices?: number[];
}

interface SmokeReport {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: 'running' | 'passed' | 'failed';
	platform: NodeJS.Platform;
	root: string;
	checks: { name: string; status: 'passed'; milliseconds: number }[];
	screenshots: string[];
	screenshotErrors?: { name: string; error: string }[];
	error?: string;
	stack?: string;
}

async function mockDialogs(application: ElectronApplication, { saves = [], opens = [], choices = [] }: DialogPlan): Promise<void> {
	await application.evaluate(
		({ dialog }: typeof Electron.CrossProcessExports, plan: { saves: (string | null)[]; opens: (string | null)[]; choices: number[]; }): void => {
			dialog.showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string; }> => {
				const filePath: string = plan.saves.shift() ?? '';
				return Promise.resolve({ canceled: !filePath, filePath });
			};
			dialog.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[]; }> => {
				const filePath: string | null | undefined = plan.opens.shift();
				return Promise.resolve({ canceled: !filePath, filePaths: filePath ? [filePath] : [] });
			};
			dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve(({ response: plan.choices.shift() ?? 2, checkboxChecked: false }));
		},
		{ saves, opens, choices }
	);
}

interface PackagedSmoke {
	root: string;
	report: SmokeReport;
	check: (name: string, action: () => Promise<void>) => Promise<void>;
	launch: () => Promise<{ application: ElectronApplication; page: Page }>;
}

const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & { smoke: PackagedSmoke; }, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<{ smoke: PackagedSmoke }>({
	smoke: async ({ playwright }: { smoke: PackagedSmoke; } & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, use: (r: PackagedSmoke) => Promise<void>, testInfo: TestInfo): Promise<void> => {
		await mkdir('artifacts', { recursive: true });
		const root: string = await mkdtemp(path.resolve('artifacts/workspace-ui-'));
		const reportPath: string = path.resolve(`artifacts/workspace-ui-${process.platform}.json`);
		const report: SmokeReport = {
			runId: randomUUID(),
			startedAt: new Date().toISOString(),
			status: 'running',
			platform: process.platform,
			root,
			checks: [],
			screenshots: []
		};
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		let activeApplication: ElectronApplication | undefined;

		async function check(name: string, action: () => Promise<void>): Promise<void> {
			const started: number = performance.now();
			await test.step(name, action);
			report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - started) });
		}

		async function launch(): Promise<{ application: ElectronApplication; page: Page; }> {
			const executablePath: string = path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch');
			const application: ElectronApplication = await playwright._electron.launch({
				executablePath,
				args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
				timeout: 30000,
				env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
			});
			activeApplication = application;
			application.on('close', (): void => {
				if (activeApplication === application) {
					activeApplication = undefined;
				}
			});
			const page: Page = await application.firstWindow({ timeout: 30_000 });
			page.setDefaultTimeout(30_000);
			await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
			await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
			return { application, page };
		}

		await use({ root, report, check, launch });

		let cleanupError: unknown;
		try {
			const application: ElectronApplication | undefined = activeApplication;
			if (application) {
				try {
					await mockDialogs(application, { choices: [1] });
				} finally {
					await application.close();
				}
			}
		} catch (error: unknown) {
			cleanupError = error;
			report.error = String(error);
			if (error instanceof Error) {
				report.stack = error.stack;
			}
		}
		report.status = testInfo.status === 'passed' && !report.error ? 'passed' : 'failed';
		report.error = testInfo.error?.message ?? report.error;
		report.stack = testInfo.error?.stack ?? report.stack;
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		if (cleanupError !== undefined) {
			throw cleanupError instanceof Error ? cleanupError : new Error('Test cleanup failed.', { cause: cleanupError });
		}
	}
});

test.describe.configure({ timeout: 180_000 });

test('packaged Electron workspace smoke test', async ({ smoke: { root, report, check, launch } }: PlaywrightTestArgs & PlaywrightTestOptions & { smoke: PackagedSmoke; } & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	let { application, page }: { application: ElectronApplication; page: Page; } = await launch();

	async function dialogs(plan: DialogPlan): Promise<void> {
		await mockDialogs(application, plan);
	}

	async function state(): Promise<WorkspaceState> {
		return page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'get-state' }));
	}

	async function waitState(expected: Partial<WorkspaceView>): Promise<void> {
		await page.waitForFunction(async (values: Partial<WorkspaceView>): Promise<boolean> => {
			const value: WorkspaceState = await window.receiptmatch.command({ type: 'get-state' });
			return !value.busy && Object.entries(values).every(([key, wanted]: [string, string | number | boolean | string[] | BankImportSummary[] | BankCorrection[] | DocumentImportSummary[] | MatchReviewCounts | DocumentCorrection[] | DuplicateDecision[] | null]): boolean => value.workspace?.[key as keyof WorkspaceView] === wanted);
		}, expected);
	}

	async function screenshot(name: string): Promise<void> {
		const file: string = path.join(root, `${name}.png`);
		try {
			await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.invalidate());
			await page.screenshot({ path: file, animations: 'disabled', timeout: 10000 });
			report.screenshots.push(file);
		} catch (error: unknown) {
			(report.screenshotErrors ??= []).push({ name, error: String(error) });
		}
	}

	await check('packaged-empty-application-security-and-offline-boundaries', async (): Promise<void> => {
		await screenshot('welcome');
		const preferences: { sandbox: boolean | undefined; contextIsolation: boolean | undefined; nodeIntegration: boolean | undefined; } = await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): { sandbox: boolean | undefined; contextIsolation: boolean | undefined; nodeIntegration: boolean | undefined; } => {
			const contents: Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences; } = BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences };
			const value: Electron.WebPreferences = contents.getLastWebPreferences();
			return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
		});
		assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
		assert.deepEqual(await page.evaluate((): string[] => Object.keys(window.receiptmatch)), [
			'command', 'bankImports', 'documentImports', 'documentSnapshot', 'matchSummaries', 'matchDetails', 'openOriginal', 'relinkOriginal',
			'analyzeOriginal', 'acceptOriginalAnalysis', 'exportSettings', 'localOcr', 'exportDocuments', 'exportReconciliation', 'subscribe',
		]);
		assert.equal(await page.evaluate((): "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function" => typeof Reflect.get(window, 'require')), 'undefined');
		assert.equal(
			await page.evaluate((): Promise<boolean> =>
				fetch('https://example.invalid/').then(
					(): boolean => false,
					(): boolean => true
				)
			),
			true
		);
		const invalid: WorkspaceState = await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'write-file', path: '/arbitrary' } as unknown as WorkspaceCommand));
		assert.equal(invalid.workspace, null);
		assert.match(invalid.error ?? '', /not supported/);
		assert.equal(await application.evaluate(({ ipcMain }: typeof Electron.CrossProcessExports): number => ipcMain.listenerCount('write-file')), 0);
		assert.equal(await application.evaluate(async ({ net }: typeof Electron.CrossProcessExports): Promise<number> => (await net.fetch('receiptmatch://app/electron/main.ts')).status), 404);
	});
	const file: string = path.join(root, 'November.receiptmatch');
	await check('new-workspace-real-keyboard-entry-and-cancelled-first-save', async (): Promise<void> => {
		const create: Locator = page.locator('wig-button').getByRole('button', { name: 'Create workspace', exact: true });
		assert.equal(await create.evaluate((button: HTMLElement | SVGElement): string => getComputedStyle(button).alignItems), 'center');
		assert.equal(await create.locator('svg').count(), 1);
		const styles: { nonceApplied: boolean; tokensLoaded: boolean; } = await page.evaluate((): { nonceApplied: boolean; tokensLoaded: boolean; } => {
			const componentStyle: HTMLStyleElement | undefined = [...document.querySelectorAll('style')].find((style: HTMLStyleElement): boolean => style.textContent.includes('wig-button-min-height'));
			return { nonceApplied: !!componentStyle?.nonce && !!componentStyle.sheet, tokensLoaded: !!getComputedStyle(document.documentElement).getPropertyValue('--wig-color-action').trim() };
		});
		assert.deepEqual(styles, { nonceApplied: true, tokensLoaded: true });
		await create.press('Enter');
		await waitState({ dirty: true, filePath: null });
		const input: Locator = page.getByLabel('Workspace name', { exact: true });
		await input.fill('');
		await input.pressSequentially('November 2026', { delay: 12 });
		await waitState({ name: 'November 2026' });
		assert.equal(await input.inputValue(), 'November 2026');
		assert.equal(await input.evaluate((element: HTMLElement | SVGElement): boolean => element === document.activeElement), true);
		await dialogs({ saves: [null] });
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await waitState({ name: 'November 2026', dirty: true, filePath: null });
		await dialogs({ saves: [file] });
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await waitState({ dirty: false, filePath: file });
		await screenshot('workspace');
	});
	await check('workspace-path-stays-inline-and-shows-the-full-path-only-when-clipped', async (): Promise<void> => {
		const location: Locator = page.locator('.workspace-location');
		const name: Locator = page.getByRole('textbox', { name: 'Workspace name' });
		const clipped: () => Promise<boolean> = (): Promise<boolean> => location.evaluate((element: HTMLElement | SVGElement): boolean => element.scrollWidth > element.clientWidth);

		await location.evaluate((element: HTMLElement | SVGElement): void => element.parentElement!.style.setProperty('flex', '0 1 180px'));
		assert.equal(await location.textContent(), file);
		await expect.poll(clipped).toBe(true);
		await location.hover();
		assert.equal(await location.getAttribute('title'), file);
		assert.equal(await location.evaluate((element: HTMLElement | SVGElement): string => getComputedStyle(element).whiteSpace), 'nowrap');
		assert.equal(await location.evaluate((element: HTMLElement | SVGElement): string => getComputedStyle(element).textOverflow), 'ellipsis');
		const [input, displayedPath]: [{ x: number; y: number; width: number; height: number; } | null, { x: number; y: number; width: number; height: number; } | null] = await Promise.all([name.boundingBox(), location.boundingBox()]);
		assert.ok(input && displayedPath && displayedPath.x >= input.x + input.width && displayedPath.y >= input.y && displayedPath.y < input.y + input.height);
		await location.evaluate((element: HTMLElement | SVGElement): void => {
			element.style.setProperty('min-width', element.scrollWidth + 'px');
			element.dispatchEvent(new MouseEvent('mouseenter'));
		});
		assert.equal(await clipped(), false);
		assert.equal(await location.getAttribute('title'), '');
		await location.evaluate((element: HTMLElement | SVGElement): string => element.style.removeProperty('min-width'));
		await location.evaluate((element: HTMLElement | SVGElement): string => element.parentElement!.style.removeProperty('flex'));
	});
	await check('unsaved-new-cancel-and-save-choice', async (): Promise<void> => {
		const id: string | undefined = (await state()).workspace?.id;
		assert.ok(id);
		await page.getByLabel('Workspace name', { exact: true }).fill('Edited workspace');
		await waitState({ name: 'Edited workspace', dirty: true });
		await dialogs({ choices: [2] });
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await waitState({ id, dirty: true });
		await dialogs({ choices: [0] });
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await waitState({ filePath: null, dirty: true });
		const read: Database.Database = new Database(file, { readonly: true });
		try {
			assert.equal(read.prepare<[], { name: string }>('SELECT name FROM workspace').get()?.name, 'Edited workspace');
		} finally {
			read.close();
		}
	});
	await check('existing-target-collision-and-failed-or-cancelled-open-preserve-current-work', async (): Promise<void> => {
		const protectedFile: string = path.join(root, 'original.receiptmatch');
		await writeFile(protectedFile, 'an unrelated original');
		const originalHash: string = await fingerprint(protectedFile);
		await page.getByLabel('Workspace name', { exact: true }).fill('Unsaved work');
		await waitState({ name: 'Unsaved work' });
		const id: string | undefined = (await state()).workspace?.id;
		assert.ok(id);
		await dialogs({ saves: [protectedFile] });
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await page.getByRole('alert').waitFor();
		await waitState({ id, dirty: true });
		assert.equal(await fingerprint(protectedFile), originalHash);
		await dialogs({ choices: [1], opens: [null] });
		await page.getByRole('button', { name: 'Open', exact: true }).click();
		await waitState({ id, dirty: true });
		const foreign: string = path.join(root, 'foreign.receiptmatch');
		const other: Database.Database = new Database(foreign);
		other.exec('CREATE TABLE other(value TEXT)');
		other.close();
		const corrupt: string = path.join(root, 'corrupt.receiptmatch');
		await writeFile(corrupt, 'damaged file');
		const future: string = path.join(root, 'future.receiptmatch');
		await createWorkspace(future, newMetadata());
		const futureDb: Database.Database = new Database(future);
		futureDb.pragma('user_version=99');
		futureDb.close();
		for (const selected of [foreign, corrupt, future]) {
			const before: string = await fingerprint(selected);
			await dialogs({ choices: [1], opens: [selected] });
			await page.getByRole('button', { name: 'Open', exact: true }).click();
			await page.getByRole('alert').waitFor();
			await waitState({ id, name: 'Unsaved work', dirty: true });
			assert.equal(await fingerprint(selected), before);
		}
	});
	await check('cancelled-save-before-new-and-close-does-not-discard', async (): Promise<void> => {
		const id: string | undefined = (await state()).workspace?.id;
		assert.ok(id);
		await dialogs({ choices: [0], saves: [null] });
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await waitState({ id, dirty: true });
		await dialogs({ choices: [2] });
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].close());
		await waitState({ id, dirty: true });
		await dialogs({ choices: [0], saves: [null] });
		await application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].close());
		await waitState({ id, dirty: true });
	});
	await check('discard-new-and-open-restore-real-workspace', async (): Promise<void> => {
		await dialogs({ choices: [1] });
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await waitState({ name: 'Untitled workspace', filePath: null });
		await dialogs({ choices: [1], opens: [file] });
		await page.getByRole('button', { name: 'Open', exact: true }).click();
		await waitState({ name: 'Edited workspace', filePath: file, dirty: false });
	});
	await check('save-failure-retains-dirty-work-and-retry-succeeds', async (): Promise<void> => {
		await page.getByLabel('Workspace name', { exact: true }).fill('After retry');
		await waitState({ name: 'After retry', dirty: true });
		await rename(file, `${file}.away`);
		try {
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await page.getByRole('alert').waitFor();
			await waitState({ name: 'After retry', dirty: true });
		} finally {
			await rename(`${file}.away`, file);
		}
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await waitState({ name: 'After retry', dirty: false });
	});
	await check('native-close-save-persists-and-process-restart-opens-same-state', async (): Promise<void> => {
		await page.getByLabel('Workspace name', { exact: true }).fill('Saved on close');
		await waitState({ dirty: true });
		await dialogs({ choices: [0] });
		await Promise.all([application.waitForEvent('close', { timeout: 30_000 }), application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].close())]);
		const db: Database.Database = new Database(file);
		db.pragma('foreign_keys=ON');
		db.exec(
			"INSERT INTO sources VALUES('s1','/references/original.pdf',NULL); INSERT INTO accounts VALUES('a1','Business','EUR'); INSERT INTO statements VALUES('st1','a1','s1'); INSERT INTO transactions VALUES('t1','st1','9007199254740993','EUR',2,1); INSERT INTO documents VALUES('d1','s1',1); INSERT INTO documents VALUES('d2','s1',1); INSERT INTO associations VALUES('x1','t1','d1','uncertain',1,'1:1:1'); INSERT INTO associations VALUES('x2','t1','d2','reliable',1,NULL);"
		);
		db.close();
		({ application, page } = await launch());
		await dialogs({ opens: [file] });
		await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
		await waitState({ name: 'Saved on close', filePath: file, dirty: false });
		await page.getByLabel('Workspace name', { exact: true }).fill('Resume preserved');
		await waitState({ dirty: true });
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await waitState({ dirty: false });
		const read: Database.Database = new Database(file, { readonly: true });
		try {
			assert.equal(read.prepare<[], { coefficient: string }>('SELECT coefficient FROM transactions').get()?.coefficient, '9007199254740993');
			assert.deepEqual(read.prepare('SELECT confidence,approved_revision FROM associations ORDER BY id').all(), [
				{ confidence: 'uncertain', approved_revision: '1:1:1' },
				{ confidence: 'reliable', approved_revision: null }
			]);
		} finally {
			read.close();
		}
	});
	await check('native-close-discard-keeps-previous-saved-state', async (): Promise<void> => {
		await page.getByLabel('Workspace name', { exact: true }).fill('Discard on close');
		await waitState({ dirty: true });
		await dialogs({ choices: [1] });
		await Promise.all([application.waitForEvent('close', { timeout: 30_000 }), application.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].close())]);
		const read: Database.Database = new Database(file, { readonly: true });
		try {
			assert.equal(read.prepare<[], { name: string }>('SELECT name FROM workspace').get()?.name, 'Resume preserved');
		} finally {
			read.close();
		}
	});
});
