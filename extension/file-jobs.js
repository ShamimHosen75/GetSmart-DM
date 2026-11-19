// Multi-connection file downloads through the companion (M13). Service worker.
//
// When the companion is installed and says it supports "files", the queue
// hands big files (1 MB and up) on servers that accept Range requests to the
// companion, which downloads them over several connections at once
// (shared/protocol.md: add_file, pause_file, cancel, set_speed_limit,
// open_file). Everything else, and anything the companion turns down
// (no_range, auth), goes through the browser as before.
//
// Jobs live in chrome.storage.local "fileJobs" ({ [id]: job }) so paused
// downloads survive a browser restart. Ids start with "file-" so progress
// messages can be told apart from video jobs.

import { CATEGORY_FOLDERS, ROOT_FOLDER, cachedSettings, categoryOf, nameFromUrl, randomId, sanitizeFilename } from './common.js';
import { bridge } from './native-bridge.js';

export const FILE_JOBS_KEY = 'fileJobs';
export const ID_PREFIX = 'file-';
const MIN_COMPANION_BYTES = 1024 * 1024;
const MISSING_RETRY_MS = 60000; // after "not installed", use the browser for a minute without asking again
const PROBE_TIMEOUT_MS = 8000;
const FALLBACK_CODES = new Set(['no_range', 'auth']);
const FINAL = new Set(['done', 'error', 'canceled']);
const PROGRESS_FIELDS = ['downloaded', 'total', 'speed', 'eta', 'filename', 'error', 'error_code', 'segments', 'connections', 'resumable'];

const hooks = { fallback: null, finished: null }; // set by queue.js

/** queue.js: how to start a browser download instead, and what to do when a job ends. */
export function setFileJobHooks({ fallback, finished }) {
  hooks.fallback = fallback;
  hooks.finished = finished;
}

// ---------- Storage ----------

