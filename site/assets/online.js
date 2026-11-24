// Online downloader page: paste a link (served by the SIDM Online service in
// online/), and MP4 to MP3 in the browser (Web Audio decodes, mp3-worker.js encodes).

const $ = (id) => document.getElementById(id);

// ---------- Service address ----------

function apiBase() {
  const meta = document.querySelector('meta[name="sidm-api"]');
  let base = meta ? meta.content : '';
  // Local testing only: ?api=http://127.0.0.1:8080 on a page served from this computer.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const override = new URLSearchParams(location.search).get('api');
  if (local && override) base = override;
  return base.replace(/\/+$/, '');
}

const API = apiBase();

class ServiceError extends Error {
  constructor(message, offline = false) {
    super(message);
    this.offline = offline;
  }
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new ServiceError('The online downloader is not reachable right now. Please try again in a few minutes.', true);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: a proxy or host error page
  }
  if (!res.ok) {
    const offline = !body || res.status >= 502;
    throw new ServiceError(
      (body && body.error) || 'The online downloader is busy right now. Please try again in a few minutes.',
      offline,
    );
  }
  return body;
}

// ---------- Small helpers ----------

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (label) button.querySelector('.od-go-label').textContent = label;
}

function setStatus(node, message, isError = false) {
  node.textContent = '';
  node.classList.toggle('is-error', isError);
  if (typeof message === 'string') node.textContent = message;
  else if (message) node.append(message);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the notice simply shows again next time
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const DIRECT_MEDIA = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|wav)(\?|#|$)/i;
const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|youtubekids\.com)$/i;
const DRM = /(^|\.)(netflix\.com|primevideo\.com|disneyplus\.com|hulu\.com|max\.com|hbomax\.com|spotify\.com|tidal\.com|deezer\.com|peacocktv\.com|paramountplus\.com|tv\.apple\.com|music\.apple\.com|hotstar\.com)$/i;

function findUrl(text) {
  text = text.trim();
  let match = text.match(URL_IN_TEXT);
  if (!match && /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) match = [`https://${text}`];
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,);\]]+$/, ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ---------- Tabs ----------

const tabs = [$('tab-link'), $('tab-mp3')];

function selectTab(tab, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    selectTab(tab);
    history.replaceState(null, '', tab.id === 'tab-mp3' ? '#mp3' : location.pathname + location.search);
  });
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    selectTab(tabs[(tabs.indexOf(tab) + 1) % tabs.length], true);
  });
}

function tabFromHash() {
  if (location.hash === '#mp3') selectTab($('tab-mp3'));
}
tabFromHash();
window.addEventListener('hashchange', tabFromHash);

// ---------- Paste a link ----------

const linkForm = $('link-form');
const linkInput = $('link-input');
const linkGo = $('link-go');
const linkStatus = $('link-status');
const result = $('link-result');
const pasteBtn = $('paste-btn');
const clearBtn = $('clear-btn');

function syncClear() {
  const has = linkInput.value.trim() !== '';
  clearBtn.hidden = !has;
  pasteBtn.hidden = has;
}
linkInput.addEventListener('input', syncClear);

clearBtn.addEventListener('click', () => {
  linkInput.value = '';
  syncClear();
  linkInput.focus();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      linkInput.value = text.trim();
      syncClear();
      linkForm.requestSubmit();
      return;
    }
  } catch {
    // The browser said no (Firefox, or permission denied): fall back to the keyboard.
  }
  linkInput.focus();
  setStatus(linkStatus, 'Press Ctrl+V (or long-press and Paste on a phone) to paste your link.');
});

function askYoutubeNotice() {
  const dialog = $('yt-notice');
  if (storageGet('sidm-yt-notice') === '1' || typeof dialog.showModal !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => {
      const ok = dialog.returnValue === 'ok';
      if (ok) storageSet('sidm-yt-notice', '1');
      resolve(ok);
    }, { once: true });
    dialog.showModal();
  });
}

function directFallback(url, message) {
  const frag = document.createDocumentFragment();
  frag.append(`${message} `);
  if (DIRECT_MEDIA.test(url.pathname)) {
    const a = el('a', '', 'Open the file directly');
    a.href = url.href;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    frag.append(a, ' and use your browser\'s Save option.');
  } else {
    const a = el('a', '', 'Get the free SIDM extension');
    a.href = 'index.html#download';
    frag.append(a, ' to download from your own computer.');
  }
  return frag;
}

linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = findUrl(linkInput.value);
  result.hidden = true;
  if (!url) {
    setStatus(linkStatus, 'Paste a video link that starts with http:// or https://.', true);
    linkInput.focus();
    return;
  }
  if (DRM.test(url.hostname)) {
    setStatus(linkStatus, 'This site uses DRM protection. SIDM does not download DRM-protected content.', true);
    return;
  }
  if (YOUTUBE.test(url.hostname) && !(await askYoutubeNotice())) {
    setStatus(linkStatus, '');
    return;
  }
  if (!API) {
    setStatus(linkStatus, directFallback(url, 'The online downloader is not set up yet.'), true);
    return;
  }
  setBusy(linkGo, true, 'Getting links…');
  setStatus(linkStatus, 'Looking at the link. This takes a few seconds…');
  try {
    const info = await api('/api/info', { method: 'POST', body: JSON.stringify({ url: url.href }) });
    setStatus(linkStatus, '');
    showResult(info);
  } catch (err) {
    setStatus(linkStatus, err.offline ? directFallback(url, err.message) : err.message, true);
  } finally {
    setBusy(linkGo, false, 'Get Download Links');
  }
});

function showResult(info) {
  const thumb = $('res-thumb');
  thumb.querySelector('img')?.remove();
  if (info.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.src = info.thumbnail;
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }
  $('res-title').textContent = info.title || 'Video';
  $('res-sub').textContent = [info.site, info.uploader, formatDuration(info.duration)].filter(Boolean).join(' · ');
  const list = $('res-options');
  list.textContent = '';
  for (const option of info.options) list.append(optionRow(info, option));
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

function optionRow(info, option) {
  const li = el('li', `od-option${option.kind === 'audio' ? ' is-audio' : ''}`);
  li.append(el('span', 'od-kind', option.ext.toUpperCase()));
  const text = el('span', 'od-opt-text');
  text.append(el('span', 'od-opt-label', option.label), el('span', 'od-opt-note', option.note || ''));
  const size = el('span', 'od-opt-size', option.size ? `${option.id === 'mp3' ? 'about ' : ''}${formatSize(option.size)}` : '');
  text.append(size);
  const btn = el('button', 'btn btn-primary od-opt-btn');
  btn.type = 'button';
  btn.innerHTML = `${DOWNLOAD_ICON}<span>Download</span>`;
  btn.setAttribute('aria-label', `Download ${option.label} ${option.ext.toUpperCase()}`);
  const barWrap = el('div', 'od-opt-bar');
  barWrap.hidden = true;
  const bar = el('div', 'od-bar is-indeterminate');
  const fill = el('span');
  bar.append(fill);
  barWrap.append(bar);
  const msg = el('p', 'od-opt-msg');
  msg.setAttribute('role', 'status');
  li.append(text, btn, barWrap, msg);

  btn.addEventListener('click', async () => {
    if (btn.dataset.file) {
      saveFile(btn.dataset.file);
      return;
    }
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Preparing…';
    msg.classList.remove('is-error');
    msg.textContent = '';
    barWrap.hidden = false;
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ info: info.info, option: option.id }) });
      const done = await followJob(job.job, bar, fill, msg);
      const fileUrl = `${API}/api/jobs/${encodeURIComponent(job.job)}/file`;
      btn.dataset.file = fileUrl;
      btn.classList.add('is-done');
      btn.querySelector('span').textContent = 'Save again';
      msg.textContent = `Ready: ${formatSize(done.size)}. Your download has started.`;
      saveFile(fileUrl);
    } catch (err) {
      btn.querySelector('span').textContent = 'Try again';
      msg.classList.add('is-error');
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
      barWrap.hidden = true;
    }
  });
  return li;
}

async function followJob(id, bar, fill, msg) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (s.state === 'done') return s;
    if (s.state === 'error' || s.state === 'canceled') throw new ServiceError(s.error || 'The download stopped.');
    const known = s.percent != null && s.state === 'downloading';
    bar.classList.toggle('is-indeterminate', !known);
    fill.style.width = known ? `${s.percent}%` : '';
    if (s.state === 'queued') msg.textContent = 'Waiting for a free slot…';
    else if (s.state === 'converting') msg.textContent = 'Almost done: joining video and sound…';
    else {
      const parts = [];
      if (known) parts.push(`${Math.floor(s.percent)}%`);
      if (s.bytes) parts.push(s.total ? `${formatSize(s.bytes)} of ${formatSize(s.total)}` : formatSize(s.bytes));
      if (s.speed) parts.push(`${formatSize(s.speed)}/s`);
      msg.textContent = `Preparing your file on our server: ${parts.join(' · ') || 'starting…'}`;
    }
  }
}

