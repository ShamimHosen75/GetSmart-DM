// Companion bridge (M7). Runs in the service worker.
//
// Talks to the GetSmart DM companion app over native messaging
// (host "com.getsmartdm.host", protocol in shared/protocol.md, v1).
//
// - Connects on demand (the popup opening on a video site, or a video
//   download), sends `hello`, and waits for the companion's `hello`.
// - Video jobs live in chrome.storage.session ("videoJobs"), so the popup can
//   show progress and the list survives the service worker sleeping.
// - When the companion goes away, running jobs become errors ("companion
//   stopped"); the next request reconnects.
// - With no running job for a minute, the port is closed so the companion and
//   this worker can exit.

import { VIDEO_QUALITIES, cachedSettings, randomId } from './common.js';
import { isDrmSite, isYouTube, videoSiteStatus, VIDEO_SITES, YOUTUBE_HOSTS } from './sites.js';
import { addMenuBuilder } from './menus.js';
import { notifyAlways } from './queue.js';
import { setLanguage, t } from './i18n.js';

export const HOST_NAME = 'com.getsmartdm.host';
export const PROTOCOL_VERSION = 1;
const JOBS_KEY = 'videoJobs'; // { [id]: job }
const STATUS_KEY = 'companion'; // { status, info, error }
const HELLO_TIMEOUT_MS = 10000;
const IDLE_DISCONNECT_MS = 60000;
const PROGRESS_FIELDS = ['downloaded', 'total', 'speed', 'eta', 'filename', 'error', 'note'];
const FINAL_STATES = new Set(['done', 'error', 'canceled']);

// ---------- Jobs in chrome.storage.session ----------

let jobChain = Promise.resolve();
function withJobs(task) {
  const run = jobChain.then(async () => {
    const { [JOBS_KEY]: jobs = {} } = await chrome.storage.session.get(JOBS_KEY);
    const result = await task(jobs);
    await chrome.storage.session.set({ [JOBS_KEY]: jobs });
    return result;
  });
  jobChain = run.catch(() => {});
  return run;
}

export async function getJobs() {
  const { [JOBS_KEY]: jobs = {} } = await chrome.storage.session.get(JOBS_KEY);
  return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
}

/** Apply one `progress` message. Only fields that are present and not null are copied. */
export function applyProgress(job, msg) {
  if (msg.state) job.state = msg.state;
  for (const field of PROGRESS_FIELDS) {
    if (msg[field] !== undefined && msg[field] !== null) job[field] = msg[field];
  }
  job.updatedAt = Date.now();
  return job;
}

// ---------- NativeBridge ----------

class NativeBridge {
  constructor() {
    this.port = null;
    this.status = 'idle'; // idle | connecting | connected | missing | error
    this.info = null; // companion hello: { version, ytdlp, ffmpeg, dir }
    this.error = '';
    this.helloWaiters = [];
    this.helloTimer = 0;
    this.idleTimer = 0;
    this.missingAt = 0; // when connecting last failed with "not installed"
    this.listeners = []; // { connected(), progress(msg) -> bool handled, disconnect(), busy() -> Promise<bool> } (file-jobs.js)
  }

  /** Let another module handle some progress messages and know about disconnects. */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /** True if the companion speaks the optional feature (from hello `features`). */
  supports(feature) {
    return this.status === 'connected' && Array.isArray(this.info?.features) && this.info.features.includes(feature);
  }

  async saveStatus() {
    await chrome.storage.session.set({ [STATUS_KEY]: { status: this.status, info: this.info, error: this.error } });
  }

