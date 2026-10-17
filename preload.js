'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('berloader', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),
  chooseCookieFile: () => ipcRenderer.invoke('dialog:cookieFile'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  openDownloadFolder: () => ipcRenderer.invoke('folder:open'),

  analyze: (payload) => ipcRenderer.invoke('url:analyze', payload),
  enqueue: (payload) => ipcRenderer.invoke('jobs:enqueue', payload),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  retryJob: (id) => ipcRenderer.invoke('jobs:retry', id),
  removeJob: (id) => ipcRenderer.invoke('jobs:remove', id),
  clearFinished: () => ipcRenderer.invoke('jobs:clearFinished'),
  pauseQueue: (flag) => ipcRenderer.invoke('jobs:pause', flag),
  revealJob: (id) => ipcRenderer.invoke('jobs:reveal', id),
  openJob: (id) => ipcRenderer.invoke('jobs:open', id),

  accountStatus: () => ipcRenderer.invoke('accounts:status'),
  accountLogin: (platform) => ipcRenderer.invoke('accounts:login', platform),
  accountLogout: (platform) => ipcRenderer.invoke('accounts:logout', platform),

  engineStatus: () => ipcRenderer.invoke('engine:status'),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  copyDiagnostics: () => ipcRenderer.invoke('diag:copy'),
  openLogs: () => ipcRenderer.invoke('diag:openLogs'),
  checkAppUpdate: () => ipcRenderer.invoke('update:check'),
  installAppUpdate: () => ipcRenderer.invoke('update:install'),

  onJobUpdate: on('jobs:update'),
  onJobRemoved: on('jobs:removed'),
  onEngineStatus: on('engine:status'),
  onAppUpdate: on('update:status')
});
