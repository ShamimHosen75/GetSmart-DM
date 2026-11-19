// In-browser video downloads (M15). Service worker side.
//
// No companion app needed: media.js tells us about the streams a tab plays
// (HLS playlists, DASH manifests, and pieces of MP4 files that players such
// as Facebook's fetch bit by bit). When the video button or the popup asks,
// the offscreen page (offscreen.js) turns them into choices ("720p"), and on
// a click it downloads every piece and joins video and audio into one MP4.
// The finished file is saved with chrome.downloads into SIDM/Video.
//
// Jobs live in chrome.storage.local "streamJobs" while they download; when
// the file is handed to Chrome the job is removed and the normal browser
// download takes its place in the lists.

import { cachedSettings, fileExtension, nameFromUrl, randomId, sanitizeFilename } from './common.js';
import { hostOf, hostMatches, isDrmSite, isYouTube } from './sites.js';
import { saveFile } from './queue.js';

export const STREAM_JOBS_KEY = 'streamJobs';
export const STREAM_PREFIX = 'stream-';
const MAX_STREAMS = 40;
const BLOBS_KEY = 'streamBlobs'; // storage.session: { [downloadId]: blobUrl }

const HLS_MIME = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);
const DASH_MIME = new Set(['application/dash+xml']);
const PIECE_MIME = new Set(['video/mp4', 'audio/mp4', 'application/octet-stream', 'binary/octet-stream']);
const RANGE_PARAMS = ['bytestart', 'byteend', 'range'];
// Hosts whose streams are signed or ciphered per session: the browser alone cannot save them.
const NEEDS_COMPANION = ['googlevideo.com', 'youtube.com', 'youtu.be'];

const streamsKey = (tabId) => `streams:${tabId}`;
const optionsKey = (tabId) => `streamOptions:${tabId}`;

// ---------- Which responses are streams (pure, exported for tests) ----------

function withoutRangeParams(url) {
  try {
    const u = new URL(url);
    let had = false;
    for (const p of RANGE_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.delete(p);
        had = true;
      }
    }
    return { url: u.href, had };
  } catch {
    return { url, had: false };
  }
}

/**
 * Is this response a stream the extension can download by itself?
 * Returns { kind: 'hls' | 'dash' | 'piece', url, total } or null.
 */
export function classifyStream({ url, type, statusCode, headers }) {
  if (statusCode < 200 || statusCode >= 300) return null;
  if (hostMatches(hostOf(url), NEEDS_COMPANION)) return null;
  const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = fileExtension(nameFromUrl(url));
  if (HLS_MIME.has(mime) || ext === 'm3u8') return { kind: 'hls', url, total: -1 };
  if (DASH_MIME.has(mime) || ext === 'mpd') return { kind: 'dash', url, total: -1 };
  if (!PIECE_MIME.has(mime) || ['ts', 'm4s', 'cmfv', 'cmfa', 'm4f', 'webm'].includes(ext)) return null;
  if (mime.includes('octet') && !['mp4', 'm4a', 'm4v'].includes(ext)) return null;
  const clean = withoutRangeParams(url);
  const partial = statusCode === 206 && (type === 'xmlhttprequest' || type === 'other');
  if (!clean.had && !partial) return null;
  const total = Number(/\/(\d+)\s*$/.exec(headers['content-range'] || '')?.[1]) || -1;
  return { kind: 'piece', url: clean.url, total };
}

/** True when a page's own address has byte-range parameters (it is a piece, not a file). */
export function hasRangeParams(url) {
  return withoutRangeParams(url).had;
}

// ---------- Per-tab list of streams ----------

