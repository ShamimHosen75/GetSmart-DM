// Popup "Downloads" tab: every Chrome download, newest first, updated in place.
//
// - Lists items from chrome.downloads.search and refreshes every 800 ms while
//   the popup is open, plus right away on download events.
// - Rows are created once per download id and then only patched (text,
//   progress width, which buttons are visible). The list is never rebuilt.
// - Speed is computed here from byte samples (5 s window, smoothed), because
//   Chrome does not report a speed. Time left = remaining bytes / speed, with
//   Chrome's estimatedEndTime as a fallback until we have two samples.

import { t } from './i18n.js';
import { CATEGORIES, baseName, categoryOf, fileExtension, formatBytes, formatDuration, nameFromUrl } from './common.js';

const REFRESH_MS = 800;
const SAMPLE_WINDOW_MS = 5000;
const MIN_SAMPLE_SPAN_MS = 600;
const SMOOTHING = 0.4; // weight of the newest speed reading
const SEARCH_LIMIT = 1000;

const ICONS = {
  pause: 'M9 5v14M15 5v14',
  resume: 'M8 5.5v13l10.5-6.5z',
  cancel: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  retry: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4',
  open: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  show: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  copy: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  remove: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
};

/** Button order in a row, with the label key for each. */
const ACTIONS = [
  ['pause', 'actPause'],
  ['resume', 'actResume'],
  ['retry', 'actRetry'],
  ['open', 'actOpen'],
  ['show', 'actShow'],
  ['copy', 'actCopyLink'],
  ['cancel', 'actCancel'],
  ['remove', 'actRemove'],
];

const CATEGORY_LABEL = {
  all: 'catAll',
  video: 'catVideo',
  music: 'catMusic',
  documents: 'catDocuments',
  programs: 'catPrograms',
  archives: 'catArchives',
  images: 'catImages',
  other: 'catOther',
};

const rows = new Map(); // download id -> row record
const speeds = new Map(); // download id -> { samples: [{t, bytes}], speed }

let els;
let filter = { text: '', category: 'all' };
let lastItems = [];
let queued = []; // waiting entries from chrome.storage.local "queue", shown first
let refreshing = false;
let refreshAgain = false;
let toastTimer = 0;

export function initDownloadsView() {
  els = {
    list: document.getElementById('dl-list'),
    search: document.getElementById('dl-search'),
    chips: document.getElementById('dl-chips'),
    clear: document.getElementById('dl-clear'),
    empty: document.getElementById('dl-empty'),
    noMatch: document.getElementById('dl-nomatch'),
    template: document.getElementById('dl-row'),
    toast: document.getElementById('dl-toast'),
  };

  buildChips();

  els.search.addEventListener('input', () => {
    filter.text = els.search.value.trim().toLowerCase();
    render();
  });
  els.clear.addEventListener('click', clearFinished);
  els.list.addEventListener('click', onActionClick);

  chrome.downloads.onCreated.addListener(refresh);
  chrome.downloads.onErased.addListener(refresh);
  chrome.downloads.onChanged.addListener(refresh);

  // Labels are built in JS, so rebuild them when the language changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.language) relabel();
  });

  refresh();
  setInterval(refresh, REFRESH_MS);
}

// ---------- Data ----------

