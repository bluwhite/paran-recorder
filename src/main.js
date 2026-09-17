const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let selectedSourceId = null;
let recordingStream = null;
let recordingPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#0f172a',
    title: 'Paran Recorder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

async function listDesktopSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
  }));
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const selected = sources.find((source) => source.id === selectedSourceId) || sources[0];

      if (!selected) {
        callback({});
        return;
      }

      const grant = { video: selected };
      if (process.platform === 'win32') {
        grant.audio = 'loopback';
      }
      callback(grant);
    } catch (error) {
      console.error('Display capture permission failed:', error);
      callback({});
    }
  });
}

function bufferFromIpcData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('Unsupported recording chunk type.');
}

function closeRecordingStream() {
  if (!recordingStream) return Promise.resolve();

  const stream = recordingStream;
  recordingStream = null;

  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:list-sources', listDesktopSources);

  ipcMain.handle('desktop:select-source', (_event, sourceId) => {
    selectedSourceId = sourceId;
    return true;
  });

  ipcMain.handle('recording:begin', async (_event, defaultFileName) => {
    if (recordingStream) {
      throw new Error('A recording is already in progress.');
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: '녹화 파일 저장',
      defaultPath: defaultFileName,
      filters: [{ name: 'WebM Video', extensions: ['webm'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    recordingPath = result.filePath.toLowerCase().endsWith('.webm')
      ? result.filePath
      : `${result.filePath}.webm`;
    recordingStream = fs.createWriteStream(recordingPath, { flags: 'w' });

    return { canceled: false, filePath: recordingPath };
  });

  ipcMain.handle('recording:write', async (_event, data) => {
    if (!recordingStream) throw new Error('Recording file is not open.');
    const chunk = bufferFromIpcData(data);

    await new Promise((resolve, reject) => {
      recordingStream.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
    return true;
  });

  ipcMain.handle('recording:finish', async () => {
    const finishedPath = recordingPath;
    await closeRecordingStream();
    recordingPath = null;
    return { filePath: finishedPath };
  });

  ipcMain.handle('recording:abort', async () => {
    const abortedPath = recordingPath;
    await closeRecordingStream();
    recordingPath = null;

    if (abortedPath) {
      try {
        await fs.promises.unlink(abortedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Failed to remove aborted recording:', error);
      }
    }
    return true;
  });
}

app.whenReady().then(() => {
  configureMediaPermissions();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (recordingStream) {
    try {
      recordingStream.end();
    } catch {
      // Best effort while the app is shutting down.
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