let chain = Promise.resolve();
function locked(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

export async function getTabStreams(tabId) {
  const key = streamsKey(tabId);
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  return list;
}

/** Remember a stream for a tab (media.js calls this from webRequest). */
export async function recordStream(tabId, stream, pageUrl) {
  const settings = await cachedSettings();
  if (!settings.showVideoButton) return;
  for (const url of [pageUrl, stream.url]) {
    if (isDrmSite(url) || isYouTube(url) || hostMatches(hostOf(url), settings.disabledSites || [])) return;
  }
  await locked(async () => {
    const list = await getTabStreams(tabId);
    const old = list.find((s) => s.url === stream.url);
    if (old) {
      old.at = Date.now();
      if (stream.total > 0) old.total = stream.total;
    } else {
      list.push({ ...stream, at: Date.now() });
      while (list.length > MAX_STREAMS) list.shift();
    }
    await chrome.storage.session.set({ [streamsKey(tabId)]: list });
  });
}

/**
 * Forget a tab's streams. With `since` (the time a new page was committed),
 * streams seen after it are kept: webRequest can report them before the
 * navigation event arrives.
 */
export function clearTabStreams(tabId, since = Infinity) {
  return locked(async () => {
    await chrome.storage.session.remove(optionsKey(tabId));
    const keep = Number.isFinite(since) ? (await getTabStreams(tabId)).filter((s) => s.at >= since) : [];
    if (keep.length) await chrome.storage.session.set({ [streamsKey(tabId)]: keep });
    else await chrome.storage.session.remove(streamsKey(tabId));
  });
}

// ---------- Offscreen page ----------

let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Download video pieces and join them into one file.',
  }).finally(() => {
    creating = null;
  });
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  // A page that was just created may not be listening yet: then the answer is undefined.
  for (let attempt = 0; ; attempt += 1) {
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    if (reply !== undefined || attempt >= 20) return reply;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------- Jobs ----------

let jobChain = Promise.resolve();
function withJobs(task) {
  const run = jobChain.then(async () => {
    const { [STREAM_JOBS_KEY]: jobs = {} } = await chrome.storage.local.get(STREAM_JOBS_KEY);
    const result = await task(jobs);
    await chrome.storage.local.set({ [STREAM_JOBS_KEY]: jobs });
    return result;
  });
  jobChain = run.catch(() => {});
  return run;
}

export async function getStreamJobs() {
  const { [STREAM_JOBS_KEY]: jobs = {} } = await chrome.storage.local.get(STREAM_JOBS_KEY);
  return Object.values(jobs);
}

export async function runningStreamJobs() {
  return (await getStreamJobs()).filter((j) => j.state === 'running').length;
}

/** The tab asked about: the content script's own tab, or the tab an extension page names. */
function tabOf(msg, sender) {
  const ownPage = String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
  return ownPage ? msg.tabId : sender.tab?.id;
}

const pageKey = (tabId) => `pageSources:${tabId}`;
const diagKey = (tabId) => `streamDiag:${tabId}`;

/** Video addresses from the page's own data, for the video that played last (the popup uses them). */
export async function savePageSources(msg, sender) {
  const tabId = tabOf(msg, sender);
  if (tabId == null) return { ok: false };
  await chrome.storage.session.set({ [pageKey(tabId)]: { matched: (msg.page?.matched || []).slice(0, 40), other: (msg.page?.other || []).slice(0, 20) } });
  return { ok: true };
}

function blocked(url, settings) {
  return isDrmSite(url) || isYouTube(url) || hostMatches(hostOf(url), settings.disabledSites || []);
}

const MAX_KEPT_OPTIONS = 60; // stream choices remembered per tab

/**
 * Choices for the video in a tab: { options: [{ id, label, hasAudio, size, kind, best, other }], refused }.
 * `msg.page` (from the video button) holds the page's own sources for that video.
 */
export async function streamOptions(msg, sender) {
  const tabId = tabOf(msg, sender);
  if (tabId == null) return { options: [], refused: '' };
  const settings = await cachedSettings();
  const streams = await getTabStreams(tabId);
  const stored = (await chrome.storage.session.get(pageKey(tabId)))[pageKey(tabId)] || {};
  const raw = msg.page || stored;
  const keep = (list) => (Array.isArray(list) ? list : []).filter((p) => p && (p.text || (p.url && /^https?:/i.test(p.url) && !blocked(p.url, settings))));
  const page = { matched: keep(raw.matched), other: keep(raw.other) };
  if (!streams.length && !page.matched.length && !page.other.length) return { options: [], refused: '' };
  const reply = await toOffscreen({ type: 'streamResolve', streams, page });
  const options = (reply?.options || []).map((o) => ({ ...o, id: randomId() }));
  // Keep the choices handed out earlier too: the menu and the popup may ask at the same time,
  // and a click on an older list must still find its choice (it was 'gone' before).
  const previous = (await chrome.storage.session.get(optionsKey(tabId)))[optionsKey(tabId)] || [];
  const kept = options.concat(previous).slice(0, MAX_KEPT_OPTIONS);
  await chrome.storage.session.set({ [optionsKey(tabId)]: kept, [diagKey(tabId)]: { at: Date.now(), diag: reply?.diag || [], error: reply?.error || '' } });
  return {
    refused: reply?.refused || '',
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      hasAudio: o.hasAudio,
      size: o.size || 0,
      kind: o.kind,
      audioOnly: Boolean(o.audioOnly),
      best: Boolean(o.best),
      other: Boolean(o.other),
    })),
  };
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return '';
  }
}

/** What SIDM saw in a tab, without addresses' query strings (they hold sign-in tokens). */
export async function streamDebug(msg, sender) {
  const tabId = tabOf(msg, sender);
  if (tabId == null) return {};
  const now = Date.now();
  const streams = (await getTabStreams(tabId)).map((s) => ({ kind: s.kind, url: cleanUrl(s.url), total: s.total, secondsAgo: Math.round((now - s.at) / 1000) }));
  const diag = (await chrome.storage.session.get(diagKey(tabId)))[diagKey(tabId)] || null;
  return { streams, lastCheck: diag };
}

function startJob(job) {
  return toOffscreen({ type: 'streamStart', job: { id: job.id, option: job.option } });
}

