'use strict';

const {
  app, BrowserWindow, session, ipcMain, shell, dialog, nativeTheme, Menu, clipboard, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

const Store = require('./store');
const blocker = require('./blocker');
const updater = require('./updater');
const { createSplash } = require('./splash');
const matchShortcut = require('../shared/shortcuts');

// ── Constants ─────────────────────────────────────────────────────────────────
const REGULAR_PARTITION = 'persist:horizon';
const PRIVATE_PARTITION = 'horizon-private'; // no "persist:" prefix = memory only
const ICON = path.join(__dirname, '../../assets/icon.ico');
const FAST = process.env.HORIZON_FAST === '1' && !app.isPackaged; // skip splash delays in tests

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  brave: 'https://search.brave.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  ecosia: 'https://www.ecosia.org/search?q=',
  startpage: 'https://www.startpage.com/do/search?q=',
  yahoo: 'https://search.yahoo.com/search?p=',
};

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  homePage: 'https://www.google.com',
  newTabPage: 'default',
  startup: 'newtab',
  theme: 'dark',
  accentColor: '#3b82f6',
  fontSize: 'medium',
  showBookmarksBar: false,
  blockTrackers: true,
  blockAds: false,
  blockThirdPartyCookies: false,
  jsInPrivate: false,
  autoUpdate: true,
};

const oneOf = (...list) => (v) => list.includes(v);
const isBool = (v) => typeof v === 'boolean';
const SETTING_RULES = {
  searchEngine: (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, v),
  homePage: (v) => typeof v === 'string' && v.length < 2048,
  newTabPage: oneOf('default', 'blank', 'home'),
  startup: oneOf('newtab', 'restore', 'home'),
  theme: oneOf('dark', 'light', 'system'),
  accentColor: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  fontSize: oneOf('small', 'medium', 'large'),
  showBookmarksBar: isBool,
  blockTrackers: isBool,
  blockAds: isBool,
  blockThirdPartyCookies: isBool,
  jsInPrivate: isBool,
  autoUpdate: isBool,
};

