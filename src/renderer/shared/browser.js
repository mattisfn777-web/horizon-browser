'use strict';

/**
 * Horizon Browser - Core Browser Engine
 * Handles: tabs, navigation, webviews, bookmarks, history, downloads
 */

const api = window.horizonAPI;

// ── State ────────────────────────────────────────────────────────────────────
let tabs = [];
let activeTabId = null;
let nextTabId = 0;
let bookmarks = [];
let settings = {};
const IS_PRIVATE = document.body.dataset.isPrivate === 'true';

// ── DOM Refs ─────────────────────────────────────────────────────────────────
const $tabsList     = document.getElementById('tabs-list');
const $newTabBtn    = document.getElementById('new-tab-btn');
const $webviewContainer = document.getElementById('webview-container');
const $newtabPage   = document.getElementById('newtab-page');
const $addressBar   = document.getElementById('address-bar');
const $btnBack      = document.getElementById('btn-back');
const $btnForward   = document.getElementById('btn-forward');
const $btnReload    = document.getElementById('btn-reload');
const $btnHome      = document.getElementById('btn-home');
const $btnBookmark  = document.getElementById('btn-bookmark');
const $btnPrivate   = document.getElementById('btn-private');
const $btnMenu      = document.getElementById('btn-menu');
const $progressBar  = document.getElementById('progress-bar');
const $progressFill = document.getElementById('progress-fill');
const $securityIcon = document.getElementById('security-icon');
const $statusbar    = document.getElementById('statusbar');
const $statusText   = document.getElementById('statusbar-text');
const $overlay      = document.getElementById('overlay');
const $newtabSearch = document.getElementById('newtab-search');
const $newtabBookmarksGrid = document.getElementById('newtab-bookmarks-grid');
const $newtabHistoryList   = document.getElementById('newtab-history-list');

// Panels
const panels = {
  menu:      document.getElementById('menu-panel'),
  bookmarks: document.getElementById('bookmarks-panel'),
  history:   document.getElementById('history-panel'),
  downloads: document.getElementById('downloads-panel'),
  settings:  document.getElementById('settings-panel'),
};

// ── URL Utils ────────────────────────────────────────────────────────────────
function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return getHomeUrl();

  // Already a full URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  if (/^about:/i.test(trimmed)) return trimmed;

  // Looks like a hostname (contains a dot, no spaces)
  if (!trimmed.includes(' ') && trimmed.includes('.') && !trimmed.startsWith('/')) {
    return 'https://' + trimmed;
  }

  // Treat as a search query
  const engine = settings.searchEngine || 'https://www.google.com/search?q=';
  return engine + encodeURIComponent(trimmed);
}

