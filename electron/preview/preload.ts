import { contextBridge, ipcRenderer } from 'electron';
import type { IOriginalPreviewData } from '../../src/shared/original-preview.js';

contextBridge.exposeInMainWorld('receiptmatchOriginal', Object.freeze({
    read: (): Promise<IOriginalPreviewData> => ipcRenderer.invoke('preview:read') as Promise<IOriginalPreviewData>,
}));
