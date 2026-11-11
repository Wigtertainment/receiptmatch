import { contextBridge, ipcRenderer } from 'electron';
import type { OriginalPreviewData } from '../../src/shared/original-preview.js';

contextBridge.exposeInMainWorld('receiptmatchOriginal', Object.freeze({
    read: () => ipcRenderer.invoke('preview:read') as Promise<OriginalPreviewData>,
}));
