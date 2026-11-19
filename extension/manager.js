// Download manager page (M12): every download in one full tab.
//
// - Left: a category tree (All, the file categories, Unfinished, Finished,
//   Queue) with live counts.
// - Middle: a sortable table (name, size, status, time left, transfer rate,
//   last try, address). Click, Ctrl/Cmd-click and Shift-click select rows;
//   Ctrl+A selects all shown; Delete deletes; Enter or a double-click opens a
//   finished file or the progress window of a running one.
// - Top: Add URL, Resume, Stop, Stop all, Delete, Delete completed,
//   Start/Stop queue, Scheduler, Grabber, Settings.
// Rows are created once per id and patched in place every 800 ms.

import { CATEGORIES, categoryOf, fileExtension, formatBytes, formatDuration, initPage, openProgressWindow } from './common.js';
import { STATE_LABEL, displayName, failureText, fileJobItems, isRunning, itemAction, stateOf, totalBytes } from './download-info.js';
import { SpeedTracker, secondsLeft } from './speed.js';
import { initAddLinks } from './add-links.js';
import { t } from './i18n.js';

const REFRESH_MS = 800;
const SEARCH_LIMIT = 5000;

const TREE = [
  { id: 'all', label: 'catAll', children: CATEGORIES.map((c) => ({ id: `cat:${c}`, label: `cat${c[0].toUpperCase()}${c.slice(1)}` })) },
  { id: 'unfinished', label: 'mUnfinished' },
  { id: 'finished', label: 'mFinished' },
  { id: 'queue', label: 'mQueue' },
];

const $ = (id) => document.getElementById(id);
const speeds = new SpeedTracker();
const rows = new Map(); // id -> { el, cells, last }
const selected = new Set(); // ids as strings
let anchor = null; // last clicked id, for Shift-click ranges
let items = []; // every download and queued entry, as display records
let shown = []; // items after the category, search and sort
let view = 'all';
let search = '';
let sort = { key: 'lastTry', dir: -1 };
let queuePaused = false;
let refreshing = false;
let toastTimer = 0;

// ---------- Data ----------

/** One display record per download or queued entry. */
function record(item) {
  const state = stateOf(item);
  const name = displayName(item);
  const total = totalBytes(item);
  const received = state === 'complete' ? Math.max(item.bytesReceived, total) : item.bytesReceived;
  const speed = state === 'downloading' ? speeds.get(item.id) : null;
  const eta = state === 'downloading' ? secondsLeft(item, speed) : NaN;
  return {
    id: String(item.id),
    item,
    state,
    name,
    category: categoryOf(name, item.mime),
    total,
    received,
    percent: total > 0 ? Math.min(100, (received / total) * 100) : state === 'complete' ? 100 : null,
    speed,
    eta,
    lastTry: Date.parse(item.endTime || item.startTime || '') || item.addedAt || 0,
    address: item.finalUrl || item.url,
  };
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [browserDownloads, files, stored] = await Promise.all([
      chrome.downloads.search({ orderBy: ['-startTime'], limit: SEARCH_LIMIT }),
      fileJobItems(),
      chrome.storage.local.get(['queue', 'queuePaused']),
    ]);
    const downloads = [...files, ...browserDownloads];
    const running = new Set();
    for (const item of downloads) {
      if (!isRunning(item)) continue;
      running.add(item.id);
      speeds.sample(item.id, item.bytesReceived);
    }
    speeds.retain(running);
    queuePaused = Boolean(stored.queuePaused);
    const queued = (stored.queue || []).map((q) => ({
      id: `q:${q.qid}`,
      qid: q.qid,
      url: q.url,
      filename: q.filename || '',
      state: 'queued',
      bytesReceived: 0,
      totalBytes: -1,
      addedAt: q.addedAt,
    }));
    items = [...queued, ...downloads].map(record);
    render();
  } catch (err) {
    console.error('SIDM: could not read downloads', err);
  } finally {
    refreshing = false;
  }
}

// ---------- Filtering and sorting ----------

function inView(rec, which = view) {
  if (which === 'all') return true;
  if (which.startsWith('cat:')) return rec.category === which.slice(4);
  if (which === 'unfinished') return ['downloading', 'paused', 'queued', 'failed', 'cancelled'].includes(rec.state);
  if (which === 'finished') return rec.state === 'complete' || rec.state === 'deleted';
  if (which === 'queue') return rec.state === 'queued';
  return true;
}

const STATUS_ORDER = ['downloading', 'paused', 'queued', 'failed', 'cancelled', 'complete', 'deleted'];

