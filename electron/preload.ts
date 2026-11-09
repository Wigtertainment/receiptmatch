import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceBridge, WorkspaceCommand, WorkspaceState } from '../src/shared/protocol.js';

const bridge: WorkspaceBridge = Object.freeze({
  command: (command: WorkspaceCommand) => ipcRenderer.invoke('workspace:command', command) as Promise<WorkspaceState>,
  subscribe: (listener: (state: WorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on('workspace:state', handler);
    return () => ipcRenderer.removeListener('workspace:state', handler);
  }
});
contextBridge.exposeInMainWorld('receiptmatch', bridge);
