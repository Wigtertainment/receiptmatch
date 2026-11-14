import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { MatchApprovalSelection } from "../../src/shared/match-approvals.js";
import type { BankCorrection } from "../../src/shared/bank-corrections.js";
import type { DocumentCorrection } from "../../src/shared/document-corrections.js";
import type { DuplicateDecision } from "../../src/shared/transaction-duplicates.js";
import type { SourceEvidence, TransactionCandidate } from "../../src/shared/bank-import.js";
import type { MatchReviewCounts } from "../../src/shared/workspace-matching.js";
import type { DocumentImportSummary } from "../../src/shared/protocol.js";
import type { BankImportSummary } from "../../src/shared/workspace-import.js";
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type ServerResponse, type IncomingMessage, type Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { concurrently, type Command, type ConcurrentlyResult } from 'concurrently';
import { test as base, type ConsoleMessage, type ElectronApplication, type Page, type PlaywrightTestOptions, type PlaywrightTestArgs, type PlaywrightWorkerArgs, type TestInfo, type PlaywrightWorkerOptions, type TestType } from '@playwright/test';
import waitOn from 'wait-on';
import type { WorkspaceCommand, WorkspaceState, WorkspaceView } from '../../src/shared/protocol.js';
import type { ChildProcess } from 'node:child_process';

declare global {
	interface Window {
		receiptmatchDevelopmentState?: WorkspaceState;
		receiptmatchDevelopmentNonce?: string;
	}
}

interface RendererEvent {
	type: string;
	message?: unknown;
	url?: string;
	error?: string;
}

interface DevelopmentReport {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: 'running' | 'passed' | 'failed';
	platform: NodeJS.Platform;
	checks: { name: string; status: 'passed'; milliseconds: number }[];
	rendererEvents: (RendererEvent & { origin: string })[];
	activeCheck?: string;
	importCompletion?: WorkspaceState;
	busyPortProbe?: { requests: number; output: string };
	hmrBundleChange?: { beforeHash: string; afterHash: string; firstDifference: number; before: string; after: string };
	failureSnapshot?: Partial<Record<'state' | 'records', unknown>>;
	cleanupErrors?: string[];
	serverOutput?: string;
	error?: string;
	stack?: string;
}

interface DevelopmentTest {
	playwright: PlaywrightWorkerArgs['playwright'];
	root: string;
	report: DevelopmentReport;
	saveReport: () => Promise<void>;
	onTeardown: (cleanup: (failed: boolean) => Promise<void>) => void;
}

interface StylesheetProbe {
	original: Buffer;
	modified: Buffer;
	write: Promise<void>;
	restore?: Promise<void>;
}

const developmentUrl: "http://127.0.0.1:4310/" = 'http://127.0.0.1:4310/';
const stylesheet: string = path.resolve('src/styles.css');
const sourceFile: string = path.resolve('tests/fixtures/revolut-synthetic-scan.pdf');
const hash: (bytes: string | Buffer) => string = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & { development: DevelopmentTest; }, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<{ development: DevelopmentTest }>({
	development: async ({ playwright }: { development: DevelopmentTest; } & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, use: (r: DevelopmentTest) => Promise<void>, testInfo: TestInfo): Promise<void> => {
		const artifacts: string = path.resolve('artifacts');
		await mkdir(artifacts, { recursive: true });
		const root: string = await mkdtemp(path.join(artifacts, 'development-'));
		const reportPath: string = path.join(artifacts, `development-${process.platform}.json`);
		const report: DevelopmentReport = {
			runId: randomUUID(),
			startedAt: new Date().toISOString(),
			status: 'running',
			platform: process.platform,
			checks: [],
			rendererEvents: []
		};
		const saveReport: () => Promise<void> = (): Promise<void> => writeFile(reportPath, JSON.stringify(report, null, 2));
		let cleanup: ((failed: boolean) => Promise<void>) | undefined;
		await saveReport();
		await use({
			playwright,
			root,
			report,
			saveReport,
			onTeardown: (action: (failed: boolean) => Promise<void>): void => {
				cleanup = action;
			}
		});

		const failed: boolean = testInfo.status !== 'passed';
		report.status = failed ? 'failed' : 'passed';
		report.error = testInfo.error?.message;
		report.stack = testInfo.error?.stack;
		try {
			await cleanup?.(failed);
			if (!failed) {
				assert.equal(path.dirname(root), artifacts);
				assert.ok(path.basename(root).startsWith('development-'));
				await rm(root, { recursive: true, force: true });
			}
		} catch (error: unknown) {
			report.status = 'failed';
			report.cleanupErrors ??= [String(error)];
			throw error;
		} finally {
			report.finishedAt = new Date().toISOString();
			await saveReport();
			console.log(JSON.stringify(report, null, 2));
		}
	}
});

