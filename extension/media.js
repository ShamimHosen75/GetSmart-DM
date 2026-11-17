// Media detection for the popup's "This page" tab (M6). Runs in the service worker.
//
// Watches response headers (read-only webRequest) and keeps video/audio
// responses per tab in chrome.storage.session (max 25), cleared when the tab
// navigates to a new page. HLS/DASH playlists and segments, XHR partial (206)
// responses, small files, YouTube, DRM services and the user's disabled sites
// are skipped. The count shows as a green badge on that tab.

import { cachedSettings, categoryOf, fileExtension, nameFromUrl, sanitizeFilename } from './common.js';
import { hostMatches, hostOf, isDrmSite, isYouTube, videoSiteStatus } from './sites.js';
import { setLanguage, t } from './i18n.js';

export const MAX_PER_TAB = 25;
const MEDIA_BADGE_COLOR = '#22b783';
const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'];

const SEGMENT_EXT = new Set(['ts', 'm4s', 'm3u8', 'mpd', 'm4f', 'cmfv', 'cmfa']);
const SEGMENT_MIME = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/dash+xml',
  'video/mp2t',
  'video/iso.segment',
  'audio/iso.segment',
]);
const OCTET_MIME = new Set(['application/octet-stream', 'binary/octet-stream', 'application/force-download', 'application/x-download', '']);

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-flv': 'flv',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const storageKey = (tabId) => `media:${tabId}`;

// ---------- Header helpers (exported for tests) ----------

/** File name from a Content-Disposition header: filename* (RFC 5987) first, then filename. */
export function filenameFromDisposition(header) {
  if (!header) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (plain) return (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
  return '';
}

function isMediaName(name) {
  const category = categoryOf(name);
  return (category === 'video' || category === 'music') && !SEGMENT_EXT.has(fileExtension(name));
}

/** Total size from Content-Range ("bytes 0-99/1234") or Content-Length; -1 if unknown. */
export function sizeFromHeaders(headers, statusCode) {
  const range = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
  if (range) return Number(range[1]);
  if (statusCode === 200 && /^\d+$/.test(headers['content-length'] || '')) return Number(headers['content-length']);
  return -1;
}

/**
 * Decide whether a response is a downloadable media file. Returns
 * { mime, size, dispositionName } or null. Pure function, exported for tests.
 */
export function classifyResponse({ url, type, statusCode, headers }) {
  if (statusCode < 200 || statusCode >= 300) return null;
  if (type === 'xmlhttprequest' && statusCode === 206) return null;

  const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (SEGMENT_MIME.has(mime)) return null;
  const urlName = nameFromUrl(url);
  if (SEGMENT_EXT.has(fileExtension(urlName))) return null;

  const dispositionName = filenameFromDisposition(headers['content-disposition']);
  if (dispositionName && SEGMENT_EXT.has(fileExtension(dispositionName))) return null;

  const isMediaMime = mime.startsWith('video/') || mime.startsWith('audio/');
  const isOctetMedia = OCTET_MIME.has(mime) && isMediaName(dispositionName || urlName);
  if (!isMediaMime && !isOctetMedia) return null;

  return { mime, size: sizeFromHeaders(headers, statusCode), dispositionName };
}

/** Name to save a detected file as. */
export function chooseName({ dispositionName, url, mime, pageTitle }) {
  if (dispositionName) return sanitizeFilename(dispositionName);
  const urlName = nameFromUrl(url);
  if (fileExtension(urlName) && isMediaName(urlName)) return sanitizeFilename(urlName);
  const ext = MIME_EXT[mime] || (mime.startsWith('audio/') ? 'mp3' : 'mp4');
  return sanitizeFilename(`${pageTitle || urlName || 'media'}.${ext}`);
}

// ---------- Per-tab storage ----------

let chain = Promise.resolve();
function locked(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

export async function getTabMedia(tabId) {
  const key = storageKey(tabId);
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  return list;
}

async function setBadge(tabId, count) {
  try {
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: MEDIA_BADGE_COLOR });
      await chrome.action.setBadgeText({ tabId, text: String(count) });
    } else {
      // null clears the tab's own value, so the global badge (active downloads) shows again.
      await chrome.action.setBadgeText({ tabId, text: null });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6c3ff0' });
    }
  } catch {
    // The tab closed in the meantime.
  }
}

