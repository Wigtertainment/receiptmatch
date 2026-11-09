import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { commandSchema, type WorkspaceState } from '../src/shared/protocol.js';
import { WorkspaceSession } from './workspace-session.js';

const appUrl = 'receiptmatch://app/index.html';
app.setName('ReceiptMatch');
protocol.registerSchemesAsPrivileged([{ scheme: 'receiptmatch', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function launch() {
  await app.whenReady();
  const assetRoot = path.join(__dirname, 'ui', 'browser');
  const assets = new Map<string, string>();
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) assets.set('/' + path.relative(assetRoot, file).split(path.sep).join('/'), file);
    }
  }
  await collect(assetRoot);
  protocol.handle('receiptmatch', async request => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' && !url.search ? assets.get(url.pathname) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('receiptmatch://app/') }));
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
  }, publish);
  ipcMain.handle('workspace:command', (event, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== appUrl) throw new Error('Workspace request denied.');
    const command = commandSchema.safeParse(payload);
    return command.success ? workspace.dispatch(command.data) : workspace.rejectRequest();
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
