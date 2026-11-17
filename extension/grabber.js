// Link grabber page: grabber.html?tab=<tabId>
//
// Collects a[href], img[src], video/audio[src] and source[src] from every
// frame of the tab with chrome.scripting.executeScript, lists them in a table
// with category chips and a text filter, and sends the selected ones to the
// download queue.

import { initPage, CATEGORIES, categoryOf, isHttpUrl, nameFromUrl } from './common.js';
import { t } from './i18n.js';

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

/** Pages where Chrome does not let extensions run scripts. */
const FORBIDDEN_SCHEMES = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|chrome-untrusted|devtools|view-source|chrome-search):/i;
const FORBIDDEN_PAGES = [
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
];

export function isForbiddenPage(url) {
  return FORBIDDEN_SCHEMES.test(url || '') || FORBIDDEN_PAGES.some((re) => re.test(url || ''));
}

/** Runs inside each frame of the page. Must be self-contained. */
function collectFromFrame() {
  const found = [];
  const add = (url, kind, text) => {
    if (url) found.push({ url: String(url), kind, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
  };
  document.querySelectorAll('a[href]').forEach((a) => add(a.href, 'link', a.textContent || a.title));
  document.querySelectorAll('img[src]').forEach((img) => add(img.currentSrc || img.src, 'image', img.alt));
  document.querySelectorAll('video[src], audio[src]').forEach((m) => add(m.currentSrc || m.src, m.tagName.toLowerCase(), m.title));
  document.querySelectorAll('source[src]').forEach((s) => add(s.src, (s.parentElement?.tagName || 'source').toLowerCase(), ''));
  return { title: document.title, items: found };
}

const KIND_RANK = { video: 3, audio: 3, image: 2, link: 1 };

/** Merge frame results: http(s) only, one entry per URL (media kinds win). */
export function mergeResults(frames) {
  const byUrl = new Map();
  for (const frame of frames) {
    for (const item of frame?.items || []) {
      if (!isHttpUrl(item.url)) continue;
      const url = item.url.split('#')[0];
      const known = byUrl.get(url);
      if (!known || (KIND_RANK[item.kind] || 0) > (KIND_RANK[known.kind] || 0)) {
        byUrl.set(url, { ...item, url, text: item.text || known?.text || '' });
      }
    }
  }
  return [...byUrl.values()].map((item) => {
    const name = nameFromUrl(item.url);
    return { ...item, name, category: categoryOf(name, item.kind === 'image' ? 'image/' : item.kind === 'video' ? 'video/' : item.kind === 'audio' ? 'audio/' : '') };
  });
}

const state = {
  tabId: null,
  items: [],
  rows: [], // { item, tr, checkbox }
  category: 'all',
  text: '',
};

const $ = (id) => document.getElementById(id);
let toastTimer = 0;

function showToast(message) {
  const toast = $('g-toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function showStatus(titleKey, bodyKey, vars) {
  $('g-content').hidden = true;
  $('g-status').hidden = false;
  $('g-status-title').textContent = t(titleKey, vars);
  $('g-status-body').textContent = bodyKey ? t(bodyKey, vars) : '';
}

async function scan() {
  state.tabId = Number(new URLSearchParams(location.search).get('tab'));
  if (!Number.isInteger(state.tabId) || state.tabId < 0) {
    return showStatus('grabTabClosedTitle', 'grabTabClosedBody');
  }

  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    $('g-source').textContent = '';
    return showStatus('grabTabClosedTitle', 'grabTabClosedBody');
  }
  $('g-source').textContent = tab.title ? `${tab.title} — ${tab.url || ''}` : tab.url || '';
  document.title = `${t('grabberTitle')} · ${tab.title || ''}`;

  // No url means Chrome hides it from us: a chrome://, edge:// or similar page.
  if (!tab.url || isForbiddenPage(tab.url)) {
    return showStatus('grabForbiddenTitle', 'grabForbiddenBody');
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, allFrames: true },
      func: collectFromFrame,
    });
  } catch {
    // Chrome refuses scripts on its own pages, the stores and some others.
    return showStatus('grabForbiddenTitle', 'grabForbiddenBody');
  }

  state.items = mergeResults(results.map((r) => r.result));
  if (!state.items.length) {
    return showStatus('grabNoLinksTitle', 'grabNoLinksBody');
  }

  $('g-status').hidden = true;
  $('g-content').hidden = false;
  buildRows();
  buildChips();
  applyFilter();
}

