const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('validation', Object.freeze({ ready: value => ipcRenderer.invoke('validation:ready', value), snapshot: value => ipcRenderer.invoke('validation:snapshot', value) }));
