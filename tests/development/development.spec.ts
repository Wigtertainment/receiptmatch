import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { concurrently, type ConcurrentlyResult } from 'concurrently';
import { test as base, type ElectronApplication, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import waitOn from 'wait-on';
import type { WorkspaceCommand, WorkspaceState, WorkspaceView } from '../../src/shared/protocol.js';

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
	saveReport(): Promise<void>;
	onTeardown(cleanup: (failed: boolean) => Promise<void>): void;
}

interface StylesheetProbe {
	original: Buffer;
	modified: Buffer;
	write: Promise<void>;
	restore?: Promise<void>;
}

const developmentUrl = 'http://127.0.0.1:4310/';
const stylesheet = path.resolve('src/styles.css');
const sourceFile = path.resolve('tests/fixtures/revolut-synthetic-scan.pdf');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const test = base.extend<{ development: DevelopmentTest }>({
	development: async ({ playwright }, use, testInfo) => {
		const artifacts = path.resolve('artifacts');
		await mkdir(artifacts, { recursive: true });
		const root = await mkdtemp(path.join(artifacts, 'development-'));
		const reportPath = path.join(artifacts, `development-${process.platform}.json`);
		const report: DevelopmentReport = {
			runId: randomUUID(),
			startedAt: new Date().toISOString(),
			status: 'running',
			platform: process.platform,
			checks: [],
			rendererEvents: []
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
			if (!failed) {
				assert.equal(path.dirname(root), artifacts);
				assert.ok(path.basename(root).startsWith('development-'));
				await rm(root, { recursive: true, force: true });
			}
		} catch (error) {
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

async function bounded<Result>(label: string, promise: Promise<Result>, milliseconds = 20000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

test.describe.configure({ timeout: 6 * 60_000 });

test('direct Electron development and stylesheet HMR', async ({ development: { playwright, root, report, saveReport, onTeardown } }) => {
	const workspaceFile = path.join(root, 'local-start.receiptmatch');
	let application: ElectronApplication | undefined;
	let launchingApplication: Promise<ElectronApplication> | undefined;
	let page: Page;
	let serverRun: ConcurrentlyResult | undefined;
	let serverCompletion: ConcurrentlyResult['result'] | undefined;
	let serverOutput = '';
	let stopOccupiedPortProbe: (() => Promise<void>) | undefined;
	let stylesheetProbe: StylesheetProbe | undefined;
	let tearingDown = false;
	const childEnvironment = {
		...process.env,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
		NG_CLI_ANALYTICS: 'false',
		CI: '1',
		PORT: '4310'
	};

	function currentApplication() {
		assert.ok(application, 'The test-owned Electron application must be running.');
		return application;
	}

	async function check(name: string, action: () => Promise<void>) {
		report.activeCheck = name;
		await saveReport();
		console.log(`RUN ${name}`);
		assert.ok(!tearingDown, 'A development check cannot start during teardown.');
		const start = performance.now();
		await test.step(name, action, { timeout: 60000 });
		report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) });
		console.log(`PASS ${name}`);
		await saveReport();
	}
	async function launch(startUrl = '') {
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
		const event = (detail: RendererEvent) => {
			report.rendererEvents.push({ origin: startUrl || 'dist', ...detail });
			report.rendererEvents = report.rendererEvents.slice(-80);
		};
		page.on('console', (message) => event({ type: 'console', message: message.text() }));
		page.on('pageerror', (error) => event({ type: 'pageerror', message: String(error) }));
		page.on('requestfailed', (request) => event({ type: 'requestfailed', url: request.url().split('?')[0], error: request.failure()?.errorText }));
		page.on('websocket', (socket) => {
			event({ type: 'websocket', url: socket.url().split('?')[0] });
			socket.on('socketerror', (error) => event({ type: 'socketerror', message: String(error) }));
			socket.on('framereceived', ({ payload }) => {
				try {
					const value: { type?: unknown } = JSON.parse(String(payload));
					event({ type: 'socketmessage', message: value.type });
				} catch {
					event({ type: 'socketmessage', message: 'non-JSON frame' });
				}
			});
		});
		await page.getByRole('heading', { name: 'Your records. Your workspace.' }).waitFor();
		assert.equal(page.url(), startUrl || 'receiptmatch://app/index.html');
		assert.equal(await currentApplication().evaluate(({ app }) => app.isPackaged), false);
		await currentApplication().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
		await page.evaluate(async () => {
			window.receiptmatchDevelopmentState = await window.receiptmatch.command({ type: 'get-state' });
			window.receiptmatch.subscribe((value) => {
				window.receiptmatchDevelopmentState = value;
			});
		});
	}
	async function dialogs({ opens = [], saves = [] }: { opens?: string[]; saves?: string[] } = {}) {
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
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			},
			{ opens, saves }
		);
	}
	async function state() {
		return page.evaluate(() => window.receiptmatch.command({ type: 'get-state' }));
	}
	async function records() {
		return page.evaluate(() => window.receiptmatch.bankImports());
	}
	async function command(value: WorkspaceCommand) {
		return bounded(
			`Completing the actual ${value.type} command`,
			page.evaluate((value) => window.receiptmatch.command(value), value),
			value.type === 'import-statement' ? 45000 : 20000
		);
	}
	async function waitWorkspace(expected: Partial<WorkspaceView>) {
		await page.waitForFunction((expected) => {
			const value = window.receiptmatchDevelopmentState;
			return value && !value.busy && Object.entries(expected).every(([key, wanted]) => value.workspace?.[key as keyof WorkspaceView] === wanted);
		}, expected);
	}
	async function close(force = false) {
		if (!application) return;
		const current = application;
		const child = current.process();
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once('exit', () => resolve());
		});
		const forceExit = async () => {
			// Exit before Playwright closes its main-process connection, so busy workspace actions cannot veto cleanup.
			await bounded(
				'Exiting the test-owned Electron instance',
				current.evaluate(({ app }) => {
					setTimeout(() => app.exit(0), 0);
				}),
				1500
			).catch(() => undefined);
			try {
				await bounded('Waiting for test-owned Electron exit', exited, 5000);
			} catch {
				child.kill();
				await bounded('Waiting for killed test-owned Electron exit', exited, 5000);
			}
		};
		try {
			if (force) await forceExit();
			else {
				await bounded('Preparing test-owned dialogs for close', dialogs(), 2000);
				await bounded(
					'Closing the test-owned Electron instance',
					Promise.all([
						exited,
						current.evaluate(({ BrowserWindow }) => {
							const main = BrowserWindow.getAllWindows()[0];
							if (!main) throw new Error('ReceiptMatch main window is missing.');
							main.close();
						})
					]),
					10000
				);
			}
		} catch (error) {
			await forceExit();
			throw error;
		} finally {
			application = undefined;
		}
	}
	async function security(url: string) {
		const preferences = await currentApplication().evaluate(({ BrowserWindow }) => {
			const contents = BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences };
			const value = contents.getLastWebPreferences();
			return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
		});
		assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
		assert.deepEqual(await page.evaluate(() => Object.keys(window.receiptmatch)), ['command', 'bankImports', 'documentImports', 'subscribe']);
		assert.equal(await page.evaluate(() => typeof Reflect.get(window, 'require')), 'undefined');
		const denied = await currentApplication().evaluate(
			async ({ session }, urls) =>
				Promise.all(
					urls.map(async (url) => {
						try {
							await session.defaultSession.fetch(url);
							return { url, error: null };
						} catch (error) {
							return { url, error: String(error) };
						}
					})
				),
			['https://example.invalid/receiptmatch-development-probe', 'http://127.0.0.1:4311/']
		);
		for (const request of denied) assert.match(request.error ?? '', /ERR_BLOCKED_BY_CLIENT/, `${url}: ${JSON.stringify(request)}`);
		const invalid = await page.evaluate(() => window.receiptmatch.command({ type: 'write-file', path: '/not-authorized' } as unknown as WorkspaceCommand));
		assert.match(invalid.error ?? '', /not supported/);
	}
	async function startServer() {
		// Fail before starting anything if another application already owns the fixed development port.
		assert.ok(!tearingDown, 'Angular cannot start during teardown.');
		await new Promise<void>((resolve, reject) => {
			const probe = createServer();
			probe.once('error', reject);
			probe.listen(4310, '127.0.0.1', () => probe.close((error) => (error ? reject(error) : resolve())));
		});
		assert.ok(!tearingDown, 'Angular cannot start during teardown.');
		const output = new Writable({
			write(chunk, _encoding, callback) {
				serverOutput = (serverOutput + chunk).slice(-12000);
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
			(events) => events,
			(events: Awaited<ConcurrentlyResult['result']>) => events
		);
		await waitOn({ resources: [developmentUrl.replace(/^http:/, 'http-get:')], timeout: 60000, interval: 250, httpTimeout: 1000, proxy: false });
		assert.equal(serverRun.commands[0].state, 'started', serverOutput);
	}
	async function stopServer() {
		if (!serverRun || !serverCompletion) return;
		for (const command of serverRun.commands) if (command.state === 'started') command.kill('SIGTERM');
		try {
			await bounded('Stopping the test-owned Angular process tree', serverCompletion, 15000);
		} catch {
			for (const command of serverRun.commands) if (command.state === 'started') command.kill('SIGKILL');
			await bounded('Killing the test-owned Angular process tree', serverCompletion, 10000);
		}
		await waitOn({ resources: ['tcp:127.0.0.1:4310'], reverse: true, timeout: 10000, interval: 100 });
		assert.ok(serverRun.commands.every((command) => ['exited', 'errored'].includes(command.state)));
		serverRun = undefined;
	}

	async function restoreStyles() {
		const probe = stylesheetProbe;
		if (!probe) return;
		probe.restore ??= (async () => {
			await probe.write.catch(() => undefined);
			const current = await readFile(stylesheet);
			if (current.equals(probe.modified)) await writeFile(stylesheet, probe.original);
			else assert.ok(current.equals(probe.original), 'The stylesheet changed during the HMR probe; preserve those changes and restore the test marker manually.');
		})();
		await probe.restore;
		if (stylesheetProbe === probe) stylesheetProbe = undefined;
	}

	onTeardown(async (failed) => {
		tearingDown = true;
		await launchingApplication?.catch(() => undefined);
		if (failed && application) {
			report.failureSnapshot = {};
			for (const [name, read] of [
				['state', state],
				['records', records]
			] as const) {
				try {
					report.failureSnapshot[name] = await bounded<unknown>(`Reading failure ${name}`, read(), 2000);
				} catch (error) {
					report.failureSnapshot[name] = { error: String(error) };
				}
			}
		}
		const cleanupErrors: unknown[] = [];
		for (const cleanup of [restoreStyles, () => close(failed), stopServer, stopOccupiedPortProbe]) {
			try {
				await cleanup?.();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (failed || cleanupErrors.length) report.serverOutput = serverOutput;
		if (cleanupErrors.length) {
			report.cleanupErrors = cleanupErrors.map(String);
			throw new AggregateError(cleanupErrors, 'Development test cleanup failed.');
		}
	});

	await access('.build/main.cjs');
	await access('.build/ui/browser/index.html');
	const sourceHash = hash(await readFile(sourceFile));
	await launch();
	await check('direct-built-desktop-security-and-explicit-sqlite-workspace', async () => {
		await security('dist');
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByLabel('Workspace name', { exact: true }).fill('Direct local workspace');
		await waitWorkspace({ name: 'Direct local workspace', dirty: true, filePath: null });
		await dialogs({ saves: [workspaceFile] });
		const saved = await command({ type: 'save' });
		assert.equal(saved.error, null);
		await waitWorkspace({ filePath: workspaceFile, dirty: false });
		assert.equal((await readFile(workspaceFile)).subarray(0, 16).toString(), 'SQLite format 3\0');
	});
	await check('direct-built-desktop-bundled-local-english-ocr-survives-save-and-process-restart', async () => {
		const savedHash = hash(await readFile(workspaceFile));
		await dialogs({ opens: [sourceFile] });
		const completed = await command({ type: 'import-statement' });
		report.importCompletion = completed;
		assert.equal(completed.error, null);
		assert.equal(completed.busy, false);
		assert.equal(completed.statementImport, null);
		assert.equal(completed.importOutcome?.status, 'imported', JSON.stringify(completed));
		const imported = await records();
		assert.equal(imported.length, 1);
		assert.equal(imported[0].result.status, 'complete');
		assert.equal(imported[0].result.sourceProvenance?.sha256, sourceHash);
		assert.deepEqual(
			imported[0].result.transactions.map((row) => row.accountAmount.value),
			[
				{ coefficient: '-123456', currency: 'EUR', scale: 2 },
				{ coefficient: '2507', currency: 'EUR', scale: 2 }
			]
		);
		assert.deepEqual(
			imported[0].result.transactions.map((row) => [row.bookingDate.value, row.direction]),
			[
				['2032-02-28', 'outgoing'],
				['2032-02-27', 'incoming']
			]
		);
		assert.ok(imported[0].result.transactions.every((row) => [...row.bookingDate.evidence, ...row.accountAmount.evidence].every((value) => value.method === 'local-ocr')));
		assert.equal(hash(await readFile(workspaceFile)), savedHash, 'Import must remain unsaved until explicit Save.');
		const persisted = await command({ type: 'save' });
		assert.equal(persisted.error, null);
		await waitWorkspace({ dirty: false });
		const saved = await state();
		assert.ok(saved.workspace);
		await close();
		await launch();
		await dialogs({ opens: [workspaceFile] });
		const reopened = await command({ type: 'open' });
		assert.equal(reopened.error, null);
		await waitWorkspace({ filePath: workspaceFile, name: 'Direct local workspace', id: saved.workspace.id, dirty: false });
		assert.deepEqual(await records(), imported);
		assert.equal(hash(await readFile(sourceFile)), sourceHash);
	});
	await close();
	await check('actual-npm-start-refuses-an-occupied-port-before-contacting-foreign-content', async () => {
		let requests = 0;
		let output = '';
		const foreign = createHttpServer((_request, response) => {
			requests++;
			response.writeHead(200);
			response.end('<h1>Synthetic foreign application</h1>');
		});
		const listening = new Promise<void>((resolve, reject) => {
			foreign.once('error', reject);
			foreign.listen(4310, '127.0.0.1', resolve);
		});
		let run: ConcurrentlyResult | undefined;
		let completion: ConcurrentlyResult['result'] | undefined;
		let cleanup: Promise<void> | undefined;
		const stopProbe = () =>
			(cleanup ??= (async () => {
				try {
					for (const command of run?.commands ?? []) if (command.state === 'started') command.kill('SIGTERM');
					if (completion) {
						try {
							await bounded('Cleaning the occupied-port test process tree', completion, 10000);
						} catch {
							for (const command of run?.commands ?? []) if (command.state === 'started') command.kill('SIGKILL');
							await bounded('Killing the occupied-port test process tree', completion, 5000);
						}
					}
				} finally {
					await listening.catch(() => undefined);
					if (foreign.listening) {
						foreign.closeAllConnections();
						await new Promise<void>((resolve, reject) => foreign.close((error) => (error ? reject(error) : resolve())));
					}
					report.busyPortProbe = { requests, output };
				}
			})());
		stopOccupiedPortProbe = stopProbe;
		try {
			await listening;
			assert.ok(!tearingDown, 'npm start cannot run during teardown.');
			const captured = new Writable({
				write(chunk, _encoding, callback) {
					output = (output + chunk).slice(-12000);
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
				(events) => events,
				(events: Awaited<ConcurrentlyResult['result']>) => events
			);
			const events = await bounded('Waiting for actual npm start to reject an occupied port', completion, 45000);
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
	await check('development-origin-keeps-sandbox-bridge-and-blocks-other-network-origins', async () => {
		await security('development');
		await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
		await page.getByLabel('Workspace name', { exact: true }).fill('Development HMR workspace');
		await waitWorkspace({ name: 'Development HMR workspace', dirty: true });
	});
	await check('stylesheet-hmr-preserves-the-renderer-and-current-workspace', async () => {
		const nonce = randomUUID();
		const before = await state();
		const beforeBundle = await (await fetch(`${developmentUrl}main.js`)).text();
		await page.evaluate((nonce) => {
			window.receiptmatchDevelopmentNonce = nonce;
		}, nonce);
		const originalStyles = await readFile(stylesheet);
		assert.ok(!tearingDown, 'The stylesheet cannot be modified during teardown.');
		const marker = `\n/* ReceiptMatch development probe ${nonce} */\n:root { --receiptmatch-development-probe: probe-${nonce}; }\n`;
		const probeStyles = Buffer.concat([originalStyles, Buffer.from(marker)]);
		stylesheetProbe = { original: originalStyles, modified: probeStyles, write: writeFile(stylesheet, probeStyles) };
		try {
			await stylesheetProbe.write;
			await page.waitForFunction(
				(nonce) => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === `probe-${nonce}`,
				nonce
			);
			assert.equal(await page.evaluate(() => window.receiptmatchDevelopmentNonce), nonce);
			assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Development HMR workspace');
			assert.deepEqual((await state()).workspace, before.workspace);
		} catch (error) {
			const afterBundle = await bounded(
				'Comparing the changed development bundle',
				fetch(`${developmentUrl}main.js`).then((response) => response.text()),
				3000
			);
			let index = 0;
			while (index < beforeBundle.length && beforeBundle[index] === afterBundle[index]) index++;
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
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === '');
		assert.equal(await page.evaluate(() => window.receiptmatchDevelopmentNonce), nonce);
		assert.deepEqual((await state()).workspace, before.workspace);
		assert.ok((await readFile(stylesheet)).equals(originalStyles), 'Restore the original stylesheet bytes exactly.');
	});
});
