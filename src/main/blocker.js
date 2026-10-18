
'use strict';

/**
 * Advanced Electron request blocker.
 *
 * Compatible with the original attach(session, getSettings) interface.
 *
 * Optional settings:
 * {
 *   blockAds: true,
 *   blockTrackers: true,
 *   blockThirdPartyCookies: true,
 *   blockPopups: true,
 *   blockAnnoyances: true,
 *   blockSocialTrackers: true,
 *   allowDomains: [],
 *   blockDomains: []
 * }
 *
 * Note:
 * This module blocks network requests. Cosmetic filtering requires
 * separate page-side logic or a full filter-list engine.
 */

const ADS = new Set([
  // Google advertising
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'googletagservices.com',
  'googleads.g.doubleclick.net',
  'pagead2.googlesyndication.com',
  'tpc.googlesyndication.com',
  '2mdn.net',
  'admob.com',
  'adsense.com',
  'adsensecustomsearchads.com',

  // Major advertising exchanges
  'adnxs.com',
  'appnexus.com',
  'criteo.com',
  'criteo.net',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'openx.com',
  'casalemedia.com',
  'indexexchange.com',
  'advertising.com',
  'adform.net',
  'smartadserver.com',
  'yieldmo.com',
  'sharethrough.com',
  'bidswitch.net',
  '3lift.com',
  'teads.tv',
  'adsrvr.org',
  'moatads.com',
  'quantcast.com',
  'lijit.com',
  ' Sovrn.com'.trim().toLowerCase(),
  'undertone.com',
  '33across.com',
  'triplelift.com',
  'media.net',
  'outbrain.com',
  'taboola.com',
  'revcontent.com',
  'mgid.com',
  'adblade.com',
  'zedo.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'exoclick.com',
  'trafficjunky.net',
  'hilltopads.com',
  'adsterra.com',

  // Amazon and retail ads
  'amazon-adsystem.com',
  'assoc-amazon.com',
  'advertising.amazon.com',
  'ads-api.amazon.com',

  // Social advertising
  'ads-twitter.com',
  'ads.twitter.com',
  'static.ads-twitter.com',
  'ads.linkedin.com',
  'ads.pinterest.com',
  'snapads.com',
  'sc-static.net',
  'an.facebook.com',
  'pixel.facebook.com',
  'connect.facebook.net',

  // Other ad providers
  'yahoo.com/ads',
  'ads.yahoo.com',
  'adroll.com',
  'rlcdn.com',
  'bluekai.com',
  'demdex.net',
  'everesttech.net',
  'contextweb.com',
  'adcolony.com',
  'unityads.unity3d.com',
  'inmobi.com',
  'applovin.com',
  'ironsrc.com',
  'vungle.com',
  'chartboost.com',
  'mintegral.com',
  'fyber.com',
  'smartadserver.com',
]);

const TRACKERS = new Set([
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'stats.g.doubleclick.net',
  'hotjar.com',
  'hotjar.io',
  'mouseflow.com',
  'fullstory.com',
  'clarity.ms',
  'crazyegg.com',
  'kissmetrics.com',
  'scorecardresearch.com',
  'quantserve.com',
  'comscore.com',
  'mixpanel.com',
  'mxpnl.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'newrelic.com',
  'nr-data.net',
  'optimizely.com',
  'chartbeat.com',
  'chartbeat.net',
  'bat.bing.com',
  'mc.yandex.ru',
  'mc.yandex.com',
  'intercom.io',
  'intercomcdn.com',
  'demdex.net',
  'bluekai.com',
  'krxd.net',
  'rlcdn.com',
  'agkn.com',
  'tapad.com',
  'everesttech.net',
  'hs-analytics.net',
  'js.hs-analytics.net',
  'loggly.com',
  'segment.com',
  'segment.io',
  'sentry.io',
  'bugsnag.com',
  'rollbar.com',
  'datadoghq.com',
  'heapanalytics.com',
  'posthog.com',
  'plausible.io',
  'rudderstack.com',
  'snowplow.io',
  'tealiumiq.com',
  'ensighten.com',
  'mousestats.com',
  'luckyorange.com',
  'inspectlet.com',
  'visualwebsiteoptimizer.com',
  'vwo.com',
  'branch.io',
  'adjust.com',
  'appsflyer.com',
  'kochava.com',
  'airbridge.io',
  'firebaseinstallations.googleapis.com',
]);

const ANNOYANCES = new Set([
  'onetrust.com',
  'cookielaw.org',
  'quantcast.mgr.consensu.org',
]);

// Hosts that must never be blocked by the built-in lists.
const NEVER_BLOCK = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

