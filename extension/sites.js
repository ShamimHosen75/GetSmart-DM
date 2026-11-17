// Site lists shared by the service worker and the popup.

/** Sites where the companion app can download the video on the page (M7). */
export const VIDEO_SITES = [
  'facebook.com',
  'fb.watch',
  'x.com',
  'twitter.com',
  'instagram.com',
  'tiktok.com',
  'vimeo.com',
  'dailymotion.com',
  'reddit.com',
  'twitch.tv',
  'vk.com',
  'ok.ru',
  'bilibili.com',
  'streamable.com',
];

/** YouTube: through the companion while the allowYouTube setting is on (default on). */
export const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'];

/**
 * DRM services: never detected, never downloaded. We refuse instead of trying
 * to work around protection.
 */
export const DRM_HOSTS = [
  'netflix.com',
  'nflxvideo.net',
  'primevideo.com',
  'amazonvideo.com',
  'disneyplus.com',
  'disney-plus.net',
  'hotstar.com',
  'hulu.com',
  'max.com',
  'hbomax.com',
  'peacocktv.com',
  'paramountplus.com',
  'tv.apple.com',
  'music.apple.com',
  'spotify.com',
  'scdn.co',
  'deezer.com',
  'tidal.com',
  'crunchyroll.com',
];

/** Host of a URL in lower case, without "www.", or "" if it has none. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True if `host` is one of `domains` or a subdomain of one. */
export function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return Boolean(h) && domains.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isYouTube(url) {
  return hostMatches(hostOf(url), YOUTUBE_HOSTS);
}

export function isDrmSite(url) {
  return hostMatches(hostOf(url), DRM_HOSTS);
}

/**
 * "video" if the companion can take this page, "youtube-off" for YouTube while
 * the setting is off, otherwise null.
 */
export function videoSiteStatus(url, allowYouTube) {
  if (isYouTube(url)) return allowYouTube ? 'video' : 'youtube-off';
  return hostMatches(hostOf(url), VIDEO_SITES) ? 'video' : null;
}

/** Normalise one "disabled sites" entry ("https://www.Example.com/x" -> "example.com"). */
export function normaliseSite(entry) {
  const text = String(entry || '').trim().toLowerCase();
  if (!text) return '';
  const host = text.includes('://') ? hostOf(text) : text.split('/')[0].replace(/^www\./, '');
  const clean = host.replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) || clean === 'localhost' ? clean : '';
}