function saveFile(href) {
  // The service sends "Content-Disposition: attachment", so the browser saves
  // the file and stays on this page.
  const a = el('a');
  a.href = href;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}

// Links shared into the page: online-downloader.html?url=...
const shared = new URLSearchParams(location.search).get('url');
if (shared) {
  linkInput.value = shared;
  syncClear();
}

// ---------- MP4 to MP3 (in the browser) ----------

const mp3Form = $('mp3-form');
const mp3File = $('mp3-file');
const mp3Drop = $('mp3-drop');
const mp3Go = $('mp3-go');
const mp3Status = $('mp3-status');
const mp3Progress = $('mp3-progress');
const mp3Bar = $('mp3-bar');
const mp3Result = $('mp3-result');
const BIG_FILE = 1024 * 1024 * 1024;
let chosen = null;
let lastUrl = null;

function chooseFile(file) {
  chosen = file || null;
  mp3Drop.classList.toggle('has-file', !!chosen);
  $('mp3-name').textContent = chosen
    ? `${chosen.name} (${formatSize(chosen.size)})`
    : 'Choose an MP4 or other video file, or drop it here';
  mp3Result.hidden = true;
  setStatus(mp3Status, chosen && chosen.size > BIG_FILE
    ? 'This is a big file. Converting it needs a lot of memory and may fail on some devices.'
    : '');
}

mp3File.addEventListener('change', () => chooseFile(mp3File.files[0]));

for (const type of ['dragenter', 'dragover']) {
  mp3Drop.addEventListener(type, (e) => {
    e.preventDefault();
    mp3Drop.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  mp3Drop.addEventListener(type, () => mp3Drop.classList.remove('is-over'));
}
mp3Drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) chooseFile(e.dataTransfer.files[0]);
});

function mp3Name(name) {
  return `${name.replace(/\.[^.]+$/, '') || 'audio'}.mp3`;
}

async function decodeAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('This browser cannot convert audio. Try the latest Chrome, Edge, Firefox or Safari.');
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: 44100 });
  } catch {
    ctx = new Ctx();
  }
  try {
    const data = await file.arrayBuffer();
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
  } catch {
    throw new Error('This file has no sound we can read. Make sure it is a video or audio file with sound (MP4, MOV, WebM, M4A).');
  } finally {
    ctx.close?.();
  }
}

function encodeMp3(audio, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('assets/mp3-worker.js');
    const channels = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c += 1) channels.push(audio.getChannelData(c).slice());
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.value);
      else if (m.type === 'done') {
        worker.terminate();
        resolve(new Blob(m.chunks, { type: 'audio/mpeg' }));
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('The MP3 encoder could not start. Reload the page and try again.'));
    };
    worker.postMessage({ sampleRate: audio.sampleRate, kbps, channels }, channels.map((c) => c.buffer));
  });
}

mp3Form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!chosen) {
    setStatus(mp3Status, 'Choose a video file first.', true);
    return;
  }
  const kbps = Number($('mp3-quality').value) || 192;
  setBusy(mp3Go, true, 'Converting…');
  mp3Result.hidden = true;
  mp3Progress.hidden = false;
  mp3Bar.parentElement.classList.add('is-indeterminate');
  mp3Bar.style.width = '';
  setStatus(mp3Status, 'Reading the sound from your file…');
  const started = performance.now();
  try {
    const audio = await decodeAudio(chosen);
    mp3Bar.parentElement.classList.remove('is-indeterminate');
    const blob = await encodeMp3(audio, kbps, (value) => {
      mp3Bar.style.width = `${Math.round(value * 100)}%`;
      setStatus(mp3Status, `Making your MP3: ${Math.floor(value * 100)}%`);
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const name = mp3Name(chosen.name);
    const save = $('mp3-save');
    save.href = lastUrl;
    save.download = name;
    $('mp3-out-name').textContent = name;
    $('mp3-out-sub').textContent = `${formatSize(blob.size)} · ${formatDuration(audio.duration)} · ${kbps} kbps`;
    mp3Result.hidden = false;
    setStatus(mp3Status, `Done in ${Math.max(1, Math.round((performance.now() - started) / 1000))} s.`);
  } catch (err) {
    setStatus(mp3Status, err.message, true);
  } finally {
    mp3Progress.hidden = true;
    setBusy(mp3Go, false, 'Convert to MP3');
  }
});
