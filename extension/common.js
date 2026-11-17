// Shared helpers used by the service worker and the extension pages.
// Keep this file free of DOM access at module top level, because the
// service worker imports it too.

import { setLanguage, applyI18n } from './i18n.js';

/** Default values for every setting stored in chrome.storage.sync. */
export const DEFAULT_SETTINGS = Object.freeze({
  language: 'auto', // auto | en | bn
  theme: 'auto', // auto | light | dark
});

/** Read all settings, with defaults filled in for anything not saved yet. */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Save one or more settings. Unknown keys are ignored. */
export async function saveSettings(partial) {
  const clean = Object.fromEntries(
    Object.entries(partial).filter(([key]) => key in DEFAULT_SETTINGS)
  );
  await chrome.storage.sync.set(clean);
}

/** Write defaults for any setting that has never been saved. */
export async function seedDefaultSettings() {
  const stored = await chrome.storage.sync.get(null);
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => !(key in stored))
  );
  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }
}

/** Apply "auto" | "light" | "dark" to the page via data-theme on <html>. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme; // CSS falls back to prefers-color-scheme
  }
}

/**
 * Common start-up for every extension page: load settings, apply language and
 * theme, translate the DOM, and keep both in sync if settings change in
 * another page. Returns the settings it loaded.
 */
export async function initPage() {
  const settings = await getSettings();
  setLanguage(settings.language);
  applyTheme(settings.theme);
  applyI18n();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.language) {
      setLanguage(changes.language.newValue);
      applyI18n();
    }
    if (changes.theme) {
      applyTheme(changes.theme.newValue);
    }
  });

  return settings;
}
