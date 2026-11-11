import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { commandSchema, matchRequestSchema, type WorkspaceState } from '../src/shared/protocol.js';
import { WorkspaceSession } from './workspace-session.js';
import { StatementImportService } from './import/service.js';
import { FolderDocumentImportService } from './documents/service.js';
import { isRendererRequestAllowed, resolveRendererUrl } from './runtime-policy.js';

// Load the same module instance as other main-process consumers of the extraction API.
const { extractPdfBytes, extractDocumentBytes } = createRequire(__filename)('./extraction-host.cjs') as Pick<typeof import('./extraction/host.js'), 'extractPdfBytes' | 'extractDocumentBytes'>;

app.setName('ReceiptMatch');
protocol.registerSchemesAsPrivileged([
  { scheme: 'receiptmatch', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'receiptmatch-extraction', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

async function launch() {
  await app.whenReady();
  const appUrl = resolveRendererUrl(app.isPackaged, process.env.ELECTRON_START_URL || undefined);
  const assetRoot = path.join(__dirname, 'ui', 'browser');
  const assets = new Map<string, string>();
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) assets.set('/' + path.relative(assetRoot, file).split(path.sep).join('/'), file);
    }
  }
  if (appUrl === 'receiptmatch://app/index.html') await collect(assetRoot);
  protocol.handle('receiptmatch', async request => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' && !url.search ? assets.get(url.pathname) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isRendererRequestAllowed(appUrl, details.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({ title: 'ReceiptMatch', width: 1120, height: 780, minWidth: 680, minHeight: 540, backgroundColor: '#f7f6f2', show: !process.argv.includes('--hidden'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  const publish = (state: WorkspaceState) => {
    if (window.isDestroyed()) return;
    window.setTitle(state.workspace ? `${state.workspace.dirty ? '• ' : ''}${state.workspace.name || 'Untitled workspace'} — ReceiptMatch` : 'ReceiptMatch');
    window.webContents.send('workspace:state', state);
  };
  const workspace = new WorkspaceSession({
    open: async () => {
      const selected = await dialog.showOpenDialog(window, { title: 'Open workspace', properties: ['openFile'], filters: [{ name: 'ReceiptMatch workspace', extensions: ['receiptmatch'] }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    save: async name => {
      const safeName = Array.from(name, character => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '-' : character).join('').replace(/[. ]+$/, '') || 'Workspace';
      const selected = await dialog.showSaveDialog(window, { title: 'Save workspace', defaultPath: `${safeName}.receiptmatch`, filters: [{ name: 'ReceiptMatch workspace', extensions: ['receiptmatch'] }], properties: ['showOverwriteConfirmation'] });
      return selected.canceled ? null : selected.filePath ?? null;
    },
    unsaved: async name => {
      const selected = await dialog.showMessageBox(window, { type: 'question', title: 'Unsaved changes', message: `Save changes to “${name || 'Untitled workspace'}”?`, detail: 'Your unsaved changes will be lost if you discard them.', buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true });
      return (['save', 'discard', 'cancel'] as const)[selected.response] ?? 'cancel';
    }
  }, publish, new StatementImportService({
    choose: async () => {
      const selected = await dialog.showOpenDialog(window, { title: 'Import bank statement', properties: ['openFile'], filters: [{ name: 'PDF bank statement', extensions: ['pdf'] }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    extract: extractPdfBytes
  }), new FolderDocumentImportService({
    choose: async () => {
      const selected = await dialog.showOpenDialog(window, { title: 'Analyze supporting document folder', properties: ['openDirectory'] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    extract: extractDocumentBytes
  }));
  const authorized = (event: Electron.IpcMainInvokeEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl;
  ipcMain.handle('workspace:command', (event, payload: unknown) => {
    if (!authorized(event)) throw new Error('Workspace request denied.');
    const command = commandSchema.safeParse(payload);
    return command.success ? workspace.dispatch(command.data) : workspace.rejectRequest();
  });
  ipcMain.handle('workspace:bank-imports', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length) throw new Error('Workspace request denied.');
    return workspace.bankImports();
  });
  ipcMain.handle('workspace:document-imports', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length) throw new Error('Workspace request denied.');
    return workspace.documentImports();
  });
  ipcMain.handle('workspace:matches', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Workspace request denied.');
    const request = matchRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Workspace request denied.');
    const { revision, transactionId } = request.data;
    return transactionId ? workspace.matchDetails(revision, transactionId) : workspace.matchSummaries(revision);
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let closing = false;
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    void workspace.requestClose().then(allowed => { if (allowed && !window.isDestroyed()) { closing = true; window.close(); } });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New workspace', accelerator: 'CmdOrCtrl+N', click: () => { void workspace.dispatch({ type: 'new' }); } },
      { label: 'Open workspace…', accelerator: 'CmdOrCtrl+O', click: () => { void workspace.dispatch({ type: 'open' }); } },
      { label: 'Save workspace', accelerator: 'CmdOrCtrl+S', click: () => { void workspace.dispatch({ type: 'save' }); } },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]));
  await window.loadURL(appUrl);
}

app.on('window-all-closed', () => app.quit());
void launch().catch(error => { dialog.showErrorBox('ReceiptMatch could not start', error instanceof Error ? error.message : String(error)); app.exit(1); });
