import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { test as base, type ElectronApplication, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { IpcMain, IpcMainInvokeEvent, Rectangle } from 'electron';
import Database from 'better-sqlite3';
import { statement, row } from '../unit/bank-fixtures.js';
import { airwallexStatement } from '../unit/airwallex-fixtures.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import { createWorkspace, newMetadata } from '../../electron/store.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import type { ImportIssue } from '../../src/shared/bank-import.js';
import type { ImportOutcome, WorkspaceCommand, WorkspaceState, WorkspaceView } from '../../src/shared/protocol.js';

interface DialogPlan {
	opens?: (string | null)[];
	saves?: (string | null)[];
	choices?: number[];
}
interface CommandTraceEntry {
	id: number;
	type: WorkspaceCommand['type'] | undefined;
	phase: 'start' | 'end' | 'throw';
	at: string;
	busy?: boolean;
	outcome?: ImportOutcome['status'] | null;
	importId?: string | null;
	dirty?: boolean | null;
	workspaceId?: string | null;
	loadRevision?: number | null;
	error?: string | null;
}
type InvokeHandler = (event: IpcMainInvokeEvent, command?: WorkspaceCommand) => unknown;
interface TracedIpcMain extends IpcMain {
	_invokeHandlers?: Map<string, InvokeHandler>;
}
interface ImportHook {
	channel: string;
	original: InvokeHandler;
	calls: number;
	held: boolean;
	release: (() => void) | null;
}
interface ImportAttempt {
	started: boolean;
	finished: boolean;
	result: WorkspaceState | null;
	events: { busy: boolean; active: boolean; outcome: ImportOutcome['status'] | null }[];
	unsubscribe: (() => void) | null;
}
declare global {
	var uiCommandTrace: CommandTraceEntry[];
	var uiCommandSequence: number;
	var uiImportHook: ImportHook | undefined;
	interface Window {
		uiImportAttempts?: Record<string, ImportAttempt>;
		__receiptmatchXss?: number;
	}
}
interface UiImportReport {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: 'running' | 'passed' | 'failed';
	platform: NodeJS.Platform;
	syntheticOnly: boolean;
	checks: { name: string; status: 'passed'; milliseconds: number; detail?: unknown }[];
	screenshots: string[];
	activeCheck?: string;
	stage?: string;
	rendererLocale?: string;
	commandTrace?: CommandTraceEntry[];
	unexpectedBusy?: { stage?: string; state: WorkspaceState; commands: CommandTraceEntry[] }[];
	captureDetails?: { file: string; width: number; height: number; bytes: number; sampledColors: number; visible: boolean; contentBounds: Rectangle }[];
	limits?: string[];
	error?: string;
	stack?: string;
	cleanupError?: string;
}
interface UiImportTest {
	playwright: PlaywrightWorkerArgs['playwright'];
	root: string;
	report: UiImportReport;
	saveReport(): Promise<void>;
	onTeardown(cleanup: (failed: boolean) => Promise<void>): void;
}
const test = base.extend<{ uiImport: UiImportTest }>({
	uiImport: async ({ playwright }, use, testInfo) => {
		await mkdir('artifacts', { recursive: true });
		const root = await mkdtemp(path.resolve('artifacts/ui-import-'));
		const reportPath = path.resolve(`artifacts/ui-import-${process.platform}.json`);
		const report: UiImportReport = {
			runId: randomUUID(),
			startedAt: new Date().toISOString(),
			status: 'running',
			platform: process.platform,
			syntheticOnly: true,
			checks: [],
			screenshots: []
		};
		const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2));
		let cleanup: ((failed: boolean) => Promise<void>) | undefined;
		await saveReport();
		await use({
			playwright,
			root,
			report,
			saveReport,
			onTeardown: (action) => {
				cleanup = action;
			}
		});

		const failed = testInfo.status !== 'passed';
		report.status = failed ? 'failed' : 'passed';
		report.error = testInfo.error?.message;
		report.stack = testInfo.error?.stack;
		try {
			await cleanup?.(failed);
		} catch (error) {
			report.status = 'failed';
			report.cleanupError = String(error);
			report.error ??= String(error);
			throw error;
		} finally {
			report.finishedAt = new Date().toISOString();
			await saveReport();
		}
	}
});

test.describe.configure({ timeout: 18 * 60_000 });

