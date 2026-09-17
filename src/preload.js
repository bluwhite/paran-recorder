const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paranRecorder', {
  platform: process.platform,
  listDesktopSources: () => ipcRenderer.invoke('desktop:list-sources'),
  selectDesktopSource: (sourceId) => ipcRenderer.invoke('desktop:select-source', sourceId),
  beginRecording: (defaultFileName) => ipcRenderer.invoke('recording:begin', defaultFileName),
  writeRecordingChunk: (arrayBuffer) => ipcRenderer.invoke('recording:write', arrayBuffer),
  finishRecording: () => ipcRenderer.invoke('recording:finish'),
  abortRecording: () => ipcRenderer.invoke('recording:abort'),
});
