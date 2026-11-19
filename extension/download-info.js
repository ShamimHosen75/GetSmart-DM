// Facts about one chrome.downloads item, shared by the popup list, the
// progress window and the manager page.

import { t } from './i18n.js';
import { baseName, nameFromUrl } from './common.js';

export function isFinished(item) {
  return item.state === 'complete' || item.state === 'interrupted';
}

export function isRunning(item) {
  return item.state === 'in_progress' && !item.paused;
}

export function displayName(item) {
  return baseName(item.filename) || nameFromUrl(item.finalUrl || item.url);
}

export function totalBytes(item) {
  if (item.totalBytes > 0) return item.totalBytes;
  if (item.state === 'complete' && item.fileSize > 0) return item.fileSize;
  return -1;
}

export function errorLabel(error) {
  if (!error) return '';
  if (error.startsWith('NETWORK_')) return t('errNetwork');
  if (error.startsWith('SERVER_')) return t('errServer');
  if (error === 'FILE_NO_SPACE') return t('errDiskFull');
  if (error === 'FILE_ACCESS_DENIED' || error === 'SERVER_FORBIDDEN') return t('errAccess');
  if (error === 'FILE_TOO_LARGE') return t('errTooLarge');
  if (error === 'FILE_BLOCKED' || error.startsWith('FILE_VIRUS') || error === 'FILE_SECURITY_CHECK_FAILED') return t('errBlocked');
  if (error === 'CRASH' || error === 'USER_SHUTDOWN') return t('errCrash');
  return '';
}

/** "queued" | "downloading" | "paused" | "complete" | "deleted" | "cancelled" | "failed" */
export function stateOf(item) {
  if (item.state === 'queued') return 'queued';
  if (item.state === 'in_progress') return item.paused ? 'paused' : 'downloading';
  if (item.state === 'complete') return item.exists === false ? 'deleted' : 'complete';
  return item.error === 'USER_CANCELED' ? 'cancelled' : 'failed';
}

export const STATE_LABEL = {
  queued: 'stateQueued',
  downloading: 'stateDownloading',
  paused: 'statePaused',
  complete: 'stateComplete',
  deleted: 'stateDeleted',
  cancelled: 'stateCancelled',
  failed: 'stateFailed',
};

// ---------- Companion file downloads (M13) ----------

const FILE_STATE = { running: 'in_progress', paused: 'in_progress', done: 'complete', error: 'interrupted', canceled: 'interrupted' };

/** A companion file job shaped like a chrome.downloads item, id "f:<job id>". */
export function fileJobItem(job) {
  const iso = (time) => (time ? new Date(time).toISOString() : undefined);
  const final = job.state === 'done' || job.state === 'error' || job.state === 'canceled';
  return {
    id: `f:${job.id}`,
    jobId: job.id,
    engine: 'companion',
    url: job.url,
    finalUrl: job.url,
    filename: job.filename || job.name,
    mime: job.mime,
    state: FILE_STATE[job.state] || 'interrupted',
    paused: job.state === 'paused',
    bytesReceived: job.downloaded || 0,
    totalBytes: job.total > 0 ? job.total : -1,
    fileSize: job.total,
    error: job.state === 'canceled' ? 'USER_CANCELED' : job.state === 'error' ? 'COMPANION' : undefined,
    errorText: job.error || '',
    canResume: job.state === 'paused' || job.state === 'error',
    exists: true,
    startTime: iso(job.createdAt),
    endTime: final ? iso(job.endedAt || job.updatedAt) : undefined,
    segments: job.segments || [],
    connections: job.connections || 0,
    maxConnections: job.maxConnections || 0,
    speedLimit: job.speedLimit || 0,
  };
}

/** A video being downloaded in the browser (M15), shaped like a chrome.downloads item, id "s:<job id>". */
export function streamJobItem(job) {
  const iso = (time) => (time ? new Date(time).toISOString() : undefined);
  const final = job.state === 'error' || job.state === 'canceled';
  return {
    id: `s:${job.id}`,
    jobId: job.id,
    engine: 'stream',
    url: job.pageUrl || '',
    finalUrl: job.pageUrl || '',
    filename: `${job.name}.mp4`,
    mime: 'video/mp4',
    state: FILE_STATE[job.state] || 'interrupted',
    paused: job.state === 'paused',
    bytesReceived: job.downloaded || 0,
    totalBytes: job.total > 0 ? job.total : -1,
    fileSize: job.total,
    error: job.state === 'canceled' ? 'USER_CANCELED' : job.state === 'error' ? 'STREAM' : undefined,
    errorText: job.state === 'error' ? streamError(job) : '',
    canResume: job.state === 'paused' || job.state === 'error' || job.state === 'canceled',
    exists: true,
    startTime: iso(job.createdAt),
    endTime: final ? iso(job.endedAt || job.updatedAt) : undefined,
    speed: job.speed || 0,
  };
}

function streamError(job) {
  const key = { encrypted: 'streamErrEncrypted', live: 'streamErrLive', forbidden: 'streamErrForbidden', gone: 'streamErrGone' }[job.code];
  return key ? t(key) : job.error || '';
}

/** Companion file jobs and in-browser video jobs as download items, from chrome.storage.local. */
export async function fileJobItems() {
  const { fileJobs = {}, streamJobs = {} } = await chrome.storage.local.get(['fileJobs', 'streamJobs']);
  return [...Object.values(fileJobs).map(fileJobItem), ...Object.values(streamJobs).map(streamJobItem)];
}

/** Why a download failed, in words, or "". */
export function failureText(item) {
  return errorLabel(item.error) || item.errorText || '';
}

/** Pause, resume, cancel, open, show or erase any download (browser or companion). */
export function itemAction(action, item) {
  if (item.engine === 'stream') {
    // Retry starts again; resume picks up where it paused when the pieces are still in memory.
    const type = { pause: 'pauseStream', resume: item.state === 'interrupted' ? 'retryStream' : 'resumeStream', cancel: 'cancelStream', erase: 'eraseStream' }[action];
    if (!type) return Promise.resolve();
    return chrome.runtime.sendMessage({ type, id: item.jobId }).then((reply) => {
      if (reply?.error) throw new Error(reply.error);
      return reply;
    });
  }
  if (item.engine === 'companion') {
    const id = item.jobId;
    const type = { pause: 'pauseFile', resume: 'resumeFile', cancel: 'cancelFile', erase: 'eraseFile', open: 'openFile', show: 'openFile' }[action];
    return chrome.runtime.sendMessage({ type, id, reveal: action === 'show' }).then((reply) => {
      if (reply?.error) throw new Error(reply.error === 'companion' ? t('companionMissing') : reply.error);
      return reply;
    });
  }
  switch (action) {
    case 'pause':
      return chrome.downloads.pause(item.id);
    case 'resume':
      return chrome.downloads.resume(item.id);
    case 'cancel':
      return chrome.downloads.cancel(item.id);
    case 'erase':
      return chrome.downloads.erase({ id: item.id });
    case 'open':
      return chrome.downloads.open(item.id);
    case 'show':
      return chrome.downloads.show(item.id);
    default:
      return undefined;
  }
}
