/**
 * Sandboxed Electron preload. Expose only the named methods below; never expose
 * ipcRenderer or a generic invoke/send wrapper to renderer code.
 */
const { contextBridge, ipcRenderer } = require('electron');
const channels = Object.freeze({
  "serviceReady": "sew:service-ready",
  "serviceStatus": "sew:service-status",
  "projectCreate": "sew:project:create",
  "projectOpen": "sew:project:open",
  "projectClose": "sew:project:close",
  "projectRecent": "sew:project:recent",
  "materialsPickFiles": "sew:materials:pick-files",
  "materialsOpenOriginal": "sew:materials:open-original",
  "exportsPickTarget": "sew:exports:pick-target",
  "exportsBackupProject": "sew:exports:backup-project",
  "exportsRestoreProject": "sew:exports:restore-project",
  "preferencesRead": "sew:preferences:read",
  "preferencesSave": "sew:preferences:save",
  "modelsConfigure": "sew:models:configure",
  "modelsTest": "sew:models:test",
  "windowMinimize": "sew:window:minimize",
  "windowToggleMaximize": "sew:window:toggle-maximize",
  "windowClose": "sew:window:close"
});

const subscribe = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('sewNative', {
  platform: process.platform,

  onServiceReady: (handler) => subscribe(channels.serviceReady, handler),
  onServiceStatus: (handler) => subscribe(channels.serviceStatus, handler),
  getServiceState: () => ipcRenderer.invoke(channels.serviceStatus),
  onProjectChanged: (handler) => subscribe(channels.projectOpen, handler),

  projectCreate: () => ipcRenderer.invoke(channels.projectCreate),
  projectOpen: () => ipcRenderer.invoke(channels.projectOpen),
  projectClose: () => ipcRenderer.invoke(channels.projectClose),
  projectRecent: () => ipcRenderer.invoke(channels.projectRecent),

  pickMaterials: () => ipcRenderer.invoke(channels.materialsPickFiles),
  openMaterialOriginal: (request) => ipcRenderer.invoke(channels.materialsOpenOriginal, request),

  pickExportTarget: (defaultName) => ipcRenderer.invoke(channels.exportsPickTarget, defaultName),
  backupProject: () => ipcRenderer.invoke(channels.exportsBackupProject),
  restoreProject: () => ipcRenderer.invoke(channels.exportsRestoreProject),

  readPreferences: () => ipcRenderer.invoke(channels.preferencesRead),
  savePreferences: (value) => ipcRenderer.invoke(channels.preferencesSave, value),

  configureModel: (value) => ipcRenderer.invoke(channels.modelsConfigure, value),
  testModel: () => ipcRenderer.invoke(channels.modelsTest),

  minimizeWindow: () => ipcRenderer.send(channels.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.send(channels.windowToggleMaximize),
  closeWindow: () => ipcRenderer.send(channels.windowClose),
});
