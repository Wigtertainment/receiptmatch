import { contextBridge, ipcRenderer } from 'electron';
import type { ExtractionBridge, ExtractionEvent, OcrRaster } from '../../src/shared/pdf-extraction.js';

const jobId: string | undefined = process.argv.find((value: string): boolean => value.startsWith('--receiptmatch-extraction-job='))?.slice('--receiptmatch-extraction-job='.length);
if (!jobId || !/^[a-f0-9-]{36}$/.test(jobId)) {
    throw new Error('Extraction preload needs an authorized job.');
}
let listening: boolean = false;
const bridge: ExtractionBridge = {
    onJob: (listener: (job: unknown) => void): void => {
        if (listening) {
            throw new Error('Extraction job listener already registered.');
        }
        listening = true;
        ipcRenderer.once('extraction:job', (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload));
    },
    ready: (): void => ipcRenderer.send('extraction:ready', { jobId }),
    report: (event: ExtractionEvent): void => ipcRenderer.send('extraction:event', { jobId, event }),
    recognize: (raster: OcrRaster): Promise<unknown> => ipcRenderer.invoke('extraction:recognize', jobId, raster)
};
contextBridge.exposeInMainWorld('receiptMatchExtraction', bridge);
