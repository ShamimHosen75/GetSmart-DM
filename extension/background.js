// SIDM service worker (Manifest V3, ES module).
//
// Every listener is registered synchronously at the top level, so Chrome can
// wake the worker for any of these events after it has been asleep.
//
// Modules:
//   queue.js          queue, folder sorting, chosen names, notifications (M3)
//   menus.js          context menus (M4)
//   media.js          media detection for the "This page" tab (M6)
//   native-bridge.js  companion app connection and video jobs (M7)
//   file-jobs.js      multi-connection file downloads through the companion (M13)
//   scheduler.js      start/stop the queue at set times, "when the queue is done" (M14)
//   stream-jobs.js    video downloads made in the browser, no install needed (M15)
//   progress.html     per-download progress window, opened here on start (M11)

import { autoOpenProgress, seedDefaultSettings } from './common.js';
import { enqueue, pump, registerQueueListeners, removeQueued, setQueuePaused } from './queue.js';
import { buildMenus, registerMenuListeners } from './menus.js';
import { registerMediaListeners, overlayHandlers } from './media.js';
import { videoHandlers } from './native-bridge.js';
import { fileHandlers, registerFileJobListeners, runningFileJobs } from './file-jobs.js';
import { planAlarms, registerSchedulerListeners } from './scheduler.js';
import { markInterruptedStreams, registerStreamListeners, runningStreamJobs, streamHandlers } from './stream-jobs.js';

const BADGE_COLOR = '#6c3ff0';

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
  seedDefaultSettings().catch((err) => console.error('SIDM: could not save default settings', err));
  updateBadge();
  pump();
  buildMenus();
  planAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  markInterruptedStreams();
  updateBadge();
  pump();
  planAlarms();
});

registerQueueListeners();
registerMenuListeners();
registerMediaListeners();
registerSchedulerListeners();
registerFileJobListeners();
registerStreamListeners();

/**
 * Content scripts only reach pages loaded after install. Add the video button
 * to the pages already open, so it works without reloading them.
 */
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['overlay.js'] }).catch(() => {})));
  } catch (err) {
    console.warn('SIDM: could not add the video button to open tabs', err);
  }
}

// ---------- Badge: number of active (running, not paused) downloads ----------

let badgeTimer = 0;

/** Recount active downloads. Coalesces bursts of download events into one count. */
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const active = await chrome.downloads.search({ state: 'in_progress', paused: false });
      const count = active.length + (await runningFileJobs()) + (await runningStreamJobs());
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      }
      await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    } catch (err) {
      console.error('SIDM: badge update failed', err);
    }
  }, 150);
}

chrome.downloads.onCreated.addListener(updateBadge);
chrome.downloads.onErased.addListener(updateBadge);
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused) updateBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.fileJobs || changes.streamJobs)) updateBadge();
});

// ---------- Progress window on download start (M11) ----------
// "ours" downloads are opened from queue.js, which knows the id it started
// (byExtensionId is not filled in yet when onCreated fires).

chrome.downloads.onCreated.addListener((item) => autoOpenProgress(item.id, 'all'));

// ---------- Messages from extension pages ----------

const CONTENT_SCRIPT_CALLS = new Set(['overlayInfo', 'overlayMedia', 'overlaySawVideo', 'overlayCompanionHelp', 'enqueue', 'addVideo', 'addStream']);

const handlers = {
  enqueue: (msg) => enqueue(msg.items || []),
  removeQueued: (msg) => removeQueued(msg.qid),
  setQueuePaused: (msg) => setQueuePaused(msg.paused),
  ...overlayHandlers, // overlayInfo, overlayMedia, overlaySawVideo, overlayCompanionHelp (content script video button)
  ...videoHandlers, // getVideoState, addVideo, cancelVideo, retryVideo, removeVideo, openVideoFolder
  ...fileHandlers, // pauseFile, resumeFile, cancelFile, eraseFile, openFile, setFileSpeedLimit
  ...streamHandlers, // streamOptions, addStream, pause/resume/retry/cancel/eraseStream; streamProgress/Ready/Failed from offscreen.html
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