  /** Start connecting if not connected. Returns immediately. */
  connect() {
    if (this.port) return;
    this.status = 'connecting';
    this.error = '';
    this.saveStatus();
    try {
      this.port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      this.port = null;
      this.finishConnect('missing', err?.message || String(err));
      return;
    }
    this.port.onMessage.addListener((msg) => this.onMessage(msg));
    this.port.onDisconnect.addListener(() => this.onDisconnect());
    this.post({ type: 'hello' });
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (this.status === 'connecting') {
        this.finishConnect('error', 'The companion did not answer.');
        this.disconnect();
      }
    }, HELLO_TIMEOUT_MS);
  }

  /** Connect and wait for the companion's hello. Resolves true when connected. */
  ensureConnected() {
    if (this.status === 'connected' && this.port) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.helloWaiters.push(resolve);
      this.connect();
    });
  }

  finishConnect(status, error = '') {
    this.status = status;
    this.error = error;
    clearTimeout(this.helloTimer);
    this.saveStatus();
    const waiters = this.helloWaiters.splice(0);
    for (const resolve of waiters) resolve(status === 'connected');
  }

  post(msg) {
    if (!this.port) return false;
    try {
      this.port.postMessage({ ...msg, v: PROTOCOL_VERSION });
      return true;
    } catch {
      return false;
    }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.v !== PROTOCOL_VERSION) {
      console.warn('GetSmart DM: companion speaks protocol', msg.v, '- ignored');
      return;
    }
    if (msg.type === 'hello') {
      this.info = {
        version: msg.version ?? null,
        ytdlp: msg.ytdlp ?? null,
        ffmpeg: msg.ffmpeg ?? null,
        dir: msg.dir ?? null,
        downloads: msg.downloads ?? null,
        features: Array.isArray(msg.features) ? msg.features : [],
      };
      this.finishConnect('connected');
      for (const l of this.listeners) l.connected?.();
      this.scheduleIdle();
    } else if (msg.type === 'progress' && msg.id) {
      if (this.listeners.some((l) => l.progress?.(msg))) {
        this.scheduleIdle();
        return;
      }
      withJobs((jobs) => {
        const job = jobs[msg.id];
        if (!job) return;
        applyProgress(job, msg);
        if (FINAL_STATES.has(job.state)) notifyFinished(job);
      }).then(() => this.scheduleIdle());
    }
  }

  onDisconnect() {
    const reason = chrome.runtime.lastError?.message || '';
    this.port = null;
    clearTimeout(this.idleTimer);
    if (this.status === 'connecting' || this.status === 'idle') {
      const missing = /not found|not installed|forbidden|Specified native messaging host/i.test(reason);
      if (missing) this.missingAt = Date.now();
      this.finishConnect(missing ? 'missing' : 'error', reason);
    } else {
      this.finishConnect('idle', reason);
    }
    for (const l of this.listeners) l.disconnect?.();
    // Anything still running cannot finish without the companion.
    withJobs((jobs) => {
      for (const job of Object.values(jobs)) {
        if (job.state === 'running') {
          job.state = 'error';
          job.error = 'companion stopped';
          job.updatedAt = Date.now();
        }
      }
    });
  }

  disconnect() {
    clearTimeout(this.idleTimer);
    if (this.port) {
      const port = this.port;
      this.port = null;
      port.disconnect();
      this.finishConnect('idle');
    }
  }

  /** Close the port after a quiet minute with no running job. */
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      let running = (await getJobs()).some((job) => job.state === 'running');
      for (const l of this.listeners) if (!running && l.busy) running = await l.busy();
      if (running) this.scheduleIdle();
      else this.disconnect();
    }, IDLE_DISCONNECT_MS);
  }

  publicStatus() {
    return { status: this.status, error: this.error, ...(this.info || {}) };
  }
}

export const bridge = new NativeBridge();

