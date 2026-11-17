// Progress window (M11): one download, opened from the popup's details button
// or automatically when a download starts (Settings > "Progress window").
//
// Shows the address, status, size, bytes downloaded with a percentage, the
// transfer rate, time left and whether the server can resume. Pause, Resume
// and Cancel act on the download. "When finished" can show the file in its
// folder and close this window. Chrome only opens a file after a click, so
// "Open file" stays a button.
//
// URL: progress.html?id=<chrome download id>

import { categoryOf, fileExtension, formatBytes, formatDuration, initPage } from './common.js';
import { STATE_LABEL, displayName, errorLabel, stateOf, totalBytes } from './download-info.js';
import { SpeedTracker, secondsLeft } from './speed.js';
import { t } from './i18n.js';

const REFRESH_MS = 800;
const PROBE_TIMEOUT_MS = 8000;
const COMPACT_HEIGHT = 190;
const FINISH_DEFAULTS_KEY = 'finishDefaults'; // storage.local: last choice, used for new windows

const id = Number(new URLSearchParams(location.search).get('id'));
const speeds = new SpeedTracker();
const $ = (sel) => document.getElementById(sel);

let item = null;
let lastState = '';
let resumeProbe = { url: '', result: undefined }; // undefined: not asked, null: unknown
let detailsShown = true;
let fullHeight = 0;
let finish = { show: false, close: false };
let finishHandled = false;
let sawRunning = false; // the "When finished" choices only apply to a download we saw running

// ---------- Data ----------

async function refresh() {
  const [found] = await chrome.downloads.search({ id });
  if (!found) {
    showGone();
    return;
  }
  item = found;
  if (item.state === 'in_progress' && !item.paused) speeds.sample(id, item.bytesReceived);
  else speeds.retain(new Set());
  render();
  maybeProbeResume();
  onFinished();
}

/** Ask the server for one byte with a Range header: 206 means it can resume. */
async function probeResume(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal: controller.signal });
    res.body?.cancel().catch(() => {});
    return res.status === 206;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function maybeProbeResume() {
  // Chrome knows for paused and interrupted downloads; ask the server only while running.
  const url = item.finalUrl || item.url;
  if (stateOf(item) !== 'downloading' || !/^https?:/i.test(url) || resumeProbe.url === url) return;
  resumeProbe = { url, result: undefined };
  probeResume(url).then((result) => {
    if (resumeProbe.url === url) resumeProbe.result = result;
    render();
  });
}

// ---------- Rendering ----------

function resumeText(state) {
  if (state === 'paused' || state === 'failed' || state === 'cancelled') {
    return item.canResume ? t('progResumeYes') : t('progResumeNo');
  }
  if (state !== 'downloading') return '—';
  if (resumeProbe.result === undefined) return t('progResumeChecking');
  if (resumeProbe.result === null) return t('progResumeUnknown');
  return resumeProbe.result ? t('progResumeYes') : t('progResumeNo');
}

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

function render() {
  if (!item) return;
  const state = stateOf(item);
  const name = displayName(item);
  const total = totalBytes(item);
  const received = state === 'complete' ? Math.max(item.bytesReceived, total) : item.bytesReceived;
  const known = total > 0;
  const percent = state === 'complete' ? 100 : known ? Math.min(100, (received / total) * 100) : 0;
  const speed = state === 'downloading' ? speeds.get(id) : null;

  document.body.dataset.state = state;
  const type = $('p-type');
  type.dataset.category = categoryOf(name, item.mime);
  setText(type, (fileExtension(name) || '?').slice(0, 4).toUpperCase());
  setText($('p-name'), name);
  $('p-name').title = name;

  let stateText = t(STATE_LABEL[state]);
  if (state === 'failed' && errorLabel(item.error)) stateText = `${stateText}: ${errorLabel(item.error)}`;
  setText($('p-state'), stateText);
  setText($('f-status'), stateText);

  const title = known && state !== 'complete' ? `${Math.floor(percent)}% ${name}` : name;
  if (document.title !== title) document.title = title;

  $('p-progress').classList.toggle('indeterminate', !known && state === 'downloading');
  $('p-bar').style.width = `${percent.toFixed(1)}%`;
  setText($('p-percent'), known || state === 'complete' ? `${percent.toFixed(percent < 10 && percent > 0 ? 1 : 0)}%` : '');

  setText($('f-url'), item.finalUrl || item.url);
  $('f-url').title = item.finalUrl || item.url;
  setText($('f-size'), known ? formatBytes(total) : t('progUnknownSize'));
  setText($('f-done'), known ? t('progDoneOf', { done: formatBytes(received), percent: percent.toFixed(1) }) : formatBytes(received));
  setText($('f-rate'), speed != null ? t('speedPerSecond', { size: formatBytes(speed) }) : '—');
  setText($('f-eta'), state === 'downloading' ? formatDuration(secondsLeft(item, speed)) || '—' : '—');
  setText($('f-resume'), resumeText(state));
  setText($('f-path'), item.filename || '—');
  $('f-path').title = item.filename || '';

  const show = {
    'b-pause': state === 'downloading',
    'b-resume': state === 'paused',
    'b-retry': (state === 'failed' || state === 'cancelled') && item.canResume,
    'b-cancel': state === 'downloading' || state === 'paused',
    'b-open': state === 'complete',
    'b-show': state === 'complete',
    'b-close': state !== 'downloading' && state !== 'paused',
  };
  for (const [button, visible] of Object.entries(show)) $(button).hidden = !visible;

  if (state !== lastState) {
    // Put the focus on the button you most likely want next.
    lastState = state;
    const primary = ['b-open', 'b-pause', 'b-resume', 'b-retry', 'b-close'].find((b) => show[b]);
    if (primary && document.hasFocus()) $(primary).focus();
  }
}

