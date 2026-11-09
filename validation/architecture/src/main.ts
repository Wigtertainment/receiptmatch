import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { stringify } from 'csv-stringify/sync';
import type { ExtractionDocument, ExtractionImage, ExtractionOperation, ExtractionOverrides, ExtractionPage, ExtractionResult, ExtractionValue } from './extraction-types.js';

interface AssociationRevision { revision: bigint | null; transactionRevision: bigint; documentRevision: bigint | null; }
interface AssociationRow extends AssociationRevision { id: string; transactionId: string; documentId: string; confidence: string; approved: string | null; source: string; }
interface TransactionRow { id: string; amount: bigint; currency: string; scale: bigint; }
interface ReportRow extends AssociationRevision { transactionId: string; amount: bigint; currency: string; scale: bigint; reference: string; fixtureState: string; associationId: string | null; documentId: string | null; confidence: string | null; approved: string | null; source: string | null; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
function errorCode(error: unknown): string | undefined { return record(error) && typeof error.code === 'string' ? error.code : undefined; }

// Synthetic architecture evidence only: no product matching algorithm or approved financial policies.
const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const directory = argument('validation-dir');
const stage = argument('validation-stage');
if (!directory || !path.isAbsolute(directory) || !['save', 'restore'].includes(stage ?? '')) throw new Error('Explicit validation directory/stage required');
nodeFs.mkdirSync(path.join(directory, `userdata-${stage}`), { recursive: true });
app.setPath('userData', path.join(directory, `userdata-${stage}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'validation', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const started = performance.now();
const checks: { name: string; milliseconds: number; status: string; detail?: unknown }[] = [];
const networkAttempts: string[] = [];
let review: BrowserWindow;
let db: Database.Database;
let nextJob = 0;

async function check(name: string, action: () => Promise<unknown> | unknown) {
  const tick = performance.now();
  const detail = await action();
  checks.push({ name, milliseconds: Math.round(performance.now() - tick), status: 'passed', ...(detail === undefined ? {} : { detail }) });
}
function secureWindow(preload: string) {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, preload), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('console-message', details => { if (details.level === 'warning' || details.level === 'error') console.error(`Renderer: ${details.message}`); });
  return window;
}
function validateExtractionResult(operation: 'image', value: unknown): ExtractionImage;
function validateExtractionResult(operation: 'extract', value: unknown): ExtractionDocument;
function validateExtractionResult(operation: ExtractionOperation, value: unknown): ExtractionValue;
function validateExtractionResult(operation: ExtractionOperation, value: unknown): ExtractionValue {
  if (!record(value)) throw new Error('Invalid extraction result');
  if (operation === 'image') {
    if (typeof value.image !== 'string' || value.image.length > 10000000 || !/^[A-Za-z0-9+/=]+$/.test(value.image)) throw new Error('Invalid extraction image');
    return { image: value.image };
  }
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 4 || value.nodeAvailable !== false) throw new Error('Invalid extraction pages');
  const seen = new Set<number>();
  const pages: ExtractionPage[] = [];
  for (const candidate of value.pages as unknown[]) {
    if (!record(candidate)) throw new Error('Invalid extraction page payload');
    const page = candidate;
    if (typeof page.page !== 'number' || !Number.isInteger(page.page) || page.page < 1 || page.page > 4 || seen.has(page.page) || (page.method !== 'embedded-text' && page.method !== 'local-ocr') || typeof page.text !== 'string' || page.text.length > 50000) throw new Error('Invalid extraction page payload');
    if (page.confidence !== undefined && (typeof page.confidence !== 'number' || !Number.isFinite(page.confidence) || page.confidence < 0 || page.confidence > 100)) throw new Error('Invalid extraction confidence');
    seen.add(page.page);
    pages.push({ page: page.page, method: page.method, text: page.text, ...(typeof page.confidence === 'number' ? { confidence: page.confidence } : {}) });
  }
  return { pages, nodeAvailable: false, ...(typeof value.crossOriginIsolated === 'boolean' ? { crossOriginIsolated: value.crossOriginIsolated } : {}) };
}
function extract(operation: 'image'): Promise<ExtractionResult<ExtractionImage>>;
function extract(operation: 'extract', bytes: Uint8Array, overrides?: ExtractionOverrides): Promise<ExtractionResult<ExtractionDocument>>;
async function extract(operation: ExtractionOperation, bytes?: Uint8Array, overrides: ExtractionOverrides = {}): Promise<ExtractionResult> {
  const window = secureWindow('extract-preload.cjs');
  const id = ++nextJob;
  return new Promise<ExtractionResult>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, value?: ExtractionResult) => {
      if (settled) return; settled = true; clearTimeout(timeout);
      ipcMain.removeListener('extraction:ready', ready); ipcMain.removeListener('extraction:result', result);
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const timeout = setTimeout(() => done(new Error('Extraction fixture timeout')), 60000);
    const ready = (event: Electron.IpcMainEvent) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== 'validation://app/extract/index.html') return;
      window.webContents.send('extraction:job', { id, operation, bytes, maxPages: 4, maxPixels: 2000000, ...overrides });
    };
    const result = (event: Electron.IpcMainEvent, message: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== 'validation://app/extract/index.html' || !record(message) || message.id !== id) return;
      if (message.kind === 'progress' && overrides.cancelOnOcr) return done(new Error('fixture extraction cancelled'));
      if (message.kind === 'progress' && overrides.crashOnOcr) { window.webContents.forcefullyCrashRenderer(); return; }
      if (message.kind === 'error') return done(new Error(String(message.error)));
      if (message.kind === 'result') {
        try { done(undefined, { ...validateExtractionResult(operation, message.value), processId: window.webContents.getOSProcessId() }); }
        catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
      }
    };
    ipcMain.on('extraction:ready', ready); ipcMain.on('extraction:result', result);
    window.webContents.on('render-process-gone', (_event, details) => done(new Error(`Extraction process gone: ${details.reason}`)));
    void window.loadURL('validation://app/extract/index.html').catch(done);
  });
}
async function hash(file: string) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

async function fixtures() {
  const image = await extract('image');
  const source = path.join(directory!, 'sources');
  await fs.mkdir(source, { recursive: true });
  for (const [name, methods] of [['text', ['text']], ['scan', ['scan']], ['mixed', ['text', 'scan']]] as const) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const method of methods) {
      const page = pdf.addPage([600, 180]);
      if (method === 'text') page.drawText('RECEIPTMATCH VALIDATION TOTAL USD 123.45', { x: 20, y: 100, size: 14, font });
      else page.drawImage(await pdf.embedPng(Buffer.from(image.image, 'base64')), { x: 0, y: 0, width: 600, height: 180 });
    }
    await fs.writeFile(path.join(source, `${name}.pdf`), await pdf.save());
  }
  await fs.writeFile(path.join(source, 'malformed.pdf'), Buffer.from('This is not a PDF.'));
  return source;
}

function openDatabase() {
  db = new Database(path.join(directory!, 'workspace.sqlite'));
  db.pragma('foreign_keys = ON'); db.defaultSafeIntegers(true);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1n);
}
function approvalStamp(row: AssociationRevision) { return `${row.revision}:${row.transactionRevision}:${row.documentRevision}`; }
function association(id: string) {
  return db.prepare<[string], AssociationRow>('SELECT a.*, t.revision AS transactionRevision, d.revision AS documentRevision, d.source FROM associations a JOIN transactions t ON t.id=a.transactionId JOIN documents d ON d.id=a.documentId WHERE a.id=?').get(id);
}
async function exportCopy(id: string, name: string, destination = path.join(directory!, 'exports')) {
  const row = association(id);
  if (!row || row.approved !== approvalStamp(row)) return { status: 'rejected', reason: 'not-approved-current-revision' };
  if (!name || /[<>:"\\/|?*]/.test(name) || Array.from(name).some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || path.basename(name) !== name) return { status: 'rejected', reason: 'invalid-filename' };
  const exportRoot = await fs.realpath(path.join(directory!, 'exports'));
  const actualDestination = await fs.realpath(destination);
  if (actualDestination !== exportRoot) return { status: 'rejected', reason: 'destination-alias' };
  const target = path.join(actualDestination, name);
  const originals = db.prepare<[], { source: string }>('SELECT source FROM documents').all();
  for (const original of originals) if (target === await fs.realpath(original.source)) return { status: 'rejected', reason: 'source-alias' };
  try { await fs.copyFile(row.source, target, nodeFs.constants.COPYFILE_EXCL); return { status: 'copied', target }; }
  catch (error) { return { status: 'failed', reason: errorCode(error) }; }
}

async function save(source: string) {
  await check('synthetic-text-scan-mixed-pdf-extraction-and-ui-responsiveness', async () => {
    const ticksBefore = Number(await review.webContents.executeJavaScript('document.querySelector("output").textContent'));
    const results = [];
    for (const name of ['text', 'scan', 'mixed']) {
      const result = await extract('extract', await fs.readFile(path.join(source, `${name}.pdf`)));
      assert.equal(result.nodeAvailable, false);
      assert.notEqual(result.processId, review.webContents.getOSProcessId());
      assert.deepEqual(result.pages.map(page => page.method), name === 'text' ? ['embedded-text'] : name === 'scan' ? ['local-ocr'] : ['embedded-text', 'local-ocr']);
      for (const page of result.pages) assert.match(page.text, /TOTAL\s+USD\s+123[.,]45/i);
      results.push({ fixture: name, pages: result.pages });
    }
    const ticksAfter = Number(await review.webContents.executeJavaScript('document.querySelector("output").textContent'));
    assert.ok(ticksAfter > ticksBefore, 'Angular heartbeat must continue during OCR');
    return { results, heartbeatTicks: ticksAfter - ticksBefore };
  });
  await check('malformed-pdf-visible-error', () => assert.rejects(() => fs.readFile(path.join(source, 'malformed.pdf')).then(bytes => extract('extract', bytes)), /PDF|Invalid/i));
  const scan = await fs.readFile(path.join(source, 'scan.pdf'));
  await check('missing-local-language-visible-error', () => assert.rejects(() => extract('extract', scan, { missingLanguage: true }), /404|fetch|network|traineddata|download/i));
  await check('page-resource-guard', () => assert.rejects(() => extract('extract', scan, { maxPages: 0 }), /page limit/));
  await check('pixel-resource-guard', () => assert.rejects(() => extract('extract', scan, { maxPixels: 100 }), /pixel limit/));
  await check('actual-extraction-cancellation-at-ocr-boundary', () => assert.rejects(() => extract('extract', scan, { cancelOnOcr: true }), /cancelled/));
  await check('extraction-process-crash-is-visible-and-review-ui-survives', async () => {
    await assert.rejects(() => extract('extract', scan, { crashOnOcr: true }), /process gone/);
    const before = Number(await review.webContents.executeJavaScript('document.querySelector("output").textContent'));
    const after = Number(await review.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => resolve(document.querySelector("output").textContent), 150))'));
    assert.ok(after > before); return { heartbeatContinues: true };
  });
  await check('sqlite-exact-money-independent-approval-and-many-to-many-fixtures', () => {
    db.exec('CREATE TABLE transactions(id TEXT PRIMARY KEY, amount INTEGER NOT NULL, currency TEXT NOT NULL, scale INTEGER NOT NULL, source TEXT NOT NULL, account TEXT NOT NULL, revision INTEGER NOT NULL, reference TEXT NOT NULL, fixtureState TEXT NOT NULL); CREATE TABLE documents(id TEXT PRIMARY KEY, source TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE associations(id TEXT PRIMARY KEY, transactionId TEXT NOT NULL REFERENCES transactions(id), documentId TEXT NOT NULL REFERENCES documents(id), confidence TEXT NOT NULL, approved TEXT, revision INTEGER NOT NULL);');
    db.transaction(() => {
      const transaction = db.prepare('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)');
      transaction.run('t1', 9007199254740993n, 'USD', 2, path.join(source, 'text.pdf'), 'fixture-account-1', 1, '=HYPERLINK("unsafe")', 'associated');
      transaction.run('t2', -9007199254740993n, 'USD', 2, path.join(source, 'text.pdf'), 'fixture-account-2', 1, 'fixture', 'associated');
      transaction.run('unmatched', 12345n, 'USD', 2, path.join(source, 'text.pdf'), 'fixture-account-1', 1, 'fixture', 'unmatched');
      transaction.run('unresolved', 12345n, 'USD', 2, path.join(source, 'text.pdf'), 'fixture-account-1', 1, 'fixture', 'unresolved');
      db.prepare('INSERT INTO documents VALUES(?,?,1)').run('d1', path.join(source, 'scan.pdf'));
      db.prepare('INSERT INTO documents VALUES(?,?,1)').run('d2', path.join(source, 'mixed.pdf'));
      const insert = db.prepare('INSERT INTO associations VALUES(?,?,?,?,?,1)');
      insert.run('approved', 't1', 'd1', 'uncertain', '1:1:1');
      insert.run('unapproved', 't1', 'd2', 'reliable', null);
      insert.run('shared', 't2', 'd1', 'reliable', null);
      insert.run('stale', 't2', 'd2', 'reliable', '0:1:1');
    })();
    assert.equal(db.prepare<[string], { amount: bigint }>('SELECT amount FROM transactions WHERE id=?').get('t1')!.amount, 9007199254740993n);
    assert.equal(db.prepare<[string], { count: bigint }>('SELECT count(*) AS count FROM associations WHERE documentId=?').get('d1')!.count, 2n);
    assert.equal(association('approved')!.confidence, 'uncertain');
    assert.equal(association('unapproved')!.approved, null);
    assert.throws(() => db.prepare('INSERT INTO associations VALUES(?,?,?,?,?,1)').run('bad', 'missing', 'd1', 'reliable', null), /FOREIGN KEY/);
    return { exactCoefficient: '9007199254740993', fixtureScale: 2, currency: 'USD', futureManyToManyOnly: true, syntheticSuggestions: true };
  });
}

async function restore() {
  await check('actual-process-restart-roundtrip', () => {
    const transaction = db.prepare<[string], TransactionRow>('SELECT * FROM transactions WHERE id=?').get('t1')!;
    assert.equal(transaction.amount, 9007199254740993n); assert.equal(transaction.scale, 2n); assert.equal(transaction.currency, 'USD');
    assert.equal(association('approved')!.approved, '1:1:1'); assert.equal(association('unapproved')!.approved, null);
    assert.equal(db.prepare<[], { count: bigint }>('SELECT count(*) AS count FROM associations').get()!.count, 4n);
  });
  const exportRoot = path.join(directory!, 'exports'); await fs.mkdir(exportRoot, { recursive: true });
  await check('approval-and-revision-gate-in-authoritative-core', async () => {
    assert.equal((await exportCopy('unapproved', 'reliable.pdf')).status, 'rejected');
    assert.equal((await exportCopy('stale', 'stale.pdf')).status, 'rejected');
    assert.equal((await exportCopy('approved', 'fixture-t1.pdf')).status, 'copied');
    assert.deepEqual(await fs.readdir(exportRoot), ['fixture-t1.pdf']);
    db.prepare('UPDATE documents SET revision=revision+1 WHERE id=?').run('d1');
    assert.equal((await exportCopy('approved', 'changed-evidence.pdf')).status, 'rejected');
    db.prepare('UPDATE documents SET revision=revision-1 WHERE id=?').run('d1');
  });
  await check('fixture-batch-approval-is-atomic-and-revision-checked', () => {
    const approveBatch = db.transaction((items: { id: string; stamp: string }[]) => {
      for (const item of items) {
        const current = association(item.id);
        if (!current || item.stamp !== approvalStamp(current)) throw new Error('fixture stale review');
        db.prepare('UPDATE associations SET approved=? WHERE id=?').run(item.stamp, item.id);
      }
    });
    assert.throws(() => approveBatch([{ id: 'shared', stamp: '1:1:1' }, { id: 'unapproved', stamp: '0:1:1' }]), /stale/);
    assert.equal(association('shared')!.approved, null);
    approveBatch([{ id: 'shared', stamp: '1:1:1' }, { id: 'unapproved', stamp: '1:1:1' }]);
    assert.equal(association('shared')!.approved, '1:1:1'); assert.equal(association('unapproved')!.approved, '1:1:1');
  });
  await check('existing-file-traversal-source-alias-and-partial-outcomes', async () => {
    const target = path.join(exportRoot, 'fixture-t1.pdf'); const before = await hash(target);
    assert.equal((await exportCopy('approved', 'fixture-t1.pdf')).status, 'failed'); assert.equal(await hash(target), before);
    for (const name of ['../escape.pdf', '..\\escape.pdf', 'C:escape.pdf', 'CON.pdf', 'bad\u0001.pdf', 'trailing.pdf.']) assert.equal((await exportCopy('approved', name)).status, 'rejected');
    assert.equal((await exportCopy('approved', 'scan.pdf', path.join(directory!, 'sources'))).status, 'rejected');
    const outcomes = [await exportCopy('approved', 'partial-success.pdf'), await exportCopy('approved', 'fixture-t1.pdf')];
    assert.deepEqual(outcomes.map(value => value.status), ['copied', 'failed']);
    return outcomes;
  });
  await check('symlink-alias-protection-where-platform-permits', async () => {
    const alias = path.join(directory!, 'export-alias');
    try { await fs.symlink(path.join(directory!, 'sources'), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { const code = errorCode(error); if (code && ['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) return { skipped: true, reason: code }; throw error; }
    assert.equal((await exportCopy('approved', 'scan.pdf', alias)).status, 'rejected');
    return { rejectedDirectoryAlias: true };
  });
  await check('csv-includes-outstanding-work-with-exact-money-and-safe-text', async () => {
    // Fixture contract only: one row per stored association and one for each unassociated transaction.
    const persisted = db.prepare<[], ReportRow>('SELECT t.id AS transactionId,t.amount,t.currency,t.scale,t.reference,t.fixtureState,a.id AS associationId,a.documentId,a.confidence,a.approved,a.revision,t.revision AS transactionRevision,d.revision AS documentRevision,d.source FROM transactions t LEFT JOIN associations a ON a.transactionId=t.id LEFT JOIN documents d ON d.id=a.documentId ORDER BY t.id,a.id').all();
    const rows = persisted.map(row => ({ transaction: row.transactionId, association: row.associationId ?? '', document: row.documentId ?? '', documentReference: row.source ? path.basename(row.source) : '', status: row.fixtureState, confidence: row.confidence ?? '', approval: row.associationId === null ? '' : row.approved === approvalStamp(row) ? 'approved' : row.approved === null ? 'unapproved' : 'stale', amount: row.amount.toString(), currency: row.currency, scale: row.scale.toString(), reference: row.reference }));
    assert.deepEqual(rows.map(row => [row.transaction, row.association, row.document, row.documentReference, row.confidence, row.approval]), [
      ['t1', 'approved', 'd1', 'scan.pdf', 'uncertain', 'approved'],
      ['t1', 'unapproved', 'd2', 'mixed.pdf', 'reliable', 'approved'],
      ['t2', 'shared', 'd1', 'scan.pdf', 'reliable', 'approved'],
      ['t2', 'stale', 'd2', 'mixed.pdf', 'reliable', 'stale'],
      ['unmatched', '', '', '', '', ''], ['unresolved', '', '', '', '', '']
    ]);
    const csv = stringify(rows, { header: true, escape_formulas: true, cast: { string: (value: string, context) => {
      if (context.column !== 'amount' || context.header) return value;
      assert.match(value, /^-?\d+$/);
      return { value, escape_formulas: false };
    } } });
    const escapedReference = `"'=HYPERLINK(""unsafe"")"`;
    const expected = [
      'transaction,association,document,documentReference,status,confidence,approval,amount,currency,scale,reference',
      `t1,approved,d1,scan.pdf,associated,uncertain,approved,9007199254740993,USD,2,${escapedReference}`,
      `t1,unapproved,d2,mixed.pdf,associated,reliable,approved,9007199254740993,USD,2,${escapedReference}`,
      't2,shared,d1,scan.pdf,associated,reliable,approved,-9007199254740993,USD,2,fixture',
      't2,stale,d2,mixed.pdf,associated,reliable,stale,-9007199254740993,USD,2,fixture',
      'unmatched,,,,unmatched,,,12345,USD,2,fixture',
      'unresolved,,,,unresolved,,,12345,USD,2,fixture'
    ].join('\n') + '\n';
    assert.equal(csv, expected);
    await fs.writeFile(path.join(exportRoot, 'reconciliation.csv'), csv, { flag: 'wx' });
    return { serializer: 'csv-stringify', rows: rows.length, source: 'persisted relation join after batch approval', textFormulaProtection: 'library formula escaping; validated coefficient column excluded', exactCoefficientStrings: true, notAProductCsvContract: true };
  });
}

async function run() {
  await app.whenReady();
  const localSession = session.defaultSession;
  localSession.webRequest.onBeforeRequest((details, callback) => { if (/^(https?|wss?|ftp):/.test(details.url)) { networkAttempts.push(details.url); callback({ cancel: true }); } else callback({}); });
  localSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await protocol.handle('validation', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
    const file = path.resolve(__dirname, relative);
    if (!file.startsWith(`${path.resolve(__dirname)}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    try {
      const bytes = await fs.readFile(file);
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
      return new Response(bytes, { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'" } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  review = secureWindow('preload.cjs');
  const uiReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Angular readiness timeout')), 30000);
    ipcMain.handle('validation:ready', (event, value: unknown) => {
      if (event.sender !== review.webContents || event.senderFrame?.url !== 'validation://app/ui/browser/index.html' || !record(value) || value.angular !== true || value.node !== false) throw new Error('Invalid renderer readiness/IPC sender');
      clearTimeout(timer); resolve();
    });
  });
  await review.loadURL('validation://app/ui/browser/index.html'); await uiReady;
  await check('packaged-angular-aot-ready-with-restricted-renderer', async () => {
    const preferences = (review.webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    return { startupMilliseconds: Math.round(performance.now() - started), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node };
  });
  await check('core-rejects-malformed-and-oversized-extraction-payloads', () => {
    for (const value of [{ pages: 'bad' }, { pages: [{ page: 1, method: 'local-ocr', text: 'x'.repeat(50001) }], nodeAvailable: false }, { pages: [{ page: 1, method: 'invented', text: 'bad' }], nodeAvailable: false }]) assert.throws(() => validateExtractionResult('extract', value), /Invalid extraction/);
  });
  await check('narrow-renderer-bridge-rejects-invalid-ipc-payload', async () => {
    assert.deepEqual(await review.webContents.executeJavaScript('Object.keys(window.validation)'), ['ready', 'snapshot']);
    assert.equal(await review.webContents.executeJavaScript('window.validation.ready({angular:false}).then(() => false, () => true)'), true);
  });
  openDatabase();
  ipcMain.handle('validation:snapshot', (event, request: unknown) => {
    if (event.sender !== review.webContents || event.senderFrame?.url !== 'validation://app/ui/browser/index.html' || !record(request) || Object.keys(request).length !== 1 || typeof request.transactionId !== 'string' || !['t1', 't2', 'unmatched', 'unresolved'].includes(request.transactionId)) throw new Error('Invalid validation snapshot request/sender');
    const transaction = db.prepare<[string], TransactionRow>('SELECT id,amount,currency,scale FROM transactions WHERE id=?').get(request.transactionId);
    if (!transaction) throw new Error('Fixture transaction not available');
    const associations = db.prepare<[string], { id: string }>('SELECT id FROM associations WHERE transactionId=? ORDER BY id').all(request.transactionId).map(({ id }) => {
      const current = association(id)!;
      return { id, confidence: current.confidence, approval: current.approved === approvalStamp(current) ? 'approved' : current.approved === null ? 'unapproved' : 'stale' };
    });
    return { transactionId: transaction.id, coefficient: transaction.amount.toString(), currency: transaction.currency, scale: Number(transaction.scale), associations };
  });
  if (stage === 'save') {
    const source = await fixtures();
    const before: Record<string, string> = {}; for (const name of await fs.readdir(source)) before[name] = await hash(path.join(source, name));
    await fs.writeFile(path.join(directory!, 'original-hashes.json'), JSON.stringify(before));
    await save(source);
  } else await restore();
  await check('exact-money-and-independent-approval-over-real-core-renderer-ipc', async () => {
    const snapshot = await review.webContents.executeJavaScript("window.validation.snapshot({transactionId:'t1'})");
    assert.deepEqual(snapshot, { transactionId: 't1', coefficient: '9007199254740993', currency: 'USD', scale: 2, associations: [{ id: 'approved', confidence: 'uncertain', approval: 'approved' }, { id: 'unapproved', confidence: 'reliable', approval: stage === 'restore' ? 'approved' : 'unapproved' }] });
    assert.equal(await review.webContents.executeJavaScript("window.validation.snapshot({sql:'SELECT *'}).then(() => false, () => true)"), true);
    return { exactCoefficientType: typeof snapshot.coefficient, actualIpc: true };
  });
  await check('original-files-remain-byte-identical', async () => {
    const before = JSON.parse(await fs.readFile(path.join(directory!, 'original-hashes.json'), 'utf8'));
    for (const [name, expected] of Object.entries(before)) assert.equal(await hash(path.join(directory!, 'sources', name)), expected);
  });
  await check('no-attempted-external-network', () => assert.deepEqual(networkAttempts, []));
}

void run().then(async () => {
  if (db) db.close();
  await fs.writeFile(path.join(directory!, `${stage}.json`), JSON.stringify({ status: 'passed', stage, syntheticOnly: true, elapsedMilliseconds: Math.round(performance.now() - started), checks, networkAttempts, memory: app.getAppMetrics().map(metric => ({ type: metric.type, workingSetSizeKiB: metric.memory.workingSetSize })) }, null, 2));
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (db) db.close();
  await fs.writeFile(path.join(directory!, `${stage}.json`), JSON.stringify({ status: 'failed', stage, error: String(error), stack: error.stack, checks, networkAttempts }, null, 2));
  app.exit(1);
});
