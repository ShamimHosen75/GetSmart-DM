// Popup: tabs "Downloads" and "This page".
// Downloads tab: downloads-view.js. "+" panel: add-links.js.

import { initPage, openManager } from './common.js';
import { showUpdateLink } from './update-check.js';
import { initDownloadsView, refreshDownloads, showToast } from './downloads-view.js';
import { initAddLinks } from './add-links.js';
import { initPageView } from './page-view.js';

const TAB_KEY = 'popupTab'; // remembered per browser in chrome.storage.local

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
  initAddLinks({
    onAdded: () => {
      selectTab(document.getElementById('tab-downloads'));
      refreshDownloads();
    },
    showMessage: (message) => showToast(message),
  });
  initPageView({ showToast });

  document.getElementById('open-manager').addEventListener('click', async () => {
    await openManager();
    window.close();
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  showUpdateLink(document.getElementById('update-link'));
}

main();