function buildRows() {
  const body = $('g-rows');
  const fragment = document.createDocumentFragment();
  state.rows = state.items.map((item) => {
    const tr = document.createElement('tr');
    const checkCell = document.createElement('td');
    checkCell.className = 'g-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', item.name);
    checkCell.append(checkbox);

    const nameCell = document.createElement('td');
    nameCell.className = 'g-name';
    nameCell.textContent = item.name;
    if (item.text && item.text !== item.name) nameCell.title = item.text;

    const typeCell = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'g-tag';
    tag.dataset.category = item.category;
    tag.textContent = t(CATEGORY_LABEL[item.category]);
    typeCell.append(tag);

    const urlCell = document.createElement('td');
    urlCell.className = 'g-url';
    urlCell.textContent = item.url;
    urlCell.title = item.url;

    tr.append(checkCell, nameCell, typeCell, urlCell);
    tr.addEventListener('click', (event) => {
      if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
      updateCount();
    });
    fragment.append(tr);
    return { item, tr, checkbox };
  });
  body.replaceChildren(fragment);
}

function buildChips() {
  const counts = { all: state.items.length };
  for (const item of state.items) counts[item.category] = (counts[item.category] || 0) + 1;
  const chips = $('g-chips');
  chips.replaceChildren();
  for (const category of ['all', ...CATEGORIES]) {
    if (!counts[category]) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.category = category;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(state.category === category));
    chip.textContent = `${t(CATEGORY_LABEL[category])} ${counts[category]}`;
    chip.addEventListener('click', () => {
      state.category = category;
      chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      applyFilter();
    });
    chips.append(chip);
  }
}

function isShown(row) {
  if (state.category !== 'all' && row.item.category !== state.category) return false;
  if (!state.text) return true;
  return `${row.item.name}\n${row.item.url}\n${row.item.text}`.toLowerCase().includes(state.text);
}

function applyFilter() {
  for (const row of state.rows) row.tr.hidden = !isShown(row);
  updateCount();
}

function updateCount() {
  const shown = state.rows.filter((r) => !r.tr.hidden);
  const selected = state.rows.filter((r) => r.checkbox.checked);
  const shownSelected = shown.filter((r) => r.checkbox.checked).length;
  const all = $('g-all');
  all.checked = shown.length > 0 && shownSelected === shown.length;
  all.indeterminate = shownSelected > 0 && shownSelected < shown.length;
  $('g-count').textContent = t('grabCount', { selected: selected.length, shown: shown.length });
  $('g-download').disabled = selected.length === 0;
}

async function downloadSelected() {
  const selected = state.rows.filter((r) => r.checkbox.checked);
  if (!selected.length) return;
  const reply = await chrome.runtime.sendMessage({ type: 'enqueue', items: selected.map((r) => ({ url: r.item.url })) });
  if (reply?.error) {
    showToast(t('actionFailed', { error: reply.error }));
    return;
  }
  for (const r of selected) r.checkbox.checked = false;
  updateCount();
  showToast(t('addedLinks', { count: reply.added }));
}

async function main() {
  await initPage();
  $('g-filter').addEventListener('input', () => {
    state.text = $('g-filter').value.trim().toLowerCase();
    applyFilter();
  });
  $('g-all').addEventListener('change', () => {
    const value = $('g-all').checked;
    for (const row of state.rows) if (!row.tr.hidden) row.checkbox.checked = value;
    updateCount();
  });
  $('g-download').addEventListener('click', downloadSelected);
  $('g-rescan').addEventListener('click', () => {
    state.category = 'all';
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.language && state.items.length) {
      buildRows();
      buildChips();
      applyFilter();
    }
  });
  await scan();
}

main();
