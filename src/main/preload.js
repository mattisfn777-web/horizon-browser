'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = new Set([
  'settings-updated', 'bookmarks-updated', 'download-started', 'download-updated', 'download-done',
  'shortcut', 'open-tab', 'permission-request', 'toast', 'update-progress', 'fullscreen-changed',
]);

contextBridge.exposeInMainWorld('hz', {
  platform: process.platform,
  init: () => invoke('app:init'),

  // window
  close: () => invoke('win:close'),
  openPrivate: () => invoke('win:openPrivate'),
  openWindow: () => invoke('win:openWindow'),
  setFullscreen: (v) => invoke('win:fullscreen', !!v),
  setTitlebar: (o) => invoke('win:titlebar', o),

  // data
  setBookmarks: (v) => invoke('data:setBookmarks', v),
  getHistory: (n) => invoke('data:getHistory', n),
  addHistory: (e) => invoke('data:addHistory', e),
  deleteHistory: (u) => invoke('data:deleteHistory', u),
  clearHistory: () => invoke('data:clearHistory'),
  getDownloads: () => invoke('data:getDownloads'),
  clearDownloads: () => invoke('data:clearDownloads'),
  downloadAction: (id, action) => invoke('download:action', id, action),
  openPath: (p) => invoke('shell:openPath', p),
  showInFolder: (p) => invoke('shell:showInFolder', p),
  setSettings: (s) => invoke('data:setSettings', s),
  clearAll: () => invoke('data:clearAll'),
  saveSession: (s) => invoke('session:save', s),
  respondPermission: (id, allow) => invoke('perm:respond', id, !!allow),
  openExternal: (u) => invoke('shell:openExternal', u),

  // updates
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),

  // events from the main process
  on(channel, fn) {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
