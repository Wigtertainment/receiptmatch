import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { commandSchema, documentExportRequestSchema, exportSettingsRequestSchema, matchRequestSchema, type WorkspaceState } from '../src/shared/protocol.js';
import type { DocumentExportResponse } from '../src/shared/document-export.js';
import { originalAdoptionRequestSchema, originalPreviewRequestSchema, originalSourceExtensions } from '../src/shared/original-preview.js';
import { WorkspaceSession } from './workspace-session.js';
import { StatementImportService } from './import/service.js';
import { FolderDocumentImportService } from './documents/service.js';
import { isRendererRequestAllowed, resolveRendererUrl } from './runtime-policy.js';
import { OriginalPreviewWindows } from './original-preview.js';
import { readExportFilenamePattern, saveExportFilenamePattern } from './export-settings.js';
import { ExportDestinationError } from './document-export.js';
import { LocalOcrSettings } from './local-ocr-settings.js';
import { localOcrRequestSchema } from '../src/shared/local-ocr-settings.js';

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
    // Angular attaches this per-document nonce to the component styles it creates.
    const nonce = url.pathname === '/index.html' ? randomBytes(18).toString('base64') : null;
    const body = nonce ? (await readFile(file, 'utf8')).replaceAll('__RECEIPTMATCH_STYLE_NONCE__', nonce) : await readFile(file);
    const styleNonce = nonce ? ` 'nonce-${nonce}'` : '';
    const policy = `default-src 'self'; script-src 'self'; style-src 'self'${styleNonce}; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'`;
    return new Response(body, { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff', ...(nonce && { 'Cache-Control': 'no-store' }) } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isRendererRequestAllowed(appUrl, details.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({ title: 'ReceiptMatch', width: 1120, height: 780, minWidth: 680, minHeight: 540, backgroundColor: '#edf2f0', show: !process.argv.includes('--hidden'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  const userData = app.getPath('userData');
  const runtimes = path.join(app.isPackaged ? process.resourcesPath : userData, 'local-ocr-runtimes');
  const localOcr = new LocalOcrSettings(path.join(userData, 'local-ocr'), {
    'pp-ocrv6-medium': path.join(runtimes, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3.12'),
    'paddleocr-vl-1.6': path.join(runtimes, 'llama', process.platform === 'win32' ? 'llama-mtmd-cli.exe' : 'llama-mtmd-cli')
  });
  const previews = new OriginalPreviewWindows(process.argv.includes('--hidden'));
  let previewLoadRevision: number | undefined;
  const publish = (state: WorkspaceState) => {
    if (window.isDestroyed()) return;
    if (state.workspace?.loadRevision !== previewLoadRevision) {
      previewLoadRevision = state.workspace?.loadRevision;
      previews.closeAll();
    }
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
    relinkOriginal: async source => {
      const selected = await dialog.showOpenDialog(window, { title: 'Locate the original file', defaultPath: path.dirname(source.filePath),
        properties: ['openFile'], filters: [{ name: 'Original document', extensions: originalSourceExtensions[source.format].map(extension => extension.slice(1)) }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    analyzeOriginal: async source => {
      const selected = await dialog.showOpenDialog(window, { title: 'Choose a changed source to analyze', defaultPath: path.dirname(source.filePath),
        properties: ['openFile'], filters: [{ name: 'Original document', extensions: originalSourceExtensions[source.format].map(extension => extension.slice(1)) }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
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
    extract: extractDocumentBytes,
    localOcr: () => localOcr.selected()
  }), extractDocumentBytes);
  const authorized = (event: Electron.IpcMainInvokeEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl;
  const exportSettingsFile = path.join(app.getPath('userData'), 'export-settings.json');
  let confirmingOcrDownload = false;
  ipcMain.handle('app:local-ocr', async (event, payload: unknown) => {
    if (!authorized(event) || closeRequested) throw new Error('Local OCR settings request denied.');
    const request = localOcrRequestSchema.parse(payload);
    if (request.type === 'cancel') await localOcr.cancel();
    if (request.type === 'select') await localOcr.select(request.selection);
    if (request.type === 'install') {
      if (confirmingOcrDownload) throw new Error('A local OCR download confirmation is already open.');
      confirmingOcrDownload = true;
      try {
        const status = await localOcr.status();
        const model = status.models.find(model => model.model === request.model)!;
        if (status.download || !model.runtimeAvailable) throw new Error('The local OCR model cannot be installed right now.');
        if (model.installed) await localOcr.select(request.model);
        else {
          const unit = model.downloadBytes >= 1_000_000_000 ? 'gigabyte' : 'megabyte';
          const size = new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 2 })
            .format(model.downloadBytes / (unit === 'gigabyte' ? 1_000_000_000 : 1_000_000));
          const confirmation = await dialog.showMessageBox(window, {
            type: 'question', title: 'Download OCR model', message: `Download ${model.name} to this device?`,
            detail: `Download size: ${size}. ReceiptMatch processes documents on this device. Only the model download uses the network.`,
            buttons: ['Download', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
          });
          if (confirmation.response === 0 && !closeRequested && !window.isDestroyed()) await localOcr.install(request.model);
        }
      } finally {
        confirmingOcrDownload = false;
      }
    }
    return localOcr.status();
  });
  let exportSettingsWrite: Promise<string> | null = null;
  ipcMain.handle('app:export-settings', async (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Export settings request denied.');
    const request = exportSettingsRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Export settings request denied.');
    try {
      if (request.data.type === 'read') {
        await exportSettingsWrite?.catch(() => null);
        return await readExportFilenamePattern(exportSettingsFile);
      }
      const { pattern } = request.data;
      const write = Promise.resolve(exportSettingsWrite).catch(() => null).then(() => saveExportFilenamePattern(exportSettingsFile, pattern));
      exportSettingsWrite = write;
      try { return await write; }
      finally { if (exportSettingsWrite === write) exportSettingsWrite = null; }
    } catch {
      throw new Error('Export settings could not be accessed.');
    }
  });
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
  ipcMain.handle('workspace:open-original', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Workspace request denied.');
    const request = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) return { error: 'This preview request is not supported.' };
    const source = workspace.originalSource(request.data);
    return source ? previews.open(JSON.stringify([request.data.kind, request.data.id, source.filePath]), source) : { error: 'The original is not available in this workspace.' };
  });
  ipcMain.handle('workspace:relink-original', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Workspace request denied.');
    const request = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Workspace request denied.');
    return workspace.relinkOriginal(request.data);
  });
  ipcMain.handle('workspace:analyze-original', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Workspace request denied.');
    const request = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Workspace request denied.');
    return workspace.analyzeOriginal(request.data);
  });
  ipcMain.handle('workspace:accept-original-analysis', (event, ...payload: unknown[]) => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Workspace request denied.');
    const request = originalAdoptionRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Workspace request denied.');
    return workspace.acceptOriginalAnalysis(request.data);
  });
  let exportRequested = false;
  let closeRequested = false;
  ipcMain.handle('workspace:export-documents', async (event, ...payload: unknown[]): Promise<DocumentExportResponse> => {
    if (!authorized(event) || payload.length !== 1) throw new Error('Document export request denied.');
    const request = documentExportRequestSchema.safeParse(payload[0]);
    if (!request.success) throw new Error('Document export request denied.');
    if (closeRequested) return { status: 'cancelled' };
    const { loadRevision, includeCsv } = request.data;
    const initial = workspace.state();
    if (initial.workspace?.loadRevision !== loadRevision) return { status: 'failed', message: 'The workspace has changed. Open Export and try again.' };
    if (exportRequested || initial.busy) return { status: 'failed', message: 'Finish the current workspace action before exporting.' };
    const savedFingerprint = includeCsv ? workspace.savedWorkspaceFingerprint() : null;
    if (includeCsv && !savedFingerprint) return { status: 'failed', message: 'Save the workspace before exporting a reconciliation report.' };
    if (!includeCsv && !initial.workspace.approvedDocumentCount) return { status: 'completed', report: { directory: null, outcomes: [] } };
    exportRequested = true;
    try {
      const selected = await dialog.showOpenDialog(window, { title: includeCsv ? 'Choose reconciliation export folder' : 'Choose export folder', properties: ['openDirectory'] });
      const destination = selected.filePaths[0];
      if (selected.canceled || !destination || closeRequested || window.isDestroyed()) return { status: 'cancelled' };
      await exportSettingsWrite?.catch(() => null);
      const pattern = await readExportFilenamePattern(exportSettingsFile);
      const current = workspace.state();
      if (closeRequested || window.isDestroyed()) return { status: 'cancelled' };
      if (current.workspace?.loadRevision !== loadRevision) {
        return { status: 'failed', message: 'The workspace has changed. Open Export and try again.' };
      }
      if (includeCsv && workspace.savedWorkspaceFingerprint() !== savedFingerprint) {
        return { status: 'failed', message: 'The saved workspace changed while choosing a folder. Start the export again.' };
      }
      if (!includeCsv && current.workspace.matchRevision !== initial.workspace.matchRevision) {
        return { status: 'failed', message: 'The workspace or its approvals changed. Review the approvals and try again.' };
      }
      if (current.busy) return { status: 'failed', message: 'Finish the current workspace action before exporting.' };
      if (includeCsv) {
        const { csv, documentCopies } = await workspace.exportReconciliation(loadRevision, destination, pattern);
        return { status: 'completed', report: documentCopies, csv };
      }
      return { status: 'completed', report: await workspace.exportApprovedDocuments(loadRevision, destination, pattern) };
    } catch (error) {
      return { status: 'failed', message: error instanceof ExportDestinationError ? error.message : 'The export could not be started. Try again.' };
    } finally { exportRequested = false; }
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let closing = false;
  window.once('closed', () => previews.closeAll());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    void workspace.requestClose().then(async allowed => {
      if (!allowed) { closeRequested = false; return; }
      while (exportSettingsWrite) await exportSettingsWrite.catch(() => null);
      await localOcr.cancel();
      if (!window.isDestroyed()) { closing = true; window.close(); }
    });
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