const SORT_VALUE = {
  name: (r) => r.name.toLowerCase(),
  size: (r) => r.total,
  status: (r) => STATUS_ORDER.indexOf(r.state) * 1000 + (r.percent ?? 0),
  eta: (r) => (Number.isFinite(r.eta) ? r.eta : Infinity),
  rate: (r) => r.speed ?? -1,
  lastTry: (r) => r.lastTry,
  address: (r) => r.address,
};

function compare(a, b) {
  const va = SORT_VALUE[sort.key](a);
  const vb = SORT_VALUE[sort.key](b);
  if (va < vb) return -sort.dir;
  if (va > vb) return sort.dir;
  return b.lastTry - a.lastTry;
}

function matchesSearch(rec) {
  return !search || `${rec.name}\n${rec.address}`.toLowerCase().includes(search);
}

// ---------- Rendering ----------

function render() {
  shown = items.filter((r) => inView(r) && matchesSearch(r)).sort(compare);
  const ids = new Set(shown.map((r) => r.id));
  for (const id of [...selected]) if (!items.some((r) => r.id === id)) selected.delete(id);

  for (const [id, row] of rows) {
    if (!ids.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }
  const body = $('m-rows');
  shown.forEach((rec, index) => {
    let row = rows.get(rec.id);
    if (!row) {
      row = createRow(rec.id);
      rows.set(rec.id, row);
    }
    updateRow(row, rec);
    if (body.children[index] !== row.el) body.insertBefore(row.el, body.children[index] || null);
  });

  $('m-empty').hidden = shown.length > 0;
  $('m-empty-body').textContent = items.length ? t('noMatchBody') : t('emptyDownloadsBody');
  renderTree();
  renderToolbar();
  renderStatus();
}

function createRow(id) {
  const el = document.createElement('tr');
  el.dataset.id = id;
  const cells = {};
  for (const key of ['name', 'size', 'status', 'eta', 'rate', 'lastTry', 'address']) {
    const td = document.createElement('td');
    td.className = `c-${key}`;
    el.append(td);
    cells[key] = td;
  }
  const type = document.createElement('span');
  type.className = 'dl-type m-type';
  const name = document.createElement('span');
  name.className = 'm-name';
  const nameBox = document.createElement('div');
  nameBox.className = 'm-name-box';
  nameBox.append(type, name);
  cells.name.append(nameBox);
  const bar = document.createElement('div');
  bar.className = 'dl-progress m-progress';
  bar.append(document.createElement('div'));
  bar.firstChild.className = 'dl-bar';
  const statusText = document.createElement('span');
  cells.status.append(statusText, bar);
  return { el, cells, type, name, statusText, bar, last: {} };
}

function patch(row, key, value, apply) {
  if (row.last[key] === value) return;
  row.last[key] = value;
  apply(value);
}

function statusText(rec) {
  let text = t(STATE_LABEL[rec.state]);
  if (rec.state === 'failed' && failureText(rec.item)) text = `${text}: ${failureText(rec.item)}`;
  if ((rec.state === 'downloading' || rec.state === 'paused') && rec.percent != null) text = `${rec.percent.toFixed(1)}% · ${text}`;
  return text;
}

function updateRow(row, rec) {
  const ext = (fileExtension(rec.name) || '?').slice(0, 4).toUpperCase();
  patch(row, 'state', rec.state, (v) => (row.el.dataset.state = v));
  patch(row, 'selected', selected.has(rec.id), (v) => row.el.setAttribute('aria-selected', String(v)));
  patch(row, 'category', rec.category, (v) => (row.type.dataset.category = v));
  patch(row, 'ext', ext, (v) => (row.type.textContent = v));
  patch(row, 'name', rec.name, (v) => {
    row.name.textContent = v;
    row.cells.name.title = v;
  });
  const size = rec.total > 0 ? formatBytes(rec.total) : rec.received > 0 ? formatBytes(rec.received) : '';
  patch(row, 'size', size, (v) => (row.cells.size.textContent = v));
  patch(row, 'status', statusText(rec), (v) => (row.statusText.textContent = v));
  const showBar = rec.state === 'downloading' || rec.state === 'paused';
  patch(row, 'bar', showBar ? (rec.percent ?? -1).toFixed(1) : 'none', () => {
    row.bar.hidden = !showBar;
    row.bar.classList.toggle('indeterminate', showBar && rec.percent == null && rec.state === 'downloading');
    row.bar.firstChild.style.width = `${rec.percent ?? 0}%`;
  });
  patch(row, 'eta', Number.isFinite(rec.eta) ? formatDuration(rec.eta) : '', (v) => (row.cells.eta.textContent = v));
  patch(row, 'rate', rec.speed != null ? t('speedPerSecond', { size: formatBytes(rec.speed) }) : '', (v) => (row.cells.rate.textContent = v));
  patch(row, 'lastTry', rec.lastTry ? new Date(rec.lastTry).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '', (v) => (row.cells.lastTry.textContent = v));
  patch(row, 'address', rec.address, (v) => {
    row.cells.address.textContent = v;
    row.cells.address.title = v;
  });
}

function renderTree() {
  const tree = $('m-tree');
  if (!tree.childElementCount) buildTree();
  for (const node of tree.querySelectorAll('[data-view]')) {
    const count = items.filter((r) => inView(r, node.dataset.view)).length;
    const badge = node.querySelector('.m-count');
    const text = count ? String(count) : '';
    if (badge.textContent !== text) badge.textContent = text;
    node.setAttribute('aria-selected', String(node.dataset.view === view));
  }
}

function buildTree() {
  const tree = $('m-tree');
  tree.replaceChildren();
  const add = (parent, node, depth) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `m-node depth-${depth}`;
    button.setAttribute('role', 'treeitem');
    button.dataset.view = node.id;
    const label = document.createElement('span');
    label.textContent = t(node.label);
    const count = document.createElement('span');
    count.className = 'm-count';
    button.append(label, count);
    button.addEventListener('click', () => {
      view = node.id;
      render();
    });
    li.append(button);
    parent.append(li);
    if (node.children) {
      const ul = document.createElement('ul');
      ul.setAttribute('role', 'group');
      for (const child of node.children) add(ul, child, depth + 1);
      li.append(ul);
    }
  };
  for (const node of TREE) add(tree, node, 0);
}

