// Popup "+" panel: paste links, one per line, and send them to the queue.

import { t } from './i18n.js';
import { isHttpUrl } from './common.js';

/** Split pasted text into http(s) URLs and a count of skipped lines. */
export function parseLinks(text) {
  const urls = [];
  let skipped = 0;
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let url = null;
    try {
      url = new URL(line).href;
    } catch {
      url = null;
    }
    if (!url || !isHttpUrl(url)) {
      skipped += 1;
    } else if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return { urls, skipped };
}

export function initAddLinks({ onAdded, showMessage }) {
  const panel = document.getElementById('add-panel');
  const toggle = document.getElementById('open-add');
  const input = document.getElementById('add-urls');
  const hint = document.getElementById('add-hint');

  const resetHint = () => {
    hint.textContent = t('addLinksHint');
    hint.classList.remove('error');
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      resetHint();
      input.focus();
    }
  };

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  document.getElementById('add-cancel').addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) panel.requestSubmit();
  });

  panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { urls, skipped } = parseLinks(input.value);
    if (!urls.length) {
      hint.textContent = t('nothingToAdd');
      hint.classList.add('error');
      return;
    }
    const reply = await chrome.runtime.sendMessage({ type: 'enqueue', items: urls.map((url) => ({ url })) });
    if (reply?.error) {
      hint.textContent = t('actionFailed', { error: reply.error });
      hint.classList.add('error');
      return;
    }
    let message = t('addedLinks', { count: reply.added });
    if (skipped) message += ` · ${t('skippedLines', { count: skipped })}`;
    input.value = '';
    setOpen(false);
    showMessage(message);
    onAdded();
  });
}
