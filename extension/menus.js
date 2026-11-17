// Context menus (M4, plus the video entry from M7).
// Runs in the service worker. Menus are created on install/update and kept
// in sync with settings that change which entries apply.

import { enqueue, notifyAlways } from './queue.js';
import { cachedSettings, isHttpUrl } from './common.js';
import { setLanguage, t } from './i18n.js';

export const MENU = {
  link: 'gsdm-link',
  media: 'gsdm-media',
  grab: 'gsdm-grab',
};

/** Extra menu builders added by later modules (the M7 video entry). */
const extraBuilders = [];
const extraClickHandlers = {};

/**
 * Register more entries. `ids` are known up front so clicks still route after
 * the service worker restarts (menus persist, in-memory state does not).
 */
export function addMenuBuilder({ ids, build, onClick }) {
  extraBuilders.push(build);
  for (const id of ids) extraClickHandlers[id] = onClick;
}

/** (Re)create all menu entries in the current language. */
export async function buildMenus() {
  const settings = await cachedSettings();
  setLanguage(settings.language);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU.link, title: t('menuDownloadLink'), contexts: ['link'] });
  chrome.contextMenus.create({ id: MENU.media, title: t('menuDownloadMedia'), contexts: ['image', 'video', 'audio'] });
  chrome.contextMenus.create({ id: MENU.grab, title: t('menuGrabLinks'), contexts: ['page'] });
  for (const build of extraBuilders) await build(settings);
}

/** Queue one URL from a menu, or explain why it cannot be saved. */
async function downloadFromMenu(url) {
  if (/^(blob|data):/i.test(url || '')) {
    return notifyAlways('notifCannotSaveTitle', 'notifBlobBody');
  }
  if (!isHttpUrl(url)) {
    return notifyAlways('notifCannotSaveTitle', 'notifNotHttpBody');
  }
  return enqueue([{ url }]);
}

async function onClicked(info, tab) {
  switch (info.menuItemId) {
    case MENU.link:
      return downloadFromMenu(info.linkUrl);
    case MENU.media:
      return downloadFromMenu(info.srcUrl);
    case MENU.grab:
      return openGrabber(tab);
    default: {
      const handler = extraClickHandlers[info.menuItemId];
      return handler ? handler(info, tab) : undefined;
    }
  }
}

export function openGrabber(tab) {
  if (!tab || tab.id == null || tab.id < 0) return undefined;
  return chrome.tabs.create({ url: chrome.runtime.getURL(`grabber.html?tab=${tab.id}`), index: tab.index + 1 });
}

export function registerMenuListeners() {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    onClicked(info, tab).catch((err) => console.error('GetSmart DM: menu action failed', err));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.language || changes.allowYouTube)) buildMenus();
  });
}
