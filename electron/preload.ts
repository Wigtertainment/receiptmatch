import { contextBridge, ipcRenderer } from 'electron';
import type { ExportSettingsRequest, WorkspaceBridge, WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import type { DocumentExportResponse } from '../src/shared/document-export.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSummary } from '../src/shared/workspace-matching.js';
import type { OriginalPreviewRequest, OriginalPreviewResult } from '../src/shared/original-preview.js';
import type { LocalOcrRequest, LocalOcrStatus } from '../src/shared/local-ocr-settings.js';

const bridge: WorkspaceBridge = Object.freeze({
  command: (command: WorkspaceCommand) => ipcRenderer.invoke('workspace:command', command) as Promise<WorkspaceState>,
  bankImports: () => ipcRenderer.invoke('workspace:bank-imports') as Promise<StoredBankImport[]>,
  documentImports: () => ipcRenderer.invoke('workspace:document-imports') as Promise<StoredDocumentImport[]>,
  matchSummaries: (revision: number) => ipcRenderer.invoke('workspace:matches', { revision }) as Promise<MatchSummary[] | null>,
  matchDetails: (revision: number, transactionId: string) => ipcRenderer.invoke('workspace:matches', { revision, transactionId }) as Promise<MatchDetails | null>,
  openOriginal: (request: OriginalPreviewRequest) => ipcRenderer.invoke('workspace:open-original', request) as Promise<OriginalPreviewResult>,
  exportSettings: (request: ExportSettingsRequest) => ipcRenderer.invoke('app:export-settings', request) as Promise<string>,
  localOcr: (request: LocalOcrRequest) => ipcRenderer.invoke('app:local-ocr', request) as Promise<LocalOcrStatus>,
  exportDocuments: (loadRevision: number) => ipcRenderer.invoke('workspace:export-documents', { loadRevision }) as Promise<DocumentExportResponse>,
  exportReconciliation: (loadRevision: number) => ipcRenderer.invoke('workspace:export-documents', { loadRevision, includeCsv: true }) as Promise<DocumentExportResponse>,
  subscribe: (listener: (state: WorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return () => ipcRenderer.removeListener('workspace:state', handler);
  }
});
contextBridge.exposeInMainWorld('receiptmatch', bridge);