async function notifyFinished(job) {
  const settings = await cachedSettings();
  if (!settings.notifications || job.state === 'canceled') return;
  setLanguage(settings.language);
  const name = (job.filename || job.title || job.url).split(/[\\/]/).pop();
  chrome.notifications.create(`gsdm-video-${job.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: t(job.state === 'done' ? 'notifDoneTitle' : 'notifFailedTitle'),
    message: job.state === 'error' && job.error ? `${name}\n${job.error}` : name,
    priority: 0,
  });
}

// ---------- Requests from the popup and menus ----------

/** State for the "This page" card. Starts a connection attempt if needed. */
export async function getVideoState({ url } = {}) {
  const settings = await cachedSettings();
  if (bridge.status !== 'connected' && bridge.status !== 'connecting') bridge.connect();
  return {
    site: url ? videoSiteStatus(url, settings.allowYouTube) : null,
    drm: url ? isDrmSite(url) : false,
    companion: bridge.publicStatus(),
    jobs: await getJobs(),
    defaultQuality: settings.defaultQuality,
  };
}

/** Start a video download through the companion. Returns { id } or { error }. */
export async function addVideo({ url, quality, title }) {
  const settings = await cachedSettings();
  setLanguage(settings.language);
  if (!/^https?:\/\//i.test(url || '')) return { error: t('videoErrBadUrl') };
  if (isDrmSite(url)) return { error: t('noteDrm') };
  const youtube = isYouTube(url);
  if (youtube && !settings.allowYouTube) return { error: t('videoErrYouTubeOff') };
  const q = VIDEO_QUALITIES.includes(quality) ? quality : settings.defaultQuality;

  if (youtube) {
    // One-time notice, the first time someone downloads from YouTube.
    const { ytNoticeShown } = await chrome.storage.local.get('ytNoticeShown');
    if (!ytNoticeShown) {
      await chrome.storage.local.set({ ytNoticeShown: true });
      await notifyAlways('ytNoticeTitle', 'ytNoticeBody');
    }
  }

  const connected = await bridge.ensureConnected();
  if (!connected) {
    return { error: bridge.status === 'missing' ? t('companionMissing') : t('companionError'), status: bridge.status };
  }

  const id = randomId();
  await withJobs((jobs) => {
    jobs[id] = { id, url, title: title || '', quality: q, state: 'running', downloaded: 0, createdAt: Date.now(), updatedAt: Date.now() };
  });
  const message = { type: 'add_video', id, url, quality: q };
  if (youtube) message.youtube = true; // only reached when the setting is on
  if (!bridge.post(message)) {
    await withJobs((jobs) => {
      Object.assign(jobs[id], { state: 'error', error: 'companion stopped' });
    });
    return { error: t('companionError') };
  }
  return { id };
}

export async function cancelVideo({ id }) {
  if (bridge.port && bridge.post({ type: 'cancel', id })) return { ok: true };
  await withJobs((jobs) => {
    if (jobs[id]?.state === 'running') Object.assign(jobs[id], { state: 'canceled', updatedAt: Date.now() });
  });
  return { ok: true };
}

export async function retryVideo({ id }) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return { error: 'not found' };
  const result = await addVideo({ url: job.url, quality: job.quality, title: job.title });
  if (result.id) await removeVideo({ id });
  return result;
}

export async function removeVideo({ id }) {
  await withJobs((jobs) => {
    if (jobs[id] && jobs[id].state !== 'running') delete jobs[id];
  });
  return { ok: true };
}

/** "C:\\a\\b" or "/home/a/b" -> a file:// URL for the folder. */
export function folderUrl(path) {
  let p = String(path || '').replace(/\\/g, '/');
  if (!p) return '';
  if (/^[a-z]:/i.test(p)) p = `/${p}`;
  if (!p.endsWith('/')) p += '/';
  return `file://${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** Open the folder the video was saved to (or the companion's default folder) in a tab. */
export async function openVideoFolder({ id }) {
  const job = (await getJobs()).find((j) => j.id === id);
  let dir = '';
  if (job?.filename && /[\\/]/.test(job.filename)) dir = job.filename.replace(/[\\/][^\\/]*$/, '');
  if (!dir) dir = bridge.info?.dir || '';
  if (!dir) return { error: t('companionError') };
  await chrome.tabs.create({ url: folderUrl(dir) });
  return { ok: true };
}

// ---------- Context menu ----------

const VIDEO_MENU_ID = 'gsdm-video';

function sitePatterns(domains) {
  return domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

addMenuBuilder({
  ids: [VIDEO_MENU_ID],
  build: async (settings) => {
    const domains = settings.allowYouTube ? [...VIDEO_SITES, ...YOUTUBE_HOSTS] : VIDEO_SITES;
    chrome.contextMenus.create({
      id: VIDEO_MENU_ID,
      title: t('menuDownloadVideo'),
      contexts: ['page', 'video', 'frame'],
      documentUrlPatterns: sitePatterns(domains),
    });
  },
  onClick: async (info, tab) => {
    const settings = await cachedSettings();
    const result = await addVideo({ url: info.pageUrl || tab?.url, quality: settings.defaultQuality, title: tab?.title });
    if (result.error) {
      const key = result.status === 'missing' ? 'companionMissing' : 'companionError';
      await notifyAlways('notifFailedTitle', result.status ? key : 'videoErrGeneric', { error: result.error });
    }
  },
});

// ---------- Messages ----------

export const videoHandlers = {
  getVideoState,
  addVideo,
  cancelVideo,
  retryVideo,
  removeVideo,
  openVideoFolder,
};
