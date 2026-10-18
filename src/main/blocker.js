
'use strict';

const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');

const NEVER_BLOCK = new Set(['localhost', '127.0.0.1', '::1']);
const attachedSessions = new WeakSet();

let enginePromise = null;
let engine = null;

function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

function matchesDomain(host, domain) {
  host = normalizeHost(host);
  domain = normalizeHost(domain);

  return !!host && !!domain &&
    (host === domain || host.endsWith('.' + domain));
}

function matchesAny(host, domains = []) {
  return Array.isArray(domains) &&
    domains.some((domain) =>
      !String(domain).includes('/') && matchesDomain(host, domain)
    );
}

function shouldBlock(rawUrl, settings = {}) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return false;

  const host = normalizeHost(url.hostname);

  if (!host || NEVER_BLOCK.has(host)) return false;
  if (matchesAny(host, settings.allowDomains)) return false;
  if (matchesAny(host, settings.blockDomains)) return true;

  return false;
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = ElectronBlocker
      .fromPrebuiltAdsAndTracking(fetch)
      .then((blocker) => {
        engine = blocker;
        return blocker;
      })
      .catch((error) => {
        enginePromise = null;
        throw error;
      });
  }

  return enginePromise;
}

function attach(ses, getSettings = () => ({})) {
  if (!ses || !ses.webRequest) {
    throw new TypeError('A valid Electron session is required.');
  }

  if (attachedSessions.has(ses)) return;
  attachedSessions.add(ses);

  // Ghostery owns the network-filtering listeners.
  // Do not register competing webRequest listeners here.
  getEngine()
    .then((blocker) => {
      blocker.enableBlockingInSession(ses);
    })
    .catch((error) => {
      console.error('[Horizon] Ghostery adblocker failed to initialize:', error);
    });

  // Cookie/header handling is intentionally separate from webRequest.
  // Electron's webRequest event listeners must not compete with Ghostery.
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    const settings = getSettings() || {};
    if (!settings.blockThirdPartyCookies || removed || !cookie) return;
    // Cookie filtering by first-party site requires request context.
    // Do not delete cookies globally: that would break sign-ins.
  });
}

module.exports = {
  attach,
  shouldBlock,
  matchesDomain,
};