/** Download one of the choices streamOptions gave. */
export async function addStream(msg, sender) {
  const tabId = tabOf(msg, sender);
  const key = optionsKey(tabId);
  const { [key]: options = [] } = await chrome.storage.session.get(key);
  const option = options.find((o) => o.id === msg.optionId);
  if (!option) return { error: 'gone' };
  const title = sanitizeFilename(String(msg.title || '').trim() || 'video', 'video').replace(/\.(mp4|m4a|ts)$/i, '');
  const suffix = option.audioOnly ? '' : option.label ? ` (${option.label})` : '';
  if (option.kind === 'file') {
    // One whole file (video with its sound): Chrome downloads it directly, with pause and resume.
    try {
      const downloadId = await saveFile(option.url, `${title}${suffix}.${option.ext || 'mp4'}`);
      return { id: downloadId };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }
  const job = {
    id: `${STREAM_PREFIX}${randomId()}`,
    name: `${title}${suffix}`,
    pageUrl: msg.pageUrl || sender.tab?.url || '',
    option,
    state: 'running',
    downloaded: 0,
    total: option.size || 0,
    speed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await withJobs((jobs) => {
    jobs[job.id] = job;
  });
  await startJob(job);
  return { id: job.id };
}

async function setJob(id, patch) {
  return withJobs((jobs) => {
    if (!jobs[id]) return null;
    Object.assign(jobs[id], patch, { updatedAt: Date.now() });
    return jobs[id];
  });
}

export async function pauseStream({ id }) {
  await toOffscreen({ type: 'streamPause', id }).catch(() => {});
  await setJob(id, { state: 'paused', speed: 0 });
  return { ok: true };
}

export async function resumeStream({ id }) {
  const reply = await toOffscreen({ type: 'streamResume', id }).catch(() => null);
  const job = await setJob(id, { state: 'running', error: '' });
  if (!job) return { error: 'not found' };
  if (!reply?.ok) await startJob(job); // the pieces in memory were lost: start again
  return { ok: true };
}

export async function retryStream({ id }) {
  const job = await setJob(id, { state: 'running', error: '', downloaded: 0, speed: 0 });
  if (!job) return { error: 'not found' };
  await startJob(job);
  return { ok: true };
}

export async function cancelStream({ id }) {
  await toOffscreen({ type: 'streamCancel', id }).catch(() => {});
  await setJob(id, { state: 'canceled', speed: 0, endedAt: Date.now() });
  return { ok: true };
}

export async function eraseStream({ id }) {
  const jobs = await getStreamJobs();
  const job = jobs.find((j) => j.id === id);
  if (job && (job.state === 'running' || job.state === 'paused')) await cancelStream({ id });
  await withJobs((all) => {
    delete all[id];
  });
  return { ok: true };
}

// ---------- Messages from the offscreen page ----------

async function streamProgress(msg) {
  await withJobs((jobs) => {
    const job = jobs[msg.id];
    if (!job || job.state !== 'running') return;
    Object.assign(job, { downloaded: msg.downloaded, speed: msg.speed, updatedAt: Date.now() });
    if (msg.total > 0) job.total = msg.total;
  });
  return { ok: true };
}

async function streamReady(msg) {
  const job = (await getStreamJobs()).find((j) => j.id === msg.id);
  if (!job) {
    toOffscreen({ type: 'streamRevoke', url: msg.url }).catch(() => {});
    return { ok: true };
  }
  try {
    const downloadId = await saveFile(msg.url, `${job.name}.${msg.ext}`);
    const { [BLOBS_KEY]: blobs = {} } = await chrome.storage.session.get(BLOBS_KEY);
    blobs[downloadId] = msg.url;
    await chrome.storage.session.set({ [BLOBS_KEY]: blobs });
    await withJobs((jobs) => {
      delete jobs[msg.id];
    });
  } catch (err) {
    await setJob(msg.id, { state: 'error', error: String(err?.message || err), speed: 0 });
  }
  return { ok: true };
}

async function streamFailed(msg) {
  const job = (await getStreamJobs()).find((j) => j.id === msg.id);
  if (!job || job.state === 'canceled') return { ok: true };
  await setJob(msg.id, { state: 'error', code: msg.code, error: msg.message || msg.code, speed: 0, endedAt: Date.now() });
  return { ok: true };
}

/** The saved file is finished: free the memory the offscreen page holds for it. */
async function onDownloadChanged(delta) {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const { [BLOBS_KEY]: blobs = {} } = await chrome.storage.session.get(BLOBS_KEY);
  const url = blobs[delta.id];
  if (!url) return;
  delete blobs[delta.id];
  await chrome.storage.session.set({ [BLOBS_KEY]: blobs });
  toOffscreen({ type: 'streamRevoke', url }).catch(() => {});
}

/** After a browser restart the pieces in memory are gone. */
export async function markInterruptedStreams() {
  await withJobs((jobs) => {
    for (const job of Object.values(jobs)) {
      if (job.state === 'running' || job.state === 'paused') Object.assign(job, { state: 'error', error: 'browser closed', speed: 0 });
    }
  });
}

export function registerStreamListeners() {
  chrome.downloads.onChanged.addListener((delta) => {
    onDownloadChanged(delta).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTabStreams(tabId);
  });
}

export const streamHandlers = {
  streamOptions,
  streamDebug,
  savePageSources,
  addStream,
  pauseStream,
  resumeStream,
  retryStream,
  cancelStream,
  eraseStream,
  streamProgress,
  streamReady,
  streamFailed,
};
