import { contextBridge, ipcRenderer } from 'electron';
import type { DocumentSnapshot, DocumentSnapshotRequest, ExportSettingsRequest, WorkspaceBridge, WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import type { DocumentExportResponse } from '../src/shared/document-export.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSummary } from '../src/shared/workspace-matching.js';
import type { OriginalAdoptionRequest, OriginalAdoptionResult, OriginalAnalysisResult, OriginalPreviewRequest, OriginalPreviewResult, OriginalRelinkResult } from '../src/shared/original-preview.js';
import type { LocalOcrRequest, LocalOcrStatus } from '../src/shared/local-ocr-settings.js';

const bridge: WorkspaceBridge = Object.freeze({
  command: (command: WorkspaceCommand): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:command', command) as Promise<WorkspaceState>,
  bankImports: (): Promise<StoredBankImport[]> => ipcRenderer.invoke('workspace:bank-imports') as Promise<StoredBankImport[]>,
  documentImports: (): Promise<StoredDocumentImport[]> => ipcRenderer.invoke('workspace:document-imports') as Promise<StoredDocumentImport[]>,
  documentSnapshot: (request: DocumentSnapshotRequest): Promise<DocumentSnapshot | null> => ipcRenderer.invoke('workspace:document-snapshot', request) as Promise<DocumentSnapshot | null>,
  matchSummaries: (revision: number): Promise<MatchSummary[] | null> => ipcRenderer.invoke('workspace:matches', { revision }) as Promise<MatchSummary[] | null>,
  matchDetails: (revision: number, transactionId: string): Promise<MatchDetails | null> => ipcRenderer.invoke('workspace:matches', { revision, transactionId }) as Promise<MatchDetails | null>,
  openOriginal: (request: OriginalPreviewRequest): Promise<OriginalPreviewResult> => ipcRenderer.invoke('workspace:open-original', request) as Promise<OriginalPreviewResult>,
  relinkOriginal: (request: OriginalPreviewRequest): Promise<OriginalRelinkResult> => ipcRenderer.invoke('workspace:relink-original', request) as Promise<OriginalRelinkResult>,
  analyzeOriginal: (request: OriginalPreviewRequest): Promise<OriginalAnalysisResult> => ipcRenderer.invoke('workspace:analyze-original', request) as Promise<OriginalAnalysisResult>,
  acceptOriginalAnalysis: (request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult> => ipcRenderer.invoke('workspace:accept-original-analysis', request) as Promise<OriginalAdoptionResult>,
  exportSettings: (request: ExportSettingsRequest): Promise<string> => ipcRenderer.invoke('app:export-settings', request) as Promise<string>,
  localOcr: (request: LocalOcrRequest): Promise<LocalOcrStatus> => ipcRenderer.invoke('app:local-ocr', request) as Promise<LocalOcrStatus>,
  exportDocuments: (loadRevision: number): Promise<DocumentExportResponse> => ipcRenderer.invoke('workspace:export-documents', { loadRevision }) as Promise<DocumentExportResponse>,
  exportReconciliation: (loadRevision: number): Promise<DocumentExportResponse> => ipcRenderer.invoke('workspace:export-documents', { loadRevision, includeCsv: true }) as Promise<DocumentExportResponse>,
  subscribe: (listener: (state: WorkspaceState) => void): () => Electron.IpcRenderer => {
    const handler: (_event: Electron.IpcRendererEvent, state: WorkspaceState) => void = (_event: Electron.IpcRendererEvent, state: WorkspaceState): void => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return (): Electron.IpcRenderer => ipcRenderer.removeListener('workspace:state', handler);
  }
});
contextBridge.exposeInMainWorld('receiptmatch', bridge);
