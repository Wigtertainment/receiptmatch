import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright';
import { createWorkspace, fingerprint, newMetadata } from '../.build/node/electron/store.js';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/workspace-ui-'));
const reportPath = path.resolve(`artifacts/workspace-ui-${process.platform}.json`);
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', platform: process.platform, root, checks: [], screenshots: [] };
await writeFile(reportPath, JSON.stringify(report, null, 2));
let application;
let page;
async function check(name, action) { const started = performance.now(); await action(); report.checks.push({ name, status: 'passed', milliseconds: Math.round(performance.now() - started) }); console.log(`PASS ${name}`); }
async function launch() {
  application = await electron.launch({ executablePath: path.resolve(`artifacts/package/ReceiptMatch-${process.platform}-${process.arch}/ReceiptMatch${process.platform === 'win32' ? '.exe' : ''}`), args: ['--hidden', '--disable-gpu', `--user-data-dir=${path.join(root, `profile-${randomUUID()}`)}`], timeout: 30000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await page.getByRole('heading', { name: 'Your records. Your workspace.' }).waitFor();
  await page.waitForFunction(() => ['78px', '70px'].includes(getComputedStyle(document.querySelector('.toolbar')).height));
}
async function dialogs({ saves = [], opens = [], choices = [] } = {}) {
  await application.evaluate(({ dialog }, plan) => {
    dialog.showSaveDialog = async () => { const filePath = plan.saves.shift(); return { canceled: !filePath, filePath }; };
    dialog.showOpenDialog = async () => { const filePath = plan.opens.shift(); return { canceled: !filePath, filePaths: filePath ? [filePath] : [] }; };
    dialog.showMessageBox = async () => ({ response: plan.choices.shift() ?? 2, checkboxChecked: false });
  }, { saves, opens, choices });
}
async function state() { return page.evaluate(() => window.receiptmatch.command({ type: 'get-state' })); }
async function waitState(expected) {
  await page.waitForFunction(async values => { const value = await window.receiptmatch.command({ type: 'get-state' }); return !value.busy && Object.entries(values).every(([key, wanted]) => value.workspace?.[key] === wanted); }, expected);
}
async function closeDiscard() {
  if (!application) return;
  await dialogs({ choices: [1] });
  await application.close(); application = undefined;
}
async function screenshot(name) {
  const file = path.join(root, `${name}.png`);
  try {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate());
    await page.screenshot({ path: file, animations: 'disabled', timeout: 10000 }); report.screenshots.push(file);
  } catch (error) { (report.screenshotErrors ??= []).push({ name, error: String(error) }); }
}

try {
  await launch();
  await check('packaged-empty-application-security-and-offline-boundaries', async () => {
    await screenshot('welcome');
    const preferences = await application.evaluate(({ BrowserWindow }) => { const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration }; });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert.deepEqual(await page.evaluate(() => Object.keys(window.receiptmatch)), ['command', 'subscribe']);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => fetch('https://example.invalid/').then(() => false, () => true)), true);
    const invalid = await page.evaluate(() => window.receiptmatch.command({ type: 'write-file', path: '/arbitrary' }));
    assert.equal(invalid.workspace, null); assert.match(invalid.error, /not supported/);
    assert.equal(await application.evaluate(({ ipcMain }) => ipcMain.listenerCount('write-file')), 0);
    assert.equal(await application.evaluate(async ({ net }) => (await net.fetch('receiptmatch://app/electron/main.ts')).status), 404);
  });
  const file = path.join(root, 'November.receiptmatch');
  await check('new-workspace-real-keyboard-entry-and-cancelled-first-save', async () => {
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await waitState({ dirty: true, filePath: null });
    const input = page.getByLabel('Workspace name', { exact: true });
    await input.fill(''); await input.pressSequentially('November 2026', { delay: 12 });
    await waitState({ name: 'November 2026' }); assert.equal(await input.inputValue(), 'November 2026'); assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await dialogs({ saves: [null] }); await page.getByRole('button', { name: 'Save', exact: true }).click(); await waitState({ name: 'November 2026', dirty: true, filePath: null });
    await dialogs({ saves: [file] }); await page.getByRole('button', { name: 'Save', exact: true }).click(); await waitState({ dirty: false, filePath: file });
    await screenshot('workspace');
  });
  await check('unsaved-new-cancel-and-save-choice', async () => {
    const id = (await state()).workspace.id;
    await page.getByLabel('Workspace name', { exact: true }).fill('Edited workspace'); await waitState({ name: 'Edited workspace', dirty: true });
    await dialogs({ choices: [2] }); await page.getByRole('button', { name: 'New', exact: true }).click(); await waitState({ id, dirty: true });
    await dialogs({ choices: [0] }); await page.getByRole('button', { name: 'New', exact: true }).click(); await waitState({ filePath: null, dirty: true });
    const read = new Database(file, { readonly: true }); assert.equal(read.prepare('SELECT name FROM workspace').get().name, 'Edited workspace'); read.close();
  });
  await check('existing-target-collision-and-failed-or-cancelled-open-preserve-current-work', async () => {
    const protectedFile = path.join(root, 'original.receiptmatch'); await writeFile(protectedFile, 'an unrelated original'); const originalHash = await fingerprint(protectedFile);
    await page.getByLabel('Workspace name', { exact: true }).fill('Unsaved work'); await waitState({ name: 'Unsaved work' }); const id = (await state()).workspace.id;
    await dialogs({ saves: [protectedFile] }); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').waitFor(); await waitState({ id, dirty: true }); assert.equal(await fingerprint(protectedFile), originalHash);
    await dialogs({ choices: [1], opens: [null] }); await page.getByRole('button', { name: 'Open', exact: true }).click(); await waitState({ id, dirty: true });
    const foreign = path.join(root, 'foreign.receiptmatch'); const other = new Database(foreign); other.exec('CREATE TABLE other(value TEXT)'); other.close();
    const corrupt = path.join(root, 'corrupt.receiptmatch'); await writeFile(corrupt, 'damaged file');
    const future = path.join(root, 'future.receiptmatch'); await createWorkspace(future, newMetadata()); const futureDb = new Database(future); futureDb.pragma('user_version=99'); futureDb.close();
    for (const selected of [foreign, corrupt, future]) {
      const before = await fingerprint(selected); await dialogs({ choices: [1], opens: [selected] }); await page.getByRole('button', { name: 'Open', exact: true }).click(); await page.getByRole('alert').waitFor(); await waitState({ id, name: 'Unsaved work', dirty: true }); assert.equal(await fingerprint(selected), before);
    }
  });
  await check('cancelled-save-before-new-and-close-does-not-discard', async () => {
    const id = (await state()).workspace.id;
    await dialogs({ choices: [0], saves: [null] }); await page.getByRole('button', { name: 'New', exact: true }).click(); await waitState({ id, dirty: true });
    await dialogs({ choices: [2] }); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await waitState({ id, dirty: true });
    await dialogs({ choices: [0], saves: [null] }); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await waitState({ id, dirty: true });
  });
  await check('discard-new-and-open-restore-real-workspace', async () => {
    await dialogs({ choices: [1] }); await page.getByRole('button', { name: 'New', exact: true }).click(); await waitState({ name: 'Untitled workspace', filePath: null });
    await dialogs({ choices: [1], opens: [file] }); await page.getByRole('button', { name: 'Open', exact: true }).click(); await waitState({ name: 'Edited workspace', filePath: file, dirty: false });
  });
  await check('save-failure-retains-dirty-work-and-retry-succeeds', async () => {
    await page.getByLabel('Workspace name', { exact: true }).fill('After retry'); await waitState({ name: 'After retry', dirty: true });
    await rename(file, `${file}.away`);
    try { await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').waitFor(); await waitState({ name: 'After retry', dirty: true }); }
    finally { await rename(`${file}.away`, file); }
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await waitState({ name: 'After retry', dirty: false });
  });
  await check('native-close-save-persists-and-process-restart-opens-same-state', async () => {
    await page.getByLabel('Workspace name', { exact: true }).fill('Saved on close'); await waitState({ dirty: true });
    await dialogs({ choices: [0] });
    const exiting = application.waitForEvent('close'); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exiting; application = undefined;
    const db = new Database(file); db.pragma('foreign_keys=ON');
    db.exec("INSERT INTO sources VALUES('s1','/references/original.pdf',NULL); INSERT INTO accounts VALUES('a1','Business','EUR'); INSERT INTO statements VALUES('st1','a1','s1'); INSERT INTO transactions VALUES('t1','st1','9007199254740993','EUR',2,1); INSERT INTO documents VALUES('d1','s1',1); INSERT INTO documents VALUES('d2','s1',1); INSERT INTO associations VALUES('x1','t1','d1','uncertain',1,'1:1:1'); INSERT INTO associations VALUES('x2','t1','d2','reliable',1,NULL);"); db.close();
    await launch(); await dialogs({ opens: [file] }); await page.getByRole('button', { name: 'Open workspace', exact: true }).click(); await waitState({ name: 'Saved on close', filePath: file, dirty: false });
    await page.getByLabel('Workspace name', { exact: true }).fill('Resume preserved'); await waitState({ dirty: true }); await page.getByRole('button', { name: 'Save', exact: true }).click(); await waitState({ dirty: false });
    const read = new Database(file, { readonly: true });
    assert.equal(read.prepare('SELECT coefficient FROM transactions').get().coefficient, '9007199254740993');
    assert.deepEqual(read.prepare('SELECT confidence,approved_revision FROM associations ORDER BY id').all(), [{ confidence: 'uncertain', approved_revision: '1:1:1' }, { confidence: 'reliable', approved_revision: null }]); read.close();
  });
  await check('native-close-discard-keeps-previous-saved-state', async () => {
    await page.getByLabel('Workspace name', { exact: true }).fill('Discard on close'); await waitState({ dirty: true });
    await dialogs({ choices: [1] }); const exiting = application.waitForEvent('close'); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exiting; application = undefined;
    const read = new Database(file, { readonly: true }); assert.equal(read.prepare('SELECT name FROM workspace').get().name, 'Resume preserved'); read.close();
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); report.stack = error.stack; process.exitCode = 1; }
finally {
  if (application) await closeDiscard();
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