function getHomeUrl() {
  return settings.homePage || 'about:blank';
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isSecure(url) {
  return url.startsWith('https://') || url.startsWith('about:') || url.startsWith('file://');
}

// ── Tab Management ───────────────────────────────────────────────────────────
function createTab(url = null, activate = true) {
  const id = nextTabId++;
  const tabUrl = url || (IS_PRIVATE ? 'about:blank' : null);

  const tab = {
    id,
    url: tabUrl,
    title: 'New Tab',
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    webviewId: `wv-${id}`,
  };

  tabs.push(tab);
  renderTab(tab);

  // Create webview
  const webview = createWebview(id, tabUrl);
  $webviewContainer.appendChild(webview);

  if (activate) {
    activateTab(id);
  }

  return id;
}

function createWebview(tabId, url) {
  const webview = document.createElement('webview');
  webview.id = `wv-${tabId}`;
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('webpreferences', 'contextIsolation=yes,javascript=' + (IS_PRIVATE ? 'no' : 'yes'));

  if (url && url !== 'newtab') {
    webview.setAttribute('src', url);
  }

  // Events
  webview.addEventListener('page-title-updated', (e) => {
    updateTab(tabId, { title: e.title });
  });

  webview.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons.length > 0) {
      updateTab(tabId, { favicon: e.favicons[0] });
    }
  });

  webview.addEventListener('did-start-loading', () => {
    updateTab(tabId, { loading: true });
    if (isActiveTab(tabId)) {
      showProgress(0.1);
      updateReloadBtn(true);
    }
  });

  webview.addEventListener('did-stop-loading', () => {
    updateTab(tabId, { loading: false });
    if (isActiveTab(tabId)) {
      hideProgress();
      updateReloadBtn(false);
      updateNavButtons();
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    updateTab(tabId, { url: e.url });
    if (isActiveTab(tabId)) {
      setAddressBar(e.url);
      updateSecurityIcon(e.url);
      updateNavButtons();
      updateBookmarkBtn(e.url);
    }
    // Save to history (not in private mode)
    if (!IS_PRIVATE && e.url && e.url !== 'about:blank') {
      const tab = getTab(tabId);
      api.addHistory({ url: e.url, title: tab?.title || e.url });
    }
    showProgress(0.8);
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    updateTab(tabId, { url: e.url });
    if (isActiveTab(tabId)) {
      setAddressBar(e.url);
      updateNavButtons();
      updateBookmarkBtn(e.url);
    }
  });

  webview.addEventListener('did-frame-navigate', (e) => {
    if (e.isMainFrame) {
      showProgress(0.5);
    }
  });

  webview.addEventListener('update-target-url', (e) => {
    if (isActiveTab(tabId)) {
      if (e.url) {
        $statusbar.classList.remove('hidden');
        $statusText.textContent = e.url;
      } else {
        $statusbar.classList.add('hidden');
      }
    }
  });

  webview.addEventListener('new-window', (e) => {
    createTab(e.url, true);
  });

  webview.addEventListener('close', () => {
    closeTab(tabId);
  });

  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || e.errorCode === 0) return; // Aborted / OK
    if (isActiveTab(tabId)) {
      hideProgress();
      updateReloadBtn(false);
    }
  });

  webview.addEventListener('dom-ready', () => {
    if (isActiveTab(tabId)) {
      updateNavButtons();
    }
  });

  // Download handling
  webview.addEventListener('will-download', (e) => {
    // Handled by main process
  });

  return webview;
}

function getWebview(tabId) {
  return document.getElementById(`wv-${tabId}`);
}

function getTab(tabId) {
  return tabs.find(t => t.id === tabId);
}

function isActiveTab(tabId) {
  return tabId === activeTabId;
}

function updateTab(tabId, updates) {
  const tab = getTab(tabId);
  if (!tab) return;
  Object.assign(tab, updates);
  updateTabEl(tab);
}

function activateTab(tabId) {
  activeTabId = tabId;
  const tab = getTab(tabId);
  if (!tab) return;

  // Update tab visuals
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  const tabEl = document.querySelector(`.tab[data-id="${tabId}"]`);
  if (tabEl) tabEl.classList.add('active');

  // Show/hide webviews and new tab page
  document.querySelectorAll('webview').forEach(wv => wv.classList.remove('active'));
  const wv = getWebview(tabId);

  if (!tab.url || tab.url === 'newtab') {
    $newtabPage.classList.remove('hidden');
    if (wv) wv.classList.remove('active');
    $addressBar.value = '';
    updateNavButtons(false, false);
    hideProgress();
    updateSecurityIcon('');
    updateBookmarkBtn('');
    loadNewtabData();
  } else {
    $newtabPage.classList.add('hidden');
    if (wv) wv.classList.add('active');
    setAddressBar(tab.url);
    updateSecurityIcon(tab.url);
    updateBookmarkBtn(tab.url);
  }

  updateNavButtons();
  updateReloadBtn(tab.loading);
}

function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  // Remove webview
  const wv = getWebview(tabId);
  if (wv) wv.remove();

  // Remove tab element
  const tabEl = document.querySelector(`.tab[data-id="${tabId}"]`);
  if (tabEl) tabEl.remove();

  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    // Close window or open new tab
    window.horizonAPI.close();
    return;
  }

  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    activateTab(tabs[newIdx].id);
  }
}

function renderTab(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = tab.id;
  el.title = tab.title;

  el.innerHTML = `
    <span class="tab-favicon-placeholder">
      <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
    </span>
    <span class="tab-title">${escHtml(tab.title)}</span>
    <button class="tab-close" title="Close tab">
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
  `;

  el.addEventListener('click', (e) => {
    if (!e.target.closest('.tab-close')) {
      activateTab(tab.id);
    }
  });

  el.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  $tabsList.appendChild(el);
}

