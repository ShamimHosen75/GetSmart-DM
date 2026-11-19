// "Update available" hint for the popup footer.
//
// Once a day at most, fetch <SITE_URL>/version.json ({"version":"x.y.z"},
// written by scripts/release.py) and compare it with this extension's version.
// The result is cached in chrome.storage.local, so opening the popup again the
// same day costs no network request. Any failure (offline, 404, bad JSON) just
// means no hint is shown.

// The download website. Set this once the domain is decided, e.g.
// 'https://sidm.example'. While it is empty, no check is made.
export const SITE_URL = 'https://sidm.online';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'updateCheck'; // { checkedAt: ms, latest: "x.y.z" | null }

/** Compare two "x.y.z" strings: >0 if a is newer, <0 if older, 0 if equal. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function fetchLatestVersion(siteUrl) {
  const response = await fetch(`${siteUrl.replace(/\/+$/, '')}/version.json`, { cache: 'no-store' });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data.version === 'string' && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : null;
}

/**
 * Returns the newer version string if the website has one, otherwise null.
 * Hits the network at most once per CHECK_EVERY_MS.
 */
export async function getAvailableUpdate({ siteUrl = SITE_URL, now = Date.now() } = {}) {
  if (!siteUrl) return null;
  const current = chrome.runtime.getManifest().version;
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);

  let latest = cache && cache.latest;
  if (!cache || !(now - cache.checkedAt < CHECK_EVERY_MS) || cache.checkedAt > now) {
    try {
      latest = await fetchLatestVersion(siteUrl);
    } catch (err) {
      latest = null;
    }
    await chrome.storage.local.set({ [CACHE_KEY]: { checkedAt: now, latest } });
  }
  return latest && compareVersions(latest, current) > 0 ? latest : null;
}

/** Show the footer link in the popup when an update exists. */
export async function showUpdateLink(link) {
  const latest = await getAvailableUpdate();
  if (!latest) return;
  link.href = SITE_URL;
  link.title = latest;
  link.hidden = false;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: SITE_URL });
    window.close();
  });
}
