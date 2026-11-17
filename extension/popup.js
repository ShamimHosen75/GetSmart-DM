// Popup: tabs "Downloads" and "This page".
// M1: shell only. The download list (M2) and page media (M6) fill the panels later.

import { initPage } from './common.js';

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

  document.getElementById('open-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

main();
