const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('extraction', Object.freeze({
  onJob: listener => ipcRenderer.on('extraction:job', (_event, job) => listener(job)),
  result: value => ipcRenderer.send('extraction:result', value),
  ready: () => ipcRenderer.send('extraction:ready')
}));
