import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceBridge, WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';
import type { StoredBankImport } from '../src/shared/workspace-import.js';
import type { StoredDocumentImport } from '../src/shared/workspace-documents.js';
import type { MatchDetails, MatchSummary } from '../src/shared/workspace-matching.js';

const bridge: WorkspaceBridge = Object.freeze({
  command: (command: WorkspaceCommand) => ipcRenderer.invoke('workspace:command', command) as Promise<WorkspaceState>,
  bankImports: () => ipcRenderer.invoke('workspace:bank-imports') as Promise<StoredBankImport[]>,
  documentImports: () => ipcRenderer.invoke('workspace:document-imports') as Promise<StoredDocumentImport[]>,
  matchSummaries: (revision: number) => ipcRenderer.invoke('workspace:matches', { revision }) as Promise<MatchSummary[] | null>,
  matchDetails: (revision: number, transactionId: string) => ipcRenderer.invoke('workspace:matches', { revision, transactionId }) as Promise<MatchDetails | null>,
  subscribe: (listener: (state: WorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return () => ipcRenderer.removeListener('workspace:state', handler);
  }
});
contextBridge.exposeInMainWorld('receiptmatch', bridge);