let chain = Promise.resolve();
function withFileJobs(task) {
  const run = chain.then(async () => {
    const { [FILE_JOBS_KEY]: jobs = {} } = await chrome.storage.local.get(FILE_JOBS_KEY);
    const result = await task(jobs);
    await chrome.storage.local.set({ [FILE_JOBS_KEY]: jobs });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function getFileJobs() {
  const { [FILE_JOBS_KEY]: jobs = {} } = await chrome.storage.local.get(FILE_JOBS_KEY);
  return Object.values(jobs);
}

export async function runningFileJobs() {
  return (await getFileJobs()).filter((job) => job.state === 'running').length;
}

// ---------- Starting ----------

/** Ask the server for one byte. Returns { total, name, mime } if it can send parts, else null. */
async function probe(url, referrer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store',
      referrer: referrer || undefined,
      signal: controller.signal,
    });
    res.body?.cancel().catch(() => {});
    const match = /bytes\s+0-0\/(\d+)/i.exec(res.headers.get('Content-Range') || '');
    if (res.status !== 206 || !match) return null;
    return {
      total: Number(match[1]),
      name: dispositionName(res.headers.get('Content-Disposition')) || nameFromUrl(res.url || url),
      mime: (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function dispositionName(value) {
  if (!value) return '';
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(value) || /filename\s*=\s*([^;]+)/i.exec(value);
  return plain ? plain[1].trim() : '';
}

async function companionReady() {
  if (bridge.status === 'missing' && Date.now() - bridge.missingAt < MISSING_RETRY_MS) return false;
  if (!(await bridge.ensureConnected())) return false;
  return bridge.supports('files');
}

/**
 * Try to download `entry` ({ url, filename?, referrer? }) with the companion.
 * Returns the job, or null when the browser should download it.
 */
export async function startWithCompanion(entry, settings) {
  if (!settings.useCompanion || settings.askWhereToSave) return null; // the companion cannot show "Save as"
  const info = await probe(entry.url, entry.referrer);
  if (!info || info.total < MIN_COMPANION_BYTES) return null;
  if (!(await companionReady())) return null;

  const name = sanitizeFilename(entry.filename || info.name || nameFromUrl(entry.url));
  const folder = settings.sortIntoFolders ? `${ROOT_FOLDER}/${CATEGORY_FOLDERS[categoryOf(name, info.mime)]}` : '';
  const job = {
    id: `${ID_PREFIX}${randomId()}`,
    url: entry.url,
    referrer: entry.referrer || '',
    name,
    folder,
    mime: info.mime,
    total: info.total,
    downloaded: 0,
    state: 'running',
    connections: 0,
    maxConnections: settings.connections,
    speedLimit: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await withFileJobs((jobs) => {
    jobs[job.id] = job;
  });
  if (!postAdd(job)) {
    await withFileJobs((jobs) => {
      delete jobs[job.id];
    });
    return null;
  }
  return job;
}

function postAdd(job) {
  const headers = {};
  if (job.referrer) headers.Referer = job.referrer;
  headers['User-Agent'] = navigator.userAgent;
  return bridge.post({
    type: 'add_file',
    id: job.id,
    url: job.url,
    filename: job.name,
    folder: job.folder,
    connections: job.maxConnections,
    headers,
    speed_limit: job.speedLimit || 0,
  });
}

// ---------- Progress from the companion ----------

function onProgress(msg) {
  if (!String(msg.id).startsWith(ID_PREFIX)) return false;
  withFileJobs(async (jobs) => {
    const job = jobs[msg.id];
    if (!job) return;
    if (msg.state) job.state = msg.state;
    for (const field of PROGRESS_FIELDS) {
      if (msg[field] !== undefined && msg[field] !== null) job[field] = msg[field];
    }
    if (job.state !== 'running') job.connections = 0;
    if (job.state !== 'error') delete job.error_code;
    job.updatedAt = Date.now();
    if (job.state === 'error' && FALLBACK_CODES.has(msg.error_code) && !(job.downloaded > 0)) {
      // The companion cannot download this one: the browser takes over.
      delete jobs[msg.id];
      queueMicrotask(() => hooks.fallback?.({ url: job.url, filename: job.name, referrer: job.referrer }));
      return;
    }
    if (FINAL.has(job.state)) {
      job.endedAt = Date.now();
      queueMicrotask(() => hooks.finished?.(job));
    }
  });
  return true;
}

/** The companion went away: running files stop, and can be resumed later. */
function onDisconnect() {
  withFileJobs((jobs) => {
    for (const job of Object.values(jobs)) {
      if (job.state === 'running') {
        Object.assign(job, { state: 'error', error: 'companion stopped', error_code: 'network', connections: 0, updatedAt: Date.now() });
      }
    }
  });
}

/** Called once from background.js (not at import time, so import cycles cannot bite). */
export function registerFileJobListeners() {
  bridge.addListener({
    connected: () => applyGlobalSpeedLimit(),
    progress: onProgress,
    disconnect: onDisconnect,
    busy: async () => (await runningFileJobs()) > 0,
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.speedLimitKBps) applyGlobalSpeedLimit();
  });
}

// ---------- Actions (from pages) ----------

async function job(id) {
  return (await getFileJobs()).find((j) => j.id === id) || null;
}

export async function pauseFile({ id }) {
  if (bridge.port && bridge.post({ type: 'pause_file', id })) return { ok: true };
  await withFileJobs((jobs) => {
    if (jobs[id]?.state === 'running') Object.assign(jobs[id], { state: 'paused', connections: 0, updatedAt: Date.now() });
  });
  return { ok: true };
}

export async function resumeFile({ id }) {
  const current = await job(id);
  if (!current) return { error: 'not found' };
  if (current.state === 'running' || current.state === 'done') return { ok: true };
  if (!(await companionReady())) return { error: 'companion' };
  const updated = await withFileJobs((jobs) => {
    Object.assign(jobs[id], { state: 'running', error: '', updatedAt: Date.now() });
    delete jobs[id].error_code;
    return jobs[id];
  });
  return postAdd(updated) ? { ok: true } : { error: 'companion' };
}

export async function cancelFile({ id }) {
  const current = await job(id);
  if (!current) return { ok: true };
  const posted = (bridge.port || (await companionReady())) &&
    bridge.post({ type: 'cancel', id, url: current.url, filename: current.name, folder: current.folder });
  if (!posted || current.state !== 'running') {
    await withFileJobs((jobs) => {
      if (jobs[id] && jobs[id].state !== 'done') Object.assign(jobs[id], { state: 'canceled', connections: 0, updatedAt: Date.now() });
    });
  }
  return { ok: true };
}

/** Remove from the list. A running or paused download is canceled first. */
export async function eraseFile({ id }) {
  const current = await job(id);
  if (current && current.state !== 'done' && current.state !== 'canceled') await cancelFile({ id });
  await withFileJobs((jobs) => {
    delete jobs[id];
  });
  return { ok: true };
}

export async function openFile({ id, reveal }) {
  const current = await job(id);
  if (!current?.filename || current.state !== 'done') return { error: 'not found' };
  if (!(bridge.port || (await companionReady()))) return { error: 'companion' };
  bridge.post({ type: 'open_file', path: current.filename, reveal: Boolean(reveal) });
  return { ok: true };
}

/** Per-file speed limit in bytes/s (0 = none), kept for when it resumes. */
export async function setFileSpeedLimit({ id, limit }) {
  const value = Math.max(0, Math.round(Number(limit) || 0));
  await withFileJobs((jobs) => {
    if (jobs[id]) jobs[id].speedLimit = value;
  });
  if (bridge.port) bridge.post({ type: 'set_speed_limit', id, limit: value });
  return { ok: true };
}

/** Global limit for all companion files (bytes/s, 0 = none). Sent on every connect. */
export async function applyGlobalSpeedLimit() {
  const settings = await cachedSettings();
  const limit = Math.max(0, Math.round(Number(settings.speedLimitKBps) || 0)) * 1024;
  if (bridge.port) bridge.post({ type: 'set_speed_limit', limit });
}

/** Scheduler stop time: pause every running companion file. */
export async function pauseRunningFiles() {
  for (const j of await getFileJobs()) if (j.state === 'running') await pauseFile({ id: j.id });
}

/** Scheduler start time: resume companion files that were paused. */
export async function resumePausedFiles() {
  for (const j of await getFileJobs()) if (j.state === 'paused') await resumeFile({ id: j.id });
}

export const fileHandlers = { pauseFile, resumeFile, cancelFile, eraseFile, openFile, setFileSpeedLimit };
