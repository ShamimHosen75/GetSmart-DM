// GetSmart DM service worker (Manifest V3, ES module).
// M1: skeleton only. Download list, queue, menus, media detection and the
// companion bridge are added in later milestones.

import { seedDefaultSettings } from './common.js';

chrome.runtime.onInstalled.addListener(() => {
  seedDefaultSettings().catch((err) => console.error('GetSmart DM: could not save default settings', err));
});
