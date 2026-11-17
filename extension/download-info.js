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
