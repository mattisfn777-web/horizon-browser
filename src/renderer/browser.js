'use strict';

(async () => {
  const hz = window.hz;
  const matchShortcut = window.HZ_matchShortcut;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── State ───────────────────────────────────────────────────────────────────
  let IS_PRIVATE = false;
  let PARTITION = '';
  let settings = {};
  let bookmarks = [];
  let engines = {};
  let info = {};
  const tabs = [];
  const closedTabs = [];
  let activeId = null;
  let nextId = 1;
  let downloads = [];
  let historyCache = [];
  let openSidebarName = null;
  let winFullscreen = false;
  let prevFs = false;
  let dragId = null;

  // ── Elements ────────────────────────────────────────────────────────────────
  const el = {
    tabsList: $('tabs-list'), newTab: $('new-tab-btn'), content: $('content'),
    newtab: $('newtab'), privNewtab: $('priv-newtab'),
    back: $('btn-back'), fwd: $('btn-fwd'), reload: $('btn-reload'), home: $('btn-home'),
    url: $('url-input'), ssl: $('ssl-icon'), bmBtn: $('bookmark-btn'), bmPath: $('bookmark-path'),
    findBtn: $('btn-find'), dlBtn: $('btn-downloads'), menuBtn: $('btn-menu'),
    progress: $('progress-bar'), bmBar: $('bookmarks-bar'), status: $('statusbar'),
    suggestions: $('suggestions'), overlay: $('sidebar-overlay'), mainMenu: $('main-menu'), ctx: $('ctx-menu'),
    find: $('find-bar'), findInput: $('find-input'), findCount: $('find-count'),
    findPrev: $('find-prev'), findNext: $('find-next'), findClose: $('find-close'),
    errPage: $('error-page'), perm: $('perm-bar'), toasts: $('toasts'), boot: $('boot'),
  };
  const sidebars = {
    bookmarks: $('sidebar-bookmarks'), history: $('sidebar-history'),
    downloads: $('sidebar-downloads'), settings: $('settings-panel'),
  };

  // ── Small helpers ───────────────────────────────────────────────────────────
  const tabById = (id) => tabs.find((t) => t.id === id);
  const activeTab = () => tabById(activeId);
  const isActive = (t) => t.id === activeId;
  const attempt = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const hostOf = (u) => attempt(() => new URL(u).hostname.replace(/^www\./, ''), u || '');
  const isWeb = (u) => /^https?:\/\//i.test(u || '');

  function originIcon(u) {
    return attempt(() => { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin + '/favicon.ico' : ''; }, '');
  }
  function favEl(iconUrl, label, large) {
    const w = document.createElement('span');
    w.className = 'fav' + (large ? ' lg' : '');
    w.textContent = (String(label || '?').replace(/^https?:\/\/(www\.)?/, '').charAt(0) || '?').toUpperCase();
    if (iconUrl) {
      const img = new Image();
      img.alt = '';
      img.onload = () => { w.textContent = ''; w.appendChild(img); };
      img.src = iconUrl;
    }
    return w;
  }

  function toast(text, opts = {}) {
    if (opts.key) el.toasts.querySelectorAll(`[data-key="${opts.key}"]`).forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    if (opts.key) t.dataset.key = opts.key;
    const span = document.createElement('span');
    span.textContent = text;
    t.appendChild(span);
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action.label;
      b.addEventListener('click', () => { opts.action.fn(); dismiss(); });
      t.appendChild(b);
    }
    function dismiss() { t.classList.add('out'); setTimeout(() => t.remove(), 220); }
    el.toasts.appendChild(t);
    setTimeout(dismiss, opts.timeout || 3200);
  }

  // ── URL resolution ──────────────────────────────────────────────────────────
  function searchUrl(q) { return (engines[settings.searchEngine] || engines.google) + encodeURIComponent(q); }
  function homeUrl() {
    const h = (settings.homePage || '').trim();
    return h ? resolveInput(h, true) || 'https://www.google.com' : 'https://www.google.com';
  }
  function resolveInput(raw, noHome) {
    const t = String(raw || '').trim();
    if (!t) return noHome ? null : homeUrl();
    if (/^javascript:/i.test(t) || /^data:/i.test(t)) return null;
    if (/^(https?|file|about|view-source):/i.test(t) && !/^[a-z]+:\d+/i.test(t)) return t;
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(t)) return 'http://' + t;
    if (!/\s/.test(t) && /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
    return searchUrl(t);
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────
  const GLOBE = '<svg class="tab-favicon-default" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.6" stroke="currentColor" stroke-width="1.2"/><path d="M1.4 7h11.2M7 1.4c1.8 1.7 1.8 9.5 0 11.2M7 1.4c-1.8 1.7-1.8 9.5 0 11.2" stroke="currentColor" stroke-width="1.1"/></svg>';
  const SPEAKER = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4.5h2L6.5 2.5v7L4 7.5H2z" fill="currentColor"/><path d="M8.2 4a3 3 0 0 1 0 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

  function buildTabEl(tab) {
    const d = document.createElement('div');
    d.className = 'tab' + (IS_PRIVATE ? ' private-tab' : '');
    d.draggable = true;
    d.dataset.id = tab.id;
    d.innerHTML = `<span class="tab-icon"></span><span class="tab-title"></span><span class="tab-audio hidden">${SPEAKER}</span>
      <button class="tab-close" title="Close tab"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`;
    d.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    d.addEventListener('click', (e) => { if (!e.target.closest('.tab-close')) activateTab(tab.id, true); });
    d.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(tab, e.clientX, e.clientY); });

    d.addEventListener('dragstart', (e) => { dragId = tab.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(tab.id)); d.classList.add('dragging'); });
    d.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === tab.id) return;
      e.preventDefault();
      const r = d.getBoundingClientRect();
      const after = e.clientX >= r.left + r.width / 2;
      d.classList.toggle('drop-after', after);
      d.classList.toggle('drop-before', !after);
    });
    d.addEventListener('dragleave', () => d.classList.remove('drop-before', 'drop-after'));
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = d.classList.contains('drop-after');
      d.classList.remove('drop-before', 'drop-after');
      moveTab(dragId, tab.id, after);
    });
    d.addEventListener('dragend', () => {
      dragId = null;
      document.querySelectorAll('.tab').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    return d;
  }

  function moveTab(id, targetId, after) {
    if (id == null || id === targetId) return;
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [t] = tabs.splice(from, 1);
    let to = tabs.findIndex((x) => x.id === targetId);
    if (to < 0) { tabs.splice(from, 0, t); return; }
    if (after) to++;
    tabs.splice(to, 0, t);
    el.tabsList.innerHTML = '';
    tabs.forEach((x) => el.tabsList.appendChild(x.el));
    saveSessionSoon();
  }

  function updateTabUi(tab) {
    const title = tab.title || (tab.url ? hostOf(tab.url) : 'New Tab');
    tab.el.querySelector('.tab-title').textContent = title;
    tab.el.title = title;
    const key = tab.loading ? 'spin' : tab.favicon || 'default';
    if (tab._iconKey !== key) {
      tab._iconKey = key;
      const holder = tab.el.querySelector('.tab-icon');
      holder.innerHTML = '';
      if (tab.loading) {
        holder.innerHTML = '<span class="tab-spinner"></span>';
      } else if (tab.favicon) {
        const img = new Image();
        img.className = 'tab-favicon';
        img.alt = '';
        img.onerror = () => { holder.innerHTML = GLOBE; };
        img.src = tab.favicon;
        holder.appendChild(img);
      } else {
        holder.innerHTML = GLOBE;
      }
    }
    tab.el.querySelector('.tab-audio').classList.toggle('hidden', !tab.audible);
  }

  function createTab(url, opts = {}) {
    const tab = {
      id: nextId++, url: '', title: '', favicon: '', loading: false, audible: false, ready: false,
      wv: null, el: null, error: null, canBack: false, canFwd: false, _iconKey: '',
    };
    tab.el = buildTabEl(tab);
    let idx = tabs.length;
    if (opts.afterId != null) { const i = tabs.findIndex((t) => t.id === opts.afterId); if (i >= 0) idx = i + 1; }
    tabs.splice(idx, 0, tab);
    el.tabsList.insertBefore(tab.el, el.tabsList.children[idx] || null);

    let target = url && url !== 'newtab' ? url : null;
    if (!target && !IS_PRIVATE && !opts.blank && settings.newTabPage === 'home') target = homeUrl();
    if (target) {
      tab.url = target;
      tab.title = hostOf(target);
      if (opts.lazy) { /* webview is created when the tab is first shown */ } else { ensureWebview(tab); load(tab, target); }
    }
    updateTabUi(tab);
    if (opts.activate !== false) activateTab(tab.id, !target);
    saveSessionSoon();
    return tab;
  }

  function ensureWebview(tab) {
    if (tab.wv) return tab.wv;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', '');
    tab.wv = wv;
    bindWebview(tab);
    el.content.appendChild(wv);
    if (isActive(tab)) wv.classList.add('active');
    return wv;
  }

  function load(tab, url) {
    tab.url = url;
    tab.error = null;
    const wv = ensureWebview(tab);
    if (tab.ready) {
      attempt(() => { const p = wv.loadURL(url); if (p && p.catch) p.catch(() => {}); });
    } else {
      wv.setAttribute('src', url);
    }
    if (isActive(tab)) { wv.classList.add('active'); hideError(); showPage(tab); syncToolbar(tab); }
  }

  function navigate(input, tab = activeTab()) {
    if (!tab) return;
    if (/^(mailto|tel):/i.test(String(input).trim())) { hz.openExternal(String(input).trim()); return; }
    const url = resolveInput(input);
    if (!url) return;
    load(tab, url);
    if (isActive(tab)) { hideSuggestions(); el.url.blur(); }
  }

  function syncNav(tab) {
    if (tab.wv && tab.ready) {
      tab.canBack = attempt(() => tab.wv.canGoBack(), false);
      tab.canFwd = attempt(() => tab.wv.canGoForward(), false);
    } else { tab.canBack = tab.canFwd = false; }
    if (isActive(tab)) { el.back.disabled = !tab.canBack; el.fwd.disabled = !tab.canFwd; }
  }

  function recordHistory(tab) {
    if (IS_PRIVATE || !isWeb(tab.url)) return;
    hz.addHistory({ url: tab.url, title: tab.title || tab.url }).catch(() => {});
  }

  function bindWebview(tab) {
    const wv = tab.wv;
    const on = (ev, fn) => wv.addEventListener(ev, fn);

    on('dom-ready', () => { tab.ready = true; syncNav(tab); });
    on('page-title-updated', (e) => {
      tab.title = e.title || tab.title;
      updateTabUi(tab);
      if (isActive(tab)) updateWindowTitle();
      recordHistory(tab);
    });
    on('page-favicon-updated', (e) => { tab.favicon = (e.favicons && e.favicons[0]) || ''; updateTabUi(tab); });
    on('did-start-loading', () => {
      tab.loading = true;
      updateTabUi(tab);
      if (isActive(tab)) { setProgress(0.15); setReloadIcon(true); }
    });
    on('did-stop-loading', () => {
      tab.loading = false;
      updateTabUi(tab);
      syncNav(tab);
      if (isActive(tab)) { finishProgress(); setReloadIcon(false); }
    });
    on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isInPlace) {
        tab.error = null;
        if (isActive(tab)) { hideError(); setProgress(0.35); }
      }
    });
    on('did-navigate', (e) => {
      if (/^chrome-error:/i.test(e.url)) return;
      tab.url = e.url;
      tab.title = hostOf(e.url);
      tab.favicon = '';
      tab._iconKey = '';
      updateTabUi(tab);
      syncNav(tab);
      recordHistory(tab);
      if (isActive(tab)) { syncToolbar(tab); setProgress(0.7); }
      saveSessionSoon();
    });
    on('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      tab.url = e.url;
      syncNav(tab);
      if (isActive(tab)) syncToolbar(tab);
      saveSessionSoon();
    });
    on('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === 0) return;
      tab.error = { code: e.errorCode, desc: e.errorDescription || '', url: e.validatedURL || tab.url };
      if (e.validatedURL && !/^chrome-error:/i.test(e.validatedURL)) tab.url = e.validatedURL;
      tab.loading = false;
      updateTabUi(tab);
      if (isActive(tab)) { showError(tab); syncToolbar(tab); finishProgress(); setReloadIcon(false); }
    });
    on('render-process-gone', () => {
      tab.error = { code: 0, desc: 'CRASHED', url: tab.url };
      tab.loading = false;
      updateTabUi(tab);
      if (isActive(tab)) { showError(tab); finishProgress(); setReloadIcon(false); }
    });
    on('update-target-url', (e) => { if (isActive(tab)) showStatus(e.url); });
    on('media-started-playing', () => { tab.audible = true; updateTabUi(tab); });
    on('media-paused', () => { tab.audible = false; updateTabUi(tab); });
    on('found-in-page', (e) => {
      if (!isActive(tab) || !e.result) return;
      const r = e.result;
      el.findCount.textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : (el.findInput.value ? '0/0' : '');
      el.findPrev.disabled = el.findNext.disabled = !r.matches;
    });
    on('enter-html-full-screen', () => {
      if (!isActive(tab)) return;
      prevFs = winFullscreen;
      document.body.classList.add('html-fs');
      hz.setFullscreen(true);
    });
    on('leave-html-full-screen', () => {
      document.body.classList.remove('html-fs');
      if (!prevFs) hz.setFullscreen(false);
    });
  }

  function activateTab(id, focusAddress) {
    const tab = tabById(id);
    if (!tab) return;
    activeId = id;
    for (const t of tabs) {
      t.el.classList.toggle('active', t === tab);
      if (t.wv) t.wv.classList.toggle('active', t === tab);
    }
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (tab.url && !tab.wv) { ensureWebview(tab); load(tab, tab.url); }
    if (tab.wv) tab.wv.classList.add('active');
    closeFind(true);
    showPage(tab);
    syncToolbar(tab);
    updateWindowTitle();
    if (tab.error) showError(tab); else hideError();
    if (!tab.url) {
      if (focusAddress) setTimeout(() => { const i = IS_PRIVATE ? $('priv-search-input') : $('nt-search-input'); (i || el.url).focus(); }, 0);
    } else if (tab.wv) {
      setTimeout(() => { if (document.activeElement !== el.url) attempt(() => tab.wv.focus()); }, 0);
    }
    saveSessionSoon();
  }

  function showPage(tab) {
    const blank = !tab.url;
    const page = IS_PRIVATE ? el.privNewtab : el.newtab;
    page.classList.toggle('active', blank);
    el.newtab.classList.toggle('blank', settings.newTabPage === 'blank');
    if (blank) renderNewtab();
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = tabs[i];
    if (!IS_PRIVATE && isWeb(tab.url)) { closedTabs.push({ url: tab.url }); if (closedTabs.length > 25) closedTabs.shift(); }
    if (tab.wv) tab.wv.remove();
    tab.el.remove();
    tabs.splice(i, 1);
    if (!tabs.length) { hz.close(); return; }
    if (activeId === id) activateTab(tabs[Math.min(i, tabs.length - 1)].id);
    saveSessionSoon();
  }

  function reopenTab() {
    const c = closedTabs.pop();
    if (c) createTab(c.url);
  }

  function cycleTab(dir) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
  }

  function tabMenu(tab, x, y) {
    const i = tabs.findIndex((t) => t.id === tab.id);
    showMenu(x, y, [
      { label: 'New tab', fn: () => createTab(null, { afterId: tab.id }) },
      { sep: true },
      { label: 'Reload', fn: () => { if (tab.wv && tab.ready) tab.wv.reload(); }, disabled: !tab.url },
      { label: 'Duplicate', fn: () => createTab(tab.url, { afterId: tab.id }), disabled: !tab.url },
      { sep: true },
      { label: 'Close tab', fn: () => closeTab(tab.id) },
      { label: 'Close other tabs', fn: () => tabs.filter((t) => t.id !== tab.id).forEach((t) => closeTab(t.id)), disabled: tabs.length < 2 },
      { label: 'Close tabs to the right', fn: () => tabs.slice(i + 1).forEach((t) => closeTab(t.id)), disabled: i === tabs.length - 1 },
    ]);
  }

  // ── Toolbar sync ────────────────────────────────────────────────────────────
  function syncToolbar(tab) {
    el.url.value = tab.url || '';
    syncNav(tab);
    setReloadIcon(tab.loading);
    updateSsl(tab.url);
    updateBookmarkBtn();
  }

  function updateWindowTitle() {
    const t = activeTab();
    const name = t && t.title && t.url ? t.title : 'New Tab';
    document.title = `${name} — Horizon${IS_PRIVATE ? ' (Private)' : ''}`;
  }

  function updateSsl(url) {
    if (!url) { el.ssl.innerHTML = ''; return; }
    const secure = /^(https|file|view-source:https):/i.test(url) || /^about:/i.test(url);
    const c = secure ? 'var(--t3)' : '#f59e0b';
    el.ssl.innerHTML = secure
      ? `<rect x="3" y="7" width="10" height="7" rx="1.5" stroke="${c}" stroke-width="1.3"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" stroke="${c}" stroke-width="1.3"/>`
      : `<circle cx="8" cy="8" r="6" stroke="${c}" stroke-width="1.3"/><path d="M8 4.8v3.8M8 10.8v.3" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`;
    $('ssl-icon').setAttribute('data-secure', secure ? '1' : '0');
    el.ssl.parentElement.title = secure ? 'Secure connection' : 'Not secure';
  }

  function setReloadIcon(loading) {
    el.reload.title = loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
    el.reload.innerHTML = loading
      ? '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 8A5.5 5.5 0 1 1 9 2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9 1v3h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  let progTimer = null;
  function setProgress(p) {
    clearTimeout(progTimer);
    el.progress.style.opacity = '1';
    el.progress.style.width = p * 100 + '%';
  }
  function finishProgress() {
    el.progress.style.width = '100%';
    clearTimeout(progTimer);
    progTimer = setTimeout(() => {
      el.progress.style.opacity = '0';
      setTimeout(() => { el.progress.style.width = '0'; }, 220);
    }, 180);
  }

  let statusTimer = null;
  function showStatus(u) {
    clearTimeout(statusTimer);
    if (u) { el.status.textContent = u; el.status.classList.add('visible'); }
    else statusTimer = setTimeout(() => el.status.classList.remove('visible'), 80);
  }

  // ── Error page ──────────────────────────────────────────────────────────────
  const ERRORS = {
    ERR_NAME_NOT_RESOLVED: ['This site can’t be reached', 'The server’s address couldn’t be found. Check for typos in the address, or your internet connection.'],
    ERR_INTERNET_DISCONNECTED: ['You’re offline', 'Check your network connection and try again.'],
    ERR_CONNECTION_REFUSED: ['Connection refused', 'The site refused to connect. It may be down or blocking your connection.'],
    ERR_CONNECTION_RESET: ['Connection was reset', 'The connection was interrupted while the page was loading.'],
    ERR_CONNECTION_TIMED_OUT: ['Connection timed out', 'The site took too long to respond.'],
    ERR_TIMED_OUT: ['Connection timed out', 'The site took too long to respond.'],
    ERR_CONNECTION_CLOSED: ['Connection closed', 'The site closed the connection unexpectedly.'],
    ERR_NETWORK_CHANGED: ['Network changed', 'Your network connection changed while loading. Try again.'],
    ERR_TOO_MANY_REDIRECTS: ['Too many redirects', 'This page redirected too many times. Clearing cookies for this site may help.'],
    ERR_BLOCKED_BY_CLIENT: ['Blocked by Horizon', 'This request was blocked by your tracker/ad protection settings.'],
    ERR_ADDRESS_UNREACHABLE: ['Address unreachable', 'The network can’t reach this address right now.'],
    CRASHED: ['This page crashed', 'Something went wrong while displaying this page. Reloading usually fixes it.'],
  };
  function showError(tab) {
    const e = tab.error;
    if (!e) return;
    let [title, desc] = ERRORS[e.desc] || [null, null];
    if (!title && /^ERR_CERT|^ERR_SSL|^ERR_BAD_SSL/.test(e.desc)) {
      title = 'Your connection isn’t private';
      desc = 'Horizon couldn’t verify this site’s security certificate, so it stopped loading the page to protect you.';
    }
    $('err-title').textContent = title || 'This page can’t be displayed';
    $('err-desc').textContent = desc || 'Something prevented the page from loading.';
    $('err-url').textContent = e.url || '';
    $('err-code').textContent = e.desc || '';
    el.errPage.classList.remove('hidden');
    el.newtab.classList.remove('active');
    el.privNewtab.classList.remove('active');
  }
  function hideError() { el.errPage.classList.add('hidden'); }

  // ── Bookmarks ───────────────────────────────────────────────────────────────
  const isBookmarked = (u) => bookmarks.some((b) => b.url === u);
  function updateBookmarkBtn() {
    const t = activeTab();
    const on = !!(t && t.url && isBookmarked(t.url));
    el.bmBtn.classList.toggle('active', on);
    el.bmBtn.title = on ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  }
  function saveBookmarks() { return hz.setBookmarks(bookmarks); }
  function toggleBookmark() {
    if (IS_PRIVATE) return;
    const t = activeTab();
    if (!t || !isWeb(t.url)) { toast('Only web pages can be bookmarked'); return; }
    const i = bookmarks.findIndex((b) => b.url === t.url);
    if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed', { key: 'bm' }); }
    else { bookmarks.unshift({ url: t.url, title: t.title || t.url, icon: t.favicon || '', time: Date.now() }); toast('Bookmarked', { key: 'bm' }); }
    saveBookmarks();
    afterBookmarksChanged();
  }
  function afterBookmarksChanged() {
    updateBookmarkBtn();
    renderBookmarksBar();
    if (openSidebarName === 'bookmarks') renderBookmarksList();
    if (!activeTab() || !activeTab().url) renderNewtab();
  }

  function renderBookmarksBar() {
    const show = !IS_PRIVATE && settings.showBookmarksBar;
    el.bmBar.classList.toggle('visible', !!show);
    if (!show) return;
    el.bmBar.innerHTML = '';
    if (!bookmarks.length) { el.bmBar.innerHTML = '<span style="font-size:12px;color:var(--t3);padding:3px 8px">Bookmarks you add will appear here</span>'; return; }
    bookmarks.slice(0, 30).forEach((b) => {
      const d = document.createElement('div');
      d.className = 'bm-bar-item';
      d.title = b.url;
      d.appendChild(favEl(b.icon || originIcon(b.url), b.title || b.url));
      const l = document.createElement('span');
      l.className = 'bm-bar-label';
      l.textContent = b.title || hostOf(b.url);
      d.appendChild(l);
      d.addEventListener('click', () => navigate(b.url));
      d.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); createTab(b.url, { activate: false }); } });
      el.bmBar.appendChild(d);
    });
  }

  function renderBookmarksList() {
    const box = $('bm-list');
    const q = $('bm-search').value.trim().toLowerCase();
    const list = bookmarks.filter((b) => !q || (b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q));
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = `<div class="sidebar-empty">${q ? 'No matches' : 'No bookmarks yet — press Ctrl+D on any page'}</div>`; return; }
    list.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.appendChild(favEl(b.icon || originIcon(b.url), b.title || b.url));
      const c = document.createElement('div');
      c.className = 'list-item-content';
      c.innerHTML = `<div class="list-item-title">${esc(b.title || b.url)}</div><div class="list-item-sub">${esc(hostOf(b.url))}</div>`;
      row.appendChild(c);
      const del = document.createElement('button');
      del.className = 'list-item-del';
      del.textContent = '×';
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        bookmarks = bookmarks.filter((x) => x.url !== b.url);
        saveBookmarks();
        afterBookmarksChanged();
      });
      row.appendChild(del);
      row.addEventListener('click', (e) => { if (e.ctrlKey) createTab(b.url, { activate: false }); else { navigate(b.url); closeSidebars(); } });
      box.appendChild(row);
    });
  }

  // ── History ─────────────────────────────────────────────────────────────────
  function dayLabel(t) {
    const d = new Date(t);
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  async function renderHistoryList() {
    const box = $('hist-list');
    const q = $('hist-search').value.trim().toLowerCase();
    const all = await hz.getHistory(1000);
    historyCache = all;
    const list = all.filter((h) => !q || (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)).slice(0, 300);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = `<div class="sidebar-empty">${q ? 'No matches' : 'No history yet'}</div>`; return; }
    let lastDay = '';
    list.forEach((h) => {
      const day = dayLabel(h.time);
      if (day !== lastDay) { lastDay = day; const hd = document.createElement('div'); hd.className = 'hist-day'; hd.textContent = day; box.appendChild(hd); }
      const row = document.createElement('div');
      row.className = 'list-item';
      row.appendChild(favEl(originIcon(h.url), h.title || h.url));
      const c = document.createElement('div');
      c.className = 'list-item-content';
      c.innerHTML = `<div class="list-item-title">${esc(h.title || h.url)}</div><div class="list-item-sub">${esc(hostOf(h.url))}</div>`;
      row.appendChild(c);
      const m = document.createElement('span');
      m.className = 'list-item-meta';
      m.textContent = new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.appendChild(m);
      const del = document.createElement('button');
      del.className = 'list-item-del';
      del.textContent = '×';
      del.title = 'Remove from history';
      del.addEventListener('click', async (e) => { e.stopPropagation(); await hz.deleteHistory(h.url); renderHistoryList(); });
      row.appendChild(del);
      row.addEventListener('click', (e) => { if (e.ctrlKey) createTab(h.url, { activate: false }); else { navigate(h.url); closeSidebars(); } });
      box.appendChild(row);
    });
  }

  // ── Downloads ───────────────────────────────────────────────────────────────
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i ? 1 : 0) + ' ' + u[i];
  }
  function upsertDownload(d) {
    const i = downloads.findIndex((x) => x.id === d.id && x.time === d.time);
    if (i >= 0) downloads[i] = d; else downloads.unshift(d);
    if (openSidebarName === 'downloads') renderDownloads();
  }
  function renderDownloads() {
    const box = $('dl-list');
    box.innerHTML = '';
    if (!downloads.length) { box.innerHTML = '<div class="sidebar-empty">No downloads yet</div>'; return; }
    downloads.slice(0, 100).forEach((d) => {
      const row = document.createElement('div');
      const prog = d.state === 'progressing';
      row.className = 'dl-item' + (prog ? '' : ' done');
      const pct = d.totalBytes ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : 0;
      const status = prog ? `${d.paused ? 'Paused · ' : ''}${fmtBytes(d.receivedBytes)}${d.totalBytes ? ' of ' + fmtBytes(d.totalBytes) : ''}`
        : d.state === 'completed' ? fmtBytes(d.totalBytes || d.receivedBytes) : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
      row.innerHTML = `<div class="dl-name" title="${esc(d.filename)}">${esc(d.filename)}</div>
        <div class="dl-progress"><div class="dl-progress-fill" style="width:${pct}%"></div></div>
        <div class="dl-meta"><span>${esc(status)}</span><span>${esc(hostOf(d.url))}</span></div>
        <div class="dl-actions"></div>`;
      const acts = row.querySelector('.dl-actions');
      const btn = (label, fn) => { const b = document.createElement('button'); b.className = 'dl-btn'; b.textContent = label; b.addEventListener('click', fn); acts.appendChild(b); };
      if (prog) {
        btn(d.paused ? 'Resume' : 'Pause', () => hz.downloadAction(d.id, d.paused ? 'resume' : 'pause'));
        btn('Cancel', () => hz.downloadAction(d.id, 'cancel'));
      } else if (d.state === 'completed') {
        btn('Open', () => hz.openPath(d.path));
        btn('Show in folder', () => hz.showInFolder(d.path));
      }
      box.appendChild(row);
    });
  }

  // ── New tab page ────────────────────────────────────────────────────────────
  async function renderNewtab() {
    if (IS_PRIVATE) { syncPrivJs(); return; }
    const grid = $('nt-bookmarks');
    grid.innerHTML = '';
    $('nt-bm-section').classList.toggle('hidden', !bookmarks.length);
    bookmarks.slice(0, 12).forEach((b) => {
      const tile = document.createElement('div');
      tile.className = 'nt-bm';
      tile.title = b.title || b.url;
      tile.appendChild(favEl(b.icon || originIcon(b.url), b.title || b.url, true));
      const s = document.createElement('span');
      s.textContent = b.title || hostOf(b.url);
      tile.appendChild(s);
      tile.addEventListener('click', () => navigate(b.url));
      grid.appendChild(tile);
    });
    const hist = await hz.getHistory(40);
    const box = $('nt-history');
    box.innerHTML = '';
    const seen = new Set();
    const recent = hist.filter((h) => { const k = hostOf(h.url) + new URL(h.url).pathname; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
    $('nt-hist-section').classList.toggle('hidden', !recent.length);
    recent.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'nt-hist';
      row.appendChild(favEl(originIcon(h.url), h.title || h.url));
      row.insertAdjacentHTML('beforeend', `<span class="nt-hist-title">${esc(h.title || h.url)}</span><span class="nt-hist-domain">${esc(hostOf(h.url))}</span>`);
      row.addEventListener('click', () => navigate(h.url));
      box.appendChild(row);
    });
  }

  function syncPrivJs() {
    const on = !!settings.jsInPrivate;
    $('priv-js-toggle').checked = on;
    $('priv-js-state').textContent = on ? 'On — applies to tabs you open from now on' : 'Off — most sites load, but scripts don’t run';
  }

  // ── Menus ───────────────────────────────────────────────────────────────────
  function closeMenus() {
    el.mainMenu.classList.remove('visible');
    el.ctx.classList.remove('visible');
  }
  function placeMenu(menu, x, y, alignRight) {
    menu.classList.add('visible');
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = alignRight ? x - w : x;
    let top = y;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
  function showMenu(x, y, items) {
    closeMenus();
    el.ctx.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; el.ctx.appendChild(s); return; }
      const d = document.createElement('div');
      d.className = 'menu-item' + (it.danger ? ' danger' : '');
      d.textContent = it.label;
      if (it.disabled) { d.style.opacity = '.4'; d.style.pointerEvents = 'none'; }
      d.addEventListener('click', () => { closeMenus(); it.fn(); });
      el.ctx.appendChild(d);
    });
    placeMenu(el.ctx, x, y, false);
  }
  function toggleMainMenu() {
    if (el.mainMenu.classList.contains('visible')) { closeMenus(); return; }
    closeMenus();
    const r = el.menuBtn.getBoundingClientRect();
    placeMenu(el.mainMenu, r.right, r.bottom + 6, true);
  }

  // ── Sidebars ────────────────────────────────────────────────────────────────
  function openSidebar(name) {
    if (IS_PRIVATE && name !== 'downloads') return;
    closeMenus();
    hideSuggestions();
    Object.values(sidebars).forEach((s) => s.classList.remove('visible'));
    sidebars[name].classList.add('visible');
    el.overlay.classList.add('visible');
    openSidebarName = name;
    if (name === 'bookmarks') { renderBookmarksList(); setTimeout(() => $('bm-search').focus(), 30); }
    if (name === 'history') { renderHistoryList(); setTimeout(() => $('hist-search').focus(), 30); }
    if (name === 'downloads') renderDownloads();
  }
  function closeSidebars() {
    Object.values(sidebars).forEach((s) => s.classList.remove('visible'));
    el.overlay.classList.remove('visible');
    openSidebarName = null;
  }
  function toggleSidebar(name) { if (openSidebarName === name) closeSidebars(); else openSidebar(name); }

  // ── Omnibox suggestions ─────────────────────────────────────────────────────
  let sgItems = [];
  let sgIndex = -1;
  function hideSuggestions() { el.suggestions.classList.remove('visible'); sgItems = []; sgIndex = -1; }
  function highlight(text, q) {
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<em class="match">' + esc(text.slice(i, i + q.length)) + '</em>' + esc(text.slice(i + q.length));
  }
  function updateSuggestions() {
    const q = el.url.value.trim();
    if (!q || el.url.value === (activeTab() || {}).url) { hideSuggestions(); return; }
    const ql = q.toLowerCase();
    const items = [];
    const seen = new Set();
    const push = (it) => { if (!seen.has(it.url) && items.length < 8) { seen.add(it.url); items.push(it); } };
    items.push({ kind: 'search', url: resolveInput(q), main: q, sub: 'Search with ' + (settings.searchEngine || 'google') });
    bookmarks.filter((b) => (b.title || '').toLowerCase().includes(ql) || b.url.toLowerCase().includes(ql)).slice(0, 3)
      .forEach((b) => push({ kind: 'bookmark', url: b.url, main: b.title || b.url, sub: b.url }));
    historyCache.filter((h) => (h.title || '').toLowerCase().includes(ql) || h.url.toLowerCase().includes(ql)).slice(0, 12)
      .forEach((h) => push({ kind: 'history', url: h.url, main: h.title || h.url, sub: h.url }));
    sgItems = items;
    sgIndex = -1;
    el.suggestions.innerHTML = '';
    const icons = {
      search: '<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
      bookmark: '<path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
      history: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.2 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    };
    items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'sg-item';
      d.innerHTML = `<svg class="sg-icon" viewBox="0 0 16 16" fill="none">${icons[it.kind]}</svg><div class="sg-text"><div class="sg-main">${highlight(it.main, q)}</div><div class="sg-sub">${esc(it.sub)}</div></div>`;
      d.addEventListener('mousedown', (e) => { e.preventDefault(); navigate(it.url); });
      d.addEventListener('mousemove', () => selectSuggestion(i));
      el.suggestions.appendChild(d);
    });
    const r = $('omnibox').getBoundingClientRect();
    el.suggestions.style.left = r.left + 'px';
    el.suggestions.style.top = r.bottom + 6 + 'px';
    el.suggestions.style.width = r.width + 'px';
    el.suggestions.classList.add('visible');
  }
  function selectSuggestion(i) {
    sgIndex = i;
    [...el.suggestions.children].forEach((c, k) => c.classList.toggle('selected', k === i));
  }

  // ── Find in page ────────────────────────────────────────────────────────────
  function openFind() {
    const t = activeTab();
    if (!t || !t.wv || !t.ready) return;
    el.find.classList.add('visible');
    el.findInput.focus();
    el.findInput.select();
  }
  function closeFind(silent) {
    if (!el.find.classList.contains('visible')) return;
    el.find.classList.remove('visible');
    el.findCount.textContent = '';
    el.findInput.value = '';
    tabs.forEach((t) => { if (t.wv && t.ready) attempt(() => t.wv.stopFindInPage('clearSelection')); });
    if (!silent) { const t = activeTab(); if (t && t.wv) attempt(() => t.wv.focus()); }
  }
  function doFind(forward, next) {
    const t = activeTab();
    const q = el.findInput.value;
    if (!t || !t.wv || !t.ready) return;
    if (!q) { attempt(() => t.wv.stopFindInPage('clearSelection')); el.findCount.textContent = ''; return; }
    const opts = { forward };
    if (next) opts.findNext = true;
    attempt(() => t.wv.findInPage(q, opts));
  }

  // ── Zoom / misc page actions ────────────────────────────────────────────────
  async function zoom(delta) {
    const t = activeTab();
    if (!t || !t.wv || !t.ready) return;
    let level = delta === 0 ? 0 : Number(await Promise.resolve(attempt(() => t.wv.getZoomLevel(), 0))) + delta;
    level = Math.max(-3, Math.min(5, level));
    attempt(() => t.wv.setZoomLevel(level));
    toast(`Zoom ${Math.round(Math.pow(1.2, level) * 100)}%`, { key: 'zoom', timeout: 1200 });
  }

  // ── Permission requests ─────────────────────────────────────────────────────
  const permQueue = [];
  let permCurrent = null;
  function nextPerm() {
    if (permCurrent || !permQueue.length) return;
    permCurrent = permQueue.shift();
    $('perm-text').textContent = `${hostOf(permCurrent.origin)} wants to ${permCurrent.label}`;
    el.perm.classList.remove('hidden');
  }
  function answerPerm(allow) {
    if (!permCurrent) return;
    hz.respondPermission(permCurrent.id, allow);
    permCurrent = null;
    el.perm.classList.add('hidden');
    nextPerm();
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  const BINDINGS = [
    ['s-search-engine', 'searchEngine', 'value'], ['s-home-page', 'homePage', 'value'], ['s-newtab-page', 'newTabPage', 'value'],
    ['s-startup', 'startup', 'value'], ['s-theme', 'theme', 'value'], ['s-font-size', 'fontSize', 'value'],
    ['s-bm-bar', 'showBookmarksBar', 'checked'], ['s-block-trackers', 'blockTrackers', 'checked'],
    ['s-block-ads', 'blockAds', 'checked'], ['s-block-3p', 'blockThirdPartyCookies', 'checked'],
    ['s-js-private', 'jsInPrivate', 'checked'], ['s-auto-update', 'autoUpdate', 'checked'],
  ];
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(h, f) { return '#' + hexToRgb(h).map((c) => Math.max(0, Math.min(255, Math.round(c * f))).toString(16).padStart(2, '0')).join(''); }

  function applySettings() {
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('light', !IS_PRIVATE && !dark);
    document.body.classList.remove('fs-small', 'fs-large');
    if (settings.fontSize === 'small') document.body.classList.add('fs-small');
    if (settings.fontSize === 'large') document.body.classList.add('fs-large');
    const root = document.documentElement.style;
    if (!IS_PRIVATE && /^#[0-9a-f]{6}$/i.test(settings.accentColor || '')) {
      const [r, g, b] = hexToRgb(settings.accentColor);
      root.setProperty('--accent', settings.accentColor);
      root.setProperty('--accent-hover', shade(settings.accentColor, 0.85));
      root.setProperty('--accent-faint', `rgba(${r},${g},${b},0.14)`);
    }
    BINDINGS.forEach(([id, key, prop]) => { const c = $(id); if (c && document.activeElement !== c) c[prop] = settings[key]; });
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color.toLowerCase() === (settings.accentColor || '').toLowerCase()));
    renderBookmarksBar();
    syncPrivJs();
    el.newtab.classList.toggle('blank', settings.newTabPage === 'blank');
    syncTitlebar();
  }
  function syncTitlebar() {
    const cs = getComputedStyle(document.body);
    hz.setTitlebar({ color: cs.getPropertyValue('--bg0').trim(), symbolColor: cs.getPropertyValue('--t1').trim() }).catch(() => {});
  }
  function patchSettings(patch) {
    settings = { ...settings, ...patch };
    applySettings();
    hz.setSettings(patch).catch(() => {});
  }

  // ── Updates (Settings → About) ──────────────────────────────────────────────
  let updInfo = null;
  async function checkUpdates() {
    const btn = $('upd-btn');
    btn.disabled = true;
    $('upd-status').textContent = 'Checking…';
    $('upd-sub').textContent = '';
    updInfo = await hz.checkUpdate();
    btn.disabled = false;
    btn.textContent = 'Check now';
    btn.onclick = checkUpdates;
    if (!updInfo.ok) {
      const msgs = {
        'not-configured': ['Updates aren’t set up yet', 'Set your GitHub repo in package.json to enable updates.'],
        'no-release': ['No releases found', 'Publish a release on GitHub to distribute updates.'],
        offline: ['Couldn’t reach GitHub', 'Check your internet connection.'],
        'rate-limited': ['GitHub is rate-limiting requests', 'Try again in a few minutes.'],
      };
      const m = msgs[updInfo.reason] || ['Couldn’t check for updates', updInfo.message || ''];
      $('upd-status').textContent = m[0];
      $('upd-sub').textContent = m[1];
    } else if (!updInfo.available) {
      $('upd-status').textContent = 'Horizon is up to date';
      $('upd-sub').textContent = `Version ${updInfo.current}`;
    } else {
      $('upd-status').textContent = `Version ${updInfo.latest} is available`;
      $('upd-sub').textContent = updInfo.canInstall ? 'Downloads in the background and restarts Horizon.' : 'Download it from GitHub.';
      btn.textContent = updInfo.canInstall ? 'Update & restart' : 'Open download page';
      btn.onclick = () => {
        if (!updInfo.canInstall) { hz.openExternal(updInfo.pageUrl); return; }
        btn.disabled = true;
        $('upd-progress').classList.remove('hidden');
        $('upd-fill').style.width = '0%';
        hz.installUpdate().catch((e) => {
          btn.disabled = false;
          $('upd-status').textContent = 'Update failed';
          $('upd-sub').textContent = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          $('upd-progress').classList.add('hidden');
        });
      };
    }
  }

  // ── Shortcuts ───────────────────────────────────────────────────────────────
  function runShortcut(name) {
    const t = activeTab();
    switch (name) {
      case 'new-tab': createTab(null, { afterId: activeId }); break;
      case 'close-tab': closeTab(activeId); break;
      case 'reopen-tab': reopenTab(); break;
      case 'new-window': hz.openWindow(); break;
      case 'new-private': hz.openPrivate(); break;
      case 'focus-address': el.url.focus(); el.url.select(); break;
      case 'reload': if (t) { if (t.error) load(t, t.url); else if (t.loading && t.wv) attempt(() => t.wv.stop()); else if (t.wv && t.ready) t.wv.reload(); } break;
      case 'hard-reload': if (t && t.wv && t.ready) attempt(() => t.wv.reloadIgnoringCache()); break;
      case 'bookmark': toggleBookmark(); break;
      case 'find': openFind(); break;
      case 'history': toggleSidebar('history'); break;
      case 'downloads': toggleSidebar('downloads'); break;
      case 'bookmarks': toggleSidebar('bookmarks'); break;
      case 'settings': toggleSidebar('settings'); break;
      case 'zoom-in': zoom(0.5); break;
      case 'zoom-out': zoom(-0.5); break;
      case 'zoom-reset': zoom(0); break;
      case 'next-tab': cycleTab(1); break;
      case 'prev-tab': cycleTab(-1); break;
      case 'back': if (t && t.canBack) attempt(() => t.wv.goBack()); break;
      case 'forward': if (t && t.canFwd) attempt(() => t.wv.goForward()); break;
      case 'home': if (t) navigate(homeUrl(), t); break;
      case 'devtools': if (t && t.wv && t.ready) attempt(() => t.wv.openDevTools()); break;
      case 'print': if (t && t.wv && t.ready) attempt(() => t.wv.print()); break;
      case 'fullscreen': hz.setFullscreen(!winFullscreen); break;
      case 'tab-last': if (tabs.length) activateTab(tabs[tabs.length - 1].id); break;
      case 'escape': onEscape(); break;
      default:
        if (/^tab-[1-8]$/.test(name)) { const i = Number(name.slice(4)) - 1; if (tabs[i]) activateTab(tabs[i].id); }
    }
  }
  function onEscape() {
    if (el.suggestions.classList.contains('visible')) { hideSuggestions(); return; }
    if (el.mainMenu.classList.contains('visible') || el.ctx.classList.contains('visible')) { closeMenus(); return; }
    if (openSidebarName) { closeSidebars(); return; }
    if (el.find.classList.contains('visible')) { closeFind(); return; }
    const t = activeTab();
    if (document.activeElement === el.url) { el.url.value = (t && t.url) || ''; el.url.blur(); if (t && t.wv) attempt(() => t.wv.focus()); return; }
    if (t && t.loading && t.wv) attempt(() => t.wv.stop());
  }

  // ── Session persistence ─────────────────────────────────────────────────────
  let sessionTimer = null;
  function saveSessionSoon() {
    if (IS_PRIVATE) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      const urls = [];
      let active = 0;
      tabs.forEach((t) => { if (isWeb(t.url)) { if (t.id === activeId) active = urls.length; urls.push(t.url); } });
      hz.saveSession({ urls, active }).catch(() => {});
    }, 800);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function wire() {
    el.newTab.addEventListener('click', () => createTab(null, {}));
    el.back.addEventListener('click', () => runShortcut('back'));
    el.fwd.addEventListener('click', () => runShortcut('forward'));
    el.reload.addEventListener('click', () => runShortcut('reload'));
    el.home.addEventListener('click', () => runShortcut('home'));
    el.bmBtn.addEventListener('click', toggleBookmark);
    el.findBtn.addEventListener('click', () => (el.find.classList.contains('visible') ? closeFind() : openFind()));
    el.dlBtn.addEventListener('click', () => toggleSidebar('downloads'));
    el.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMainMenu(); });
    el.overlay.addEventListener('click', closeSidebars);
    document.querySelectorAll('.sidebar-close').forEach((b) => b.addEventListener('click', closeSidebars));
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.menu') && !e.target.closest('#btn-menu')) closeMenus();
      if (!e.target.closest('#suggestions') && e.target !== el.url) hideSuggestions();
    });
    window.addEventListener('blur', closeMenus);
    window.addEventListener('resize', () => { closeMenus(); hideSuggestions(); });

    // Omnibox
    el.url.addEventListener('focus', async () => { el.url.select(); if (!IS_PRIVATE) historyCache = await hz.getHistory(800); });
    el.url.addEventListener('input', updateSuggestions);
    el.url.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && sgItems.length) { e.preventDefault(); selectSuggestion((sgIndex + 1) % sgItems.length); }
      else if (e.key === 'ArrowUp' && sgItems.length) { e.preventDefault(); selectSuggestion((sgIndex - 1 + sgItems.length) % sgItems.length); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = sgIndex >= 0 ? sgItems[sgIndex].url : null;
        navigate(pick || el.url.value, activeTab());
      }
    });

    // New-tab search boxes
    const bindSearch = (input, btn) => {
      const go = () => { const v = input.value.trim(); if (v) { input.value = ''; navigate(v); } };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      btn.addEventListener('click', go);
    };
    bindSearch($('nt-search-input'), $('nt-search-btn'));
    bindSearch($('priv-search-input'), $('priv-search-btn'));
    $('priv-js-toggle').addEventListener('change', (e) => patchSettings({ jsInPrivate: e.target.checked }));

    // Main menu
    const act = (id, fn) => $(id).addEventListener('click', () => { closeMenus(); fn(); });
    act('mm-new-tab', () => runShortcut('new-tab'));
    act('mm-new-private', () => hz.openPrivate());
    act('mm-bookmarks', () => openSidebar('bookmarks'));
    act('mm-history', () => openSidebar('history'));
    act('mm-downloads', () => openSidebar('downloads'));
    act('mm-zoom-in', () => zoom(0.5));
    act('mm-zoom-out', () => zoom(-0.5));
    act('mm-zoom-reset', () => zoom(0));
    act('mm-print', () => runShortcut('print'));
    act('mm-devtools', () => runShortcut('devtools'));
    act('mm-find', openFind);
    act('mm-settings', () => openSidebar('settings'));

    // Find bar
    el.findInput.addEventListener('input', () => doFind(true, false));
    el.findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, true); } });
    el.findNext.addEventListener('click', () => doFind(true, true));
    el.findPrev.addEventListener('click', () => doFind(false, true));
    el.findClose.addEventListener('click', () => closeFind());

    // Sidebars
    $('bm-search').addEventListener('input', renderBookmarksList);
    $('hist-search').addEventListener('input', renderHistoryList);
    $('bm-add-current').addEventListener('click', () => { const t = activeTab(); if (t && !isBookmarked(t.url)) toggleBookmark(); else if (t) toast('Already bookmarked', { key: 'bm' }); renderBookmarksList(); });
    $('hist-clear-all').addEventListener('click', async () => { if (confirm('Clear all browsing history?')) { await hz.clearHistory(); renderHistoryList(); } });
    $('dl-clear-all').addEventListener('click', async () => { await hz.clearDownloads(); downloads = downloads.filter((d) => d.state === 'progressing'); renderDownloads(); });

    // Error page / permissions
    $('err-retry').addEventListener('click', () => { const t = activeTab(); if (t) load(t, t.url); });
    $('perm-allow').addEventListener('click', () => answerPerm(true));
    $('perm-block').addEventListener('click', () => answerPerm(false));

    // Settings
    document.querySelectorAll('.settings-nav-item').forEach((n) => n.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach((x) => x.classList.toggle('active', x === n));
      document.querySelectorAll('.settings-section').forEach((s) => s.classList.toggle('hidden', s.id !== 'sec-' + n.dataset.section));
    }));
    BINDINGS.forEach(([id, key, prop]) => {
      const c = $(id);
      if (!c) return;
      c.addEventListener(prop === 'checked' ? 'change' : (c.tagName === 'INPUT' ? 'change' : 'change'), () => {
        let v = c[prop];
        if (key === 'homePage') { v = String(v).trim() || 'https://www.google.com'; }
        patchSettings({ [key]: v });
      });
    });
    document.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => patchSettings({ accentColor: s.dataset.color })));
    $('swatch-custom-btn').addEventListener('click', () => $('s-accent-custom').click());
    $('s-accent-custom').addEventListener('change', (e) => patchSettings({ accentColor: e.target.value }));
    $('s-clear-all').addEventListener('click', async () => {
      if (!confirm('Clear browsing history, downloads list, cookies, cache and site data?')) return;
      await hz.clearAll();
      historyCache = [];
      downloads = [];
      toast('Browsing data cleared');
    });
    $('upd-btn').addEventListener('click', checkUpdates);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applySettings(); });

    // Keyboard (when the toolbar/UI has focus; page focus is handled in the main process)
    document.addEventListener('keydown', (e) => {
      const name = matchShortcut({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
      if (!name) return;
      if (name === 'escape') { onEscape(); return; }
      // Let text inputs keep native Alt+arrows etc.; everything else is a browser shortcut.
      e.preventDefault();
      runShortcut(name);
    });

    // Events from main
    hz.on('shortcut', runShortcut);
    hz.on('open-tab', ({ url, background }) => {
      const u = resolveInput(url);
      if (u) createTab(u, { activate: !background, afterId: activeId });
    });
    hz.on('settings-updated', (s) => { settings = s; applySettings(); });
    hz.on('bookmarks-updated', (b) => { if (!IS_PRIVATE) { bookmarks = b; afterBookmarksChanged(); } });
    hz.on('fullscreen-changed', (v) => { winFullscreen = !!v; });
    hz.on('permission-request', (p) => { permQueue.push(p); nextPerm(); });
    hz.on('toast', (p) => toast(p.text, p.url ? { action: { label: p.actionLabel || 'Open', fn: () => hz.openExternal(p.url) }, timeout: 9000 } : {}));
    hz.on('download-started', (d) => {
      upsertDownload(d);
      el.dlBtn.classList.remove('pulse'); void el.dlBtn.offsetWidth; el.dlBtn.classList.add('pulse');
      toast(`Downloading ${d.filename}`, { key: 'dl', action: { label: 'View', fn: () => openSidebar('downloads') } });
    });
    hz.on('download-updated', upsertDownload);
    hz.on('download-done', (d) => {
      upsertDownload(d);
      if (d.state === 'completed') toast(`Downloaded ${d.filename}`, { key: 'dl', action: { label: 'Open', fn: () => hz.openPath(d.path) }, timeout: 5000 });
    });
    hz.on('update-progress', (p) => {
      $('upd-progress').classList.remove('hidden');
      if (p.phase === 'installing') { $('upd-status').textContent = 'Installing update…'; $('upd-sub').textContent = 'Horizon will restart in a moment.'; $('upd-fill').style.width = '100%'; return; }
      const pct = p.total ? (p.received / p.total) * 100 : 0;
      $('upd-fill').style.width = pct + '%';
      $('upd-status').textContent = `Downloading update… ${Math.round(pct)}%`;
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  try {
    const init = await hz.init();
    if (!init) throw new Error('Could not initialise the browser window');
    IS_PRIVATE = !!init.isPrivate;
    PARTITION = init.partition;
    settings = init.settings;
    bookmarks = init.bookmarks || [];
    engines = init.searchEngines || {};
    info = init.info || {};
    document.body.classList.toggle('is-private', IS_PRIVATE);

    $('about-version').textContent = info.version || '—';
    $('about-chromium').textContent = info.chromium || '—';
    $('about-electron').textContent = info.electron || '—';

    wire();
    applySettings();
    downloads = IS_PRIVATE ? [] : await hz.getDownloads();
    updateWindowTitle();

    if (init.restore && init.restore.urls.length) {
      init.restore.urls.forEach((u, i) => createTab(u, { activate: false, lazy: i !== init.restore.active }));
      const idx = Math.min(init.restore.active || 0, tabs.length - 1);
      activateTab(tabs[idx].id);
    } else if (init.startUrl) {
      createTab(init.startUrl);
    } else if (!IS_PRIVATE && settings.startup === 'home') {
      createTab(homeUrl());
    } else {
      createTab(null, { blank: true });
    }
    if (init.notice) toast(init.notice.text, { action: { label: init.notice.actionLabel || 'Open', fn: () => hz.openExternal(init.notice.url) }, timeout: 12000 });
  } catch (e) {
    console.error(e);
    document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;z-index:99999;margin:0;padding:24px;background:#111;color:#f88;white-space:pre-wrap">Horizon failed to start:\n${esc(e && e.stack ? e.stack : e)}</pre>`);
  } finally {
    setTimeout(() => el.boot.classList.add('out'), 80);
    setTimeout(() => el.boot.remove(), 500);
  }
})();
