// Download queue, folder sorting, file names and finish/fail notifications.
// Runs in the service worker.
//
// Queue: downloads we start ourselves (popup "+", context menus, grabber,
// "This page") are stored in chrome.storage.local and only handed to
// chrome.downloads when fewer than `maxSimultaneous` downloads are running.
// Pausing a download frees its slot.
//
// File names: Chrome does not reliably honour `filename` passed to
// chrome.downloads.download, so names we choose are remembered in a Map keyed
// by URL and applied in onDeterminingFilename, only for items whose
// byExtensionId is ours. Folder sorting ("SIDM/<Category>/<name>")
// applies to every download while the setting is on.

import {
  CATEGORY_FOLDERS,
  autoOpenProgress,
  MAX_SIMULTANEOUS_RANGE,
  ROOT_FOLDER,
  baseName,
  cachedSettings,
  categoryOf,
  isHttpUrl,
  nameFromUrl,
  randomId,
  sanitizeFilename,
} from './common.js';
import { setLanguage, t } from './i18n.js';
import { runningFileJobs, setFileJobHooks, startWithCompanion } from './file-jobs.js';

const QUEUE_KEY = 'queue'; // chrome.storage.local: [{ qid, url, filename?, referrer?, addedAt }]

/** URL -> file name we chose. Filled just before chrome.downloads.download. */
const chosenNames = new Map();

// ---------- Queue storage ----------

export async function getQueue() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  return queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/** Serialise every queue change and pump so two events never start the same item. */
let chain = Promise.resolve();
function locked(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

/**
 * Add downloads to the queue. `items` = [{ url, filename? }]. Only http(s)
 * URLs are accepted. Returns { added, rejected }.
 */
export function enqueue(items) {
  return locked(async () => {
    const queue = await getQueue();
    let added = 0;
    let rejected = 0;
    for (const item of items) {
      if (!item || !isHttpUrl(item.url)) {
        rejected += 1;
        continue;
      }
      queue.push({
        qid: randomId(),
        url: item.url,
        filename: item.filename ? sanitizeFilename(item.filename) : undefined,
        referrer: item.referrer || undefined,
        addedAt: Date.now(),
      });
      added += 1;
    }
    await setQueue(queue);
    await pumpUnlocked();
    return { added, rejected };
  });
}

/** Remove a waiting item (popup "Cancel" on a queued row). */
export function removeQueued(qid) {
  return locked(async () => {
    const queue = await getQueue();
    await setQueue(queue.filter((q) => q.qid !== qid));
  });
}

/** Stop or start taking items from the queue. Running downloads are not touched. */
export async function setQueuePaused(paused) {
  await chrome.storage.local.set({ queuePaused: Boolean(paused) });
  if (!paused) await pump();
  return { ok: true };
}

/** Start queued items while there are free slots. */
export function pump() {
  return locked(pumpUnlocked);
}

async function pumpUnlocked() {
  const settings = await cachedSettings();
  const [min, max] = MAX_SIMULTANEOUS_RANGE;
  const limit = Math.min(max, Math.max(min, Number(settings.maxSimultaneous) || 3));

  let queue = await getQueue();
  if (!queue.length) return;
  const { queuePaused } = await chrome.storage.local.get('queuePaused');
  if (queuePaused) return; // "Stop queue" in the manager (M12) or the scheduler (M14)
  const running = await chrome.downloads.search({ state: 'in_progress', paused: false });
  let free = limit - running.length - (await runningFileJobs());

  while (free > 0 && queue.length) {
    const next = queue.shift();
    await setQueue(queue); // remove first, so a crash never starts it twice
    try {
      await startDownload(next, settings);
      await chrome.storage.session.set({ queueActive: true }); // scheduler.js: "when the queue is done"
      free -= 1;
    } catch (err) {
      console.error('SIDM: could not start', next.url, err);
      notifyFailure(next.filename || nameFromUrl(next.url), err?.message || String(err));
    }
    queue = await getQueue();
  }
}

async function startDownload(entry, settings) {
  // Big files on servers that send parts go to the companion (M13), the rest to the browser.
  const job = await startWithCompanion(entry, settings);
  if (job) {
    autoOpenProgress(`f:${job.id}`, 'ours');
    return job.id;
  }
  return startBrowserDownload(entry, settings);
}

async function startBrowserDownload(entry, settings) {
  if (entry.filename) chosenNames.set(entry.url, entry.filename);
  const options = {
    url: entry.url,
    conflictAction: 'uniquify',
    saveAs: Boolean(settings.askWhereToSave),
  };
  const id = await chrome.downloads.download(options);
  autoOpenProgress(id, 'ours'); // not awaited: the queue does not wait for a window
  return id;
}

setFileJobHooks({
  // The companion turned a file down (no ranges, login needed): the browser downloads it.
  fallback: async (entry) => {
    try {
      await startBrowserDownload(entry, await cachedSettings());
    } catch (err) {
      notifyFailure(entry.filename || nameFromUrl(entry.url), err?.message || String(err));
    }
  },
  finished: (job) => {
    pump();
    const name = baseName(job.filename) || job.name;
    if (job.state === 'done') notify(`gsdm-fdone-${job.id}`, 'notifDoneTitle', name);
    else if (job.state === 'error') notify(`gsdm-ffail-${job.id}`, 'notifFailedTitle', `${name}\n${job.error || ''}`.trim());
  },
});

// ---------- File names and folder sorting ----------

/**
 * Work out the relative path Chrome should save `item` to, or null to keep
 * Chrome's choice. Exported for tests.
 */
export function plannedPath(item, settings, ownId = chrome.runtime.id) {
  let name = null;
  if (item.byExtensionId === ownId) {
    name = chosenNames.get(item.url) ?? chosenNames.get(item.finalUrl) ?? null;
  }
  const original = baseName(item.filename) || nameFromUrl(item.finalUrl || item.url);
  const finalName = sanitizeFilename(name || original);

  if (!settings.sortIntoFolders) {
    return name ? finalName : null;
  }
  const folder = CATEGORY_FOLDERS[categoryOf(finalName, item.mime)];
  return `${ROOT_FOLDER}/${folder}/${finalName}`;
}

function onDeterminingFilename(item, suggest) {
  cachedSettings()
    .then((settings) => {
      const path = plannedPath(item, settings);
      chosenNames.delete(item.url);
      if (item.finalUrl) chosenNames.delete(item.finalUrl);
      if (path) suggest({ filename: path, conflictAction: 'uniquify' });
      else suggest();
    })
    .catch((err) => {
      console.error('SIDM: filename step failed', err);
      suggest();
    });
  return true; // we call suggest asynchronously
}

// ---------- Notifications ----------

const NOTIFY_ICON = 'icons/icon128.png';

async function notify(id, titleKey, message) {
  const settings = await cachedSettings();
  if (!settings.notifications) return;
  setLanguage(settings.language);
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: t(titleKey),
    message,
    priority: 0,
  });
}