function updateTabEl(tab) {
  const el = document.querySelector(`.tab[data-id="${tab.id}"]`);
  if (!el) return;

  el.title = tab.title;

  // Title
  const titleEl = el.querySelector('.tab-title');
  if (titleEl) titleEl.textContent = tab.title || 'Loading…';

  // Favicon / spinner
  const faviconWrapper = el.querySelector('.tab-favicon-placeholder');
  if (faviconWrapper) {
    if (tab.loading) {
      faviconWrapper.innerHTML = '<div class="tab-loading"></div>';
    } else if (tab.favicon) {
      faviconWrapper.innerHTML = `<img class="tab-favicon" src="${escHtml(tab.favicon)}" alt="">`;
    } else {
      faviconWrapper.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
    }
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────
function navigate(url, tabId = activeTabId) {
  const normalized = normalizeUrl(url);
  const wv = getWebview(tabId);

  updateTab(tabId, { url: normalized, title: 'Loading…' });

  if (!wv) return;

  if (!normalized || normalized === 'newtab') {
    activateTab(tabId);
    return;
  }

  $newtabPage.classList.add('hidden');
  wv.classList.add('active');
  wv.src = normalized;
}

function setAddressBar(url) {
  if (url === 'about:blank' || !url) {
    $addressBar.value = '';
    return;
  }
  // Show clean URL (without about:, data:, etc. noise)
  $addressBar.value = url;
}

function updateNavButtons(canBack, canFwd) {
  const wv = getWebview(activeTabId);
  if (wv) {
    $btnBack.disabled    = typeof canBack !== 'undefined' ? !canBack : !wv.canGoBack();
    $btnForward.disabled = typeof canFwd !== 'undefined'  ? !canFwd  : !wv.canGoForward();
  } else {
    $btnBack.disabled    = true;
    $btnForward.disabled = true;
  }
}

function updateReloadBtn(isLoading) {
  if (isLoading) {
    $btnReload.title = 'Stop (Escape)';
    $btnReload.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  } else {
    $btnReload.title = 'Reload (Ctrl+R)';
    $btnReload.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 9 2.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M9 1v3h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
  }
}

function updateSecurityIcon(url) {
  if (!url || url === 'about:blank') {
    $securityIcon.innerHTML = '';
    return;
  }
  if (isSecure(url)) {
    $securityIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" title="Secure"><rect x="2" y="5" width="8" height="6" rx="1" fill="none" stroke="#4caf50" stroke-width="1.2"/><path d="M4 5V4a2 2 0 0 1 4 0v1" stroke="#4caf50" stroke-width="1.2" fill="none"/></svg>`;
    $securityIcon.title = 'Secure connection';
  } else {
    $securityIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5" width="8" height="6" rx="1" fill="none" stroke="#f39c12" stroke-width="1.2"/><path d="M4 5V4a2 2 0 0 1 4 0v1" stroke="#f39c12" stroke-width="1.2" fill="none"/><line x1="6" y1="5" x2="4" y2="3" stroke="#f39c12" stroke-width="1.2"/></svg>`;
    $securityIcon.title = 'Not secure';
  }
}

// ── Progress bar ─────────────────────────────────────────────────────────────
let progressTimer = null;

function showProgress(amount) {
  $progressFill.style.width = (amount * 100) + '%';
  $progressBar.style.opacity = '1';
  clearTimeout(progressTimer);
}

function hideProgress() {
  $progressFill.style.width = '100%';
  progressTimer = setTimeout(() => {
    $progressBar.style.opacity = '0';
    setTimeout(() => {
      $progressFill.style.width = '0%';
      $progressBar.style.opacity = '1';
    }, 200);
  }, 200);
}

// ── Bookmarks ────────────────────────────────────────────────────────────────
async function loadBookmarks() {
  bookmarks = await api.getBookmarks();
}

async function saveBookmarks() {
  await api.setBookmarks(bookmarks);
}

function isBookmarked(url) {
  return bookmarks.some(b => b.url === url);
}

async function toggleBookmark(url, title) {
  if (!url || url === 'about:blank') return;
  const idx = bookmarks.findIndex(b => b.url === url);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
  } else {
    bookmarks.unshift({ url, title: title || url, time: Date.now() });
  }
  await saveBookmarks();
  updateBookmarkBtn(url);
  renderBookmarksList();
}

function updateBookmarkBtn(url) {
  if (isBookmarked(url)) {
    $btnBookmark.classList.add('bookmarked');
    $btnBookmark.title = 'Remove bookmark';
  } else {
    $btnBookmark.classList.remove('bookmarked');
    $btnBookmark.title = 'Bookmark this page';
  }
}

function renderBookmarksList() {
  const container = document.getElementById('bookmarks-list');
  if (!container) return;

  if (bookmarks.length === 0) {
    container.innerHTML = '<div class="empty-state">No bookmarks yet</div>';
    return;
  }

  container.innerHTML = '';
  bookmarks.forEach(b => {
    const el = document.createElement('div');
    el.className = 'panel-list-item';
    el.innerHTML = `
      <span class="panel-list-title">${escHtml(b.title || b.url)}</span>
      <span class="panel-list-sub">${escHtml(getDomain(b.url))}</span>
      <button class="del-btn" title="Remove">×</button>
    `;
    el.querySelector('.panel-list-title').addEventListener('click', () => {
      navigate(b.url);
      closePanel('bookmarks');
    });
    el.querySelector('.del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      bookmarks = bookmarks.filter(x => x.url !== b.url);
      await saveBookmarks();
      renderBookmarksList();
    });
    container.appendChild(el);
  });
}