/** Fetch all downloads and patch the list. Never runs twice at once. */
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const [items, stored] = await Promise.all([
      chrome.downloads.search({ orderBy: ['-startTime'], limit: SEARCH_LIMIT }),
      chrome.storage.local.get('queue'),
    ]);
    trackSpeeds(items);
    queued = (stored.queue || [])
      .slice()
      .reverse()
      .map((q) => ({ id: `q:${q.qid}`, qid: q.qid, url: q.url, filename: q.filename || '', state: 'queued', bytesReceived: 0, totalBytes: -1 }));
    lastItems = [...queued, ...items];
    render();
  } catch (err) {
    console.error('GetSmart DM: could not read downloads', err);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

function trackSpeeds(items) {
  const now = performance.now();
  const seen = new Set();
  for (const item of items) {
    if (!isRunning(item)) continue;
    seen.add(item.id);
    let track = speeds.get(item.id);
    if (!track) {
      track = { samples: [], speed: null };
      speeds.set(item.id, track);
    }
    const { samples } = track;
    const last = samples[samples.length - 1];
    if (!last || last.bytes !== item.bytesReceived || now - last.t >= REFRESH_MS / 2) {
      samples.push({ t: now, bytes: item.bytesReceived });
    }
    while (samples.length > 2 && now - samples[0].t > SAMPLE_WINDOW_MS) samples.shift();

    const first = samples[0];
    const newest = samples[samples.length - 1];
    const span = newest.t - first.t;
    if (span >= MIN_SAMPLE_SPAN_MS) {
      const reading = Math.max(0, ((newest.bytes - first.bytes) * 1000) / span);
      track.speed = track.speed == null ? reading : track.speed * (1 - SMOOTHING) + reading * SMOOTHING;
    }
  }
  // Paused, finished or erased downloads start fresh next time.
  for (const id of speeds.keys()) if (!seen.has(id)) speeds.delete(id);
}

// ---------- Item helpers ----------

function isFinished(item) {
  return item.state === 'complete' || item.state === 'interrupted';
}

function isRunning(item) {
  return item.state === 'in_progress' && !item.paused;
}

function displayName(item) {
  return baseName(item.filename) || nameFromUrl(item.finalUrl || item.url);
}

function totalBytes(item) {
  if (item.totalBytes > 0) return item.totalBytes;
  if (item.state === 'complete' && item.fileSize > 0) return item.fileSize;
  return -1;
}

function errorLabel(error) {
  if (!error) return '';
  if (error.startsWith('NETWORK_')) return t('errNetwork');
  if (error.startsWith('SERVER_')) return t('errServer');
  if (error === 'FILE_NO_SPACE') return t('errDiskFull');
  if (error === 'FILE_ACCESS_DENIED' || error === 'SERVER_FORBIDDEN') return t('errAccess');
  if (error === 'FILE_TOO_LARGE') return t('errTooLarge');
  if (error === 'FILE_BLOCKED' || error.startsWith('FILE_VIRUS') || error === 'FILE_SECURITY_CHECK_FAILED') return t('errBlocked');
  if (error === 'CRASH' || error === 'USER_SHUTDOWN') return t('errCrash');
  return '';
}

/** "queued" | "downloading" | "paused" | "complete" | "deleted" | "cancelled" | "failed" */
function stateOf(item) {
  if (item.state === 'queued') return 'queued';
  if (item.state === 'in_progress') return item.paused ? 'paused' : 'downloading';
  if (item.state === 'complete') return item.exists === false ? 'deleted' : 'complete';
  return item.error === 'USER_CANCELED' ? 'cancelled' : 'failed';
}

const STATE_LABEL = {
  queued: 'stateQueued',
  downloading: 'stateDownloading',
  paused: 'statePaused',
  complete: 'stateComplete',
  deleted: 'stateDeleted',
  cancelled: 'stateCancelled',
  failed: 'stateFailed',
};

/** Which buttons a row shows in each state. */
const VISIBLE_ACTIONS = {
  queued: ['copy', 'cancel'],
  downloading: ['pause', 'copy', 'cancel'],
  paused: ['resume', 'copy', 'cancel'],
  complete: ['open', 'show', 'copy', 'remove'],
  deleted: ['retry', 'copy', 'remove'],
  cancelled: ['retry', 'copy', 'remove'],
  failed: ['retry', 'copy', 'remove'],
};

function matchesFilter(item) {
  if (filter.category !== 'all' && categoryOf(displayName(item), item.mime) !== filter.category) return false;
  if (!filter.text) return true;
  const haystack = `${displayName(item)}\n${item.finalUrl || ''}\n${item.url || ''}`.toLowerCase();
  return haystack.includes(filter.text);
}

// ---------- Rendering ----------

function render() {
  const shown = lastItems.filter(matchesFilter);
  const shownIds = new Set(shown.map((item) => item.id));

  // Drop rows for downloads that were erased or are filtered out.
  for (const [id, row] of rows) {
    if (!shownIds.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }

  // Create or patch rows, and move a row only if it is not already in place.
  shown.forEach((item, index) => {
    let row = rows.get(item.id);
    if (!row) {
      row = createRow(item.id);
      rows.set(item.id, row);
    }
    updateRow(row, item);
    const atIndex = els.list.children[index];
    if (atIndex !== row.el) els.list.insertBefore(row.el, atIndex || null);
  });

  els.empty.hidden = lastItems.length > 0;
  els.noMatch.hidden = lastItems.length === 0 || shown.length > 0;
  els.clear.hidden = !lastItems.some(isFinished);
}

function svgIcon(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function createRow(id) {
  const el = els.template.content.firstElementChild.cloneNode(true);
  el.dataset.id = String(id);
  const actions = el.querySelector('.dl-actions');
  const buttons = {};
  for (const [action, labelKey] of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon-button small act-${action}`;
    button.dataset.action = action;
    button.title = t(labelKey);
    button.setAttribute('aria-label', button.title);
    button.hidden = true;
    button.append(svgIcon(ICONS[action]));
    actions.append(button);
    buttons[action] = button;
  }
  return {
    el,
    type: el.querySelector('.dl-type'),
    name: el.querySelector('.dl-name'),
    bar: el.querySelector('.dl-bar'),
    progress: el.querySelector('.dl-progress'),
    state: el.querySelector('.dl-state'),
    size: el.querySelector('.dl-size'),
    speed: el.querySelector('.dl-speed'),
    eta: el.querySelector('.dl-eta'),
    buttons,
    last: {}, // last values written, so unchanged fields are not touched
  };
}

/** Write `value` into `row[key]` only if it changed since last time. */
function setText(row, key, value) {
  if (row.last[key] === value) return;
  row.last[key] = value;
  row[key].textContent = value;
  row[key].hidden = value === '';
}

function setAttr(row, key, el, apply, value) {
  if (row.last[key] === value) return;
  row.last[key] = value;
  apply(el, value);
}

function updateRow(row, item) {
  const state = stateOf(item);
  const name = displayName(item);
  const category = categoryOf(name, item.mime);
  const total = totalBytes(item);
  const received = state === 'complete' ? Math.max(item.bytesReceived, total) : item.bytesReceived;

  setAttr(row, 'stateClass', row.el, (el, v) => (el.dataset.state = v), state);
  setAttr(row, 'category', row.type, (el, v) => (el.dataset.category = v), category);
  setText(row, 'type', (fileExtension(name) || '?').slice(0, 4).toUpperCase());
  setText(row, 'name', name);
  setAttr(row, 'title', row.name, (el, v) => (el.title = v), `${name}\n${item.finalUrl || item.url}`);

  // Progress bar
  const known = total > 0;
  const percent = state === 'complete' ? 100 : known ? Math.min(100, (received / total) * 100) : 0;
  setAttr(row, 'indeterminate', row.progress, (el, v) => el.classList.toggle('indeterminate', v), !known && state === 'downloading');
  setAttr(row, 'percent', row.bar, (el, v) => (el.style.width = `${v}%`), percent.toFixed(1));

  // State text, with the failure reason when we know it
  let stateText = t(STATE_LABEL[state]);
  if (state === 'failed') {
    const reason = errorLabel(item.error);
    if (reason) stateText = `${stateText}: ${reason}`;
  }
  setText(row, 'state', stateText);

  // Size
  let sizeText;
  if (state === 'downloading' || state === 'paused') {
    sizeText = known ? t('sizeOf', { done: formatBytes(received), total: formatBytes(total) }) : formatBytes(received);
  } else if (state === 'complete' || state === 'deleted') {
    sizeText = formatBytes(total > 0 ? total : received);
  } else {
    sizeText = known && received > 0 ? t('sizeOf', { done: formatBytes(received), total: formatBytes(total) }) : '';
  }
  setText(row, 'size', sizeText);

  // Speed and time left (only while running)
  let speedText = '';
  let etaText = '';
  if (state === 'downloading') {
    const speed = speeds.get(item.id)?.speed;
    let seconds = NaN;
    if (speed != null) {
      speedText = t('speedPerSecond', { size: formatBytes(speed) });
      if (known && speed > 0) seconds = (total - received) / speed;
    }
    if (!Number.isFinite(seconds) && item.estimatedEndTime) {
      seconds = (Date.parse(item.estimatedEndTime) - Date.now()) / 1000;
    }
    const duration = formatDuration(seconds);
    if (duration) etaText = t('timeLeft', { time: duration });
  }
  setText(row, 'speed', speedText);
  setText(row, 'eta', etaText);

  // Buttons
  const visible = VISIBLE_ACTIONS[state];
  const visibleKey = visible.join(',');
  if (row.last.visible !== visibleKey) {
    row.last.visible = visibleKey;
    for (const [action, button] of Object.entries(row.buttons)) {
      button.hidden = !visible.includes(action);
    }
  }
}

function buildChips() {
  els.chips.replaceChildren();
  for (const category of ['all', ...CATEGORIES]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.category = category;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(filter.category === category));
    chip.textContent = t(CATEGORY_LABEL[category]);
    chip.addEventListener('click', () => {
      filter.category = category;
      els.chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      render();
    });
    els.chips.append(chip);
  }
}

function relabel() {
  buildChips();
  for (const row of rows.values()) {
    for (const [action, labelKey] of ACTIONS) {
      row.buttons[action].title = t(labelKey);
      row.buttons[action].setAttribute('aria-label', row.buttons[action].title);
    }
    row.last = {}; // force every text field to be rewritten
  }
  render();
}

// ---------- Actions ----------

async function onActionClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const rawId = button.closest('.dl-row').dataset.id;
  const item = lastItems.find((i) => String(i.id) === rawId);
  if (!item) return;
  try {
    await runAction(button.dataset.action, item);
  } catch (err) {
    showToast(t('actionFailed', { error: err?.message || String(err) }), true);
  }
  refresh();
}

async function runAction(action, item) {
  switch (action) {
    case 'pause':
      return chrome.downloads.pause(item.id);
    case 'resume':
      return chrome.downloads.resume(item.id);
    case 'cancel':
      if (item.state === 'queued') return chrome.runtime.sendMessage({ type: 'removeQueued', qid: item.qid });
      return chrome.downloads.cancel(item.id);
    case 'retry':
      return retry(item);
    case 'open':
      return chrome.downloads.open(item.id);
    case 'show':
      return chrome.downloads.show(item.id);
    case 'copy':
      await navigator.clipboard.writeText(item.finalUrl || item.url);
      return showToast(t('linkCopied'));
    case 'remove':
      return chrome.downloads.erase({ id: item.id });
    default:
      return undefined;
  }
}

/** Resume where Chrome allows it, otherwise queue the same URL again. */
async function retry(item) {
  if (item.state === 'interrupted' && item.canResume) {
    return chrome.downloads.resume(item.id);
  }
  const reply = await chrome.runtime.sendMessage({ type: 'enqueue', items: [{ url: item.url, filename: displayName(item) }] });
  if (!reply?.added) throw new Error(reply?.error || 'not added');
  // The new download replaces the failed row.
  await chrome.downloads.erase({ id: item.id });
  return undefined;
}

async function clearFinished() {
  const finished = lastItems.filter(isFinished);
  await Promise.all(finished.map((item) => chrome.downloads.erase({ id: item.id })));
  refresh();
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
}