test('packaged Electron bank import interface', async ({ uiImport: { playwright, root, report, saveReport, onTeardown } }) => {
	const workspaceFile = path.join(root, 'ui-records.receiptmatch');
	const precisionFile = path.join(root, 'presentation-only.receiptmatch');
	const original = path.join(root, 'synthetic-statement.pdf');
	const duplicate = path.join(root, 'identical-copy.pdf');
	const partial = path.join(root, 'synthetic-partial.pdf');
	const scanned = path.join(root, 'synthetic-scanned-statement.pdf');
	const payload = '<img src=x onerror="window.__receiptmatchXss=1"> & <script>window.__receiptmatchXss=2</script>';
	let application: ElectronApplication | undefined;
	function currentApplication() {
		assert.ok(application, 'The test-owned Electron application must be running.');
		return application;
	}
	let page: Page;
	const normalized = (value: string | null) => String(value).replace(/\s+/g, ' ').trim();
	const fingerprint = async (file: string) =>
		createHash('sha256')
			.update(await readFile(file))
			.digest('hex');
	const transactions = () => page.getByRole('table', { name: 'Transactions', exact: true });
	const drafts = () => page.getByRole('table', { name: 'Unresolved drafts', exact: true });

	async function bounded<Result>(label: string, operation: Promise<Result>, milliseconds = 20000) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	async function check(name: string, action: () => Promise<unknown>) {
		report.activeCheck = name;
		report.stage = 'started';
		await saveReport();
		console.log(`RUN ${name}`);
		const start = performance.now();
		const detail = await test.step(name, action, { timeout: 60_000 });
		report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start), ...(detail === undefined ? {} : { detail }) });
		report.stage = 'passed';
		await saveReport();
		console.log(`PASS ${name}`);
	}
	async function stage(name: string) {
		report.stage = name;
		await saveReport();
		console.log(`STAGE ${name}`);
	}
	async function launch() {
		application = await playwright._electron.launch({
			executablePath: path.resolve(process.platform === 'win32' ? 'release/win-unpacked/ReceiptMatch.exe' : 'release/linux-unpacked/receiptmatch'),
			args: ['--disable-gpu', '--lang=de-DE', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
			timeout: 30000,
			env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' }
		});
		page = await application.firstWindow({ timeout: 30000 });
		page.setDefaultTimeout(20000);
		page.setDefaultNavigationTimeout(20000);
		await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
		await currentApplication().evaluate(({ ipcMain }) => {
			const original = (ipcMain as TracedIpcMain)._invokeHandlers?.get('workspace:command');
			if (typeof original !== 'function') throw new Error('The pinned Electron workspace command handler is unavailable for tracing.');
			globalThis.uiCommandTrace = [];
			globalThis.uiCommandSequence = 0;
			const snapshot = (value: WorkspaceState) => ({
				busy: value.busy,
				outcome: value.importOutcome?.status ?? null,
				importId: value.importOutcome?.importId ?? null,
				dirty: value.workspace?.dirty ?? null,
				workspaceId: value.workspace?.id ?? null,
				loadRevision: value.workspace?.loadRevision ?? null,
				error: value.error
			});
			ipcMain.removeHandler('workspace:command');
			ipcMain.handle('workspace:command', async (event, command) => {
				if (command?.type === 'get-state') return original(event, command);
				const id = ++globalThis.uiCommandSequence;
				const type = command?.type;
				const entry: CommandTraceEntry = { id, type, phase: 'start', at: new Date().toISOString() };
				globalThis.uiCommandTrace.push(entry);
				Object.assign(entry, snapshot((await original(event, { type: 'get-state' })) as WorkspaceState));
				try {
					const result = await original(event, command);
					globalThis.uiCommandTrace.push({ id, type, phase: 'end', at: new Date().toISOString(), ...snapshot(result as WorkspaceState) });
					return result;
				} catch (error) {
					globalThis.uiCommandTrace.push({ id, type, phase: 'throw', at: new Date().toISOString(), error: String(error) });
					throw error;
				}
			});
		});
		await currentApplication().evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.setContentSize(1120, 900);
			window.show();
			window.focus();
		});
		const locale = await page.evaluate(() => new Intl.NumberFormat().resolvedOptions().locale);
		assert.match(locale, /^de(?:-|$)/, 'The renderer must actually use the requested German system locale.');
		report.rendererLocale = locale;
	}
	async function dialogs({ opens = [], saves = [], choices = [] }: DialogPlan = {}) {
		await currentApplication().evaluate(
			({ dialog }, plan) => {
				dialog.showOpenDialog = async () => {
					const file = plan.opens.shift();
					return { canceled: !file, filePaths: file ? [file] : [] };
				};
				dialog.showSaveDialog = async () => {
					const file = plan.saves.shift();
					return { canceled: !file, filePath: file ?? '' };
				};
				dialog.showMessageBox = async () => ({ response: plan.choices.shift() ?? 2, checkboxChecked: false });
			},
			{ opens, saves, choices }
		);
	}
	async function state() {
		const result = await page.evaluate(() => window.receiptmatch.command({ type: 'get-state' }));
		assert.ok(result.workspace);
		return { ...result, workspace: result.workspace };
	}
	async function commandTrace() {
		return currentApplication().evaluate(() => globalThis.uiCommandTrace ?? []);
	}
	async function commandSequence() {
		return currentApplication().evaluate(() => globalThis.uiCommandSequence);
	}
	async function commandEnd(type: WorkspaceCommand['type'], after: number) {
		const deadline = performance.now() + 20000;
		while (performance.now() < deadline) {
			const entry = await currentApplication().evaluate(
				(_electron, { type, after }) => globalThis.uiCommandTrace.find((entry) => entry.phase === 'end' && entry.type === type && entry.id > after),
				{ type, after }
			);
			if (entry) return entry;
			await settle();
		}
		report.commandTrace = await commandTrace();
		throw new Error(`The real ${type} command did not finish after sequence ${after}.`);
	}
	async function clickCommand(locator: Locator, type: WorkspaceCommand['type']) {
		const sequence = await commandSequence();
		await locator.click();
		return commandEnd(type, sequence);
	}
	async function waitState(expected: Partial<WorkspaceView>) {
		await page.waitForFunction(async (expected) => {
			const value = await window.receiptmatch.command({ type: 'get-state' });
			return !value.busy && Object.entries(expected).every(([key, wanted]) => value.workspace?.[key as keyof WorkspaceView] === wanted);
		}, expected);
	}
	async function outcome(status: ImportOutcome['status'], issueCode?: ImportIssue['code']) {
		await page.waitForFunction(
			async ({ status, issueCode }) => {
				const value = await window.receiptmatch.command({ type: 'get-state' });
				return !value.busy && value.importOutcome?.status === status && (!issueCode || value.importOutcome.issues.some((issue) => issue.code === issueCode));
			},
			{ status, issueCode }
		);
		await page.getByTestId('import-outcome').waitFor();
		return state();
	}
	async function importFile(file: string | null, status: ImportOutcome['status'] = 'imported', issueCode?: ImportIssue['code']) {
		const before = await state();
		if (before.busy || before.statementImport) {
			report.unexpectedBusy ??= [];
			report.unexpectedBusy.push({ stage: report.stage, state: before, commands: await commandTrace() });
			await saveReport();
			console.error(`UNEXPECTED BUSY ${JSON.stringify(report.unexpectedBusy.at(-1))}`);
			await waitState({});
		}
		const attempt = randomUUID();
		await page.evaluate((attempt) => {
			const probe: ImportAttempt = { started: false, finished: false, result: null, events: [], unsubscribe: null };
			(window.uiImportAttempts ??= {})[attempt] = probe;
			probe.unsubscribe = window.receiptmatch.subscribe((value) => {
				probe.events.push({ busy: value.busy, active: value.statementImport !== null, outcome: value.importOutcome?.status ?? null });
				if (value.busy && value.statementImport !== null) probe.started = true;
				if (probe.started && !value.busy && value.statementImport === null && value.importOutcome !== null) {
					probe.finished = true;
					probe.result = value;
				}
			});
		}, attempt);
		try {
			const sequence = await commandSequence();
			await dialogs({ opens: [file] });
			await page.getByRole('button', { name: 'Import statement', exact: true }).click();
			await page.waitForFunction((attempt) => window.uiImportAttempts?.[attempt]?.started === true, attempt);
			const completion = await commandEnd('import-statement', sequence);
			await page.waitForFunction((attempt) => window.uiImportAttempts?.[attempt]?.finished === true, attempt);
			const result = await page.evaluate((attempt) => window.uiImportAttempts?.[attempt]?.result, attempt);
			assert.ok(result?.workspace && result.importOutcome);
			assert.equal(result.importOutcome.status, status);
			assert.equal(result.busy, false);
			assert.equal(result.statementImport, null);
			assert.equal(completion.outcome, status);
			assert.equal(completion.importId, result.importOutcome.importId);
			if (issueCode) assert.ok(result.importOutcome.issues.some((issue) => issue.code === issueCode));
			await page.getByTestId('import-outcome').waitFor();
			if (status === 'imported')
				await page.waitForFunction((id) => document.querySelector<HTMLSelectElement>('#statement-select')?.value === id, result.importOutcome.importId);
			return { ...result, workspace: result.workspace, importOutcome: result.importOutcome };
		} finally {
			await page.evaluate((attempt) => {
				window.uiImportAttempts?.[attempt]?.unsubscribe?.();
				delete window.uiImportAttempts?.[attempt];
			}, attempt);
		}
	}
	async function openFile(file: string, name?: string) {
		const previous = await state();
		await dialogs({ opens: [file], choices: [1] });
		await clickCommand(page.getByRole('button', { name: 'Open', exact: true }), 'open');
		await waitState({ filePath: file, loadRevision: previous.workspace.loadRevision + 1 });
		if (name) await page.waitForFunction((name) => document.querySelector<HTMLInputElement>('#workspace-name')?.value === name, name);
	}
	async function close(force = false) {
		if (!application) return;
		const current = application;
		const child = current.process();
		const exit = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once('exit', () => resolve());
		});
		const forceExit = async () => {
			try {
				await bounded(
					'Exiting the test-owned Electron application',
					current.evaluate(({ app }) => app.exit(0)),
					1500
				);
			} catch {
				/* Target closure can reject the RPC after app.exit succeeds. */
			}
			try {
				await bounded('Waiting for the test application exit', exit, 2000);
			} catch {
				child.kill();
				await bounded('Waiting for the killed test application', exit, 2000);
			}
		};
		try {
			if (force) await forceExit();
			else
				await bounded(
					'Closing the test-owned application',
					(async () => {
						await dialogs({ choices: [1] });
						await Promise.all([
							exit,
							current.evaluate(({ BrowserWindow }) => {
								const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'receiptmatch://app/index.html');
								if (!main) throw new Error('ReceiptMatch main window is missing.');
								main.close();
							})
						]);
					})(),
					5000
				);
		} catch (error) {
			await forceExit();
			throw error;
		} finally {
			if (application === current) application = undefined;
		}
	}
	async function settle() {
		await bounded(
			'Waiting for rendered frames',
			page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
			5000
		);
	}
	async function screenshot(name: string) {
		const file = path.join(root, `${name}.png`);
		report.stage = `capture:${name}`;
		await saveReport();
		console.log(`CAPTURE ${name}`);
		await bounded(
			'Scrolling the actual statement view',
			page.locator('.statement-imports').evaluate((element) => element.scrollIntoView({ block: 'start' }))
		);
		await settle();
		const captured = await bounded(
			`Capturing the actual ReceiptMatch viewport (${name})`,
			currentApplication().evaluate(async ({ BrowserWindow }, file) => {
				const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'receiptmatch://app/index.html');
				if (!main) throw new Error('ReceiptMatch main window is missing.');
				main.show();
				main.focus();
				main.webContents.invalidate();
				const image = await main.webContents.capturePage(undefined, { stayAwake: true, stayHidden: false });
				const size = image.getSize();
				const png = image.toPNG();
				const bitmap = image.toBitmap();
				const colors = new Set();
				for (let index = 0; index + 4 <= bitmap.length && colors.size < 64; index += 256) colors.add(bitmap.readUInt32LE(index));
				if (image.isEmpty() || size.width < 600 || size.height < 400 || png.length < 1000 || colors.size < 8)
					throw new Error(`The actual viewport capture is empty or visually uniform: ${JSON.stringify({ ...size, bytes: png.length, colors: colors.size })}`);
				const fs = process.getBuiltinModule('fs');
				if (!fs) throw new Error('The native filesystem module is unavailable.');
				fs.writeFileSync(file, png);
				return { ...size, bytes: png.length, sampledColors: colors.size, visible: main.isVisible(), contentBounds: main.getContentBounds() };
			}, file)
		);
		assert.equal(captured.visible, true);
		report.screenshots.push(file);
		(report.captureDetails ??= []).push({ file, ...captured });
		await saveReport();
		console.log(`CAPTURED ${name} ${captured.width}x${captured.height}`);
		return file;
	}
	async function fixture(file: string, isPartial = false) {
		const input = statement();
		if (isPartial) input.pages[0].spans.push(...row(335, '26 Feb 2032', 'To: Cedar Tools', null, null));
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		pdf.setTitle(isPartial ? 'Synthetic UI partial statement' : 'Synthetic UI complete statement');
		for (const source of input.pages) {
			const sheet = pdf.addPage([source.width, source.height]);
			for (const item of source.spans) sheet.drawText(item.text, { x: item.region.x, y: source.height - item.region.y - 10, size: 10, font });
		}
		await writeFile(file, await pdf.save());
	}
	async function airwallexFixture(file: string, isPartial = false) {
		const input = airwallexStatement();
		if (isPartial) {
			const amount = input.pages[0].spans.find((item) => item.text === '16.43 EUR');
			assert.ok(amount);
			amount.text = 'Unreadable EUR';
		}
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		pdf.setTitle(isPartial ? 'Synthetic Airwallex unresolved debit' : 'Synthetic Airwallex complete statement');
		for (const source of input.pages) {
			const sheet = pdf.addPage([source.width, source.height]);
			for (const item of source.spans) {
				const size = Math.min(9, item.region.width / font.widthOfTextAtSize(item.text, 1));
				sheet.drawText(item.text, { x: item.region.x, y: source.height - item.region.y - 10, size, font });
			}
		}
		await writeFile(file, await pdf.save());
	}
	async function bankRecords() {
		const values = await page.evaluate(() => window.receiptmatch.bankImports());
		return values.map((value) => storedBankImportSchema.parse(value));
	}
	async function selectStatement(record: StoredBankImport) {
		await page.getByLabel('Statement', { exact: true }).selectOption(record.id);
		await page.waitForFunction(
			({ id, filename }) =>
				document.querySelector<HTMLSelectElement>('#statement-select')?.value === id && document.querySelector('.statement-summary h3')?.textContent?.trim() === filename,
			{ id: record.id, filename: path.basename(record.filePath) }
		);
		await transactions().waitFor();
	}
	function sourceFact(row: Locator, name: string) {
		return row
			.locator('.source-facts > div')
			.filter({ has: page.getByText(name, { exact: true }) })
			.locator('dd');
	}
	async function hook(channel: string, mode: 'count' | 'fail-one' | 'delay-one' | 'delay-rename') {
		await currentApplication().evaluate(
			({ ipcMain }, { channel, mode }) => {
				const original = (ipcMain as TracedIpcMain)._invokeHandlers?.get(channel);
				if (typeof original !== 'function') throw new Error(`The pinned Electron invocation handler cannot be instrumented: ${channel}`);
				const probe: ImportHook = { channel, original, calls: 0, held: false, release: null };
				globalThis.uiImportHook = probe;
				ipcMain.removeHandler(channel);
				ipcMain.handle(channel, async (event, ...args) => {
					const result = await original(event, ...args);
					probe.calls++;
					if (mode === 'fail-one' && probe.calls === 1) throw new Error('Controlled readonly detail-load failure');
					if ((mode === 'delay-one' && probe.calls === 1) || (mode === 'delay-rename' && args[0]?.type === 'rename' && !probe.held)) {
						probe.held = true;
						return new Promise((resolve) => {
							probe.release = () => resolve(result);
						});
					}
					return result;
				});
			},
			{ channel, mode }
		);
	}
	async function hookState() {
		return currentApplication().evaluate(() => {
			const hook = globalThis.uiImportHook;
			if (!hook) throw new Error('The controlled IPC hook was not installed.');
			return { calls: hook.calls, held: hook.held };
		});
	}
	async function waitHeld() {
		const deadline = performance.now() + 10000;
		while (performance.now() < deadline) {
			if ((await hookState()).held) return;
			await settle();
		}
		throw new Error('The controlled IPC response was never held.');
	}
	async function releaseHook() {
		await currentApplication().evaluate(() => globalThis.uiImportHook?.release?.());
		await settle();
	}
	async function restoreHook() {
		await currentApplication().evaluate(({ ipcMain }) => {
			const probe = globalThis.uiImportHook;
			if (!probe) return;
			probe.release?.();
			ipcMain.removeHandler(probe.channel);
			ipcMain.handle(probe.channel, probe.original);
			globalThis.uiImportHook = undefined;
		});
	}

	onTeardown(async (failed) => {
		if (!application) return;
		try {
			report.commandTrace = await bounded('Reading the mutating command trace', commandTrace(), 3000);
			await bounded('Restoring the test-only IPC wrapper', restoreHook(), 5000);
		} finally {
			await close(failed);
		}
	});
	await fixture(original);
	await copyFile(original, duplicate);
	await fixture(partial, true);
	const malformed = path.join(root, 'malformed.pdf');
	await writeFile(malformed, 'Not a PDF.');
	const unknown = path.join(root, 'unsupported.pdf');
	const unsupported = await PDFDocument.create();
	unsupported.addPage().drawText('Independent unsupported synthetic statement');
	await writeFile(unknown, await unsupported.save());
	const presentationInput = statement();
	presentationInput.source = { sourceId: randomUUID(), sha256: createHash('sha256').update('presentation-only-seeded-record').digest('hex') };
	presentationInput.extraction.runId = randomUUID();
	const presented = parseBankStatement(presentationInput);
	presented.transactions[0].accountAmount.value = { coefficient: '-900719925474099312345678901234567890', currency: 'EUR', scale: 18 };
	presented.transactions[1].accountAmount.value = { coefficient: '1', currency: 'EUR', scale: 18 };
	presented.transactions[0].description.value = payload;
	presented.transactions[0].description.evidence[0].rawText = payload;
	presented.status = 'partial';
	presented.issues.push({
		code: 'presentation-note',
		severity: 'warning',
		message: 'Synthetic transaction notice',
		pageId: 'page-1',
		rowId: presented.transactions[0].rowId,
		field: 'description',
		evidence: presented.transactions[0].description.evidence
	});
	const presentationRecord = storedBankImportSchema.parse({
		id: randomUUID(),
		importedAt: '2032-03-01T12:00:00.000Z',
		filePath: path.join(root, 'presentation-only-seeded.pdf'),
		result: presented,
		accounts: presented.accountSections.map((section) => ({ sectionId: section.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
		transactions: presented.transactions.map((row) => ({ rowId: row.rowId, transactionId: randomUUID() })),
		drafts: []
	});
	await createWorkspace(precisionFile, { ...newMetadata(), name: 'Presentation-only exact values' }, [presentationRecord]);
	const snapshotA = path.join(root, 'snapshot-a.receiptmatch');
	const snapshotB = path.join(root, 'snapshot-b.receiptmatch');
	const snapshotMetadata = { ...newMetadata(), name: 'Same identity snapshots' };
	for (const [file, marker, amount] of [
		[snapshotA, 'SAME-IDENTITY SNAPSHOT A', '-101'],
		[snapshotB, 'SAME-IDENTITY SNAPSHOT B', '-202']
	]) {
		const record = structuredClone(presentationRecord);
		record.result.transactions[0].description.value = marker;
		record.result.transactions[0].description.evidence[0].rawText = marker;
		record.result.transactions[0].accountAmount.value = { coefficient: amount, currency: 'EUR', scale: 2 };
		assert.ok(record.result.sourceProvenance);
		record.result.sourceProvenance.sha256 = createHash('sha256').update(marker).digest('hex');
		await createWorkspace(file, snapshotMetadata, [record]);
		const db = new Database(file);
		try {
			db.prepare('UPDATE workspace SET saved_at=?').run('2032-03-01T12:00:00.000Z');
		} finally {
			db.close();
		}
	}
	const beforeOriginal = await fingerprint(original);
	await launch();
	await check('visible-ui-import-details-save-and-real-process-restart', async () => {
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByLabel('Workspace name', { exact: true }).fill('UI import records');
		await dialogs({ saves: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ filePath: workspaceFile, dirty: false });
		await importFile(original);
		await transactions().waitFor();
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
		assert.match(normalized(await transactions().locator('tbody > tr').first().textContent()), /-1\.234,56 EUR/);
		await transactions().locator('tbody > tr').first().getByText('Source details', { exact: true }).click();
		await page.getByText('Date (UTC)', { exact: true }).first().waitFor();
		assert.match((await transactions().locator('tbody > tr').first().textContent()) ?? '', /SYNTHETIC-A/);
		assert.match((await transactions().locator('tbody > tr').first().textContent()) ?? '', /Region in PDF points/);
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		const saved = await state();
		const ids = saved.workspace.imports.map((record) => record.id);
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Open workspace', exact: true }), 'open');
		await waitState({ filePath: workspaceFile, dirty: false });
		await transactions().waitFor();
		assert.deepEqual(
			(await state()).workspace.imports.map((record) => record.id),
			ids
		);
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
		assert.equal(await fingerprint(original), beforeOriginal);
	});
	await check('identical-import-and-renaming-do-not-refetch-or-duplicate-clean-records', async () => {
		const ids = (await state()).workspace.imports.map((record) => record.id);
		await hook('workspace:bank-imports', 'count');
		try {
			const skipped = await importFile(duplicate, 'skipped');
			assert.equal(skipped.workspace.dirty, false);
			assert.deepEqual(
				skipped.workspace.imports.map((record) => record.id),
				ids
			);
			await page.getByLabel('Workspace name', { exact: true }).fill('UI import records renamed');
			await waitState({ name: 'UI import records renamed', dirty: true });
			await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
			await waitState({ dirty: false });
			await settle();
			assert.equal((await hookState()).calls, 0);
		} finally {
			await restoreHook();
		}
	});
	await check('partial-import-separates-valid-transactions-from-unknown-drafts-and-issues', async () => {
		await stage('partial: before real import click');
		const imported = await importFile(partial);
		await drafts().waitFor();
		await stage('partial: fresh import outcome and selected details received');
		assert.equal(imported.workspace.imports.length, 2);
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
		assert.equal(await drafts().locator('tbody > tr').count(), 1);
		assert.equal((await drafts().locator('tbody td.amount-cell').textContent())?.trim(), 'Unknown');
		assert.ok((await drafts().locator('.row-issues li').count()) > 0);
		await page.getByTestId('statement-warnings').waitFor();
		assert.match((await page.getByLabel('Statement', { exact: true }).locator('option:checked').textContent()) ?? '', /synthetic-partial\.pdf.*Partial import/);
		await stage('partial: before Save');
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		await stage('partial: saved; before capture');
		return { screenshot: await screenshot('partial-wide') };
	});
	await check('unsupported-malformed-password-and-cancelled-native-selection-preserve-visible-records', async () => {
		const before = await state();
		const savedHash = await fingerprint(workspaceFile);
		for (const [file, status, code] of [
			[unknown, 'unsupported'],
			[malformed, 'failed', 'pdf-invalid'],
			[path.resolve('tests/fixtures/password-required.pdf'), 'failed', 'pdf-password'],
			[null, 'cancelled']
		] as const) {
			await stage(`rejected-input: ${file ? path.basename(file) : 'cancelled selection'} before click`);
			const result = await importFile(file, status, code);
			await stage(`rejected-input: fresh ${status} completion`);
			assert.equal(result.workspace.dirty, false);
			assert.deepEqual(result.workspace.imports, before.workspace.imports);
			assert.equal(await transactions().locator('tbody > tr').count(), 2);
			assert.equal(await drafts().locator('tbody > tr').count(), 1);
			assert.equal(await fingerprint(workspaceFile), savedHash);
		}
	});
	await check('actual-scanned-statement-financial-rows-use-local-english-ocr-and-source-details', async () => {
		// Fixed, independently invented raster statement: compare identical bytes across OS/font installations.
		await copyFile(path.resolve('tests/fixtures/revolut-synthetic-scan.pdf'), scanned);
		const imported = await importFile(scanned);
		await transactions().waitFor();
		assert.equal(imported.workspace.imports.length, 3);
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
		const visible = normalized(await transactions().textContent());
		assert.match(visible, /-1\.234,56 EUR/);
		assert.match(visible, /25,07 EUR/);
		await transactions().locator('tbody > tr').first().getByText('Source details', { exact: true }).click();
		await transactions()
			.getByText(/Local English OCR/)
			.first()
			.waitFor();
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
	});
	await check('real-cancel-button-stops-active-ocr-and-the-next-import-recovers', async () => {
		const png = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 1200;
			canvas.height = 1600;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('The test canvas does not support 2D rendering.');
			context.fillStyle = 'white';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = 'black';
			context.font = '30px Arial';
			for (let line = 0; line < 35; line++) context.fillText(`SYNTHETIC CANCELLATION LINE ${line + 1} TOTAL EUR 123.45`, 25, 50 + line * 42);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const pdf = await PDFDocument.create();
		const image = await pdf.embedPng(Buffer.from(png, 'base64'));
		pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
		const cancellation = path.join(root, 'synthetic-cancellation.pdf');
		await writeFile(cancellation, await pdf.save());
		const before = await state();
		await dialogs({ opens: [cancellation] });
		await page.getByRole('button', { name: 'Import statement', exact: true }).click();
		await page.waitForFunction(async () => (await window.receiptmatch.command({ type: 'get-state' })).statementImport?.progress?.phase === 'ocr');
		await page.getByTestId('import-progress').waitFor();
		for (const name of ['New', 'Open', 'Save']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
		await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Match suggestions' }).click();
		await page.getByText('Statement import in progress.', { exact: true }).waitFor();
		await page.getByRole('button', { name: 'View import', exact: true }).click();
		await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
		const cancelled = await outcome('cancelled');
		assert.equal(cancelled.workspace.dirty, false);
		assert.deepEqual(cancelled.workspace.imports, before.workspace.imports);
		await importFile(duplicate, 'skipped');
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
	});
	await check('explicitly-seeded-presentation-preserves-system-locale-scale18-precision-and-escapes-raw-text', async () => {
		await openFile(precisionFile, 'Presentation-only exact values');
		await transactions().waitFor();
		const first = transactions().locator('tbody > tr').nth(0);
		const second = transactions().locator('tbody > tr').nth(1);
		assert.equal(normalized(await first.locator('td.amount-cell').first().textContent()), '-900.719.925.474.099.312,345678901234567890 EUR');
		assert.equal(normalized(await second.locator('td.amount-cell').first().textContent()), '0,000000000000000001 EUR');
		assert.equal((await first.locator('td.date-cell').textContent())?.trim(), '28.02.2032');
		assert.equal((await first.locator('.row-description').textContent())?.trim(), payload);
		await first.getByText('Source details', { exact: true }).click();
		await first.getByText('Printed date basis', { exact: true }).waitFor();
		assert.match((await first.textContent()) ?? '', /Printed date basis/);
		await page.getByText('Synthetic transaction notice', { exact: false }).first().waitFor();
		for (const name of ['Account reference', 'Account currency', 'Account section']) await first.getByRole('region', { name, exact: true }).waitFor();
		assert.equal(await first.locator('img, script').count(), 0);
		assert.equal(await page.evaluate(() => window.__receiptmatchXss ?? null), null);
		return { source: 'Explicit Store API presentation seed, not a parsed PDF or matching result', screenshot: await screenshot('exact-values-wide') };
	});
	await check('readonly-retry-and-delayed-record-reply-cannot-show-another-workspaces-financial-data', async () => {
		await hook('workspace:bank-imports', 'fail-one');
		try {
			await openFile(workspaceFile);
			await page.getByRole('button', { name: 'Retry details', exact: true }).waitFor();
			assert.equal(await transactions().count(), 0);
			await page.getByRole('button', { name: 'Retry details', exact: true }).click();
			await transactions().waitFor();
			assert.equal((await hookState()).calls, 2);
		} finally {
			await restoreHook();
		}
		await openFile(precisionFile);
		await transactions().waitFor();
		await hook('workspace:bank-imports', 'delay-one');
		try {
			await openFile(workspaceFile);
			await waitHeld();
			assert.equal(await transactions().count(), 0);
			await openFile(precisionFile, 'Presentation-only exact values');
			await transactions().waitFor();
			await releaseHook();
			assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Presentation-only exact values');
			assert.equal((await transactions().locator('.row-description').first().textContent())?.trim(), payload);
			assert.equal(await page.getByLabel('Statement', { exact: true }).inputValue(), presentationRecord.id);
		} finally {
			await restoreHook();
		}
	});
	await check('late-command-reply-cannot-regress-a-newer-native-menu-subscribed-workspace', async () => {
		await openFile(workspaceFile);
		await transactions().waitFor();
		await hook('workspace:command', 'delay-rename');
		try {
			await page.getByLabel('Workspace name', { exact: true }).fill('Delayed stale name');
			await waitHeld();
			await dialogs({ opens: [precisionFile], choices: [1] });
			await currentApplication().evaluate(({ Menu }) => {
				const item = Menu.getApplicationMenu()
					?.items.find((item) => item.label === 'File')
					?.submenu?.items.find((item) => item.label.startsWith('Open workspace'));
				if (!item) throw new Error('The native Open workspace action is missing.');
				item.click();
			});
			await waitState({ filePath: precisionFile });
			await transactions().waitFor();
			await releaseHook();
			assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Presentation-only exact values');
			assert.equal((await transactions().locator('.row-description').first().textContent())?.trim(), payload);
		} finally {
			await restoreHook();
		}
	});
	await check('opening-same-identities-and-reopening-replaced-snapshot-refreshes-canonical-financial-data', async () => {
		await openFile(snapshotA);
		await transactions().waitFor();
		await page.waitForFunction(() => document.querySelector('[data-testid="transactions-table"] .row-description')?.textContent?.trim() === 'SAME-IDENTITY SNAPSHOT A');
		const firstState = await state();
		await openFile(snapshotB);
		await transactions().waitFor();
		await page.waitForFunction(() => document.querySelector('[data-testid="transactions-table"] .row-description')?.textContent?.trim() === 'SAME-IDENTITY SNAPSHOT B');
		const secondState = await state();
		assert.equal(secondState.workspace.id, firstState.workspace.id);
		assert.deepEqual(
			secondState.workspace.imports.map((record) => record.id),
			firstState.workspace.imports.map((record) => record.id)
		);
		assert.equal(secondState.workspace.savedAt, firstState.workspace.savedAt);
		assert.match(normalized(await transactions().locator('tbody > tr').first().textContent()), /-2,02 EUR/);
		await openFile(snapshotA);
		await page.waitForFunction(() => document.querySelector('[data-testid="transactions-table"] .row-description')?.textContent?.trim() === 'SAME-IDENTITY SNAPSHOT A');
		const replacement = path.join(root, 'replacement-snapshot.receiptmatch');
		await copyFile(snapshotB, replacement);
		await rename(replacement, snapshotA);
		await openFile(snapshotA);
		await page.waitForFunction(() => document.querySelector('[data-testid="transactions-table"] .row-description')?.textContent?.trim() === 'SAME-IDENTITY SNAPSHOT B');
		assert.match(normalized(await transactions().locator('tbody > tr').first().textContent()), /-2,02 EUR/);
	});
	await check('keyboard-source-details-and-680px-layout-keep-tables-contained-with-real-visible-captures', async () => {
		await openFile(workspaceFile);
		await transactions().waitFor();
		const imports = (await state()).workspace.imports;
		const partialImport = imports.find((record) => path.basename(record.filePath) === path.basename(partial));
		assert.ok(partialImport);
		await page.getByLabel('Statement', { exact: true }).selectOption(partialImport.id);
		await drafts().waitFor();
		const summary = transactions().locator('tbody > tr').first().getByText('Source details', { exact: true });
		await summary.focus();
		await page.keyboard.press('Enter');
		await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>('[data-testid="transactions-table"] tbody details')?.open);
		await page.keyboard.press('Space');
		await page.waitForFunction(() => !document.querySelector<HTMLDetailsElement>('[data-testid="transactions-table"] tbody details')?.open);
		await currentApplication().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 800));
		await settle();
		const region = page.getByRole('region', { name: 'Transactions table, horizontally scrollable', exact: true });
		await region.focus();
		const before = await region.evaluate((element) => element.scrollLeft);
		await page.keyboard.press('ArrowRight');
		await page.waitForFunction((before) => (document.querySelector('[aria-label="Transactions table, horizontally scrollable"]')?.scrollLeft ?? 0) > before, before);
		const bounds = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
		assert.equal(bounds.width, 680);
		assert.ok(bounds.content <= bounds.client + 1, JSON.stringify(bounds));
		assert.equal(await region.evaluate((element) => document.activeElement === element), true);
		return { bounds, screenshot: await screenshot('partial-narrow-keyboard') };
	});
	const airwallex = path.join(root, 'synthetic-airwallex.pdf');
	const airwallexDuplicate = path.join(root, 'identical-airwallex-copy.pdf');
	const airwallexPartial = path.join(root, 'synthetic-airwallex-partial.pdf');
	const airwallexScanned = path.resolve('tests/fixtures/airwallex-synthetic-scan.pdf');
	await airwallexFixture(airwallex);
	await copyFile(airwallex, airwallexDuplicate);
	await airwallexFixture(airwallexPartial, true);
	const airwallexOriginalHash = await fingerprint(airwallex);
	const airwallexScanHash = await fingerprint(airwallexScanned);
	await check('airwallex-actual-ui-keeps-exact-values-provenance-and-both-banks-through-explicit-save-and-restart', async () => {
		await currentApplication().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 900));
		await openFile(workspaceFile);
		await transactions().waitFor();
		const before = await bankRecords();
		const savedHash = await fingerprint(workspaceFile);
		assert.ok(before.length && before.every((record) => record.result.adapter?.bankId === 'revolut'));
		const imported = await importFile(airwallex);
		await transactions().waitFor();
		assert.equal(imported.workspace.imports.length, before.length + 1);
		assert.equal(imported.workspace.dirty, true);
		assert.equal(await fingerprint(workspaceFile), savedHash, 'Import must not save the workspace implicitly.');
		const records = await bankRecords();
		const record = records.at(-1);
		assert.ok(record);
		assert.deepEqual(records.slice(0, -1), before);
		assert.equal(record.result.adapter?.bankId, 'airwallex');
		assert.equal(record.result.status, 'complete');
		assert.equal(record.result.sourceProvenance?.sha256, airwallexOriginalHash);
		assert.deepEqual(
			record.result.transactions.map((row) => [row.bookingDate.value, row.accountAmount.value.coefficient, row.direction]),
			[
				['2032-03-01', '-1643', 'outgoing'],
				['2032-03-02', '-1307', 'outgoing'],
				['2032-03-03', '419', 'incoming'],
				['2032-03-04', '2753', 'incoming']
			]
		);
		assert.deepEqual(
			record.result.transactions.map((row) => row.reportedOriginalAmount?.value ?? null),
			[{ coefficient: '-1807', currency: 'USD', scale: 2 }, null, { coefficient: '419', currency: 'EUR', scale: 2 }, null]
		);
		assert.equal(record.result.accountSections[0].accountReference, null);
		assert.ok(record.result.transactions.every((row) => row.bookingDate.basisLabel === 'Date (Central European Time)' && row.valueDate === null));
		assert.ok(record.result.sourceProvenance);
		const pageIds = new Map(record.result.sourceProvenance.pages.map((page) => [page.pageId, page.pageNumber]));
		assert.ok(record.result.transactions[0].bookingDate.evidence.some((value) => pageIds.get(value.pageId) === 3));
		assert.ok(record.result.transactions[2].description.evidence.every((value) => pageIds.get(value.pageId) === 2));
		assert.equal(await transactions().locator('tbody > tr').count(), 4);
		const rows = transactions().locator('tbody > tr');
		for (const [index, date, amount, direction] of [
			[0, '01.03.2032', '-16,43 EUR', 'Outgoing'],
			[1, '02.03.2032', '-13,07 EUR', 'Outgoing'],
			[2, '03.03.2032', '4,19 EUR', 'Incoming'],
			[3, '04.03.2032', '27,53 EUR', 'Incoming']
		] as const) {
			assert.equal(normalized(await rows.nth(index).locator('td.date-cell').textContent()), date);
			assert.equal(normalized(await rows.nth(index).locator('td.amount-cell').first().textContent()), amount);
			assert.equal(normalized(await rows.nth(index).locator('td').nth(3).textContent()), direction);
		}
		assert.equal(normalized(await rows.nth(0).locator('td.amount-cell').nth(1).textContent()), '-18,07 USD');
		assert.equal(normalized(await rows.nth(1).locator('td.amount-cell').nth(1).textContent()), 'Unknown');
		assert.equal(normalized(await rows.nth(2).locator('td.amount-cell').nth(1).textContent()), '4,19 EUR');
		assert.equal(normalized(await page.locator('.account-list dd').textContent()), 'Unknown account reference');
		await rows.first().getByText('Source details', { exact: true }).click();
		await sourceFact(rows.first(), 'Printed date basis').waitFor();
		assert.equal(normalized(await sourceFact(rows.first(), 'Printed date basis').textContent()), 'Date (Central European Time)');
		assert.equal(normalized(await sourceFact(rows.first(), 'Account reference').textContent()), 'Unknown');
		for (const label of ['Booking date', 'Description', 'Account amount', 'Account currency', 'Account section']) {
			const group = rows.first().getByRole('region', { name: label, exact: true });
			assert.match((await group.textContent()) ?? '', /Page [123] · Embedded text/);
			assert.match((await group.textContent()) ?? '', /Region in PDF points/);
		}
		await rows.first().getByText('Source details', { exact: true }).click();
		const wide = await screenshot('airwallex-complete-wide');
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		const retained = await bankRecords();
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Open workspace', exact: true }), 'open');
		await waitState({ filePath: workspaceFile, dirty: false });
		await transactions().waitFor();
		assert.deepEqual(await bankRecords(), retained);
		await selectStatement(record);
		assert.equal(await transactions().locator('tbody > tr').count(), 4);
		await selectStatement(before[0]);
		assert.equal(await transactions().locator('tbody > tr').count(), 2);
		assert.match(normalized(await transactions().textContent()), /-1\.234,56 EUR/);
		assert.equal(
			await transactions()
				.getByText(/Lantern Supplies/)
				.count(),
			0
		);
		await selectStatement(record);
		assert.match(normalized(await transactions().textContent()), /-16,43 EUR/);
		assert.equal(
			await transactions()
				.getByText(/Orchard Workshop/)
				.count(),
			0
		);
		const savedAfterRestart = await fingerprint(workspaceFile);
		const skipped = await importFile(airwallexDuplicate, 'skipped');
		assert.equal(skipped.workspace.dirty, false);
		assert.equal(skipped.importOutcome.importId, record.id);
		assert.deepEqual(await bankRecords(), retained);
		assert.equal(await fingerprint(workspaceFile), savedAfterRestart);
		assert.equal(await page.getByLabel('Statement', { exact: true }).inputValue(), record.id);
		assert.equal(await fingerprint(airwallex), airwallexOriginalHash);
		return { screenshot: wide, retainedBanks: [...new Set(retained.map((record) => record.result.adapter?.bankId))] };
	});
	await check('airwallex-partial-ui-retains-three-valid-rows-and-one-visible-unknown-draft-after-restart', async () => {
		const before = await bankRecords();
		const savedHash = await fingerprint(workspaceFile);
		const imported = await importFile(airwallexPartial);
		await drafts().waitFor();
		assert.equal(imported.workspace.dirty, true);
		assert.equal(await fingerprint(workspaceFile), savedHash);
		const records = await bankRecords();
		const record = records.at(-1);
		assert.ok(record);
		assert.deepEqual(records.slice(0, -1), before);
		assert.equal(record.result.status, 'partial');
		assert.equal(record.result.transactions.length, 3);
		assert.equal(record.result.unresolvedDrafts.length, 1);
		assert.equal(record.result.unresolvedDrafts[0].accountAmount, null);
		assert.deepEqual(
			record.result.transactions.map((row) => row.accountAmount.value.coefficient),
			['-1307', '419', '2753']
		);
		assert.equal(await transactions().locator('tbody > tr').count(), 3);
		assert.equal(await drafts().locator('tbody > tr').count(), 1);
		assert.equal(normalized(await drafts().locator('td.amount-cell').first().textContent()), 'Unknown');
		assert.ok((await drafts().locator('.row-issues li').count()) > 0);
		await page.getByTestId('statement-warnings').waitFor();
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		const retained = await bankRecords();
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Open workspace', exact: true }), 'open');
		await waitState({ filePath: workspaceFile, dirty: false });
		await transactions().waitFor();
		assert.deepEqual(await bankRecords(), retained);
		await selectStatement(record);
		await drafts().waitFor();
		assert.equal(await transactions().locator('tbody > tr').count(), 3);
		assert.equal(await drafts().locator('tbody > tr').count(), 1);
		assert.equal(normalized(await drafts().locator('td.amount-cell').first().textContent()), 'Unknown');
		await currentApplication().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 800));
		await settle();
		const region = page.getByRole('region', { name: 'Transactions table, horizontally scrollable', exact: true });
		await region.focus();
		const bounds = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
		assert.equal(bounds.width, 680);
		assert.ok(bounds.content <= bounds.client + 1, JSON.stringify(bounds));
		return { screenshot: await screenshot('airwallex-partial-narrow'), bounds };
	});
	await check('airwallex-records-and-selected-partial-view-survive-failed-inputs-and-native-chooser-cancellation', async () => {
		const before = await bankRecords();
		const savedHash = await fingerprint(workspaceFile);
		const selected = await page.getByLabel('Statement', { exact: true }).inputValue();
		for (const [file, status, code] of [
			[unknown, 'unsupported'],
			[malformed, 'failed', 'pdf-invalid'],
			[path.resolve('tests/fixtures/password-required.pdf'), 'failed', 'pdf-password'],
			[null, 'cancelled']
		] as const) {
			const result = await importFile(file, status, code);
			assert.equal(result.workspace.dirty, false);
			assert.deepEqual(await bankRecords(), before);
			assert.equal(await fingerprint(workspaceFile), savedHash);
			assert.equal(await page.getByLabel('Statement', { exact: true }).inputValue(), selected);
			assert.equal(await transactions().locator('tbody > tr').count(), 3);
			assert.equal(await drafts().locator('tbody > tr').count(), 1);
			assert.equal(normalized(await drafts().locator('td.amount-cell').first().textContent()), 'Unknown');
		}
	});
	await check('airwallex-uncertain-real-ocr-retains-visible-drafts-without-inventing-financial-values-through-save-and-restart', async () => {
		const uncertain = path.resolve('tests/fixtures/airwallex-synthetic-uncertain-scan.pdf');
		const sourceHash = await fingerprint(uncertain);
		const before = await bankRecords();
		const savedHash = await fingerprint(workspaceFile);
		const imported = await importFile(uncertain);
		await drafts().waitFor();
		assert.equal(imported.workspace.dirty, true);
		assert.equal(await fingerprint(workspaceFile), savedHash);
		const records = await bankRecords();
		const record = records.at(-1);
		assert.ok(record);
		assert.deepEqual(records.slice(0, -1), before);
		assert.equal(record.result.adapter?.bankId, 'airwallex');
		assert.equal(record.result.status, 'partial');
		assert.equal(record.result.sourceProvenance?.sha256, sourceHash);
		assert.ok(record.result.transactions.length > 0, 'Readable financial rows must remain available beside unresolved rows.');
		assert.ok(record.result.unresolvedDrafts.length > 0);
		const expected = new Map([
			['2032-03-01', { amount: '-1643', direction: 'outgoing', original: { coefficient: '-1807', currency: 'USD', scale: 2 } }],
			['2032-03-02', { amount: '-1307', direction: 'outgoing', original: null }],
			['2032-03-03', { amount: '419', direction: 'incoming', original: { coefficient: '419', currency: 'EUR', scale: 2 } }]
		]);
		const represented = [...record.result.transactions, ...record.result.unresolvedDrafts];
		for (const date of expected.keys())
			assert.equal(
				represented.filter((row) => row.bookingDate?.value === date).length,
				1,
				'Every source transaction must remain visible as exactly one transaction or unresolved draft.'
			);
		const retainedDates = new Set();
		for (const row of record.result.transactions) {
			const wanted = expected.get(row.bookingDate.value);
			assert.ok(wanted, 'Only a known, readable source transaction can be imported.');
			assert.ok(!retainedDates.has(row.bookingDate.value));
			retainedDates.add(row.bookingDate.value);
			assert.deepEqual(row.accountAmount.value, { coefficient: wanted.amount, currency: 'EUR', scale: 2 });
			assert.equal(row.direction, wanted.direction);
			assert.deepEqual(row.reportedOriginalAmount?.value ?? null, wanted.original);
			assert.ok([...row.bookingDate.evidence, ...row.accountAmount.evidence, ...row.description.evidence].every((value) => value.method === 'local-ocr'));
		}
		assert.ok(record.result.unresolvedDrafts.every((row) => row.issues.length && row.evidence.some((value) => value.method === 'local-ocr')));
		assert.equal(await transactions().locator('tbody > tr').count(), record.result.transactions.length);
		assert.equal(await drafts().locator('tbody > tr').count(), record.result.unresolvedDrafts.length);
		assert.ok((await drafts().locator('.row-issues li').count()) > 0);
		await page.getByTestId('statement-warnings').waitFor();
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		const retained = await bankRecords();
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Open workspace', exact: true }), 'open');
		await waitState({ filePath: workspaceFile, dirty: false });
		await transactions().waitFor();
		assert.deepEqual(await bankRecords(), retained);
		await selectStatement(record);
		await drafts().waitFor();
		assert.equal(await drafts().locator('tbody > tr').count(), record.result.unresolvedDrafts.length);
		assert.ok((await drafts().locator('.row-issues li').count()) > 0);
		assert.equal(await fingerprint(uncertain), sourceHash);
		return { transactions: record.result.transactions.length, unresolvedDrafts: record.result.unresolvedDrafts.length, sourceHash };
	});
	await check('airwallex-active-ocr-cancellation-preserves-records-and-real-raster-import-recovers-with-exact-values', async () => {
		const before = await bankRecords();
		const savedHash = await fingerprint(workspaceFile);
		const sequence = await commandSequence();
		await dialogs({ opens: [airwallexScanned] });
		await page.getByRole('button', { name: 'Import statement', exact: true }).click();
		await page.waitForFunction(async () => (await window.receiptmatch.command({ type: 'get-state' })).statementImport?.progress?.phase === 'ocr');
		await page.getByTestId('import-progress').waitFor();
		for (const name of ['New', 'Open', 'Save']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
		await clickCommand(page.getByRole('button', { name: 'Cancel import', exact: true }), 'cancel-import');
		const cancelled = await outcome('cancelled');
		const completion = await commandEnd('import-statement', sequence);
		assert.equal(completion.outcome, 'cancelled');
		assert.equal(cancelled.workspace.dirty, false);
		assert.deepEqual(await bankRecords(), before);
		assert.equal(await fingerprint(workspaceFile), savedHash);
		await currentApplication().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 900));
		const imported = await importFile(airwallexScanned);
		await transactions().waitFor();
		assert.equal(imported.workspace.dirty, true);
		assert.equal(await fingerprint(workspaceFile), savedHash);
		const records = await bankRecords();
		const record = records.at(-1);
		assert.ok(record);
		assert.deepEqual(records.slice(0, -1), before);
		assert.equal(record.result.adapter?.bankId, 'airwallex');
		assert.equal(record.result.status, 'complete');
		assert.equal(record.result.unresolvedDrafts.length, 0);
		assert.equal(record.result.sourceProvenance?.sha256, airwallexScanHash);
		assert.deepEqual(
			record.result.transactions.map((row) => [row.bookingDate.value, row.accountAmount.value.coefficient]),
			[
				['2032-03-01', '-1643'],
				['2032-03-02', '-1307'],
				['2032-03-03', '419']
			]
		);
		assert.deepEqual(
			record.result.transactions.map((row) => row.reportedOriginalAmount?.value ?? null),
			[{ coefficient: '-1807', currency: 'USD', scale: 2 }, null, { coefficient: '419', currency: 'EUR', scale: 2 }]
		);
		assert.ok(
			record.result.transactions.every(
				(row) =>
					row.bookingDate.basisLabel === 'Date' &&
					[...row.bookingDate.evidence, ...row.accountAmount.evidence, ...row.description.evidence].every((value) => value.method === 'local-ocr')
			)
		);
		assert.equal(record.result.accountSections[0].accountReference, null);
		assert.equal(await transactions().locator('tbody > tr').count(), 3);
		const visible = normalized(await transactions().textContent());
		for (const value of ['-16,43 EUR', '-13,07 EUR', '4,19 EUR', '-18,07 USD']) assert.ok(visible.includes(value), value);
		const first = transactions().locator('tbody > tr').first();
		await first.getByText('Source details', { exact: true }).click();
		await first
			.getByRole('region', { name: 'Account amount', exact: true })
			.getByText(/Local English OCR/)
			.first()
			.waitFor();
		assert.equal(normalized(await sourceFact(first, 'Printed date basis').textContent()), 'Date');
		await clickCommand(page.getByRole('button', { name: 'Save', exact: true }), 'save');
		await waitState({ dirty: false });
		const retained = await bankRecords();
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		await clickCommand(page.getByRole('button', { name: 'Open workspace', exact: true }), 'open');
		await waitState({ filePath: workspaceFile, dirty: false });
		await transactions().waitFor();
		assert.deepEqual(await bankRecords(), retained);
		await selectStatement(record);
		assert.equal(await transactions().locator('tbody > tr').count(), 3);
		assert.equal(await fingerprint(airwallexScanned), airwallexScanHash);
	});
	assert.equal(await fingerprint(airwallex), airwallexOriginalHash);
	assert.equal(await fingerprint(airwallexScanned), airwallexScanHash);
	assert.equal(await fingerprint(original), beforeOriginal);
	report.limits = [
		'Synthetic statements and native-dialog stubs; no private financial files.',
		'Scale-18/XSS presentation workspace was explicitly seeded through the Store API.',
		'Visible ReceiptMatch-window captures only; no OS desktop capture or installer/physical-GPU certification.',
		'Fault injection wraps pinned Electron IPC handlers only in host automation, without production test flags.'
	];
});