// ── History ───────────────────────────────────────────────────────────────────
async function renderHistoryList() {
  const history = await api.getHistory();
  const container = document.getElementById('history-list');
  if (!container) return;

  if (!history || history.length === 0) {
    container.innerHTML = '<div class="empty-state">No history yet</div>';
    return;
  }

  container.innerHTML = '';
  history.slice(0, 100).forEach(h => {
    const el = document.createElement('div');
    el.className = 'panel-list-item';
    const t = new Date(h.time);
    const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="panel-list-title">${escHtml(h.title || h.url)}</span>
      <span class="panel-list-sub">${timeStr}</span>
      <button class="del-btn" title="Remove">×</button>
    `;
    el.querySelector('.panel-list-title').addEventListener('click', () => {
      navigate(h.url);
      closePanel('history');
    });
    container.appendChild(el);
  });
}

// ── Downloads ─────────────────────────────────────────────────────────────────
async function renderDownloadsList() {
  const downloads = await api.getDownloads();
  const container = document.getElementById('downloads-list');
  if (!container) return;

  if (!downloads || downloads.length === 0) {
    container.innerHTML = '<div class="empty-state">No downloads yet</div>';
    return;
  }

  container.innerHTML = '';
  downloads.slice(0, 50).forEach(d => {
    const el = document.createElement('div');
    el.className = 'panel-list-item';
    el.innerHTML = `
      <span class="panel-list-title">${escHtml(d.filename || 'File')}</span>
      <span class="panel-list-sub">${d.state || ''}</span>
    `;
    container.appendChild(el);
  });
}

// ── New Tab Data ──────────────────────────────────────────────────────────────
async function loadNewtabData() {
  // Bookmarks grid
  if ($newtabBookmarksGrid) {
    if (bookmarks.length === 0) {
      $newtabBookmarksGrid.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Add bookmarks to see them here</div>';
    } else {
      $newtabBookmarksGrid.innerHTML = '';
      bookmarks.slice(0, 12).forEach(b => {
        const tile = document.createElement('div');
        tile.className = 'bookmark-tile';
        const domain = getDomain(b.url);
        tile.innerHTML = `
          <img class="bookmark-tile-icon"
               src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32"
               onerror="this.style.display='none'"
               alt="">
          <span class="bookmark-tile-name">${escHtml(b.title || domain)}</span>
        `;
        tile.addEventListener('click', () => navigate(b.url));
        $newtabBookmarksGrid.appendChild(tile);
      });
    }
  }

  // Recent history
  if ($newtabHistoryList && !IS_PRIVATE) {
    const history = await api.getHistory();
    if (!history || history.length === 0) {
      $newtabHistoryList.innerHTML = '';
      return;
    }
    $newtabHistoryList.innerHTML = '';
    history.slice(0, 6).forEach(h => {
      const el = document.createElement('div');
      el.className = 'history-item';
      const t = new Date(h.time);
      el.innerHTML = `
        <span class="history-item-title">${escHtml(h.title || h.url)}</span>
        <span class="history-item-domain">${escHtml(getDomain(h.url))}</span>
        <span class="history-item-time">${t.toLocaleDateString()}</span>
      `;
      el.addEventListener('click', () => navigate(h.url));
      $newtabHistoryList.appendChild(el);
    });
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  settings = await api.getSettings();
  const sel = document.getElementById('search-engine-select');
  const homeInput = document.getElementById('home-page-input');
  if (sel) sel.value = settings.searchEngine || 'https://www.google.com/search?q=';
  if (homeInput) homeInput.value = settings.homePage || 'https://www.google.com';
}

async function saveSettings() {
  const sel = document.getElementById('search-engine-select');
  const homeInput = document.getElementById('home-page-input');
  const newSettings = {};
  if (sel) newSettings.searchEngine = sel.value;
  if (homeInput) newSettings.homePage = homeInput.value;
  settings = { ...settings, ...newSettings };
  await api.setSettings(settings);
}

// ── Panel Management ──────────────────────────────────────────────────────────
let openPanel = null;

function togglePanel(name) {
  if (openPanel === name) {
    closePanel(name);
  } else {
    openPanelFn(name);
  }
}

function openPanelFn(name) {
  // Close any open panel
  if (openPanel) {
    panels[openPanel]?.classList.add('hidden');
  }

  // Load panel data
  if (name === 'bookmarks') renderBookmarksList();
  if (name === 'history') renderHistoryList();
  if (name === 'downloads') renderDownloadsList();
  if (name === 'settings') { loadSettings(); }

  panels[name]?.classList.remove('hidden');
  $overlay.classList.remove('hidden');
  openPanel = name;
}

function closePanel(name) {
  panels[name]?.classList.add('hidden');
  $overlay.classList.add('hidden');
  openPanel = null;
}

function closeAllPanels() {
  Object.keys(panels).forEach(k => panels[k]?.classList.add('hidden'));
  $overlay.classList.add('hidden');
  openPanel = null;
}

// ── Event Listeners ───────────────────────────────────────────────────────────
// Window controls
document.getElementById('btn-minimize')?.addEventListener('click', () => api.minimize());
document.getElementById('btn-maximize')?.addEventListener('click', () => api.maximize());
document.getElementById('btn-close')?.addEventListener('click', () => api.close());

// Navigation
$btnBack?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  if (wv?.canGoBack()) wv.goBack();
});

$btnForward?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  if (wv?.canGoForward()) wv.goForward();
});

$btnReload?.addEventListener('click', () => {
  const tab = getTab(activeTabId);
  const wv = getWebview(activeTabId);
  if (!wv) return;
  if (tab?.loading) {
    wv.stop();
  } else {
    wv.reload();
  }
});

$btnHome?.addEventListener('click', () => {
  navigate(getHomeUrl());
});

$btnBookmark?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  const tab = getTab(activeTabId);
  if (!tab?.url) return;
  toggleBookmark(tab.url, tab.title || wv?.getTitle?.() || tab.url);
});

$btnPrivate?.addEventListener('click', () => {
  api.openPrivateWindow();
});

$btnMenu?.addEventListener('click', () => {
  togglePanel('menu');
});

// Address bar
$addressBar?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = $addressBar.value.trim();
    if (val) navigate(val);
  } else if (e.key === 'Escape') {
    const tab = getTab(activeTabId);
    $addressBar.value = tab?.url || '';
    $addressBar.blur();
  }
});

$addressBar?.addEventListener('focus', () => {
  $addressBar.select();
});

// New tab
$newTabBtn?.addEventListener('click', () => {
  createTab('newtab', true);
});

// New tab search
$newtabSearch?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = $newtabSearch.value.trim();
    if (val) {
      navigate(normalizeUrl(val));
      $newtabSearch.value = '';
    }
  }
});

document.getElementById('newtab-search-btn')?.addEventListener('click', () => {
  const val = $newtabSearch?.value.trim();
  if (val) navigate(normalizeUrl(val));
});

// Menu panel actions
document.getElementById('pm-new-tab')?.addEventListener('click', () => {
  closeAllPanels();
  createTab('newtab', true);
});

document.getElementById('pm-new-private')?.addEventListener('click', () => {
  closeAllPanels();
  api.openPrivateWindow();
});

document.getElementById('pm-bookmarks')?.addEventListener('click', () => {
  closeAllPanels();
  togglePanel('bookmarks');
});

document.getElementById('pm-history')?.addEventListener('click', () => {
  closeAllPanels();
  togglePanel('history');
});

document.getElementById('pm-downloads')?.addEventListener('click', () => {
  closeAllPanels();
  togglePanel('downloads');
});

document.getElementById('pm-settings')?.addEventListener('click', () => {
  closeAllPanels();
  togglePanel('settings');
});

document.getElementById('pm-zoom-in')?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  if (wv) wv.setZoomFactor((wv.getZoomFactor() || 1) + 0.1);
});

document.getElementById('pm-zoom-out')?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  if (wv) wv.setZoomFactor(Math.max(0.5, (wv.getZoomFactor() || 1) - 0.1));
});

document.getElementById('pm-zoom-reset')?.addEventListener('click', () => {
  const wv = getWebview(activeTabId);
  if (wv) wv.setZoomFactor(1);
});

// Clear history
document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
  await api.clearHistory();
  renderHistoryList();
});

// Clear data
document.getElementById('btn-clear-data')?.addEventListener('click', async () => {
  await api.clearSessionData();
  await api.clearHistory();
  alert('Browsing data cleared.');
});

// Panel close buttons
document.querySelectorAll('.panel-close').forEach(btn => {
  btn.addEventListener('click', () => closeAllPanels());
});

// Settings save on change
document.getElementById('search-engine-select')?.addEventListener('change', saveSettings);
document.getElementById('home-page-input')?.addEventListener('change', saveSettings);

// Overlay click = close panels
$overlay?.addEventListener('click', closeAllPanels);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    api.openPrivateWindow();
    return;
  }

  if (ctrl && e.key === 't') {
    e.preventDefault();
    createTab('newtab', true);
    return;
  }

  if (ctrl && e.key === 'w') {
    e.preventDefault();
    closeTab(activeTabId);
    return;
  }

  if (ctrl && e.key === 'r') {
    e.preventDefault();
    const wv = getWebview(activeTabId);
    wv?.reload();
    return;
  }

  if (ctrl && e.key === 'l') {
    e.preventDefault();
    $addressBar?.focus();
    $addressBar?.select();
    return;
  }

  if (ctrl && e.key === 'd') {
    e.preventDefault();
    $btnBookmark?.click();
    return;
  }

  if (e.key === 'F5') {
    const wv = getWebview(activeTabId);
    wv?.reload();
    return;
  }

  if (e.key === 'Escape') {
    if (openPanel) {
      closeAllPanels();
    } else {
      const tab = getTab(activeTabId);
      const wv = getWebview(activeTabId);
      if (tab?.loading) wv?.stop();
    }
    return;
  }

  // Alt+Left/Right for back/forward
  if (e.altKey && e.key === 'ArrowLeft') {
    const wv = getWebview(activeTabId);
    if (wv?.canGoBack()) wv.goBack();
    return;
  }

  if (e.altKey && e.key === 'ArrowRight') {
    const wv = getWebview(activeTabId);
    if (wv?.canGoForward()) wv.goForward();
    return;
  }

  // Ctrl+1-9: switch tabs
  if (ctrl && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (idx < tabs.length) {
      activateTab(tabs[idx].id);
    }
    return;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  await loadBookmarks();

  // Open first tab
  if (IS_PRIVATE) {
    createTab('about:blank', true);
  } else {
    createTab('newtab', true);
  }
}

init().catch(console.error);
