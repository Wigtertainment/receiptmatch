import { contextBridge, ipcRenderer } from 'electron';
import type { ExtractionBridge, ExtractionEvent } from '../../src/shared/pdf-extraction.js';

const jobId = process.argv.find((value) => value.startsWith('--receiptmatch-extraction-job='))?.slice('--receiptmatch-extraction-job='.length);
if (!jobId || !/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('Extraction preload needs an authorized job.');
let listening = false;
const bridge: ExtractionBridge = {
    onJob: (listener) => {
        if (listening) throw new Error('Extraction job listener already registered.');
        listening = true;
        ipcRenderer.once('extraction:job', (_event, payload: unknown) => listener(payload));
    },
    ready: () => ipcRenderer.send('extraction:ready', { jobId }),
    report: (event: ExtractionEvent) => ipcRenderer.send('extraction:event', { jobId, event })
};
contextBridge.exposeInMainWorld('receiptMatchExtraction', bridge);
