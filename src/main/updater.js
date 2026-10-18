'use strict';
/**
 * GitHub Releases updater.
 *
 * Looks at https://github.com/<owner>/<repo>/releases/latest, compares the tag with the running
 * version, downloads the "Horizon-Setup-x.y.z.exe" asset, verifies it (size + SHA-256 when GitHub
 * provides a digest) and runs it silently. The installer then relaunches Horizon.
 *
 * Configure owner/repo in package.json -> "horizon": { "githubOwner", "githubRepo" }.
 */
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const pkg = require('../../package.json');
const cfg = pkg.horizon || {};
const OWNER = String(cfg.githubOwner || '');
const REPO = String(cfg.githubRepo || '');
const UA = `Horizon-Updater/${app.getVersion()}`;

// Test hook (ignored in packaged builds): point the updater at a local mock server.
const TEST_API = !app.isPackaged ? process.env.HORIZON_UPDATE_API : '';
const TEST_DRYRUN = !app.isPackaged && process.env.HORIZON_UPDATE_DRYRUN === '1';

function isConfigured() {
  if (TEST_API) return true;
  return /^[\w.-]+$/.test(OWNER) && /^[\w.-]+$/.test(REPO) && !/^YOUR[_-]/i.test(OWNER) && !/^YOUR[_-]/i.test(REPO);
}

/** True when this build can download and run the installer itself. */
function canInstall(info) {
  if (!info || !info.ok || !info.available || !info.asset || isPortable()) return false;
  return TEST_DRYRUN || (app.isPackaged && process.platform === 'win32');
}

function isPortable() { return !!process.env.PORTABLE_EXECUTABLE_FILE; }
function releasesPage() { return `https://github.com/${OWNER}/${REPO}/releases/latest`; }
function tempDir() { return path.join(app.getPath('temp'), 'horizon-update'); }

function parse(v) {
  return String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
}
function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchT(url, ms, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await net.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...headers } });
  } finally {
    clearTimeout(timer);
  }
}

/** Ask GitHub for the latest release. Never throws. */
async function check() {
  const current = app.getVersion();
  if (!isConfigured()) return { ok: false, reason: 'not-configured', current };
  const url = TEST_API || `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
  try {
    const res = await fetchT(url, 8000, { Accept: 'application/vnd.github+json' });
    if (res.status === 404) return { ok: false, reason: 'no-release', current };
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate-limited', current };
    if (!res.ok) return { ok: false, reason: 'error', message: `HTTP ${res.status}`, current };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+(\.\d+)?/.test(latest)) return { ok: false, reason: 'error', message: 'Bad release tag', current };
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const a = assets.find((x) => /^Horizon-Setup-.*\.exe$/i.test(x.name)) || assets.find((x) => /setup.*\.exe$/i.test(x.name));
    return {
      ok: true,
      current,
      latest,
      available: compare(latest, current) > 0,
      asset: a ? { name: path.basename(String(a.name)), url: String(a.browser_download_url), size: Number(a.size) || 0, digest: a.digest || '' } : null,
      notes: String(rel.body || '').slice(0, 2000),
      pageUrl: String(rel.html_url || releasesPage()),
    };
  } catch (e) {
    return { ok: false, reason: 'offline', message: e.message, current };
  }
}

function assertTrustedUrl(u) {
  if (TEST_API) return;
  const url = new URL(u);
  const prefix = `/${OWNER}/${REPO}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(prefix)) {
    throw new Error('Refusing to download from an untrusted location');
  }
}

/** Download the installer, reporting progress. Returns the file path. */
async function download(info, onProgress) {
  if (!info || !info.asset) throw new Error('No installer attached to this release');
  assertTrustedUrl(info.asset.url);
  fs.rmSync(tempDir(), { recursive: true, force: true });
  fs.mkdirSync(tempDir(), { recursive: true });
  const file = path.join(tempDir(), info.asset.name);

  const res = await fetchT(info.asset.url, 30000, {});
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.asset.size || 0;

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;
  let lastTick = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      received += value.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 80) { lastTick = now; onProgress(received, total); }
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (onProgress) onProgress(received, total || received);

  if (info.asset.size && received !== info.asset.size) throw new Error('Downloaded file is incomplete');
  const m = /^sha256:([0-9a-f]{64})$/i.exec(info.asset.digest || '');
  if (m && hash.digest('hex') !== m[1].toLowerCase()) throw new Error('Checksum mismatch — update discarded');
  return file;
}

/** Run the downloaded installer silently; it relaunches Horizon when finished. */
function install(file) {
  if (TEST_DRYRUN) { console.log('[updater] dry run, would install', file); return; }
  if (process.platform !== 'win32') throw new Error('Automatic install is only supported on Windows');
  const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function cleanup() { try { fs.rmSync(tempDir(), { recursive: true, force: true }); } catch { /* ignore */ } }

module.exports = { canInstall, check, download, install, cleanup, isConfigured, isPortable, releasesPage, compare };