// ── Logging & crash safety ────────────────────────────────────────────────────
let logFile = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* ignore */ }
  if (!app.isPackaged) console.log(line.trim());
}
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  app.setAppUserModelId('com.horizon.browser');

  let store = null;
  const windows = new Map(); // BrowserWindow.id -> ctx
  const byContents = new Map(); // host webContents.id -> ctx
  let primaryId = null;
  let startUrl = null;
  let pendingNotice = null;
  let mainStarted = false;
  let quitting = false;
  let settingsCache = { ...DEFAULT_SETTINGS };
  let privateCount = 0;
  let cascade = 0;

  const getSettings = () => settingsCache;
  const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 50) : ms));

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function urlFromArgs(argv) {
    for (const a of argv.slice(1)) {
      if (/^https?:\/\//i.test(a)) return a;
      if (path.isAbsolute(a) && /\.(html?|pdf|svg|png|jpe?g|gif|webp|txt)$/i.test(a) && fs.existsSync(a)) {
        return 'file:///' + a.replace(/\\/g, '/');
      }
    }
    return null;
  }

  function send(ctx, channel, ...args) {
    if (ctx && !ctx.win.isDestroyed() && !ctx.win.webContents.isDestroyed()) ctx.win.webContents.send(channel, ...args);
  }
  function broadcast(channel, ...args) {
    for (const ctx of windows.values()) send(ctx, channel, ...args);
  }
  function ctxOf(e) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const ctx = win && windows.get(win.id);
    if (!ctx) throw new Error('Unauthorized sender');
    return ctx;
  }
  function safeOrigin(u) {
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : ''; } catch { return ''; }
  }
  function sanitizeFilename(n) {
    return String(n || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'download';
  }
  function uniquePath(dir, name) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let n = 1; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
    return p;
  }
  function titlebarColors(isPrivate) {
    if (isPrivate) return { color: '#000000', symbolColor: '#d8d8e8', bg: '#000000' };
    const t = settingsCache.theme;
    const dark = t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
    return dark
      ? { color: '#0d0d0d', symbolColor: '#e8e8e8', bg: '#161616' }
      : { color: '#f5f5f5', symbolColor: '#111111', bg: '#ffffff' };
  }

  // ── Sessions ────────────────────────────────────────────────────────────────
  const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'speaker-selection', 'keyboardLock']);
  const ASK_LABELS = {
    media: 'use your camera or microphone',
    notifications: 'show notifications',
    midi: 'use your MIDI devices',
    midiSysex: 'use your MIDI devices',
    'clipboard-read': 'read your clipboard',
  };
  const privateDecisions = new Map();
  const pendingPerms = new Map();
  let permSeq = 0;
  const downloadItems = new Map();
  let dlSeq = 0;
  const liveDownloads = new Map();

  function decisionKey(origin, permission) { return `${origin}|${permission}`; }
  function remembered(isPrivate, origin, permission) {
    const k = decisionKey(origin, permission);
    if (isPrivate) return privateDecisions.get(k);
    const saved = store.get('permissions', {});
    return Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : undefined;
  }
  function remember(isPrivate, origin, permission, allow) {
    const k = decisionKey(origin, permission);
    if (isPrivate) { privateDecisions.set(k, allow); return; }
    const saved = { ...store.get('permissions', {}) };
    saved[k] = allow;
    store.set('permissions', saved);
  }

  function setupPermissions(ses, isPrivate) {
    ses.setPermissionCheckHandler((_wc, permission, origin) => {
      if (AUTO_ALLOW.has(permission)) return true;
      return remembered(isPrivate, safeOrigin(origin), permission) === true;
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (AUTO_ALLOW.has(permission)) return callback(true);
      if (!ASK_LABELS[permission]) return callback(false);
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      if (!origin) return callback(false);
      const known = remembered(isPrivate, origin, permission);
      if (known !== undefined) return callback(known);
      const host = wc.hostWebContents || wc;
      const ctx = byContents.get(host.id);
      if (!ctx) return callback(false);

      let label = ASK_LABELS[permission];
      if (permission === 'media' && Array.isArray(details.mediaTypes)) {
        const v = details.mediaTypes.includes('video');
        const a = details.mediaTypes.includes('audio');
        label = v && a ? 'use your camera and microphone' : v ? 'use your camera' : a ? 'use your microphone' : label;
      }
      const id = ++permSeq;
      const timer = setTimeout(() => finish(id, false, false), 60000);
      pendingPerms.set(id, { callback, origin, permission, isPrivate, timer, ctx });
      send(ctx, 'permission-request', { id, origin, label });
    });
  }

  function finish(id, allow, save) {
    const p = pendingPerms.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPerms.delete(id);
    if (save) remember(p.isPrivate, p.origin, p.permission, allow);
    try { p.callback(allow); } catch { /* webContents may be gone */ }
  }

  function setupDownloads(ses, isPrivate) {
    ses.on('will-download', (_event, item, wc) => {
      const host = wc && (wc.hostWebContents || wc);
      const ctx = host && byContents.get(host.id);
      const id = ++dlSeq;
      const savePath = uniquePath(app.getPath('downloads'), sanitizeFilename(item.getFilename()));
      item.setSavePath(savePath);
      downloadItems.set(id, item);

      const info = {
        id,
        filename: path.basename(savePath),
        url: item.getURL(),
        path: savePath,
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        paused: false,
        time: Date.now(),
      };
      liveDownloads.set(id, info);
      send(ctx, 'download-started', { ...info });

      item.on('updated', (_e, state) => {
        info.receivedBytes = item.getReceivedBytes();
        info.totalBytes = item.getTotalBytes();
        info.state = state;
        info.paused = item.isPaused();
        send(ctx, 'download-updated', { ...info });
      });
      item.once('done', (_e, state) => {
        info.receivedBytes = item.getReceivedBytes();
        info.state = state;
        info.paused = false;
        downloadItems.delete(id);
        send(ctx, 'download-done', { ...info });
        if (!isPrivate) {
          const list = store.get('downloads', []).filter((d) => d.id !== id || d.time !== info.time);
          list.unshift({ ...info });
          store.set('downloads', list.slice(0, 200));
        }
      });
    });
  }

  let uaString = '';
  function setupSession(ses, isPrivate) {
    if (uaString) ses.setUserAgent(uaString);
    blocker.attach(ses, getSettings);
    setupPermissions(ses, isPrivate);
    setupDownloads(ses, isPrivate);
  }

  async function clearPrivateData() {
    const ses = session.fromPartition(PRIVATE_PARTITION);
    try { await ses.clearStorageData(); await ses.clearCache(); } catch (e) { log('clearPrivateData', e); }
    privateDecisions.clear();
  }

  // ── Webview (guest) hardening & behaviour ───────────────────────────────────
  function setupGuest(wc, ctx) {
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      // Real popups (OAuth, payment windows) keep window.opener working; links become tabs.
      if (disposition === 'new-window' && features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            icon: ICON,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
          },
        };
      }
      if (/^(https?:|about:blank)/i.test(url)) {
        send(ctx, 'open-tab', { url, background: disposition === 'background-tab' });
      }
      return { action: 'deny' };
    });

    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const name = matchShortcut({ key: input.key, ctrl: input.control || input.meta, shift: input.shift, alt: input.alt });
      if (!name) return;
      if (name !== 'escape') event.preventDefault();
      send(ctx, 'shortcut', name);
    });

    wc.on('context-menu', (_event, params) => buildContextMenu(wc, ctx, params));
  }

  function buildContextMenu(wc, ctx, params) {
    const t = [];
    const openTab = (url, background) => send(ctx, 'open-tab', { url, background: !!background });
    const hasSel = !!params.selectionText && params.selectionText.trim().length > 0;

    if (params.misspelledWord && params.dictionarySuggestions) {
      for (const s of params.dictionarySuggestions.slice(0, 4)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (t.length) t.push({ type: 'separator' });
    }
    if (params.linkURL) {
      t.push({ label: 'Open link in new tab', click: () => openTab(params.linkURL, false) });
      t.push({ label: 'Open link in background tab', click: () => openTab(params.linkURL, true) });
      t.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
      t.push({ type: 'separator' });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      t.push({ label: 'Open image in new tab', click: () => openTab(params.srcURL, false) });
      t.push({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
      t.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
      t.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
      t.push({ type: 'separator' });
    }
    if (params.isEditable) {
      t.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (hasSel) {
      const q = params.selectionText.trim();
      t.push({ role: 'copy' });
      const short = q.length > 28 ? q.slice(0, 28) + '…' : q;
      t.push({
        label: `Search for “${short}”`,
        click: () => openTab((SEARCH_ENGINES[settingsCache.searchEngine] || SEARCH_ENGINES.google) + encodeURIComponent(q.slice(0, 500)), false),
      });
    }
    if (!params.isEditable && !params.linkURL && params.mediaType !== 'image') {
      if (t.length) t.push({ type: 'separator' });
      t.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      t.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      t.push({ label: 'Reload', click: () => wc.reload() });
      t.push({ type: 'separator' });
      t.push({ label: 'Print…', click: () => wc.print() });
      if (/^https?:/i.test(params.pageURL || '')) {
        t.push({ label: 'View page source', click: () => openTab('view-source:' + params.pageURL, false) });
      }
    }
    t.push({ type: 'separator' });
    t.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });

    // Collapse doubled separators.
    const clean = t.filter((item, i) => !(item.type === 'separator' && (i === 0 || t[i - 1].type === 'separator')));
    Menu.buildFromTemplate(clean).popup({ window: ctx.win });
  }

  // ── Window factory ──────────────────────────────────────────────────────────
  function boundsVisible(b) {
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 80 && b.x + (b.width || 0) > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
    });
  }

  function createWindow({ isPrivate = false, url = null, primary = false } = {}) {
    const ws = store.get('windowState', { width: 1280, height: 800 });
    const tb = titlebarColors(isPrivate);
    const opts = {
      width: Math.max(640, Math.min(ws.width || 1280, 8000)),
      height: Math.max(420, Math.min(ws.height || 800, 8000)),
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: tb.bg,
      title: isPrivate ? 'Horizon — Private' : 'Horizon',
      icon: ICON,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: tb.color, symbolColor: tb.symbolColor, height: 36 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    };
    if (!isPrivate && boundsVisible(ws) && windows.size === 0) {
      opts.x = ws.x;
      opts.y = ws.y;
    } else if (windows.size > 0) {
      const last = BrowserWindow.getFocusedWindow() || [...windows.values()][0].win;
      const b = last.getBounds();
      cascade = (cascade + 1) % 6;
      opts.x = b.x + 28 * (cascade || 1);
      opts.y = b.y + 28 * (cascade || 1);
    }

    const win = new BrowserWindow(opts);
    const wcId = win.webContents.id;
    const ctx = {
      win, isPrivate, primary, partition: isPrivate ? PRIVATE_PARTITION : REGULAR_PARTITION,
      pendingUrl: url, restored: false,
    };
    windows.set(win.id, ctx);
    byContents.set(wcId, ctx);
    if (isPrivate) privateCount++;
    if (primary) primaryId = win.id;

    win.removeMenu();
    if (!isPrivate && primary && ws.maximized) win.maximize();

    // The browser UI never navigates or opens windows itself.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.javascript = isPrivate ? !!settingsCache.jsInPrivate : true;
      params.partition = ctx.partition;
    });
    win.webContents.on('did-attach-webview', (_e, wc) => setupGuest(wc, ctx));

    const saveBounds = () => {
      if (isPrivate || win.id !== primaryId || win.isDestroyed()) return;
      clearTimeout(ctx.boundsTimer);
      ctx.boundsTimer = setTimeout(() => {
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
        const maximized = win.isMaximized();
        const prev = store.get('windowState', {});
        store.set('windowState', maximized ? { ...prev, maximized: true } : { ...win.getBounds(), maximized: false });
      }, 500);
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.on('maximize', saveBounds);
    win.on('unmaximize', saveBounds);
    win.on('enter-full-screen', () => send(ctx, 'fullscreen-changed', true));
    win.on('leave-full-screen', () => send(ctx, 'fullscreen-changed', false));

    win.on('closed', () => {
      windows.delete(win.id);
      byContents.delete(wcId);
      for (const [id, p] of pendingPerms) if (p.ctx === ctx) finish(id, false, false);
      if (isPrivate && --privateCount <= 0) { privateCount = 0; clearPrivateData(); }
    });

    win.once('ready-to-show', () => win.show());
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 8000);

    win.loadFile(path.join(__dirname, '../renderer/browser.html'), { query: { private: isPrivate ? '1' : '0' } });
    return ctx;
  }

  // ── IPC ─────────────────────────────────────────────────────────────────────
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    try { return await fn(e, ...args); } catch (err) { log('ipc', channel, err); throw err; }
  });

  handle('app:init', (e) => {
    const ctx = ctxOf(e);
    const s = getSettings();
    const startUrlForWindow = ctx.pendingUrl;
    ctx.pendingUrl = null;
    let restore = null;
    if (!ctx.isPrivate && ctx.primary && !ctx.restored) {
      ctx.restored = true;
      const saved = store.get('session', null);
      if (!startUrlForWindow && s.startup === 'restore' && saved && Array.isArray(saved.urls) && saved.urls.length) restore = saved;
    }
    const notice = pendingNotice;
    pendingNotice = null;
    return {
      isPrivate: ctx.isPrivate,
      partition: ctx.partition,
      settings: s,
      bookmarks: ctx.isPrivate ? [] : store.get('bookmarks', []),
      searchEngines: SEARCH_ENGINES,
      startUrl: startUrlForWindow,
      restore,
      notice,
      info: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        packaged: app.isPackaged,
        portable: updater.isPortable(),
        updatesConfigured: updater.isConfigured(),
      },
    };
  });

  handle('win:close', (e) => ctxOf(e).win.close());
  handle('win:openPrivate', () => { createWindow({ isPrivate: true }); });
  handle('win:openWindow', () => { createWindow({}); });
  handle('win:fullscreen', (e, v) => ctxOf(e).win.setFullScreen(!!v));
  handle('win:titlebar', (e, o) => {
    const ctx = ctxOf(e);
    const ok = (c) => typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c.trim());
    if (o && ok(o.color) && ok(o.symbolColor) && process.platform === 'win32') {
      try { ctx.win.setTitleBarOverlay({ color: o.color.trim(), symbolColor: o.symbolColor.trim(), height: 36 }); } catch { /* unsupported */ }
    }
  });

  handle('data:setBookmarks', (e, list) => {
    const ctx = ctxOf(e);
    if (ctx.isPrivate || !Array.isArray(list)) return false;
    const clean = list.slice(0, 5000).filter((b) => b && typeof b.url === 'string').map((b) => ({
      url: b.url.slice(0, 2048),
      title: String(b.title || b.url).slice(0, 300),
      icon: typeof b.icon === 'string' ? b.icon.slice(0, 2048) : '',
      time: Number(b.time) || Date.now(),
    }));
    store.set('bookmarks', clean);
    broadcast('bookmarks-updated', clean);
    return true;
  });

  handle('data:getHistory', (e, limit) => {
    if (ctxOf(e).isPrivate) return [];
    const n = Math.max(1, Math.min(Number(limit) || 500, 10000));
    return store.get('history', []).slice(0, n);
  });
  handle('data:addHistory', (e, entry) => {
    if (ctxOf(e).isPrivate || !entry || !/^https?:\/\//i.test(String(entry.url))) return;
    const url = String(entry.url).slice(0, 2048);
    const title = String(entry.title || url).slice(0, 300);
    const h = store.get('history', []);
    if (h[0] && h[0].url === url) {
      if (h[0].title !== title) { h[0].title = title; store.set('history', h); }
      return;
    }
    h.unshift({ url, title, time: Date.now() });
    store.set('history', h.slice(0, 10000));
  });
  handle('data:deleteHistory', (_e, url) => {
    store.set('history', store.get('history', []).filter((h) => h.url !== url));
  });
  handle('data:clearHistory', () => { store.set('history', []); });

  handle('data:getDownloads', (e) => (ctxOf(e).isPrivate ? [] : store.get('downloads', [])));
  handle('data:clearDownloads', () => { store.set('downloads', []); });
  handle('download:action', (_e, id, action) => {
    const item = downloadItems.get(Number(id));
    if (!item) return;
    if (action === 'cancel') item.cancel();
    else if (action === 'pause' && !item.isPaused()) item.pause();
    else if (action === 'resume' && item.canResume()) item.resume();
  });

  function knownDownloadPath(p) {
    if (typeof p !== 'string') return false;
    return store.get('downloads', []).some((d) => d.path === p) || [...liveDownloads.values()].some((d) => d.path === p);
  }
  handle('shell:openPath', async (_e, p) => { if (knownDownloadPath(p)) return shell.openPath(p); return 'Not allowed'; });
  handle('shell:showInFolder', (_e, p) => { if (knownDownloadPath(p)) shell.showItemInFolder(p); });
  handle('shell:openExternal', (_e, url) => {
    if (/^(https?:|mailto:|tel:)/i.test(String(url))) return shell.openExternal(String(url));
  });

  function applySettingsSideEffects() {
    nativeTheme.themeSource = settingsCache.theme;
    for (const ctx of windows.values()) {
      if (ctx.isPrivate) continue;
      const tb = titlebarColors(false);
      if (process.platform === 'win32') {
        try { ctx.win.setTitleBarOverlay({ color: tb.color, symbolColor: tb.symbolColor, height: 36 }); } catch { /* ignore */ }
      }
    }
  }
  handle('data:setSettings', (e, patch) => {
    ctxOf(e);
    if (!patch || typeof patch !== 'object') return settingsCache;
    const next = { ...settingsCache };
    for (const [k, v] of Object.entries(patch)) {
      if (SETTING_RULES[k] && SETTING_RULES[k](v)) next[k] = v;
    }
    settingsCache = next;
    store.set('settings', next);
    applySettingsSideEffects();
    broadcast('settings-updated', next);
    return next;
  });

  handle('data:clearAll', async () => {
    store.set('history', []);
    store.set('downloads', []);
    store.set('permissions', {});
    const ses = session.fromPartition(REGULAR_PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache().catch(() => {});
  });

  handle('session:save', (e, s) => {
    const ctx = ctxOf(e);
    if (ctx.isPrivate || ctx.win.id !== primaryId || !s || !Array.isArray(s.urls)) return;
    const urls = s.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 60).map((u) => u.slice(0, 2048));
    store.set('session', { urls, active: Math.max(0, Math.min(Number(s.active) || 0, urls.length - 1)) });
  });

  handle('perm:respond', (_e, id, allow) => finish(Number(id), !!allow, true));

  // Updates triggered from the Settings panel
  let lastCheck = null;
  handle('update:check', async () => {
    lastCheck = await updater.check();
    return {
      ...lastCheck,
      canInstall: updater.canInstall(lastCheck),
      pageUrl: lastCheck.pageUrl || updater.releasesPage(),
    };
  });
  handle('update:install', async (e) => {
    const ctx = ctxOf(e);
    if (!lastCheck || !lastCheck.ok || !lastCheck.available || !lastCheck.asset) throw new Error('No update available');
    const file = await updater.download(lastCheck, (r, t) => send(ctx, 'update-progress', { received: r, total: t, phase: 'downloading' }));
    send(ctx, 'update-progress', { phase: 'installing' });
    await sleep(700);
    updater.install(file);
    quitting = true;
    setTimeout(() => app.exit(0), 300);
  });

  // ── Startup flow ────────────────────────────────────────────────────────────
  async function startupFlow(splash) {
    const s = getSettings();
    const firstRun = !store.has('installedAt');
    if (firstRun) store.set('installedAt', Date.now());
    const t0 = Date.now();

    if (firstRun) {
      splash.status({ phase: 'setup', text: 'Setting up Horizon…', progress: null });
      await sleep(1100);
    }
    if (!s.autoUpdate) {
      splash.status({ phase: 'starting', text: 'Starting Horizon…' });
      await sleep(500);
      return 'launch';
    }

    splash.status({ phase: 'checking', text: 'Looking for updates…', progress: null });
    const info = await updater.check();
    await sleep(Math.max(0, 1300 - (Date.now() - t0)));

    if (!info.ok) {
      const offline = info.reason === 'offline';
      splash.status({ phase: 'starting', text: offline ? 'You’re offline — starting Horizon…' : 'Starting Horizon…' });
      await sleep(600);
      return 'launch';
    }
    if (!info.available) {
      splash.status({ phase: 'uptodate', text: 'Horizon is up to date' });
      await sleep(700);
      return 'launch';
    }

    if (!updater.canInstall(info)) {
      pendingNotice = { text: `Horizon ${info.latest} is available`, url: info.pageUrl, actionLabel: 'Download' };
      splash.status({ phase: 'uptodate', text: `Update ${info.latest} available` });
      await sleep(900);
      return 'launch';
    }

    try {
      splash.status({ phase: 'downloading', text: `Downloading update ${info.latest}`, progress: 0, version: info.latest });
      const file = await updater.download(info, (r, t) => {
        splash.status({ phase: 'downloading', progress: t ? r / t : null, detail: t ? `${(r / 1048576).toFixed(1)} / ${(t / 1048576).toFixed(1)} MB` : '' });
      });
      splash.status({ phase: 'installing', text: 'Installing update…', progress: null, detail: 'Horizon will restart automatically' });
      await sleep(1200);
      updater.install(file);
      return 'installing';
    } catch (e) {
      log('update failed', e);
      splash.status({ phase: 'error', text: 'Update failed — starting current version', progress: null, detail: '' });
      await sleep(1600);
      return 'launch';
    }
  }

  async function start() {
    const splash = createSplash();
    splash.win.on('closed', () => { if (!mainStarted && !quitting) app.quit(); });
    await splash.ready;

    splash.status({ appVersion: app.getVersion() });
    let outcome = 'launch';
    try { outcome = await startupFlow(splash); } catch (e) { log('startupFlow', e); }

    if (outcome === 'installing') {
      quitting = true;
      app.exit(0);
      return;
    }

    splash.status({ phase: 'starting', text: 'Starting Horizon…', progress: null, detail: '' });
    mainStarted = true;
    const ctx = createWindow({ primary: true, url: startUrl });
    ctx.win.once('ready-to-show', () => setTimeout(() => splash.close(), FAST ? 0 : 250));
    setTimeout(() => splash.close(), 10000);
  }

  // ── App lifecycle ───────────────────────────────────────────────────────────
  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgs(argv);
    const target = [...windows.values()].find((c) => !c.isPrivate) || [...windows.values()][0];
    if (!target) { if (url) startUrl = url; return; }
    if (target.win.isMinimized()) target.win.restore();
    target.win.focus();
    if (url) send(target, 'open-tab', { url, background: false });
  });

  app.on('before-quit', () => { quitting = true; if (store) store.flush(); });
  app.on('window-all-closed', () => { if (mainStarted || quitting) app.quit(); });

  app.whenReady().then(async () => {
    try {
      logFile = path.join(app.getPath('userData'), 'horizon.log');
      try { if (fs.statSync(logFile).size > 1048576) fs.truncateSync(logFile, 0); } catch { /* none yet */ }

      store = new Store('horizon-data', { bookmarks: [], history: [], downloads: [], permissions: {}, settings: DEFAULT_SETTINGS });
      settingsCache = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
      nativeTheme.themeSource = settingsCache.theme;
      Menu.setApplicationMenu(null);
      updater.cleanup();
      startUrl = urlFromArgs(process.argv);

      // A normal Chrome user agent: many sites reject UAs that mention "Electron".
      uaString = session.defaultSession.getUserAgent().replace(/\s(Horizon|horizon-browser|Electron)\/[\d.]+/gi, '');
      session.defaultSession.setUserAgent(uaString);
      setupSession(session.fromPartition(REGULAR_PARTITION), false);
      setupSession(session.fromPartition(PRIVATE_PARTITION), true);

      app.on('activate', () => { if (!windows.size && mainStarted) createWindow({ primary: true }); });
      await start();
    } catch (e) {
      log('fatal startup error', e);
      dialog.showErrorBox('Horizon could not start', String(e && e.message ? e.message : e));
      app.exit(1);
    }
  });
}
