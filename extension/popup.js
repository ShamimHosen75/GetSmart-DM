// Popup: tabs "Downloads" and "This page".
// The Downloads tab lives in downloads-view.js; page media (M6) fills "This page" later.

import { initPage } from './common.js';
import { showUpdateLink } from './update-check.js';

const TAB_KEY = 'popupTab'; // remembered per browser in chrome.storage.local

import { initDownloadsView } from './downloads-view.js';

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((button) => {
    const selected = button === tab;
    button.setAttribute('aria-selected', String(selected));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
  });
  chrome.storage.local.set({ [TAB_KEY]: tab.id });
}

async function main() {
  await initPage();

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab));
  });

  const { [TAB_KEY]: lastTab } = await chrome.storage.local.get(TAB_KEY);
  const remembered = lastTab && document.getElementById(lastTab);
  if (remembered) selectTab(remembered);

  initDownloadsView();

  document.getElementById('open-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  showUpdateLink(document.getElementById('update-link'));
}

main();
