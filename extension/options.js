// Options page. M1: language, theme and an About card.
// The full settings page is built in M8. Settings save on change.

import { initPage, saveSettings } from './common.js';

let toastTimer = 0;

function showSaved() {
  const toast = document.getElementById('toast');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

async function main() {
  const settings = await initPage();

  document.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    input.value = settings[key];
    input.addEventListener('change', async () => {
      await saveSettings({ [key]: input.value });
      showSaved();
    });
  });

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;
  document.getElementById('extension-id').textContent = chrome.runtime.id;
}

main();
