import type { MatchApprovalSelection } from "../src/shared/match-approvals.js";
import type { StoredBankImport } from "../src/shared/workspace-import.js";
import type { StoredDocumentImport } from "../src/shared/workspace-documents.js";
import type { ReconciliationExportReport } from "../src/shared/document-export.js";
import type { OriginalAdoptionResult } from "../src/shared/original-preview.js";
import type { OriginalAnalysisResult } from "../src/shared/original-preview.js";
import type { OriginalRelinkResult } from "../src/shared/original-preview.js";
import type { OriginalPreviewResult } from "../src/shared/original-preview.js";
import type { MatchDetails } from "../src/shared/workspace-matching.js";
import type { MatchSummary } from "../src/shared/workspace-matching.js";
import type { DocumentSnapshot } from "../src/shared/protocol.js";
import type { LocalOcrModel } from "../src/shared/pdf-extraction.js";
import type { LocalOcrStatus } from "../src/shared/local-ocr-settings.js";
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { commandSchema, documentExportRequestSchema, documentSnapshotRequestSchema, exportSettingsRequestSchema, matchRequestSchema, type WorkspaceState } from '../src/shared/protocol.js';
import type { DocumentExportResponse } from '../src/shared/document-export.js';
import { originalAdoptionRequestSchema, originalPreviewRequestSchema, originalSourceExtensions } from '../src/shared/original-preview.js';
import { WorkspaceSession } from './workspace-session.js';
import { offerStartupUpdate } from './desktop-update.js';
import type { BaseUpdater } from 'electron-updater';
import { StatementImportService } from './import/service.js';
import { FolderDocumentImportService } from './documents/service.js';
import { isRendererRequestAllowed, resolveRendererUrl } from './runtime-policy.js';
import { OriginalPreviewWindows, type OriginalSource } from './original-preview.js';
import { readExportFilenamePattern, saveExportFilenamePattern } from './export-settings.js';
import { ExportDestinationError } from './document-export.js';
import { LocalOcrSettings } from './local-ocr-settings.js';
import { localOcrRequestSchema } from '../src/shared/local-ocr-settings.js';
import type { ZodSafeParseResult } from 'zod';
import type { LocalDocumentOcr } from './extraction/host.js';

// Load the same module instance as other main-process consumers of the extraction API.
const { extractPdfBytes, extractDocumentBytes }: Pick<typeof import("./extraction/host.js"), "extractPdfBytes" | "extractDocumentBytes"> = createRequire(__filename)('./extraction-host.cjs') as Pick<typeof import('./extraction/host.js'), 'extractPdfBytes' | 'extractDocumentBytes'>;

