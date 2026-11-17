// GetSmart DM service worker (Manifest V3, ES module).
// M2: default settings + toolbar badge with the number of active downloads.
// Queue, menus, media detection and the companion bridge come in later milestones.

import { seedDefaultSettings } from './common.js';

const BADGE_COLOR = '#6c3ff0';

chrome.runtime.onInstalled.addListener(() => {
  seedDefaultSettings().catch((err) => console.error('GetSmart DM: could not save default settings', err));
  updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

// ---------- Badge: number of active (running, not paused) downloads ----------

let badgeTimer = 0;

/** Recount active downloads. Coalesces bursts of download events into one count. */
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const active = await chrome.downloads.search({ state: 'in_progress', paused: false });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      }
      await chrome.action.setBadgeText({ text: active.length ? String(active.length) : '' });
    } catch (err) {
      console.error('GetSmart DM: badge update failed', err);
    }
  }, 150);
}

chrome.downloads.onCreated.addListener(updateBadge);
chrome.downloads.onErased.addListener(updateBadge);
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused) updateBadge();
});