function showGone() {
  item = null;
  $('p-details').hidden = true;
  $('p-gone').hidden = false;
  document.querySelector('.p-bar-row').hidden = true;
  setText($('p-name'), t('appName'));
  setText($('p-state'), '');
  for (const button of document.querySelectorAll('.p-buttons button')) button.hidden = button.id !== 'b-close';
  $('b-details').hidden = true;
}

// ---------- When finished ----------

async function loadFinish() {
  const key = `finish:${id}`;
  const [session, local] = await Promise.all([chrome.storage.session.get(key), chrome.storage.local.get(FINISH_DEFAULTS_KEY)]);
  finish = { show: false, close: false, ...(local[FINISH_DEFAULTS_KEY] || {}), ...(session[key] || {}) };
  $('fin-show').checked = finish.show;
  $('fin-close').checked = finish.close;
  for (const field of ['show', 'close']) {
    $(`fin-${field}`).addEventListener('change', async (event) => {
      finish[field] = event.target.checked;
      await chrome.storage.session.set({ [key]: finish });
      await chrome.storage.local.set({ [FINISH_DEFAULTS_KEY]: finish });
    });
  }
}

/** Run the "When finished" choices once, when a download this window watched completes. */
function onFinished() {
  if (!item) return;
  if (item.state === 'in_progress') {
    sawRunning = true;
    return;
  }
  if (item.state !== 'complete' || !sawRunning || finishHandled) return;
  finishHandled = true;
  if (finish.show && item.exists !== false) chrome.downloads.show(id);
  if (finish.close) window.close();
}

// ---------- Buttons ----------

function act(button, action) {
  $(button).addEventListener('click', async () => {
    try {
      await action();
    } catch (err) {
      setText($('p-state'), t('actionFailed', { error: err?.message || String(err) }));
    }
    refresh();
  });
}

async function setDetails(shown) {
  detailsShown = shown;
  $('p-details').hidden = !shown;
  $('b-details').textContent = shown ? t('progHideDetails') : t('progShowDetails');
  try {
    const win = await chrome.windows.getCurrent();
    if (win.type !== 'popup') return;
    if (!shown) fullHeight = win.height;
    await chrome.windows.update(win.id, { height: shown ? fullHeight || win.height : COMPACT_HEIGHT });
  } catch {
    // A normal tab cannot be resized; hiding the details is enough.
  }
}

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) other.setAttribute('aria-selected', String(other === tab));
      for (const panel of document.querySelectorAll('.p-panel')) panel.hidden = panel.dataset.panel !== tab.dataset.panel;
    });
  }
}

async function main() {
  await initPage();
  initTabs();
  await loadFinish();

  act('b-pause', () => chrome.downloads.pause(id));
  act('b-resume', () => chrome.downloads.resume(id));
  act('b-retry', () => chrome.downloads.resume(id));
  act('b-cancel', () => chrome.downloads.cancel(id));
  act('b-open', () => chrome.downloads.open(id));
  act('b-show', () => chrome.downloads.show(id));
  $('b-close').addEventListener('click', () => window.close());
  $('b-details').addEventListener('click', () => setDetails(!detailsShown));
  $('b-details').textContent = t('progHideDetails');
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id === id) refresh();
  });
  chrome.downloads.onErased.addListener((erased) => {
    if (erased === id) showGone();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.language) {
      $('b-details').textContent = detailsShown ? t('progHideDetails') : t('progShowDetails');
      render();
    }
  });

  if (!Number.isInteger(id) || id < 0) {
    showGone();
    return;
  }
  await refresh();
  setInterval(refresh, REFRESH_MS);
}

main();
