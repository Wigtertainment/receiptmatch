import { contextBridge, ipcRenderer } from 'electron';
import type { OriginalPreviewData } from '../../src/shared/original-preview.js';

contextBridge.exposeInMainWorld('receiptmatchOriginal', Object.freeze({
    read: (): Promise<OriginalPreviewData> => ipcRenderer.invoke('preview:read') as Promise<OriginalPreviewData>,
}));