function addMedia(tabId, entry) {
  return locked(async () => {
    const list = await getTabMedia(tabId);
    if (list.some((m) => m.url === entry.url)) return;
    list.push(entry);
    while (list.length > MAX_PER_TAB) list.shift();
    await chrome.storage.session.set({ [storageKey(tabId)]: list });
    await setBadge(tabId, list.length);
  });
}

/** Clear a tab's list, keeping only entries for `keepUrl` (a media file opened directly). */
export function clearTab(tabId, keepUrl) {
  return locked(async () => {
    const list = keepUrl ? (await getTabMedia(tabId)).filter((m) => m.url === keepUrl) : [];
    if (list.length) await chrome.storage.session.set({ [storageKey(tabId)]: list });
    else await chrome.storage.session.remove(storageKey(tabId));
    await setBadge(tabId, list.length);
  });
}

// ---------- Blocking rules ----------

/** Why detection is off for a page URL: "youtube", "drm", "disabled", "off" or null. */
export function detectionBlockReason(pageUrl, settings) {
  if (!settings.mediaDetection) return 'off';
  if (isYouTube(pageUrl)) return 'youtube';
  if (isDrmSite(pageUrl)) return 'drm';
  if (hostMatches(hostOf(pageUrl), settings.disabledSites || [])) return 'disabled';
  return null;
}

// ---------- Listener ----------

async function onHeadersReceived(details) {
  if (details.tabId < 0) return;
  const headers = {};
  for (const h of details.responseHeaders || []) headers[h.name.toLowerCase()] = h.value || '';

  const found = classifyResponse({ url: details.url, type: details.type, statusCode: details.statusCode, headers });
  if (!found) return;

  const settings = await cachedSettings();
  if (found.size >= 0 && found.size < (Number(settings.minMediaSizeKB) || 0) * 1024) return;
  if (isYouTube(details.url) || isDrmSite(details.url)) return;

  let tab;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return;
  }
  const pageUrl = details.type === 'main_frame' ? details.url : tab.url || tab.pendingUrl || '';
  if (detectionBlockReason(pageUrl, settings)) return;

  await addMedia(details.tabId, {
    url: details.url,
    name: chooseName({ ...found, url: details.url, pageTitle: tab.title }),
    size: found.size,
    mime: found.mime,
    foundAt: Date.now(),
  });
}

export function registerMediaListeners() {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      onHeadersReceived(details).catch((err) => console.error('GetSmart DM: media detection failed', err));
    },
    { urls: ['<all_urls>'], types: RESOURCE_TYPES },
    ['responseHeaders']
  );

  // New page in the tab: start a fresh list. Chrome resets tab badges on
  // navigation, so the badge is set again for whatever is kept.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) clearTab(details.tabId, details.url);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(storageKey(tabId));
  });
}

// ---------- Video button content script (M10) ----------

const OVERLAY_STRINGS = [
  'overlayButton',
  'overlayLoading',
  'overlayVideoSite',
  'overlayViaCompanion',
  'overlayFiles',
  'overlayNothing',
  'overlayStarted',
  'overlayFailed',
  'downloadVideo',
];

/** Should the video button run on this page? Never on DRM, disabled sites, or YouTube unless allowed. */
export function overlayAllowed(pageUrl, frameUrl, settings) {
  if (!settings.showVideoButton) return false;
  for (const url of [pageUrl, frameUrl]) {
    if (!url) continue;
    if (isDrmSite(url)) return false;
    if (isYouTube(url) && !settings.allowYouTube) return false;
    if (hostMatches(hostOf(url), settings.disabledSites || [])) return false;
  }
  return true;
}

export const overlayHandlers = {
  overlayInfo: async (msg, sender) => {
    const settings = await cachedSettings();
    const pageUrl = sender.tab?.url || '';
    if (!overlayAllowed(pageUrl, sender.url, settings)) return { enabled: false };
    setLanguage(settings.language);
    return {
      enabled: true,
      quality: settings.defaultQuality,
      strings: Object.fromEntries(OVERLAY_STRINGS.map((key) => [key, t(key)])),
    };
  },
  overlayMedia: async (msg, sender) => {
    const settings = await cachedSettings();
    const pageUrl = sender.tab?.url || '';
    if (!overlayAllowed(pageUrl, sender.url, settings)) return { site: null, media: [] };
    const media = sender.tab ? await getTabMedia(sender.tab.id) : [];
    return {
      site: videoSiteStatus(pageUrl, settings.allowYouTube),
      media: media.slice().reverse().map(({ url, name, size, mime }) => ({ url, name, size, mime })),
    };
  },
};