app.setName('ReceiptMatch');
protocol.registerSchemesAsPrivileged([
  { scheme: 'receiptmatch', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'receiptmatch-extraction', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

async function launch(): Promise<void> {
  await app.whenReady();
  const startUrl: string | undefined = process.env.ELECTRON_START_URL;
  const appUrl: ReturnType<typeof resolveRendererUrl> = resolveRendererUrl(app.isPackaged, startUrl?.length ? startUrl : undefined);
  const assetRoot: string = path.join(__dirname, 'ui', 'browser');
  const assets: Map<string, string> = new Map<string, string>();
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file: string = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(file);
      } else if (entry.isFile()) {
        assets.set('/' + path.relative(assetRoot, file).split(path.sep).join('/'), file);
      }
    }
  }
  if (appUrl === 'receiptmatch://app/index.html') {
    await collect(assetRoot);
  }
  protocol.handle('receiptmatch', async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const file: string | undefined = url.hostname === 'app' && !url.search ? assets.get(url.pathname) : undefined;
    if (!file) {
      return new Response('Not found', { status: 404 });
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    // Angular attaches this per-document nonce to the component styles it creates.
    const nonce: string | null = url.pathname === '/index.html' ? randomBytes(18).toString('base64') : null;
    const body: string | NonSharedBuffer = nonce ? (await readFile(file, 'utf8')).replaceAll('__RECEIPTMATCH_STYLE_NONCE__', nonce) : await readFile(file);
    const styleNonce: string = nonce ? ` 'nonce-${nonce}'` : '';
    const policy: string = `default-src 'self'; script-src 'self'; style-src 'self'${styleNonce}; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'`;
    return new Response(body, { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff', ...(nonce && { 'Cache-Control': 'no-store' }) } });
  });
  session.defaultSession.webRequest.onBeforeRequest((details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => callback({ cancel: !isRendererRequestAllowed(appUrl, details.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents: Electron.WebContents, _permission: "ar" | "automatic-fullscreen" | "background-fetch" | "background-sync" | "captured-surface-control" | "clipboard-read" | "clipboard-sanitized-write" | "deprecated-sync-clipboard-read" | "display-capture" | "fileSystem" | "fullscreen" | "geolocation" | "geolocation-approximate" | "hand-tracking" | "hid" | "idle-detection" | "keyboardLock" | "local-fonts" | "local-network" | "local-network-access" | "loopback-network" | "media" | "mediaKeySystem" | "midi" | "midiSysex" | "nfc" | "notifications" | "openExternal" | "payment-handler" | "periodic-background-sync" | "persistent-storage" | "pointerLock" | "screen-wake-lock" | "sensors" | "serial" | "smart-card" | "speaker-selection" | "storage-access" | "system-wake-lock" | "top-level-storage-access" | "usb" | "vr" | "web-app-installation" | "web-printing" | "window-management" | "unknown", callback: (permissionGranted: boolean) => void): void => callback(false));
  session.defaultSession.setPermissionCheckHandler((): false => false);
  const window: BrowserWindow = new BrowserWindow({ title: 'ReceiptMatch', width: 1120, height: 780, minWidth: 680, minHeight: 540, backgroundColor: '#edf2f0', show: !process.argv.includes('--hidden'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  const userData: string = app.getPath('userData');
  const runtimes: string = path.join(app.isPackaged ? process.resourcesPath : userData, 'local-ocr-runtimes');
  const localOcr: LocalOcrSettings = new LocalOcrSettings(path.join(userData, 'local-ocr'), {
    'pp-ocrv6-medium': path.join(runtimes, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3.12'),
    'paddleocr-vl-1.6': path.join(runtimes, 'llama', process.platform === 'win32' ? 'llama-mtmd-cli.exe' : 'llama-mtmd-cli')
  });
  const previews: OriginalPreviewWindows = new OriginalPreviewWindows(process.argv.includes('--hidden'));
  let previewLoadRevision: number | undefined;
  const publish: (state: WorkspaceState) => void = (state: WorkspaceState): void => {
    if (window.isDestroyed()) {
      return;
    }
    if (state.workspace?.loadRevision !== previewLoadRevision) {
      previewLoadRevision = state.workspace?.loadRevision;
      previews.closeAll();
    }
    window.setTitle(state.workspace ? `${state.workspace.dirty ? '• ' : ''}${state.workspace.name || 'Untitled workspace'} — ReceiptMatch` : 'ReceiptMatch');
    window.webContents.send('workspace:state', state);
  };
  const workspace: WorkspaceSession = new WorkspaceSession({
    open: async (): Promise<string | null> => {
      const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: 'Open workspace', properties: ['openFile'], filters: [{ name: 'ReceiptMatch workspace', extensions: ['receiptmatch'] }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    save: async (name: string): Promise<string | null> => {
      const safeName: string = Array.from(name, (character: string): string => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '-' : character).join('').replace(/[. ]+$/, '') || 'Workspace';
      const selected: Electron.SaveDialogReturnValue = await dialog.showSaveDialog(window, { title: 'Save workspace', defaultPath: `${safeName}.receiptmatch`, filters: [{ name: 'ReceiptMatch workspace', extensions: ['receiptmatch'] }], properties: ['showOverwriteConfirmation'] });
      return selected.canceled ? null : selected.filePath ?? null;
    },
    relinkOriginal: async (source: OriginalSource): Promise<string | null> => {
      const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: 'Locate the original file', defaultPath: path.dirname(source.filePath),
        properties: ['openFile'], filters: [{ name: 'Original document', extensions: originalSourceExtensions[source.format].map((extension: ".pdf" | ".png" | ".jpg" | ".jpeg"): string => extension.slice(1)) }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    analyzeOriginal: async (source: OriginalSource): Promise<string | null> => {
      const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: 'Choose a changed source to analyze', defaultPath: path.dirname(source.filePath),
        properties: ['openFile'], filters: [{ name: 'Original document', extensions: originalSourceExtensions[source.format].map((extension: ".pdf" | ".png" | ".jpg" | ".jpeg"): string => extension.slice(1)) }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    unsaved: async (name: string): Promise<"save" | "discard" | "cancel"> => {
      const selected: Electron.MessageBoxReturnValue = await dialog.showMessageBox(window, { type: 'question', title: 'Unsaved changes', message: `Save changes to “${name || 'Untitled workspace'}”?`, detail: 'Your unsaved changes will be lost if you discard them.', buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true });
      return (['save', 'discard', 'cancel'] as const)[selected.response] ?? 'cancel';
    }
  }, publish, new StatementImportService({
    choose: async (): Promise<string | null> => {
      const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: 'Import bank statement', properties: ['openFile'], filters: [{ name: 'PDF bank statement', extensions: ['pdf'] }] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    extract: extractPdfBytes
  }), new FolderDocumentImportService({
    choose: async (): Promise<string | null> => {
      const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: 'Analyze supporting document folder', properties: ['openDirectory'] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    extract: extractDocumentBytes,
    localOcr: (): Promise<LocalDocumentOcr | undefined> => localOcr.selected()
  }), extractDocumentBytes, path.join(userData, 'transaction-ignore-rules'));
  const authorized: (event: Electron.IpcMainInvokeEvent) => boolean = (event: Electron.IpcMainInvokeEvent): boolean => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl;
  const exportSettingsFile: string = path.join(app.getPath('userData'), 'export-settings.json');
  let confirmingOcrDownload: boolean = false;

  async function requestOcrInstall(modelId: LocalOcrModel): Promise<void> {
    if (confirmingOcrDownload) {
      throw new Error('A local OCR download confirmation is already open.');
    }
    confirmingOcrDownload = true;
    try {
      const status: LocalOcrStatus = await localOcr.status();
      const model: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; } = status.models.find((model: { model: LocalOcrModel; name: string; downloadBytes: number; installed: boolean; runtimeAvailable: boolean; runtimeIssue?: string; }): boolean => model.model === modelId)!;
      if (status.download || !model.runtimeAvailable) {
        throw new Error('The local OCR model cannot be installed right now.');
      }
      if (model.installed) {
        await localOcr.select(modelId);
      } else {
        const unit: "gigabyte" | "megabyte" = model.downloadBytes >= 1_000_000_000 ? 'gigabyte' : 'megabyte';
        const size: string = new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 2 })
          .format(model.downloadBytes / (unit === 'gigabyte' ? 1_000_000_000 : 1_000_000));
        const confirmation: Electron.MessageBoxReturnValue = await dialog.showMessageBox(window, {
          type: 'question', title: 'Download OCR model', message: `Download ${model.name} to this device?`,
            detail: `Download size: ${size}. ReceiptMatch processes documents on this device.`,
          buttons: ['Download', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
        });
        if (confirmation.response === 0 && !closeRequested && !window.isDestroyed()) {
          await localOcr.install(modelId);
        }
      }
    } finally {
      confirmingOcrDownload = false;
    }
  }

  ipcMain.handle('app:local-ocr', async (event: Electron.IpcMainInvokeEvent, payload: unknown): Promise<LocalOcrStatus> => {
    if (!authorized(event) || closeRequested) {
      throw new Error('Local OCR settings request denied.');
    }
    const request: { type: "status"; } | { type: "select"; selection: "pp-ocrv6-medium" | "paddleocr-vl-1.6" | "standard"; } | { type: "install"; model: "pp-ocrv6-medium" | "paddleocr-vl-1.6"; } | { type: "cancel"; } = localOcrRequestSchema.parse(payload);
    if (request.type === 'cancel') {
      await localOcr.cancel();
    }
    if (request.type === 'select') {
      await localOcr.select(request.selection);
    }
    if (request.type === 'install') {
      await requestOcrInstall(request.model);
    }
    return localOcr.status();
  });
  let exportSettingsWrite: Promise<string> | null = null;
  ipcMain.handle('app:export-settings', async (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<string> => {
    if (!authorized(event) || payload.length !== 1 || closeRequested) {
      throw new Error('Export settings request denied.');
    }
    const request: ZodSafeParseResult<{ type: "read"; } | { type: "save"; pattern: string; }> = exportSettingsRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Export settings request denied.');
    }
    try {
      if (request.data.type === 'read') {
        await exportSettingsWrite?.catch((): null => null);
        return await readExportFilenamePattern(exportSettingsFile);
      }
      const { pattern }: { type: "save"; pattern: string; } = request.data;
      const write: Promise<string> = Promise.resolve(exportSettingsWrite).catch((): null => null).then((): Promise<string> => saveExportFilenamePattern(exportSettingsFile, pattern));
      exportSettingsWrite = write;
      try {
        return await write;
      } finally {
        if (exportSettingsWrite === write) {
          exportSettingsWrite = null;
        }
      }
    } catch {
      throw new Error('Export settings could not be accessed.');
    }
  });

  ipcMain.handle('app:version', (event: Electron.IpcMainInvokeEvent): string => {
    if (!authorized(event)) {
      throw new Error('Application version request denied.');
    }
    return app.getVersion();
  });

  ipcMain.handle('workspace:command', (event: Electron.IpcMainInvokeEvent, payload: unknown): WorkspaceState | Promise<WorkspaceState> => {
    if (!authorized(event)) {
      throw new Error('Workspace request denied.');
    }
    if (closeRequested) {
      return workspace.state();
    }
    const command: ZodSafeParseResult<{ type: "get-state"; } | { type: "new"; } | { type: "open"; } | { type: "save"; } | { type: "import-statement"; } | { type: "import-documents"; } | { type: "cancel-import"; } | { type: "rename"; name: string; } | { type: "set-transaction-ignored"; revision: number; transactionId: string; ignored: boolean; remember?: true | undefined; } | { type: "review-match"; revision: number; transactionId: string; review: { status: "open"; } | { status: "assigned"; documentId: string; } | { status: "completed-without-document"; }; } | { type: "set-duplicate-decision"; revision: number; transactionId: string; otherTransactionId: string; decision: "separate" | "keep-first" | "keep-second" | "clear"; } | { type: "correct-bank-row"; revision: number; rowId: string; changes: { bookingDate?: string | undefined; accountAmount?: { coefficient: string; currency: string; scale: number; } | undefined; }; } | { change: { kind: "amount"; value: { coefficient: string; currency: string; scale: number; }; } | { kind: "date"; value: string; }; documentId: string; sectionId: string; fieldId: string | null; type: "correct-document-field"; revision: number; } | { type: "approve-matches"; loadRevision: number; selections: MatchApprovalSelection[]; }> = commandSchema.safeParse(payload);
    return command.success ? workspace.dispatch(command.data) : workspace.rejectRequest();
  });

  ipcMain.handle('workspace:bank-imports', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): StoredBankImport[] => {
    if (!authorized(event) || payload.length) {
      throw new Error('Workspace request denied.');
    }
    return workspace.bankImports();
  });

  ipcMain.handle('workspace:document-imports', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): StoredDocumentImport[] => {
    if (!authorized(event) || payload.length) {
      throw new Error('Workspace request denied.');
    }
    return workspace.documentImports();
  });

  ipcMain.handle('workspace:document-snapshot', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): DocumentSnapshot | null => {
    if (!authorized(event) || payload.length !== 1) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ loadRevision: number; revision: number; }> = documentSnapshotRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Workspace request denied.');
    }
    return workspace.documentSnapshot(request.data);
  });

  ipcMain.handle('workspace:matches', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): MatchSummary[] | MatchDetails | null => {
    if (!authorized(event) || payload.length !== 1) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ revision: number; transactionId?: string | undefined; }> = matchRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Workspace request denied.');
    }
    const { revision, transactionId }: { revision: number; transactionId?: string | undefined; } = request.data;
    return transactionId ? workspace.matchDetails(revision, transactionId) : workspace.matchSummaries(revision);
  });

  ipcMain.handle('workspace:open-original', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<OriginalPreviewResult> | { error: string; } => {
    if (!authorized(event) || payload.length !== 1) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ kind: "document" | "statement"; id: string; loadRevision: number; }> = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      return { error: 'This preview request is not supported.' };
    }
    const source: OriginalSource | null = workspace.originalSource(request.data);
    return source ? previews.open(JSON.stringify([request.data.kind, request.data.id, source.filePath]), source) : { error: 'The original is not available in this workspace.' };
  });

  ipcMain.handle('workspace:relink-original', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<OriginalRelinkResult> => {
    if (!authorized(event) || payload.length !== 1 || closeRequested) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ kind: "document" | "statement"; id: string; loadRevision: number; }> = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Workspace request denied.');
    }
    return workspace.relinkOriginal(request.data);
  });

  ipcMain.handle('workspace:analyze-original', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<OriginalAnalysisResult> => {
    if (!authorized(event) || payload.length !== 1 || closeRequested) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ kind: "document" | "statement"; id: string; loadRevision: number; }> = originalPreviewRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Workspace request denied.');
    }
    return workspace.analyzeOriginal(request.data);
  });

  ipcMain.handle('workspace:accept-original-analysis', (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<OriginalAdoptionResult> => {
    if (!authorized(event) || payload.length !== 1 || closeRequested) {
      throw new Error('Workspace request denied.');
    }
    const request: ZodSafeParseResult<{ token: string; loadRevision: number; acknowledgeConflicts: boolean; }> = originalAdoptionRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Workspace request denied.');
    }
    return workspace.acceptOriginalAnalysis(request.data);
  });
  let exportRequested: boolean = false;
  let closeRequested: boolean = false;

  function validateExportAfterFolderChoice(loadRevision: number, includeCsv: boolean, savedFingerprint: string | null, matchRevision: number): DocumentExportResponse | null {
    const current: WorkspaceState = workspace.state();
    if (closeRequested || window.isDestroyed()) {
      return { status: 'cancelled' };
    }
    if (current.workspace?.loadRevision !== loadRevision) {
      return { status: 'failed', message: 'The workspace has changed. Open Export and try again.' };
    }
    if (includeCsv && workspace.savedWorkspaceFingerprint() !== savedFingerprint) {
      return { status: 'failed', message: 'The saved workspace changed while choosing a folder. Start the export again.' };
    }
    if (!includeCsv && current.workspace.matchRevision !== matchRevision) {
      return { status: 'failed', message: 'The workspace or its approvals changed. Review the approvals and try again.' };
    }
    if (current.busy) {
      return { status: 'failed', message: 'Finish the current workspace action before exporting.' };
    }
    return null;
  }

  async function chooseExportDestination(loadRevision: number, includeCsv: boolean, savedFingerprint: string | null, matchRevision: number): Promise<DocumentExportResponse> {
    const selected: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window, { title: includeCsv ? 'Choose reconciliation export folder' : 'Choose export folder', properties: ['openDirectory'] });
    const destination: string = selected.filePaths[0];
    if (selected.canceled || !destination || closeRequested || window.isDestroyed()) {
      return { status: 'cancelled' };
    }
    await exportSettingsWrite?.catch((): null => null);
    const pattern: string = await readExportFilenamePattern(exportSettingsFile);
    const blocked: DocumentExportResponse | null = validateExportAfterFolderChoice(loadRevision, includeCsv, savedFingerprint, matchRevision);
    if (blocked) {
      return blocked;
    }
    if (includeCsv) {
      const { csv, documentCopies }: ReconciliationExportReport = await workspace.exportReconciliation(loadRevision, destination, pattern);
      return { status: 'completed', report: documentCopies, csv };
    }
    return { status: 'completed', report: await workspace.exportApprovedDocuments(loadRevision, destination, pattern) };
  }

  ipcMain.handle('workspace:export-documents', async (event: Electron.IpcMainInvokeEvent, ...payload: unknown[]): Promise<DocumentExportResponse> => {
    if (!authorized(event) || payload.length !== 1) {
      throw new Error('Document export request denied.');
    }
    const request: ZodSafeParseResult<{ loadRevision: number; includeCsv: boolean; }> = documentExportRequestSchema.safeParse(payload[0]);
    if (!request.success) {
      throw new Error('Document export request denied.');
    }
    if (closeRequested) {
      return { status: 'cancelled' };
    }
    const { loadRevision, includeCsv }: { loadRevision: number; includeCsv: boolean } = request.data;
    const initial: WorkspaceState = workspace.state();
    if (initial.workspace?.loadRevision !== loadRevision) {
      return { status: 'failed', message: 'The workspace has changed. Open Export and try again.' };
    }
    if (exportRequested || initial.busy) {
      return { status: 'failed', message: 'Finish the current workspace action before exporting.' };
    }
    const savedFingerprint: string | null = includeCsv ? workspace.savedWorkspaceFingerprint() : null;
    if (includeCsv && !savedFingerprint) {
      return { status: 'failed', message: 'Save the workspace before exporting a reconciliation report.' };
    }
    if (!includeCsv && !initial.workspace.approvedDocumentCount) {
      return { status: 'completed', report: { directory: null, outcomes: [] } };
    }
    exportRequested = true;
    try {
      return await chooseExportDestination(loadRevision, includeCsv, savedFingerprint, initial.workspace.matchRevision);
    } catch (error: unknown) {
      return { status: 'failed', message: error instanceof ExportDestinationError ? error.message : 'The export could not be started. Try again.' };
    } finally {
      exportRequested = false;
    }
  });
  window.webContents.on('will-navigate', (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => event.preventDefault());
  window.webContents.setWindowOpenHandler((): { action: "deny"; } => ({ action: 'deny' }));
  let closing: boolean = false;
  window.once('closed', (): void => previews.closeAll());
  window.on('close', (event: { preventDefault: () => void; readonly defaultPrevented: boolean; }): void => {
    if (closing) {
      return;
    }
    event.preventDefault();
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    void workspace.requestClose().then(async (allowed: boolean): Promise<void> => {
      if (!allowed) {
        closeRequested = false; return;
      }
      while (exportSettingsWrite) {
        await exportSettingsWrite.catch((): null => null);
      }
      await localOcr.cancel();
      if (!window.isDestroyed()) {
        closing = true; window.close();
      }
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New workspace', accelerator: 'CmdOrCtrl+N', click: (): void => {
        if (!closeRequested) {
          void workspace.dispatch({ type: 'new' });
        }
      } },
      { label: 'Open workspace…', accelerator: 'CmdOrCtrl+O', click: (): void => {
        if (!closeRequested) {
          void workspace.dispatch({ type: 'open' });
        }
      } },
      { label: 'Save workspace', accelerator: 'CmdOrCtrl+S', click: (): void => {
        if (!closeRequested) {
          void workspace.dispatch({ type: 'save' });
        }
      } },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]));
  await window.loadURL(appUrl);
  void offerStartupUpdate(window, async (updater: BaseUpdater): Promise<void> => {
    if (closeRequested || window.isDestroyed()) {
      return;
    }
    if (exportRequested || workspace.state().busy) {
      await dialog.showMessageBox(window, { type: 'info', title: 'ReceiptMatch update', message: 'Finish the current action and restart ReceiptMatch to install the update.' });
      return;
    }
    closeRequested = true;
    try {
      if (!await workspace.requestClose()) {
        return;
      }
      await exportSettingsWrite?.catch((): null => null);
      await localOcr.cancel();
      if (!updater.install(false, true)) {
        throw new Error('The update installer could not start.');
      }
      closing = true;
      app.quit();
    } finally {
      if (!closing) {
        closeRequested = false;
      }
    }
  }).catch((error: unknown): void => console.warn('ReceiptMatch update check could not finish.', error));
}

app.on('window-all-closed', (): void => app.quit());
void launch().catch((error: unknown): void => {
  dialog.showErrorBox('ReceiptMatch could not start', error instanceof Error ? error.message : String(error)); app.exit(1);
});