function selectedRecords() {
  return items.filter((r) => selected.has(r.id));
}

function renderToolbar() {
  const sel = selectedRecords();
  const enable = {
    resume: sel.some((r) => r.state === 'paused' || ((r.state === 'failed' || r.state === 'cancelled') && r.item.canResume)),
    stop: sel.some((r) => r.state === 'downloading'),
    stopAll: items.some((r) => r.state === 'downloading'),
    delete: sel.length > 0,
    deleteCompleted: items.some((r) => r.state === 'complete' || r.state === 'deleted'),
  };
  for (const [tool, on] of Object.entries(enable)) document.querySelector(`[data-tool="${tool}"]`).disabled = !on;
  const label = queuePaused ? t('mStartQueue') : t('mStopQueue');
  if ($('tool-queue-label').textContent !== label) $('tool-queue-label').textContent = label;
  $('tool-queue').setAttribute('aria-pressed', String(queuePaused));
}

function renderStatus() {
  const running = items.filter((r) => r.state === 'downloading');
  const speed = running.reduce((sum, r) => sum + (r.speed || 0), 0);
  const waiting = items.filter((r) => r.state === 'queued').length;
  const parts = [t('mCountItems', { count: shown.length })];
  if (selected.size) parts.push(t('mCountSelected', { count: selected.size }));
  if (running.length) parts.push(t('mCountRunning', { count: running.length, speed: t('speedPerSecond', { size: formatBytes(speed) }) }));
  if (waiting) parts.push(queuePaused ? t('mQueueStopped', { count: waiting }) : t('mQueueWaiting', { count: waiting }));
  const text = parts.join(' · ');
  if ($('m-status').textContent !== text) $('m-status').textContent = text;
}

function renderSortHeaders() {
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.setAttribute('aria-sort', th.dataset.sort === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }
}

// ---------- Selection ----------

function onRowClick(event) {
  const tr = event.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (event.shiftKey && anchor) {
    const ids = shown.map((r) => r.id);
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    if (!(event.ctrlKey || event.metaKey)) selected.clear();
    if (a >= 0) for (const rid of ids.slice(a, b + 1)) selected.add(rid);
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = id;
  } else {
    selected.clear();
    selected.add(id);
    anchor = id;
  }
  render();
}

function openRecord(rec) {
  if (!rec) return undefined;
  if (rec.state === 'complete') return itemAction('open', rec.item);
  if (rec.state === 'downloading' || rec.state === 'paused') return openProgressWindow(rec.item.id);
  return undefined;
}

function onKey(event) {
  if (event.target.closest('input, textarea, dialog')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    for (const r of shown) selected.add(r.id);
    render();
  } else if (event.key === 'Delete' && selected.size) {
    runTool('delete');
  } else if (event.key === 'Enter' && selected.size === 1) {
    openRecord(selectedRecords()[0]);
  } else if (event.key === 'Escape') {
    selected.clear();
    render();
  }
}

