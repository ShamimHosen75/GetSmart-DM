// Progress window (M11): one download, opened from the popup's details button
// or automatically when a download starts (Settings > "Progress window").
//
// Shows the address, status, size, bytes downloaded with a percentage, the
// transfer rate, time left and whether the server can resume. Pause, Resume
// and Cancel act on the download. "When finished" can show the file in its
// folder and close this window. Chrome only opens a file after a click, so
// "Open file" stays a button.
//
// Companion file downloads (M13) also show their parts as a segment bar and a
// connection table, and take a speed limit.
//
// URL: progress.html?id=<chrome download id> or ?id=f:<companion job id>

import { categoryOf, fileExtension, formatBytes, formatDuration, initPage } from './common.js';
import { STATE_LABEL, displayName, failureText, fileJobItem, itemAction, stateOf, totalBytes } from './download-info.js';
import { SpeedTracker, secondsLeft } from './speed.js';
import { t } from './i18n.js';

const REFRESH_MS = 800;
const PROBE_TIMEOUT_MS = 8000;
const COMPACT_HEIGHT = 190;
const FINISH_DEFAULTS_KEY = 'finishDefaults'; // storage.local: last choice, used for new windows

const rawId = new URLSearchParams(location.search).get('id') || '';
const companion = rawId.startsWith('f:');
const id = companion ? rawId : Number(rawId);
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

async function find() {
  if (!companion) return (await chrome.downloads.search({ id }))[0];
  const { fileJobs = {} } = await chrome.storage.local.get('fileJobs');
  const job = fileJobs[id.slice(2)];
  return job ? fileJobItem(job) : null;
}

async function refresh() {
  const found = await find();
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
  if (companion) return; // the companion only takes servers that can resume
  if (stateOf(item) !== 'downloading' || !/^https?:/i.test(url) || resumeProbe.url === url) return;
  resumeProbe = { url, result: undefined };
  probeResume(url).then((result) => {
    if (resumeProbe.url === url) resumeProbe.result = result;
    render();
  });
}

// ---------- Rendering ----------

function resumeText(state) {
  if (companion) return t('progResumeYes');
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
  if (state === 'failed' && failureText(item)) stateText = `${stateText}: ${failureText(item)}`;
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

  if (companion) renderParts(state, total);

  const show = {
    'b-pause': state === 'downloading',
    'b-resume': state === 'paused',
    'b-retry': (state === 'failed' || state === 'cancelled') && Boolean(item.canResume),
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

// ---------- Companion parts (M13) ----------

/** One bar per part of the file, and a row per part: range, downloaded, state. */
function renderParts(state, total) {
  const box = $('p-parts');
  box.hidden = false;
  const segs = item.segments || [];
  const running = state === 'downloading';
  setText($('f-conns'), running ? t('progConnectionsOf', { active: item.connections, max: item.maxConnections || item.connections }) : '—');

  const bar = $('p-segbar');
  while (bar.children.length < segs.length) bar.append(document.createElement('div'));
  while (bar.children.length > segs.length) bar.lastChild.remove();
  segs.forEach(([start, end, done], i) => {
    const el = bar.children[i];
    el.style.left = `${(start / total) * 100}%`;
    el.style.width = `${(Math.min(done, end - start + 1) / total) * 100}%`;
  });

  const body = $('p-conn-rows');
  const rowsWanted = segs.length;
  while (body.children.length < rowsWanted) {
    const tr = document.createElement('tr');
    for (let c = 0; c < 4; c += 1) tr.append(document.createElement('td'));
    body.append(tr);
  }
  while (body.children.length > rowsWanted) body.lastChild.remove();
  segs.forEach(([start, end, done], i) => {
    const cells = body.children[i].children;
    const size = end - start + 1;
    setText(cells[0], String(i + 1));
    setText(cells[1], `${formatBytes(start)} – ${formatBytes(end + 1)}`);
    setText(cells[2], `${formatBytes(Math.min(done, size))} (${Math.floor((Math.min(done, size) / size) * 100)}%)`);
    setText(cells[3], done >= size ? t('progPartDone') : running ? t('progPartReceiving') : t('statePaused'));
  });
}

function initSpeedLimit() {
  if (!companion) return;
  $('p-speed-browser').hidden = true;
  $('p-speed-companion').hidden = false;
  const input = $('sp-limit');
  const toggle = $('sp-on');
  const sync = () => {
    input.disabled = !toggle.checked;
  };
  find().then((found) => {
    const limit = found?.speedLimit || 0;
    toggle.checked = limit > 0;
    input.value = limit > 0 ? Math.round(limit / 1024) : 500;
    sync();
  });
  const save = async () => {
    sync();
    const kb = Math.max(1, Math.round(Number(input.value) || 0));
    input.value = kb;
    await chrome.runtime.sendMessage({ type: 'setFileSpeedLimit', id: id.slice(2), limit: toggle.checked ? kb * 1024 : 0 });
  };
  toggle.addEventListener('change', save);
  input.addEventListener('change', save);
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
  if (finish.show && item.exists !== false) itemAction('show', item);
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

  act('b-pause', () => itemAction('pause', item));
  act('b-resume', () => itemAction('resume', item));
  act('b-retry', () => itemAction('resume', item));
  act('b-cancel', () => itemAction('cancel', item));
  act('b-open', () => itemAction('open', item));
  act('b-show', () => itemAction('show', item));
  initSpeedLimit();
  $('b-close').addEventListener('click', () => window.close());
  $('b-details').addEventListener('click', () => setDetails(!detailsShown));
  $('b-details').textContent = t('progHideDetails');
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id === id) refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (companion && area === 'local' && changes.fileJobs) refresh();
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

  if (!companion && (!Number.isInteger(id) || id < 0)) {
    showGone();
    return;
  }
  await refresh();
  setInterval(refresh, REFRESH_MS);
}

main();
