// Popup "This page" tab: media files the current tab played (M6) and, on
// video sites, the companion card (M7, see video-card.js).

import { t, applyI18n } from './i18n.js';
import { categoryOf, fileExtension, formatBytes, getSettings } from './common.js';
import { detectionBlockReason } from './media.js';
import { initVideoCard } from './video-card.js';

const NOTE_KEY = {
  off: 'noteDetectionOff',
  youtube: 'noteYouTube',
  drm: 'noteDrm',
  disabled: 'noteSiteDisabled',
};

let els;
let tab = null;
let media = [];
let onToast = () => {};
let reasonShown = null;

export async function initPageView({ showToast }) {
  onToast = showToast;
  els = {
    list: document.getElementById('media-list'),
    empty: document.getElementById('page-empty'),
    note: document.getElementById('page-note'),
    template: document.getElementById('media-row'),
  };
  tab = await currentTab();
  els.list.addEventListener('click', onClick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && tab && changes[`media:${tab.id}`]) load();
    if (area === 'sync') load();
  });
  await load();
  await initVideoCard({ currentTab: tab, showToast });
  return tab;
}

/** The tab the popup was opened on. popup.html?tab=<id> picks one (used by the tests). */
async function currentTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(forced) && forced > 0) {
    try {
      return await chrome.tabs.get(forced);
    } catch {
      return null;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active || null;
}

async function load() {
  const settings = await getSettings();
  const reason = tab?.url ? detectionBlockReason(tab.url, settings) : null;
  reasonShown = reason;
  els.note.hidden = !reason;
  els.note.textContent = reason ? t(NOTE_KEY[reason]) : '';

  const key = tab ? `media:${tab.id}` : null;
  media = key ? (await chrome.storage.session.get(key))[key] || [] : [];
  render();
}

function render() {
  const fragment = document.createDocumentFragment();
  for (const item of [...media].reverse()) {
    const row = els.template.content.firstElementChild.cloneNode(true);
    row.dataset.url = item.url;
    const type = row.querySelector('.dl-type');
    type.dataset.category = categoryOf(item.name, item.mime);
    type.textContent = (fileExtension(item.name) || '?').slice(0, 4).toUpperCase();
    const name = row.querySelector('.dl-name');
    name.textContent = item.name;
    name.title = `${item.name}\n${item.url}`;
    const size = formatBytes(item.size);
    row.querySelector('.m-size').textContent = size;
    row.querySelector('.m-size').hidden = !size;
    row.querySelector('.m-type').textContent = item.mime || '';
    applyI18n(row);
    fragment.append(row);
  }
  els.list.replaceChildren(fragment);
  els.empty.hidden = media.length > 0 || Boolean(reasonShown);
}

async function onClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = media.find((m) => m.url === button.closest('.media-row').dataset.url);
  if (!item) return;
  try {
    if (button.dataset.action === 'download') {
      const reply = await chrome.runtime.sendMessage({ type: 'enqueue', items: [{ url: item.url, filename: item.name }] });
      if (reply?.error) throw new Error(reply.error);
      onToast(t('addedLinks', { count: reply.added }));
    } else if (button.dataset.action === 'copy') {
      await navigator.clipboard.writeText(item.url);
      onToast(t('linkCopied'));
    }
  } catch (err) {
    onToast(t('actionFailed', { error: err?.message || String(err) }), true);
  }
}