// ---------- Toolbar ----------

async function eachSelected(states, action) {
  for (const rec of selectedRecords()) {
    if (states.includes(rec.state)) await action(rec).catch(() => {});
  }
}

async function findWebTab() {
  const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  return tabs.find((tab) => /^https?:/i.test(tab.url || '')) || null;
}

async function confirmDelete(records) {
  const dialog = $('delete-dialog');
  $('delete-title').textContent = t('mDeleteTitle', { count: records.length });
  $('delete-files').checked = false;
  dialog.returnValue = '';
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  if (dialog.returnValue !== 'delete') return;
  const removeFiles = $('delete-files').checked;
  for (const rec of records) {
    try {
      if (rec.state === 'queued') {
        await chrome.runtime.sendMessage({ type: 'removeQueued', qid: rec.item.qid });
        continue;
      }
      if (rec.item.engine) {
        // Cancels a running or paused file first; the companion removes only its own partial file.
        // Finished companion files stay on disk: the browser cannot delete files it did not download.
        await itemAction('erase', rec.item);
      } else {
        if (rec.state === 'downloading' || rec.state === 'paused') await chrome.downloads.cancel(rec.item.id);
        // Only when asked, and only the file this download made.
        if (removeFiles && rec.state === 'complete') await chrome.downloads.removeFile(rec.item.id).catch(() => {});
        await chrome.downloads.erase({ id: rec.item.id });
      }
    } catch (err) {
      showToast(t('actionFailed', { error: err?.message || String(err) }), true);
    }
    selected.delete(rec.id);
  }
}

async function runTool(tool) {
  switch (tool) {
    case 'resume':
      return eachSelected(['paused', 'failed', 'cancelled'], (r) => itemAction('resume', r.item));
    case 'stop':
      return eachSelected(['downloading'], (r) => itemAction('pause', r.item));
    case 'stopAll':
      // Stop the queue first, or pausing would let the next waiting item start.
      await chrome.runtime.sendMessage({ type: 'setQueuePaused', paused: true });
      for (const rec of items) if (rec.state === 'downloading') await itemAction('pause', rec.item).catch(() => {});
      return undefined;
    case 'delete':
      return confirmDelete(selectedRecords());
    case 'deleteCompleted':
      for (const rec of items) {
        if (rec.state === 'complete' || rec.state === 'deleted') await itemAction('erase', rec.item);
      }
      return undefined;
    case 'queue':
      return chrome.runtime.sendMessage({ type: 'setQueuePaused', paused: !queuePaused });
    case 'scheduler':
      return chrome.tabs.create({ url: chrome.runtime.getURL('options.html#scheduler') });
    case 'grabber': {
      const tab = await findWebTab();
      if (!tab) return showToast(t('mNoWebTab'), true);
      return chrome.tabs.create({ url: chrome.runtime.getURL(`grabber.html?tab=${tab.id}`) });
    }
    case 'options':
      return chrome.runtime.openOptionsPage();
    default:
      return undefined;
  }
}

function showToast(message, isError = false) {
  const toast = $('dl-toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ---------- Start ----------

async function main() {
  await initPage();
  renderSortHeaders();

  for (const button of document.querySelectorAll('.m-tool[data-tool]')) {
    if (button.dataset.tool === 'add') continue; // handled by initAddLinks
    button.addEventListener('click', async () => {
      try {
        await runTool(button.dataset.tool);
      } catch (err) {
        showToast(t('actionFailed', { error: err?.message || String(err) }), true);
      }
      refresh();
    });
  }
  initAddLinks({ onAdded: refresh, showMessage: (text, isError) => showToast(text, isError) });

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      sort = sort.key === th.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.sort, dir: th.dataset.sort === 'name' || th.dataset.sort === 'address' ? 1 : -1 };
      renderSortHeaders();
      render();
    });
  }
  $('m-rows').addEventListener('click', onRowClick);
  $('m-rows').addEventListener('dblclick', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (tr) openRecord(items.find((r) => r.id === tr.dataset.id));
  });
  $('m-search').addEventListener('input', (event) => {
    search = event.target.value.trim().toLowerCase();
    render();
  });
  document.addEventListener('keydown', onKey);

  chrome.downloads.onCreated.addListener(refresh);
  chrome.downloads.onErased.addListener(refresh);
  chrome.downloads.onChanged.addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.queue || changes.queuePaused || changes.fileJobs)) refresh();
    if (area === 'sync' && changes.language) {
      buildTree();
      for (const row of rows.values()) row.last = {};
      render();
    }
  });

  await refresh();
  setInterval(refresh, REFRESH_MS);
}

main();