const VALID_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'stylesheet',
  'subFrame',
  'object',
  'ping',
  'cspReport',
  'other',
]);

function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

function getHostname(rawUrl) {
  try {
    return normalizeHost(new URL(rawUrl).hostname);
  } catch {
    return '';
  }
}

function matchesDomain(host, domain) {
  host = normalizeHost(host);
  domain = normalizeHost(domain);

  if (!host || !domain) return false;

  // Exact host or a real subdomain boundary.
  return host === domain || host.endsWith('.' + domain);
}

function matchesAny(host, domains) {
  for (const domain of domains) {
    // URL path entries are intentionally not treated as hostnames.
    if (String(domain).includes('/')) continue;
    if (matchesDomain(host, domain)) return true;
  }

  return false;
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

  // User allowlist takes priority over built-in filters.
  if (matchesAny(host, settings.allowDomains || [])) return false;

  // Explicit blocklist takes priority over ordinary category switches.
  if (matchesAny(host, settings.blockDomains || [])) return true;

  if (settings.blockAds !== false && matchesAny(host, ADS)) {
    return true;
  }

  if (settings.blockTrackers !== false && matchesAny(host, TRACKERS)) {
    return true;
  }

  if (settings.blockAnnoyances && matchesAny(host, ANNOYANCES)) {
    return true;
  }

  return false;
}

function getTopUrl(details) {
  try {
    const wc = details.webContents;

    if (!wc || wc.isDestroyed()) return '';
    return wc.getURL() || '';
  } catch {
    return '';
  }
}

function isThirdParty(requestUrl, topUrl) {
  try {
    const request = new URL(requestUrl);
    const top = new URL(topUrl);

    if (!['http:', 'https:'].includes(request.protocol)) return false;
    if (!['http:', 'https:'].includes(top.protocol)) return false;

    // Conservative fallback: host comparison avoids the unsafe
    // assumption that the final two labels always identify a site.
    // For production, use a Public Suffix List implementation.
    return normalizeHost(request.hostname) !== normalizeHost(top.hostname);
  } catch {
    return false;
  }
}

function attach(ses, getSettings = () => ({})) {
  if (!ses || !ses.webRequest) {
    throw new TypeError('A valid Electron session is required.');
  }

  // Electron permits only one listener per webRequest event per session.
  // Install this module centrally and do not overwrite these listeners elsewhere.

  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const settings = getSettings() || {};
        const mainFrame = details.resourceType === 'mainFrame';

        // Never block the user's direct navigation to a domain.
        if (mainFrame) return callback({});

        // Optional per-domain exceptions and explicit user rules apply
        // to subresources as well as scripts, images and frames.
        const blocked = shouldBlock(details.url, settings);

        if (blocked) {
          return callback({ cancel: true });
        }

        // Do not block normal site content merely because it is an
        // image, script or stylesheet.
        if (
          settings.blockResourceTypes &&
          Array.isArray(settings.blockResourceTypes) &&
          settings.blockResourceTypes.includes(details.resourceType) &&
          VALID_RESOURCE_TYPES.has(details.resourceType)
        ) {
          return callback({ cancel: true });
        }

        callback({});
      } catch (error) {
        // Fail open rather than breaking all web navigation.
        callback({});
      }
    }
  );

  ses.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const settings = getSettings() || {};
        const headers = { ...(details.requestHeaders || {}) };

        // Remove identifying client header case-insensitively.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'x-client-data') {
            delete headers[key];
          }
        }

        if (settings.sendDNT !== false) {
          headers.DNT = '1';
          headers['Sec-GPC'] = '1';
        }

        if (
          settings.blockThirdPartyCookies &&
          details.resourceType !== 'mainFrame'
        ) {
          const topUrl = getTopUrl(details);

          if (topUrl && isThirdParty(details.url, topUrl)) {
            for (const key of Object.keys(headers)) {
              if (key.toLowerCase() === 'cookie') {
                delete headers[key];
              }
            }
          }
        }

        callback({ requestHeaders: headers });
      } catch {
        callback({});
      }
    }
  );

  ses.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const settings = getSettings() || {};

        if (
          !settings.blockThirdPartyCookies ||
          details.resourceType === 'mainFrame' ||
          !details.responseHeaders
        ) {
          return callback({});
        }

        const topUrl = getTopUrl(details);

        if (!topUrl || !isThirdParty(details.url, topUrl)) {
          return callback({});
        }

        const headers = { ...details.responseHeaders };

        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'set-cookie') {
            delete headers[key];
          }
        }

        callback({ responseHeaders: headers });
      } catch {
        callback({});
      }
    }
  );
}

module.exports = {
  attach,
  shouldBlock,
  isThirdParty,
  matchesDomain,
};
