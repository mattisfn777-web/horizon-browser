'use strict';
const { BrowserWindow } = require('electron');
const path = require('path');

/** Small frameless window shown while Horizon starts, checks for updates and installs them. */
function createSplash() {
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    backgroundColor: '#0b0c10',
    title: 'Horizon',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);

  let last = { phase: 'starting', text: 'Starting…' };
  let loaded = false;
  const push = () => { if (loaded && !win.isDestroyed()) win.webContents.send('splash-status', last); };

  const ready = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => { loaded = true; push(); win.show(); resolve(); });
    setTimeout(resolve, 4000); // never hang on the splash
  });
  win.loadFile(path.join(__dirname, '../renderer/splash.html'));

  return {
    win,
    ready,
    status(s) { last = { ...last, ...s }; push(); },
    close() { if (!win.isDestroyed()) win.close(); },
  };
}

module.exports = { createSplash };
