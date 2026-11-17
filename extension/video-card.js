// Popup "This page": the companion card on video sites and the list of
// video downloads (M7). State comes from the service worker (getVideoState);
// it refreshes whenever the jobs or the companion status change.

import { t } from './i18n.js';
import { VIDEO_QUALITIES, formatBytes, formatDuration } from './common.js';

const QUALITY_LABEL = {
  best: 'qualityBest',
  1080: 'quality1080',
  720: 'quality720',
  480: 'quality480',
  360: 'quality360',
  audio: 'qualityAudio',
};

const STATE_LABEL = {
  running: 'videoStateRunning',
  done: 'videoStateDone',
  error: 'videoStateError',
  canceled: 'videoStateCanceled',
};

const ACTIONS = {
  running: ['cancel'],
  done: ['folder', 'remove'],
  error: ['retry', 'remove'],
  canceled: ['retry', 'remove'],
};

const ICONS = {
  cancel: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  retry: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4',
  remove: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
  folder: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
};
const ACTION_LABEL = { cancel: 'actCancel', retry: 'actRetry', remove: 'actRemove', folder: 'actOpenFolder' };
const MESSAGE = { cancel: 'cancelVideo', retry: 'retryVideo', remove: 'removeVideo', folder: 'openVideoFolder' };

let card;
let tab;
let toast = () => {};
let state = null;
let chosenQuality = null;
let busy = false;

export async function initVideoCard({ currentTab, showToast }) {
  card = document.getElementById('video-card');
  tab = currentTab;
  toast = showToast;
  card.addEventListener('click', onClick);
  card.addEventListener('change', (event) => {
    if (event.target.id === 'v-quality') chosenQuality = event.target.value;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'session' && (changes.videoJobs || changes.companion)) || (area === 'sync' && (changes.allowYouTube || changes.language))) {
      refresh();
    }
  });
  await refresh();
}

async function refresh() {
  state = await chrome.runtime.sendMessage({ type: 'getVideoState', url: tab?.url || '' });
  if (!state || state.error) return;
  if (!chosenQuality) chosenQuality = state.defaultQuality;
  render();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function companionLine(companion) {
  const line = el('div', 'v-status');
  line.dataset.status = companion.status;
  const dot = el('span', 'v-dot');
  let text;
  let help = '';
  switch (companion.status) {
    case 'connected':
      text = companion.version ? t('companionConnectedVersion', { version: companion.version }) : t('companionConnected');
      if (!companion.ytdlp) help = t('companionNoYtdlp');
      break;
    case 'connecting':
      text = t('companionConnecting');
      break;
    case 'missing':
      text = t('companionMissing');
      help = t('companionMissingHelp');
      break;
    case 'error':
      text = t('companionError');
      break;
    default:
      text = t('companionIdle');
  }
  line.append(dot, el('span', '', text));
  const wrap = el('div');
  wrap.append(line);
  if (help) wrap.append(el('p', 'v-help', help));
  return wrap;
}

function controls() {
  const row = el('div', 'v-controls');
  const label = el('label', 'v-label', t('videoQuality'));
  label.htmlFor = 'v-quality';
  const select = el('select', 'select');
  select.id = 'v-quality';
  for (const q of VIDEO_QUALITIES) {
    const option = el('option', '', t(QUALITY_LABEL[q]));
    option.value = q;
    select.append(option);
  }
  select.value = chosenQuality || 'best';
  const button = el('button', 'primary-button', t('downloadVideo'));
  button.type = 'button';
  button.id = 'v-download';
  button.disabled = busy || state.companion.status === 'missing';
  row.append(label, select, button);
  return row;
}

function jobRow(job) {
  const li = el('li', 'dl-row v-job');
  li.dataset.id = job.id;
  li.dataset.state = job.state === 'done' ? 'complete' : job.state === 'running' ? 'downloading' : job.state === 'canceled' ? 'cancelled' : 'failed';
  const type = el('div', 'dl-type', job.quality === 'audio' ? 'AUD' : 'VID');
  type.dataset.category = job.quality === 'audio' ? 'music' : 'video';
  const body = el('div', 'dl-body');
  const name = (job.filename || job.title || job.url).split(/[\\/]/).pop();
  const nameEl = el('div', 'dl-name', name);
  nameEl.title = job.url;
  const progress = el('div', 'dl-progress');
  const bar = el('div', 'dl-bar');
  const known = job.total > 0;
  if (!known && job.state === 'running') progress.classList.add('indeterminate');
  bar.style.width = `${job.state === 'done' ? 100 : known ? Math.min(100, (job.downloaded / job.total) * 100) : 0}%`;
  progress.append(bar);

  const meta = el('div', 'dl-meta');
  let stateText = t(STATE_LABEL[job.state] || 'videoStateRunning');
  if (job.state === 'error' && job.error) stateText += `: ${job.error === 'companion stopped' ? t('companionStopped') : job.error}`;
  meta.append(el('span', 'dl-state', stateText));
  if (job.state === 'running') {
    if (job.downloaded > 0) meta.append(el('span', '', known ? t('sizeOf', { done: formatBytes(job.downloaded), total: formatBytes(job.total) }) : formatBytes(job.downloaded)));
    if (job.speed > 0) meta.append(el('span', '', t('speedPerSecond', { size: formatBytes(job.speed) })));
    const eta = formatDuration(job.eta);
    if (eta) meta.append(el('span', '', t('timeLeft', { time: eta })));
  } else if (job.state === 'done' && job.total > 0) {
    meta.append(el('span', '', formatBytes(job.total)));
  }
  body.append(nameEl, progress, meta);
  if (job.note) body.append(el('div', 'v-note', job.note));

  const actions = el('div', 'dl-actions');
  for (const action of ACTIONS[job.state] || []) {
    const button = el('button', 'icon-button small');
    button.type = 'button';
    button.dataset.vaction = action;
    button.title = t(ACTION_LABEL[action]);
    button.setAttribute('aria-label', button.title);
    button.append(icon(ICONS[action]));
    actions.append(button);
  }
  li.append(type, body, actions);
  return li;
}

function render() {
  const parts = [];
  if (state.site === 'video') {
    const box = el('div', 'v-box');
    box.append(el('div', 'v-title', t('videoCardTitle')), companionLine(state.companion), controls());
    parts.push(box);
  } else if (state.site === 'youtube-off') {
    const box = el('div', 'v-box');
    box.append(el('div', 'v-title', t('videoCardTitle')), el('p', 'v-help', t('youTubeOffCard')));
    parts.push(box);
  }
  if (state.jobs.length) {
    parts.push(el('div', 'v-section', t('videoJobsTitle')));
    const list = el('ul', 'dl-list v-jobs');
    for (const job of state.jobs) list.append(jobRow(job));
    parts.push(list);
  }
  card.replaceChildren(...parts);
  card.hidden = parts.length === 0;
}

async function onClick(event) {
  const download = event.target.closest('#v-download');
  if (download) {
    busy = true;
    render();
    const reply = await chrome.runtime.sendMessage({ type: 'addVideo', url: tab.url, quality: chosenQuality, title: tab.title });
    busy = false;
    if (reply?.error) toast(reply.error, true);
    else toast(t('videoAdded'));
    return refresh();
  }
  const button = event.target.closest('button[data-vaction]');
  if (!button) return undefined;
  const id = button.closest('.v-job').dataset.id;
  const reply = await chrome.runtime.sendMessage({ type: MESSAGE[button.dataset.vaction], id });
  if (reply?.error) toast(reply.error, true);
  return refresh();
}
