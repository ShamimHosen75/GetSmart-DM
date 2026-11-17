// Settings page (M8). Every control saves to chrome.storage.sync on change.
//
// Controls declare what they edit with data-setting (the key) and data-kind:
//   (none) select/text value, "bool" checkbox, "int" number clamped to
//   data-min..data-max, "sites" textarea with one host per line.
// "Allow YouTube" is special: turning it on needs the Terms of Service dialog.

import { initPage, saveSettings, getSettings } from './common.js';
import { normaliseSite } from './sites.js';
import { t } from './i18n.js';

let toastTimer = 0;

function showSaved() {
  const toast = document.getElementById('toast');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

function readControl(input) {
  switch (input.dataset.kind) {
    case 'bool':
      return input.checked;
    case 'int': {
      const min = Number(input.dataset.min);
      const max = Number(input.dataset.max);
      const value = Math.round(Number(input.value));
      return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
    }
    case 'sites':
      return [...new Set(input.value.split(/[\s,]+/).map(normaliseSite).filter(Boolean))];
    case 'days':
      return [...input.querySelectorAll('input:checked')].map((box) => Number(box.value)).sort();
    default:
      return input.value;
  }
}

function writeControl(input, value) {
  switch (input.dataset.kind) {
    case 'bool':
      input.checked = Boolean(value);
      break;
    case 'sites':
      input.value = (value || []).join('\n');
      break;
    case 'days':
      for (const box of input.querySelectorAll('input')) box.checked = (value || []).includes(Number(box.value));
      break;
    default:
      input.value = value;
  }
}

function bindSettings(settings) {
  document.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    writeControl(input, settings[key]);
    input.addEventListener('change', async () => {
      const value = readControl(input);
      writeControl(input, value); // show the cleaned value (clamped number, tidy site list)
      await saveSettings({ [key]: value });
      showSaved();
    });
  });
}

function bindYouTube(settings) {
  const toggle = document.getElementById('allowYouTube');
  const dialog = document.getElementById('yt-dialog');
  toggle.checked = settings.allowYouTube;
  toggle.addEventListener('change', async () => {
    if (!toggle.checked) {
      await saveSettings({ allowYouTube: false });
      showSaved();
      return;
    }
    toggle.checked = false; // only after the warning is accepted
    dialog.returnValue = '';
    dialog.showModal();
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue === 'accept') {
      toggle.checked = true;
      await saveSettings({ allowYouTube: true });
      showSaved();
    }
  });
}

async function showCompanion() {
  const box = document.getElementById('companion-status');
  const text = document.getElementById('companion-text');
  const detail = document.getElementById('companion-detail');
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'getVideoState', url: '' });
  } catch {
    state = null;
  }
  const c = state?.companion || { status: 'idle' };
  box.dataset.status = c.status;
  const labels = {
    connected: c.version ? t('companionConnectedVersion', { version: c.version }) : t('companionConnected'),
    connecting: t('companionConnecting'),
    missing: t('companionMissing'),
    error: t('companionError'),
    idle: t('companionIdle'),
  };
  text.textContent = labels[c.status] || labels.idle;
  if (c.status === 'connected') {
    detail.textContent = t('companionDetail', { ytdlp: c.ytdlp || '—', ffmpeg: c.ffmpeg || '—', dir: c.dir || '—' });
  } else if (c.status === 'missing') {
    detail.textContent = t('companionMissingHelp');
  } else {
    detail.textContent = t('setCompanionHint');
  }
  if (c.status === 'connecting' || c.status === 'idle') setTimeout(showCompanion, 1000);
}

async function main() {
  await initPage();
  const settings = await getSettings();
  bindSettings(settings);
  bindYouTube(settings);

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;
  document.getElementById('extension-id').textContent = chrome.runtime.id;

  // Another page (or the popup) changed a setting: show it here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      const input = document.querySelector(`[data-setting="${key}"]`);
      if (input && document.activeElement !== input) writeControl(input, change.newValue);
      if (key === 'allowYouTube') document.getElementById('allowYouTube').checked = Boolean(change.newValue);
    }
    if (changes.language) showCompanion();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.companion) showCompanion();
  });
  showCompanion();
}

main();
