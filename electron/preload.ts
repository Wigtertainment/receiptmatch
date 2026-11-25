import { contextBridge, ipcRenderer } from 'electron';
import type { IDocumentSnapshot, DocumentSnapshotRequest, ExportSettingsRequest, IWorkspaceBridge, WorkspaceCommand, IWorkspaceState } from '../src/shared/protocol.js';
import type { DocumentExportResponse } from '../src/shared/document-export.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { IMatchDetails, IMatchSummary } from '../src/shared/workspace-matching.js';
import type { OriginalAdoptionRequest, OriginalAdoptionResult, OriginalAnalysisResult, OriginalPreviewRequest, IOriginalPreviewResult, OriginalRelinkResult } from '../src/shared/original-preview.js';
import type { LocalOcrRequest, LocalOcrStatus } from '../src/shared/local-ocr-settings.js';
import type { ReceiptAiAcceptRequest, ReceiptAiDiscardRequest, ReceiptAiPreviewResult, ReceiptAiRequest } from '../src/shared/receipt-ai.js';
import type { StatementAiAcceptRequest, StatementAiDiscardRequest, StatementAiPreviewResult, StatementAiRequest } from '../src/shared/statement-ai.js';

const bridge: IWorkspaceBridge = Object.freeze({
  command: (command: WorkspaceCommand): Promise<IWorkspaceState> => ipcRenderer.invoke('workspace:command', command) as Promise<IWorkspaceState>,
  bankImports: (): Promise<StoredBankImport[]> => ipcRenderer.invoke('workspace:bank-imports') as Promise<StoredBankImport[]>,
  documentImports: (): Promise<StoredDocumentImport[]> => ipcRenderer.invoke('workspace:document-imports') as Promise<StoredDocumentImport[]>,
  documentSnapshot: (request: DocumentSnapshotRequest): Promise<IDocumentSnapshot | null> => ipcRenderer.invoke('workspace:document-snapshot', request) as Promise<IDocumentSnapshot | null>,
  matchSummaries: (revision: number): Promise<IMatchSummary[] | null> => ipcRenderer.invoke('workspace:matches', { revision }) as Promise<IMatchSummary[] | null>,
  matchDetails: (revision: number, transactionId: string): Promise<IMatchDetails | null> => ipcRenderer.invoke('workspace:matches', { revision, transactionId }) as Promise<IMatchDetails | null>,
  openOriginal: (request: OriginalPreviewRequest): Promise<IOriginalPreviewResult> => ipcRenderer.invoke('workspace:open-original', request) as Promise<IOriginalPreviewResult>,
  relinkOriginal: (request: OriginalPreviewRequest): Promise<OriginalRelinkResult> => ipcRenderer.invoke('workspace:relink-original', request) as Promise<OriginalRelinkResult>,
  analyzeOriginal: (request: OriginalPreviewRequest): Promise<OriginalAnalysisResult> => ipcRenderer.invoke('workspace:analyze-original', request) as Promise<OriginalAnalysisResult>,
  reanalyzeReceipt: (request: ReceiptAiRequest): Promise<ReceiptAiPreviewResult> => ipcRenderer.invoke('workspace:reanalyze-receipt', request) as Promise<ReceiptAiPreviewResult>,
  acceptReceiptAnalysis: (request: ReceiptAiAcceptRequest): Promise<OriginalAdoptionResult> => ipcRenderer.invoke('workspace:accept-receipt-analysis', request) as Promise<OriginalAdoptionResult>,
  discardReceiptAnalysis: (request: ReceiptAiDiscardRequest): Promise<void> => ipcRenderer.invoke('workspace:discard-receipt-analysis', request) as Promise<void>,
  reanalyzeStatement: (request: StatementAiRequest): Promise<StatementAiPreviewResult> => ipcRenderer.invoke('workspace:reanalyze-statement', request) as Promise<StatementAiPreviewResult>,
  acceptStatementAnalysis: (request: StatementAiAcceptRequest): Promise<OriginalAdoptionResult> => ipcRenderer.invoke('workspace:accept-statement-analysis', request) as Promise<OriginalAdoptionResult>,
  discardStatementAnalysis: (request: StatementAiDiscardRequest): Promise<void> => ipcRenderer.invoke('workspace:discard-statement-analysis', request) as Promise<void>,
  acceptOriginalAnalysis: (request: OriginalAdoptionRequest): Promise<OriginalAdoptionResult> => ipcRenderer.invoke('workspace:accept-original-analysis', request) as Promise<OriginalAdoptionResult>,
  exportSettings: (request: ExportSettingsRequest): Promise<string> => ipcRenderer.invoke('app:export-settings', request) as Promise<string>,
  localOcr: (request: LocalOcrRequest): Promise<LocalOcrStatus> => ipcRenderer.invoke('app:local-ocr', request) as Promise<LocalOcrStatus>,
  exportDocuments: (loadRevision: number): Promise<DocumentExportResponse> => ipcRenderer.invoke('workspace:export-documents', { loadRevision }) as Promise<DocumentExportResponse>,
  exportReconciliation: (loadRevision: number): Promise<DocumentExportResponse> => ipcRenderer.invoke('workspace:export-documents', { loadRevision, includeCsv: true }) as Promise<DocumentExportResponse>,
  subscribe: (listener: (state: IWorkspaceState) => void): () => Electron.IpcRenderer => {
    const handler: (_event: Electron.IpcRendererEvent, state: IWorkspaceState) => void = (_event: Electron.IpcRendererEvent, state: IWorkspaceState): void => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return (): Electron.IpcRenderer => ipcRenderer.removeListener('workspace:state', handler);
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version') as Promise<string>
});
contextBridge.exposeInMainWorld('receiptmatch', bridge);