async function bounded<Result>(label: string, promise: Promise<Result>, milliseconds: number = 20000): Promise<Result> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve: (value: PromiseLike<never>) => void, reject: (reason?: unknown) => void): void => {
				timer = setTimeout((): void => reject(new Error(`${label} timed out`)), milliseconds);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

test.describe.configure({ timeout: 6 * 60_000 });

test('direct Electron development and stylesheet HMR', async ({ development: { playwright, root, report, saveReport, onTeardown } }: PlaywrightTestArgs & PlaywrightTestOptions & { development: DevelopmentTest; } & PlaywrightWorkerArgs & PlaywrightWorkerOptions): Promise<void> => {
	const workspaceFile: string = path.join(root, 'local-start.receiptmatch');
	let application: ElectronApplication | undefined;
	let launchingApplication: Promise<ElectronApplication> | undefined;
	let page: Page;
	let serverRun: ConcurrentlyResult | undefined;
	let serverCompletion: ConcurrentlyResult['result'] | undefined;
	let serverOutput: string = '';
	let stopOccupiedPortProbe: (() => Promise<void>) | undefined;
	let stylesheetProbe: StylesheetProbe | undefined;
	let tearingDown: boolean = false;
	const childEnvironment: { PATH: string; NG_CLI_ANALYTICS: string; CI: string; PORT: string; } = {
		...process.env,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
		NG_CLI_ANALYTICS: 'false',
		CI: '1',
		PORT: '4310'
	};

	function currentApplication(): ElectronApplication {
		assert.ok(application, 'The test-owned Electron application must be running.');
		return application;
	}

	async function check(name: string, action: () => Promise<void>): Promise<void> {
		report.activeCheck = name;
		await saveReport();
		console.log(`RUN ${name}`);
		assert.ok(!tearingDown, 'A development check cannot start during teardown.');
		const start: number = performance.now();
		await test.step(name, action, { timeout: 60000 });
		report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) });
		console.log(`PASS ${name}`);
		await saveReport();
	}

	async function launch(startUrl: string = ''): Promise<void> {
		const executablePath: unknown = (await import('electron')).default;
		assert.ok(typeof executablePath === 'string', 'The Electron package must resolve to its executable path.');
		assert.ok(!tearingDown, 'Electron cannot start during teardown.');
		launchingApplication = playwright._electron.launch({
			executablePath,
			args: ['.', '--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
			env: { ...process.env, ELECTRON_START_URL: startUrl },
			chromiumSandbox: true,
			timeout: 30000
		});
		try {
			application = await launchingApplication;
		} finally {
			launchingApplication = undefined;
		}
		page = await currentApplication().firstWindow({ timeout: 30000 });
		page.setDefaultTimeout(20000);
		const event: (detail: RendererEvent) => void = (detail: RendererEvent): void => {
			report.rendererEvents.push({ origin: startUrl || 'dist', ...detail });
			report.rendererEvents = report.rendererEvents.slice(-80);
		};
		page.on('console', (message: ConsoleMessage): void => event({ type: 'console', message: message.text() }));
		page.on('pageerror', (error: Error): void => event({ type: 'pageerror', message: String(error) }));
		page.on('requestfailed', (request: import('@playwright/test').Request): void => event({ type: 'requestfailed', url: request.url().split('?')[0], error: request.failure()?.errorText }));
		page.on('websocket', (socket: import('@playwright/test').WebSocket): void => {
			event({ type: 'websocket', url: socket.url().split('?')[0] });
			socket.on('socketerror', (error: string): void => event({ type: 'socketerror', message: String(error) }));
			socket.on('framereceived', ({ payload }: { payload: string | Buffer; }): void => {
				try {
					const value: unknown = JSON.parse(String(payload));
					const type: unknown = typeof value === 'object' && value !== null && 'type' in value ? value.type : undefined;
					event({ type: 'socketmessage', message: type });
				} catch {
					event({ type: 'socketmessage', message: 'non-JSON frame' });
				}
			});
		});
		await page.getByRole('heading', { name: 'ReceiptMatch', exact: true }).waitFor();
		assert.equal(page.url(), startUrl || 'receiptmatch://app/index.html');
		assert.equal(await currentApplication().evaluate(({ app }: typeof Electron.CrossProcessExports): boolean => app.isPackaged), false);
		await currentApplication().evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
		await page.evaluate(async (): Promise<void> => {
			window.receiptmatchDevelopmentState = await window.receiptmatch.command({ type: 'get-state' });
			window.receiptmatch.subscribe((value: WorkspaceState): void => {
				window.receiptmatchDevelopmentState = value;
			});
		});
	}

	async function dialogs({ opens = [], saves = [] }: { opens?: string[]; saves?: string[] } = {}): Promise<void> {
		await currentApplication().evaluate(
			({ dialog }: typeof Electron.CrossProcessExports, plan: { opens: string[]; saves: string[]; }): void => {
				dialog.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[]; }> => {
					const file: string | undefined = plan.opens.shift();
					return Promise.resolve({ canceled: !file, filePaths: file ? [file] : [] });
				};
				dialog.showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string; }> => {
					const file: string | undefined = plan.saves.shift();
					return Promise.resolve({ canceled: !file, filePath: file ?? '' });
				};
				dialog.showMessageBox = async (): Promise<{ response: number; checkboxChecked: false; }> => Promise.resolve({ response: 1, checkboxChecked: false });
			},
			{ opens, saves }
		);
	}

	async function state(): Promise<WorkspaceState> {
		return page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'get-state' }));
	}

	async function records(): Promise<StoredBankImport[]> {
		return page.evaluate((): Promise<StoredBankImport[]> => window.receiptmatch.bankImports());
	}

	async function command(value: WorkspaceCommand): Promise<WorkspaceState> {
		return bounded(
			`Completing the actual ${value.type} command`,
			page.evaluate((value: { type: "get-state"; } | { type: "new"; } | { type: "open"; } | { type: "save"; } | { type: "import-statement"; } | { type: "import-documents"; } | { type: "cancel-import"; } | { type: "rename"; name: string; } | { type: "set-transaction-ignored"; revision: number; transactionId: string; ignored: boolean; remember?: true | undefined; } | { type: "review-match"; revision: number; transactionId: string; review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; }; } | { type: "set-duplicate-decision"; revision: number; transactionId: string; otherTransactionId: string; decision: "separate" | "keep-first" | "keep-second" | "clear"; } | { type: "correct-bank-row"; revision: number; rowId: string; changes: { bookingDate?: string | undefined; accountAmount?: { coefficient: string; currency: string; scale: number; } | undefined; }; } | { change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; fieldId: string | null; type: "correct-document-field"; revision: number; } | { type: "approve-matches"; loadRevision: number; selections: MatchApprovalSelection[]; }): Promise<WorkspaceState> => window.receiptmatch.command(value), value),
			typeof value === 'object' && value !== null && 'type' in value && value.type === 'import-statement' ? 45000 : 20000
		);
	}

	async function waitWorkspace(expected: Partial<WorkspaceView>): Promise<void> {
		await page.waitForFunction((expected: Partial<WorkspaceView>): boolean | undefined => {
			const value: WorkspaceState | undefined = window.receiptmatchDevelopmentState;
			return value && !value.busy && Object.entries(expected).every(([key, wanted]: [string, string | number | boolean | string[] | BankImportSummary[] | BankCorrection[] | DocumentImportSummary[] | MatchReviewCounts | DocumentCorrection[] | DuplicateDecision[] | null]): boolean => value.workspace?.[key as keyof WorkspaceView] === wanted);
		}, expected);
	}

	async function close(force: boolean = false): Promise<void> {
		if (!application) {
			return;
		}
		const current: ElectronApplication = application;
		const child: ChildProcess = current.process();
		const exited: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
			} else {
				child.once('exit', (): void => resolve());
			}
		});
		const forceExit: () => Promise<void> = async (): Promise<void> => {
			// Exit before Playwright closes its main-process connection, so busy workspace actions cannot veto cleanup.
			await bounded(
				'Exiting the test-owned Electron instance',
				current.evaluate(({ app }: typeof Electron.CrossProcessExports): void => {
					setTimeout((): void => app.exit(0), 0);
				}),
				1500
			).catch((): undefined => undefined);
			try {
				await bounded('Waiting for test-owned Electron exit', exited, 5000);
			} catch {
				child.kill();
				await bounded('Waiting for killed test-owned Electron exit', exited, 5000);
			}
		};
		try {
			if (force) {
				await forceExit();
			} else {
				await bounded('Preparing test-owned dialogs for close', dialogs(), 2000);
				await bounded(
					'Closing the test-owned Electron instance',
					Promise.all([
						exited,
						current.evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): void => {
							const main: Electron.BrowserWindow = BrowserWindow.getAllWindows()[0];
							if (!main) {
								throw new Error('ReceiptMatch main window is missing.');
							}
							main.close();
						})
					]),
					10000
				);
			}
		} catch (error: unknown) {
			await forceExit();
			throw error;
		} finally {
			application = undefined;
		}
	}

	async function security(url: string): Promise<void> {
		const preferences: { sandbox: boolean | undefined; contextIsolation: boolean | undefined; nodeIntegration: boolean | undefined; } = await currentApplication().evaluate(({ BrowserWindow }: typeof Electron.CrossProcessExports): { sandbox: boolean | undefined; contextIsolation: boolean | undefined; nodeIntegration: boolean | undefined; } => {
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
		const denied: ({ url: string; error: null; } | { url: string; error: string; })[] = await currentApplication().evaluate(
			async ({ session }: typeof Electron.CrossProcessExports, urls: string[]): Promise<({ url: string; error: null; } | { url: string; error: string; })[]> =>
				Promise.all(
					urls.map(async (url: string): Promise<{ url: string; error: null; } | { url: string; error: string; }> => {
						try {
							await session.defaultSession.fetch(url);
							return { url, error: null };
						} catch (error: unknown) {
							return { url, error: String(error) };
						}
					})
				),
			['https://example.invalid/receiptmatch-development-probe', 'http://127.0.0.1:4311/']
		);
		for (const request of denied) {
			assert.match(request.error ?? '', /ERR_BLOCKED_BY_CLIENT/, `${url}: ${JSON.stringify(request)}`);
		}
		const invalid: WorkspaceState = await page.evaluate((): Promise<WorkspaceState> => window.receiptmatch.command({ type: 'write-file', path: '/not-authorized' } as unknown as WorkspaceCommand));
		assert.match(invalid.error ?? '', /not supported/);
	}

	async function startServer(): Promise<void> {
		// Fail before starting anything if another application already owns the fixed development port.
		assert.ok(!tearingDown, 'Angular cannot start during teardown.');
		await new Promise<void>((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
			const probe: NetServer = createServer();
			probe.once('error', reject);
			probe.listen(4310, '127.0.0.1', (): NetServer => probe.close((error: Error | undefined): void => (error ? reject(error) : resolve())));
		});
		assert.ok(!tearingDown, 'Angular cannot start during teardown.');
		const output: Writable = new Writable({
			write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
				serverOutput = (serverOutput + chunk.toString()).slice(-12000);
				callback();
			}
		});
		serverRun = concurrently(
			[
				{
					name: 'angular',
					command: 'node node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 4310 --hmr',
					env: childEnvironment
				}
			],
			{ cwd: process.cwd(), raw: false, prefix: 'none', outputStream: output, killOthersOn: ['failure', 'success'] }
		);
		serverCompletion = serverRun.result.then(
			(events: Awaited<ConcurrentlyResult['result']>): Awaited<ConcurrentlyResult['result']> => events,
			(events: Awaited<ConcurrentlyResult['result']>): Awaited<ConcurrentlyResult['result']> => events
		);
		await waitOn({ resources: [developmentUrl.replace(/^http:/, 'http-get:')], timeout: 60000, interval: 250, httpTimeout: 1000, proxy: false });
		assert.equal(serverRun.commands[0].state, 'started', serverOutput);
	}

	async function stopServer(): Promise<void> {
		if (!serverRun || !serverCompletion) {
			return;
		}
		for (const command of serverRun.commands) {
			if (command.state === 'started') {
				command.kill('SIGTERM');
			}
		}
		try {
			await bounded('Stopping the test-owned Angular process tree', serverCompletion, 15000);
		} catch {
			for (const command of serverRun.commands) {
				if (command.state === 'started') {
					command.kill('SIGKILL');
				}
			}
			await bounded('Killing the test-owned Angular process tree', serverCompletion, 10000);
		}
		await waitOn({ resources: ['tcp:127.0.0.1:4310'], reverse: true, timeout: 10000, interval: 100 });
		assert.ok(serverRun.commands.every((command: Command): boolean => ['exited', 'errored'].includes(command.state)));
		serverRun = undefined;
	}

	async function restoreStyles(): Promise<void> {
		const probe: StylesheetProbe | undefined = stylesheetProbe;
		if (!probe) {
			return;
		}
		probe.restore ??= (async (): Promise<void> => {
			await probe.write.catch((): undefined => undefined);
			const current: NonSharedBuffer = await readFile(stylesheet);
			if (current.equals(probe.modified)) {
				await writeFile(stylesheet, probe.original);
			} else {
				assert.ok(current.equals(probe.original), 'The stylesheet changed during the HMR probe; preserve those changes and restore the test marker manually.');
			}
		})();
		await probe.restore;
		if (stylesheetProbe === probe) {
			stylesheetProbe = undefined;
		}
	}

	onTeardown(async (failed: boolean): Promise<void> => {
		tearingDown = true;
		await launchingApplication?.catch((): undefined => undefined);
		if (failed && application) {
			report.failureSnapshot = {};
			for (const [name, read] of [
				['state', state],
				['records', records]
			] as const) {
				try {
					report.failureSnapshot[name] = await bounded<unknown>(`Reading failure ${name}`, read(), 2000);
				} catch (error: unknown) {
					report.failureSnapshot[name] = { error: String(error) };
				}
			}
		}
		const cleanupErrors: unknown[] = [];
		for (const cleanup of [restoreStyles, (): Promise<void> => close(failed), stopServer, stopOccupiedPortProbe]) {
			try {
				await cleanup?.();
			} catch (error: unknown) {
				cleanupErrors.push(error);
			}
		}
		if (failed || cleanupErrors.length) {
			report.serverOutput = serverOutput;
		}
		if (cleanupErrors.length) {
			report.cleanupErrors = cleanupErrors.map(String);
			throw new AggregateError(cleanupErrors, 'Development test cleanup failed.');
		}
	});

	await access('.build/main.cjs');
	await access('.build/ui/browser/index.html');
	const sourceHash: string = hash(await readFile(sourceFile));
	await launch();
	await check('direct-built-desktop-security-and-explicit-sqlite-workspace', async (): Promise<void> => {
		await security('dist');
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByLabel('Workspace name', { exact: true }).fill('Direct local workspace');
		await waitWorkspace({ name: 'Direct local workspace', dirty: true, filePath: null });
		await dialogs({ saves: [workspaceFile] });
		const saved: WorkspaceState = await command({ type: 'save' });
		assert.equal(saved.error, null);
		await waitWorkspace({ filePath: workspaceFile, dirty: false });
		assert.equal((await readFile(workspaceFile)).subarray(0, 16).toString(), 'SQLite format 3\0');
	});
	await check('direct-built-desktop-bundled-local-english-ocr-survives-save-and-process-restart', async (): Promise<void> => {
		const savedHash: string = hash(await readFile(workspaceFile));
		await dialogs({ opens: [sourceFile] });
		const completed: WorkspaceState = await command({ type: 'import-statement' });
		report.importCompletion = completed;
		assert.equal(completed.error, null);
		assert.equal(completed.busy, false);
		assert.equal(completed.statementImport, null);
		assert.equal(completed.importOutcome?.status, 'imported', JSON.stringify(completed));
		const imported: Awaited<ReturnType<typeof records>> = await records();
		assert.equal(imported.length, 1);
		assert.equal(imported[0].result.status, 'complete');
		assert.equal(imported[0].result.sourceProvenance?.sha256, sourceHash);
		assert.deepEqual(
			imported[0].result.transactions.map((row: TransactionCandidate): { coefficient: string; currency: string; scale: number; } => row.accountAmount.value),
			[
				{ coefficient: '-123456', currency: 'EUR', scale: 2 },
				{ coefficient: '2507', currency: 'EUR', scale: 2 }
			]
		);
		assert.deepEqual(
			imported[0].result.transactions.map((row: TransactionCandidate): string[] => [row.bookingDate.value, row.direction]),
			[
				['2032-02-28', 'outgoing'],
				['2032-02-27', 'incoming']
			]
		);
		assert.ok(imported[0].result.transactions.every((row: TransactionCandidate): boolean => [...row.bookingDate.evidence, ...row.accountAmount.evidence].every((value: SourceEvidence): boolean => value.method === 'local-ocr')));
		assert.equal(hash(await readFile(workspaceFile)), savedHash, 'Import must remain unsaved until explicit Save.');
		const persisted: WorkspaceState = await command({ type: 'save' });
		assert.equal(persisted.error, null);
		await waitWorkspace({ dirty: false });
		const saved: WorkspaceState = await state();
		assert.ok(saved.workspace);
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		const reopened: WorkspaceState = await command({ type: 'open' });
		assert.equal(reopened.error, null);
		await waitWorkspace({ filePath: workspaceFile, name: 'Direct local workspace', id: saved.workspace.id, dirty: false });
		assert.deepEqual(await records(), imported);
		assert.equal(hash(await readFile(sourceFile)), sourceHash);
	});
	await close();
	await check('actual-npm-start-refuses-an-occupied-port-before-contacting-foreign-content', async (): Promise<void> => {
		let requests: number = 0;
		let output: string = '';
		const foreign: Server<typeof IncomingMessage, typeof ServerResponse> = createHttpServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage> & { req: IncomingMessage; }): void => {
			requests++;
			response.writeHead(200);
			response.end('<h1>Synthetic foreign application</h1>');
		});
		const listening: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
			foreign.once('error', reject);
			foreign.listen(4310, '127.0.0.1', resolve);
		});
		let run: ConcurrentlyResult | undefined;
		let completion: ConcurrentlyResult['result'] | undefined;
		let cleanup: Promise<void> | undefined;
		const stopProbe: () => Promise<void> = (): Promise<void> =>
			(cleanup ??= (async (): Promise<undefined> => {
				try {
					for (const command of run?.commands ?? []) {
						if (command.state === 'started') {
							command.kill('SIGTERM');
						}
					}
					if (completion) {
						try {
							await bounded('Cleaning the occupied-port test process tree', completion, 10000);
						} catch {
							for (const command of run?.commands ?? []) {
								if (command.state === 'started') {
									command.kill('SIGKILL');
								}
							}
							await bounded('Killing the occupied-port test process tree', completion, 5000);
						}
					}
				} finally {
					await listening.catch((): undefined => undefined);
					if (foreign.listening) {
						foreign.closeAllConnections();
						await new Promise<void>((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): Server<typeof IncomingMessage, typeof ServerResponse> => foreign.close((error: Error | undefined): void => (error ? reject(error) : resolve())));
					}
					report.busyPortProbe = { requests, output };
				}
			})());
		stopOccupiedPortProbe = stopProbe;
		try {
			await listening;
			assert.ok(!tearingDown, 'npm start cannot run during teardown.');
			const captured: Writable = new Writable({
				write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
					output = (output + chunk.toString()).slice(-12000);
					callback();
				}
			});
			run = concurrently([{ name: 'actual-start', command: 'npm start', env: childEnvironment }], {
				cwd: process.cwd(),
				raw: false,
				prefix: 'none',
				outputStream: captured,
				killOthersOn: ['failure', 'success']
			});
			completion = run.result.then(
				(events: Awaited<ConcurrentlyResult['result']>): Awaited<ConcurrentlyResult['result']> => events,
				(events: Awaited<ConcurrentlyResult['result']>): Awaited<ConcurrentlyResult['result']> => events
			);
			const events: Awaited<ConcurrentlyResult['result']> = await bounded('Waiting for actual npm start to reject an occupied port', completion, 45000);
			assert.equal(events.length, 1);
			assert.equal(events[0].exitCode, 1);
			assert.match(output, /Timed out waiting for: tcp:127\.0\.0\.1:4310/);
			assert.equal(requests, 0, 'The actual start command must not navigate to another application.');
			assert.equal(run.commands[0].state, 'exited');
		} finally {
			await stopProbe();
			stopOccupiedPortProbe = undefined;
		}
	});
	await startServer();
	await launch(developmentUrl);
	await check('development-origin-keeps-sandbox-bridge-and-blocks-other-network-origins', async (): Promise<void> => {
		await security('development');
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByLabel('Workspace name', { exact: true }).fill('Development HMR workspace');
		await waitWorkspace({ name: 'Development HMR workspace', dirty: true });
	});
	await check('stylesheet-hmr-preserves-the-renderer-and-current-workspace', async (): Promise<void> => {
		const nonce: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
		const before: WorkspaceState = await state();
		const beforeBundle: string = await (await fetch(`${developmentUrl}main.js`)).text();
		await page.evaluate((nonce: `${string}-${string}-${string}-${string}-${string}`): void => {
			window.receiptmatchDevelopmentNonce = nonce;
		}, nonce);
		const originalStyles: NonSharedBuffer = await readFile(stylesheet);
		assert.ok(!tearingDown, 'The stylesheet cannot be modified during teardown.');
		const marker: string = `\n/* ReceiptMatch development probe ${nonce} */\n:root { --receiptmatch-development-probe: probe-${nonce}; }\n`;
		const probeStyles: Buffer<ArrayBuffer> = Buffer.concat([originalStyles, Buffer.from(marker)]);
		stylesheetProbe = { original: originalStyles, modified: probeStyles, write: writeFile(stylesheet, probeStyles) };
		try {
			await stylesheetProbe.write;
			await page.waitForFunction(
				(nonce: `${string}-${string}-${string}-${string}-${string}`): boolean => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === `probe-${nonce}`,
				nonce
			);
			assert.equal(await page.evaluate((): string | undefined => window.receiptmatchDevelopmentNonce), nonce);
			assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Development HMR workspace');
			assert.deepEqual((await state()).workspace, before.workspace);
		} catch (error: unknown) {
			const afterBundle: string = await bounded(
				'Comparing the changed development bundle',
				fetch(`${developmentUrl}main.js`).then((response: Response): Promise<string> => response.text()),
				3000
			);
			let index: number = 0;
			while (index < beforeBundle.length && beforeBundle[index] === afterBundle[index]) {
				index++;
			}
			report.hmrBundleChange = {
				beforeHash: hash(beforeBundle),
				afterHash: hash(afterBundle),
				firstDifference: index,
				before: beforeBundle.slice(Math.max(0, index - 100), index + 250),
				after: afterBundle.slice(Math.max(0, index - 100), index + 250)
			};
			throw error;
		} finally {
			await restoreStyles();
		}
		await page.waitForFunction((): boolean => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === '');
		assert.equal(await page.evaluate((): string | undefined => window.receiptmatchDevelopmentNonce), nonce);
		assert.deepEqual((await state()).workspace, before.workspace);
		assert.ok((await readFile(stylesheet)).equals(originalStyles), 'Restore the original stylesheet bytes exactly.');
	});
});
