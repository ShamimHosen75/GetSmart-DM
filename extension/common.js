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

// ---------- Files and categories ----------

/** Category ids, in the order the UI lists them. */
export const CATEGORIES = ['video', 'music', 'documents', 'programs', 'archives', 'images', 'other'];

const EXTENSION_CATEGORY = new Map();
for (const [category, list] of Object.entries({
  video: 'mp4 m4v mkv webm avi mov wmv flv f4v mpg mpeg 3gp 3g2 m2ts mts ogv',
  music: 'mp3 m4a aac wav flac ogg oga opus wma aiff aif alac mka',
  documents: 'pdf doc docx docm xls xlsx xlsm ppt pptx odt ods odp rtf txt csv tsv epub mobi md json xml',
  programs: 'exe msi msix msixbundle appx appxbundle apk xapk dmg pkg deb rpm appimage bat cmd ps1 jar',
  archives: 'zip rar 7z tar gz tgz bz2 tbz2 xz txz zst lz lzma cab iso img arj',
  images: 'jpg jpeg jfif png gif webp bmp svg ico tif tiff heic heif avif',
})) {
  for (const ext of list.split(' ')) EXTENSION_CATEGORY.set(ext, category);
}

const MIME_CATEGORY = [
  [/^video\//, 'video'],
  [/^audio\//, 'music'],
  [/^image\//, 'images'],
  [/^text\/|^application\/(pdf|msword|rtf|epub|json|xml)|^application\/vnd\.(ms-|openxmlformats|oasis\.opendocument)/, 'documents'],
  [/^application\/(zip|x-zip|x-rar|vnd\.rar|x-7z|gzip|x-gzip|x-tar|x-bzip|x-xz|zstd|x-iso9660)/, 'archives'],
  [/^application\/(x-msdownload|x-msi|x-ms-installer|x-msdos-program|vnd\.microsoft\.portable-executable|vnd\.android\.package-archive|x-apple-diskimage|x-debian-package|x-rpm)/, 'programs'],
];

/** Last path segment of a Windows or POSIX path. */
export function baseName(path) {
  return String(path || '').split(/[\\/]/).pop();
}

/** Lower-case file extension without the dot, or "". */
export function fileExtension(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Category id for a file: by extension first, then by MIME type. */
export function categoryOf(name, mime = '') {
  const byExt = EXTENSION_CATEGORY.get(fileExtension(name));
  if (byExt) return byExt;
  const type = String(mime).toLowerCase();
  for (const [pattern, category] of MIME_CATEGORY) {
    if (pattern.test(type)) return category;
  }
  return 'other';
}

/** A display name for a URL: its last path segment, decoded, or the host. */
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return String(url || '');
  }
}

// ---------- Formatting ----------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 -> "1.5 KB". Returns "" for unknown (negative or non-numeric) sizes. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Seconds -> "0:42", "12:05" or "1:02:09". Returns "" when unknown. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
