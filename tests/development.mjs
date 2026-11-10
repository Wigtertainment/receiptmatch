import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { concurrently } from 'concurrently';
import { _electron as electron } from 'playwright';
import waitOn from 'wait-on';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/development-'));
const reportPath = path.resolve(`artifacts/development-${process.platform}.json`);
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', platform: process.platform, checks: [], rendererEvents: [] };
const developmentUrl = 'http://127.0.0.1:4310/';
const workspaceFile = path.join(root, 'local-start.receiptmatch');
const sourceFile = path.resolve('tests/fixtures/revolut-synthetic-scan.pdf');
const stylesheet = path.resolve('src/styles.css');
let application, page, serverRun, serverCompletion, originalStyles, probeStyles;
let serverOutput = '';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const childEnvironment = {
    ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, NG_CLI_ANALYTICS: 'false', CI: '1', PORT: '4310'
};
await writeFile(reportPath, JSON.stringify(report, null, 2));

async function bounded(label, promise, milliseconds = 20000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
    finally { clearTimeout(timer); }
}
async function check(name, action) {
    report.activeCheck = name; await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(`RUN ${name}`);
    const start = performance.now(); await bounded(name, action(), 60000);
    report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - start) }); console.log(`PASS ${name}`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
}
async function launch(startUrl = '') {
    const executablePath = (await import('electron')).default;
    application = await electron.launch({
        executablePath, args: ['.', '--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`],
        env: { ...process.env, ELECTRON_START_URL: startUrl }, chromiumSandbox: true, timeout: 30000
    });
    page = await application.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(20000);
    const event = detail => { report.rendererEvents.push({ origin: startUrl || 'dist', ...detail }); report.rendererEvents = report.rendererEvents.slice(-80); };
    page.on('console', message => event({ type: 'console', message: message.text() }));
    page.on('pageerror', error => event({ type: 'pageerror', message: String(error) }));
    page.on('requestfailed', request => event({ type: 'requestfailed', url: request.url().split('?')[0], error: request.failure()?.errorText }));
    page.on('websocket', socket => {
        event({ type: 'websocket', url: socket.url().split('?')[0] });
        socket.on('socketerror', error => event({ type: 'socketerror', message: String(error) }));
        socket.on('framereceived', ({ payload }) => {
            try { const value = JSON.parse(String(payload)); event({ type: 'socketmessage', message: value.type }); }
            catch { event({ type: 'socketmessage', message: 'non-JSON frame' }); }
        });
    });
    await page.getByRole('heading', { name: 'Your records. Your workspace.' }).waitFor();
    assert.equal(page.url(), startUrl || 'receiptmatch://app/index.html');
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), false);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    await page.evaluate(async () => {
        window.receiptmatchDevelopmentState = await window.receiptmatch.command({ type: 'get-state' });
        window.receiptmatch.subscribe(value => { window.receiptmatchDevelopmentState = value; });
    });
}
async function dialogs({ opens = [], saves = [] } = {}) {
    await application.evaluate(({ dialog }, plan) => {
        dialog.showOpenDialog = async () => { const file = plan.opens.shift(); return { canceled: !file, filePaths: file ? [file] : [] }; };
        dialog.showSaveDialog = async () => { const file = plan.saves.shift(); return { canceled: !file, filePath: file }; };
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, { opens, saves });
}
async function state() { return page.evaluate(() => window.receiptmatch.command({ type: 'get-state' })); }
async function records() { return page.evaluate(() => window.receiptmatch.bankImports()); }
async function command(value) {
    return bounded(`Completing the actual ${value.type} command`, page.evaluate(value => window.receiptmatch.command(value), value), value.type === 'import-statement' ? 45000 : 20000);
}
async function waitWorkspace(expected) {
    await page.waitForFunction(expected => {
        const value = window.receiptmatchDevelopmentState;
        return value && !value.busy && Object.entries(expected).every(([key, wanted]) => value.workspace?.[key] === wanted);
    }, expected);
}
async function close(force = false) {
    if (!application) return;
    const current = application; const child = current.process();
    const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    const forceExit = async () => {
        // Exit before Playwright closes its main-process connection, so busy workspace actions cannot veto cleanup.
        await bounded('Exiting the test-owned Electron instance', current.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }), 1500).catch(() => {});
        try { await bounded('Waiting for test-owned Electron exit', exited, 5000); }
        catch { child.kill(); await bounded('Waiting for killed test-owned Electron exit', exited, 5000); }
    };
    try {
        if (force) await forceExit();
        else { await bounded('Preparing test-owned dialogs for close', dialogs(), 2000); await bounded('Closing the test-owned Electron instance', current.close(), 10000); }
    } catch (error) { await forceExit(); throw error; }
    finally { application = undefined; }
}
async function security(url) {
    const preferences = await application.evaluate(({ BrowserWindow }) => {
        const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert.deepEqual(await page.evaluate(() => Object.keys(window.receiptmatch)), ['command', 'bankImports', 'subscribe']);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const denied = await application.evaluate(async ({ session }, urls) => Promise.all(urls.map(async url => {
        try { await session.defaultSession.fetch(url); return { url, error: null }; }
        catch (error) { return { url, error: String(error) }; }
    })), ['https://example.invalid/receiptmatch-development-probe', 'http://127.0.0.1:4311/']);
    for (const request of denied) assert.match(request.error ?? '', /ERR_BLOCKED_BY_CLIENT/, `${url}: ${JSON.stringify(request)}`);
    const invalid = await page.evaluate(() => window.receiptmatch.command({ type: 'write-file', path: '/not-authorized' }));
    assert.match(invalid.error, /not supported/);
}
async function startServer() {
    // Fail before starting anything if another application already owns the fixed development port.
    await new Promise((resolve, reject) => {
        const probe = createServer(); probe.once('error', reject); probe.listen(4310, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
    });
    const output = new Writable({ write(chunk, _encoding, callback) { serverOutput = (serverOutput + chunk).slice(-12000); callback(); } });
    serverRun = concurrently([{
        name: 'angular', command: 'node node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 4310 --hmr',
        env: childEnvironment
    }], { cwd: process.cwd(), raw: false, prefix: 'none', outputStream: output, killOthersOn: ['failure', 'success'] });
    serverCompletion = serverRun.result.then(events => events, events => events);
    await waitOn({ resources: [developmentUrl.replace(/^http:/, 'http-get:')], timeout: 60000, interval: 250, httpTimeout: 1000, proxy: false });
    assert.equal(serverRun.commands[0].state, 'started', serverOutput);
}
async function stopServer() {
    if (!serverRun) return;
    for (const command of serverRun.commands) if (command.state === 'started') command.kill('SIGTERM');
    try { await bounded('Stopping the test-owned Angular process tree', serverCompletion, 15000); }
    catch {
        for (const command of serverRun.commands) if (command.state === 'started') command.kill('SIGKILL');
        await bounded('Killing the test-owned Angular process tree', serverCompletion, 10000);
    }
    await waitOn({ resources: ['tcp:127.0.0.1:4310'], reverse: true, timeout: 10000, interval: 100 });
    assert.ok(serverRun.commands.every(command => ['exited', 'errored'].includes(command.state)));
    serverRun = undefined;
}
async function restoreStyles() {
    if (!probeStyles) return;
    const current = await readFile(stylesheet);
    if (current.equals(probeStyles)) await writeFile(stylesheet, originalStyles);
    else assert.ok(current.equals(originalStyles), 'The stylesheet changed during the HMR probe; preserve those changes and restore the test marker manually.');
    probeStyles = undefined;
}

try {
    await access('.build/main.cjs'); await access('.build/ui/browser/index.html');
    const sourceHash = hash(await readFile(sourceFile));
    await launch();
    await check('direct-built-desktop-security-and-explicit-sqlite-workspace', async () => {
        await security('dist');
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
        await page.getByLabel('Workspace name', { exact: true }).fill('Direct local workspace');
        await waitWorkspace({ name: 'Direct local workspace', dirty: true, filePath: null });
        await dialogs({ saves: [workspaceFile] }); const saved = await command({ type: 'save' }); assert.equal(saved.error, null);
        await waitWorkspace({ filePath: workspaceFile, dirty: false });
        assert.equal((await readFile(workspaceFile)).subarray(0, 16).toString(), 'SQLite format 3\0');
    });
    await check('direct-built-desktop-bundled-local-english-ocr-survives-save-and-process-restart', async () => {
        const savedHash = hash(await readFile(workspaceFile));
        await dialogs({ opens: [sourceFile] }); const completed = await command({ type: 'import-statement' });
        report.importCompletion = completed;
        assert.equal(completed.error, null); assert.equal(completed.busy, false); assert.equal(completed.statementImport, null);
        assert.equal(completed.importOutcome?.status, 'imported', JSON.stringify(completed));
        const imported = await records(); assert.equal(imported.length, 1);
        assert.equal(imported[0].result.status, 'complete');
        assert.equal(imported[0].result.sourceProvenance.sha256, sourceHash);
        assert.deepEqual(imported[0].result.transactions.map(row => row.accountAmount.value), [
            { coefficient: '-123456', currency: 'EUR', scale: 2 }, { coefficient: '2507', currency: 'EUR', scale: 2 }
        ]);
        assert.deepEqual(imported[0].result.transactions.map(row => [row.bookingDate.value, row.direction]), [
            ['2032-02-28', 'outgoing'], ['2032-02-27', 'incoming']
        ]);
        assert.ok(imported[0].result.transactions.every(row => [...row.bookingDate.evidence, ...row.accountAmount.evidence].every(value => value.method === 'local-ocr')));
        assert.equal(hash(await readFile(workspaceFile)), savedHash, 'Import must remain unsaved until explicit Save.');
        const persisted = await command({ type: 'save' }); assert.equal(persisted.error, null); await waitWorkspace({ dirty: false });
        const saved = await state(); await close(); await launch();
        await dialogs({ opens: [workspaceFile] }); const reopened = await command({ type: 'open' }); assert.equal(reopened.error, null);
        await waitWorkspace({ filePath: workspaceFile, name: 'Direct local workspace', id: saved.workspace.id, dirty: false });
        assert.deepEqual(await records(), imported); assert.equal(hash(await readFile(sourceFile)), sourceHash);
    });
    await close();
    await check('actual-npm-start-refuses-an-occupied-port-before-contacting-foreign-content', async () => {
        let requests = 0; let output = '';
        const foreign = createHttpServer((_request, response) => { requests++; response.writeHead(200); response.end('<h1>Synthetic foreign application</h1>'); });
        await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(4310, '127.0.0.1', resolve); });
        let run, completion;
        try {
            const captured = new Writable({ write(chunk, _encoding, callback) { output = (output + chunk).slice(-12000); callback(); } });
            run = concurrently([{ name: 'actual-start', command: 'npm start', env: childEnvironment }],
                { cwd: process.cwd(), raw: false, prefix: 'none', outputStream: captured, killOthersOn: ['failure', 'success'] });
            completion = run.result.then(events => events, events => events);
            const events = await bounded('Waiting for actual npm start to reject an occupied port', completion, 45000);
            assert.equal(events.length, 1); assert.equal(events[0].exitCode, 1);
            assert.match(output, /Timed out waiting for: tcp:127\.0\.0\.1:4310/);
            assert.equal(requests, 0, 'The actual start command must not navigate to another application.');
            assert.equal(run.commands[0].state, 'exited');
        } finally {
            try {
                for (const command of run?.commands ?? []) if (command.state === 'started') command.kill('SIGTERM');
                if (completion) {
                    try { await bounded('Cleaning the occupied-port test process tree', completion, 10000); }
                    catch {
                        for (const command of run.commands) if (command.state === 'started') command.kill('SIGKILL');
                        await bounded('Killing the occupied-port test process tree', completion, 5000);
                    }
                }
            } finally {
                foreign.closeAllConnections(); await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
                report.busyPortProbe = { requests, output };
            }
        }
    });
    await startServer(); await launch(developmentUrl);
    await check('development-origin-keeps-sandbox-bridge-and-blocks-other-network-origins', async () => {
        await security('development');
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
        await page.getByLabel('Workspace name', { exact: true }).fill('Development HMR workspace');
        await waitWorkspace({ name: 'Development HMR workspace', dirty: true });
    });
    await check('stylesheet-hmr-preserves-the-renderer-and-current-workspace', async () => {
        const nonce = randomUUID(); const before = await state();
        const beforeBundle = await (await fetch(`${developmentUrl}main.js`)).text();
        await page.evaluate(nonce => { window.receiptmatchDevelopmentNonce = nonce; }, nonce);
        originalStyles = await readFile(stylesheet);
        const marker = `\n/* ReceiptMatch development probe ${nonce} */\n:root { --receiptmatch-development-probe: probe-${nonce}; }\n`;
        probeStyles = Buffer.concat([originalStyles, Buffer.from(marker)]);
        try {
            await writeFile(stylesheet, probeStyles);
            await page.waitForFunction(nonce => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === `probe-${nonce}`, nonce);
            assert.equal(await page.evaluate(() => window.receiptmatchDevelopmentNonce), nonce);
            assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Development HMR workspace');
            assert.deepEqual((await state()).workspace, before.workspace);
        } catch (error) {
            const afterBundle = await bounded('Comparing the changed development bundle', fetch(`${developmentUrl}main.js`).then(response => response.text()), 3000);
            let index = 0; while (index < beforeBundle.length && beforeBundle[index] === afterBundle[index]) index++;
            report.hmrBundleChange = {
                beforeHash: hash(beforeBundle), afterHash: hash(afterBundle), firstDifference: index,
                before: beforeBundle.slice(Math.max(0, index - 100), index + 250), after: afterBundle.slice(Math.max(0, index - 100), index + 250)
            };
            throw error;
        } finally { await restoreStyles(); }
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--receiptmatch-development-probe').trim() === '');
        assert.equal(await page.evaluate(() => window.receiptmatchDevelopmentNonce), nonce);
        assert.deepEqual((await state()).workspace, before.workspace);
        assert.ok((await readFile(stylesheet)).equals(originalStyles), 'Restore the original stylesheet bytes exactly.');
    });
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.error = String(error); report.stack = error.stack; process.exitCode = 1;
    if (application) {
        report.failureSnapshot = {};
        for (const [name, read] of [['state', state], ['records', records]]) {
            try { report.failureSnapshot[name] = await bounded(`Reading failure ${name}`, read(), 2000); }
            catch (diagnosticError) { report.failureSnapshot[name] = { error: String(diagnosticError) }; }
        }
    }
} finally {
    for (const cleanup of [restoreStyles, () => close(report.status === 'failed'), stopServer]) {
        try { await cleanup(); }
        catch (error) { report.status = 'failed'; (report.cleanupErrors ??= []).push(String(error)); process.exitCode = 1; }
    }
    if (report.status === 'passed') {
        try {
            assert.equal(path.dirname(root), path.resolve('artifacts')); assert.ok(path.basename(root).startsWith('development-'));
            await rm(root, { recursive: true, force: true });
        } catch (error) { report.status = 'failed'; report.cleanupErrors = [String(error)]; process.exitCode = 1; }
    } else report.serverOutput = serverOutput;
    report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    if (report.status === 'failed') setTimeout(() => process.exit(1), 1000);
}