function notifyFailure(name, reason) {
  notify(`gsdm-fail-${randomId()}`, 'notifFailedTitle', reason ? `${name}\n${reason}` : name);
}

/** A notice that is shown even when finish/fail notifications are off. */
export async function notifyAlways(titleKey, messageKey, vars = {}) {
  const settings = await cachedSettings();
  setLanguage(settings.language);
  chrome.notifications.create(`gsdm-info-${randomId()}`, {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: t(titleKey),
    message: t(messageKey, vars),
    priority: 0,
  });
}

async function onDownloadChanged(delta) {
  if (delta.paused || delta.state) pump();
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  const name = baseName(item.filename) || nameFromUrl(item.url);
  if (state === 'complete') {
    notify(`gsdm-done-${item.id}`, 'notifDoneTitle', name);
  } else if (item.error !== 'USER_CANCELED') {
    notify(`gsdm-fail-${item.id}`, 'notifFailedTitle', `${name}\n${item.error || ''}`.trim());
  }
}

function onNotificationClicked(notificationId) {
  const match = /^gsdm-(done|fail)-(\d+)$/.exec(notificationId);
  if (match && match[1] === 'done') {
    chrome.downloads.show(Number(match[2]));
  }
  chrome.notifications.clear(notificationId);
}

// ---------- Wiring (called once from background.js at top level) ----------

export function registerQueueListeners() {
  chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  chrome.downloads.onChanged.addListener(onDownloadChanged);
  chrome.downloads.onErased.addListener(() => pump());
  chrome.notifications.onClicked.addListener(onNotificationClicked);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.maxSimultaneous) pump();
  });
}
