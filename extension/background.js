// GetSmart DM service worker (Manifest V3, ES module).
//
// Every listener is registered synchronously at the top level, so Chrome can
// wake the worker for any of these events after it has been asleep.
//
// Modules:
//   queue.js          queue, folder sorting, chosen names, notifications (M3)
//   menus.js          context menus (M4)
//   media.js          media detection for the "This page" tab (M6)
//   native-bridge.js  companion app connection and video jobs (M7)
//   progress.html     per-download progress window, opened here on start (M11)

import { autoOpenProgress, seedDefaultSettings } from './common.js';
import { enqueue, pump, registerQueueListeners, removeQueued, setQueuePaused } from './queue.js';
import { buildMenus, registerMenuListeners } from './menus.js';
import { registerMediaListeners, overlayHandlers } from './media.js';
import { videoHandlers } from './native-bridge.js';

const BADGE_COLOR = '#6c3ff0';

chrome.runtime.onInstalled.addListener(() => {
  seedDefaultSettings().catch((err) => console.error('GetSmart DM: could not save default settings', err));
  updateBadge();
  pump();
  buildMenus();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  pump();
});

registerQueueListeners();
registerMenuListeners();
registerMediaListeners();

// ---------- Badge: number of active (running, not paused) downloads ----------

let badgeTimer = 0;

/** Recount active downloads. Coalesces bursts of download events into one count. */
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const active = await chrome.downloads.search({ state: 'in_progress', paused: false });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      }
      await chrome.action.setBadgeText({ text: active.length ? String(active.length) : '' });
    } catch (err) {
      console.error('GetSmart DM: badge update failed', err);
    }
  }, 150);
}

chrome.downloads.onCreated.addListener(updateBadge);
chrome.downloads.onErased.addListener(updateBadge);
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused) updateBadge();
});

// ---------- Progress window on download start (M11) ----------
// "ours" downloads are opened from queue.js, which knows the id it started
// (byExtensionId is not filled in yet when onCreated fires).

chrome.downloads.onCreated.addListener((item) => autoOpenProgress(item.id, 'all'));

// ---------- Messages from extension pages ----------

const CONTENT_SCRIPT_CALLS = new Set(['overlayInfo', 'overlayMedia', 'enqueue', 'addVideo']);

const handlers = {
  enqueue: (msg) => enqueue(msg.items || []),
  removeQueued: (msg) => removeQueued(msg.qid),
  setQueuePaused: (msg) => setQueuePaused(msg.paused),
  ...overlayHandlers, // overlayInfo, overlayMedia (content script video button)
  ...videoHandlers, // getVideoState, addVideo, cancelVideo, retryVideo, removeVideo, openVideoFolder
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own pages and our content script talk to the worker. The content
  // script (sender.tab set, page origin) may only use the calls it needs.
  if (sender.id !== chrome.runtime.id || !msg || !handlers[msg.type]) return false;
  const fromPage = Boolean(sender.tab) && !String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (fromPage && !CONTENT_SCRIPT_CALLS.has(msg.type)) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg, sender))
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true; // async response
});
