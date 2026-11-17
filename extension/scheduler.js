// Scheduler and "when the queue is done" (M14). Service worker.
//
// - Scheduler: on the chosen days, start the queue at a start time and, if a
//   stop time is set, stop it again (running downloads are paused). Uses
//   chrome.alarms, which wake the service worker.
// - When the queue is done (nothing waiting, nothing running after the queue
//   started something): do nothing, show a notification, or close the browser.
//   Turning the computer off is not possible from a browser extension.

import { cachedSettings, getSettings } from './common.js';
import { getQueue, pump, setQueuePaused } from './queue.js';
import { pauseRunningFiles, resumePausedFiles, runningFileJobs } from './file-jobs.js';
import { setLanguage, t } from './i18n.js';

const START_ALARM = 'gsdm-schedule-start';
const STOP_ALARM = 'gsdm-schedule-stop';
const QUEUE_ACTIVE_KEY = 'queueActive'; // storage.session, set by queue.js when it starts an item
const SCHEDULE_KEYS = ['scheduleEnabled', 'scheduleStart', 'scheduleStop', 'scheduleDays'];

/** Next Date at "HH:MM" on one of `days` (0 = Sunday), after `now`. */
export function nextTime(hhmm, days, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!match || !days?.length) return null;
  for (let add = 0; add <= 7; add += 1) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, Number(match[1]), Number(match[2]), 0, 0);
    if (at > now && days.includes(at.getDay())) return at;
  }
  return null;
}

export async function planAlarms() {
  const settings = await getSettings(); // not the cache: this runs from storage.onChanged, maybe before the cache sees it
  await chrome.alarms.clear(START_ALARM);
  await chrome.alarms.clear(STOP_ALARM);
  if (!settings.scheduleEnabled) return;
  const start = nextTime(settings.scheduleStart, settings.scheduleDays);
  if (start) chrome.alarms.create(START_ALARM, { when: start.getTime() });
  const stop = settings.scheduleStop ? nextTime(settings.scheduleStop, settings.scheduleDays) : null;
  if (stop) chrome.alarms.create(STOP_ALARM, { when: stop.getTime() });
}

async function onAlarm(alarm) {
  if (alarm.name === START_ALARM) {
    await setQueuePaused(false);
    // Downloads the scheduler (or "Stop all") paused carry on too.
    for (const item of await chrome.downloads.search({ state: 'in_progress', paused: true })) {
      if (item.canResume) await chrome.downloads.resume(item.id).catch(() => {});
    }
    await resumePausedFiles();
    await pump();
  } else if (alarm.name === STOP_ALARM) {
    await setQueuePaused(true);
    for (const item of await chrome.downloads.search({ state: 'in_progress', paused: false })) {
      await chrome.downloads.pause(item.id).catch(() => {});
    }
    await pauseRunningFiles();
  } else {
    return;
  }
  await planAlarms();
}

// ---------- When the queue is done ----------

let checkTimer = 0;
/** Check, a moment after a download event, whether the queue has just finished. */
export function checkQueueDone() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const { [QUEUE_ACTIVE_KEY]: active } = await chrome.storage.session.get(QUEUE_ACTIVE_KEY);
    if (!active) return;
    const [running, files, queue] = await Promise.all([
      chrome.downloads.search({ state: 'in_progress' }),
      runningFileJobs(),
      getQueue(),
    ]);
    if (running.some((d) => !d.paused) || files > 0 || queue.length) return;
    if (running.length) return; // something is only paused: not done
    await chrome.storage.session.set({ [QUEUE_ACTIVE_KEY]: false });
    const settings = await cachedSettings();
    if (settings.whenQueueDone === 'notify') {
      setLanguage(settings.language);
      chrome.notifications.create(`gsdm-queue-done-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: t('queueDoneTitle'),
        message: t('queueDoneBody'),
        priority: 0,
      });
    } else if (settings.whenQueueDone === 'close') {
      for (const win of await chrome.windows.getAll()) await chrome.windows.remove(win.id).catch(() => {});
    }
  }, 1500);
}

export function registerSchedulerListeners() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    onAlarm(alarm).catch((err) => console.error('GetSmart DM: scheduler failed', err));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && SCHEDULE_KEYS.some((key) => changes[key])) planAlarms();
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state || delta.paused) checkQueueDone();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fileJobs) checkQueueDone();
  });
}
