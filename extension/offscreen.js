// Offscreen page: in-browser video downloads (M15).
//
// The service worker opens this hidden page (chrome.offscreen, reason BLOBS)
// because a worker can be stopped at any time and cannot parse XML. Here:
//   - "streamResolve": turn the streams a tab played (HLS playlists, DASH
//     manifests, pieces of MP4 files that players fetch bit by bit) into
//     download choices such as "720p".
//   - "streamStart": fetch every piece (6 at a time), join video and audio
//     into one MP4, and hand the worker a blob: URL to save with
//     chrome.downloads.
// Encrypted/DRM streams and live streams are refused, never worked around.

import { joinTracks, readInit } from './mp4.js';
import { parseM3u8, parseMpd } from './stream-parse.js';

const PARALLEL = 6;
const RETRIES = 3;
const PROBE_BYTES = 512 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const PROBE_MS = 8000;
const PROGRESS_MS = 500;

const jobs = new Map(); // id -> { controller, paused, wake }

class StreamError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------- Fetching ----------

async function fetchBytes(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {};
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { headers, credentials: 'include', cache: 'no-store', signal });
      if (res.status === 403 || res.status === 401) throw new StreamError('forbidden', `HTTP ${res.status}`);
      if (res.status === 404 || res.status === 410) throw new StreamError('gone', `HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range sends the whole file: cut out the part we asked for.
      if (range && res.status === 200 && range.end != null && bytes.length > range.end - range.start + 1) {
        return { bytes: bytes.subarray(range.start, range.end + 1), res };
      }
      return { bytes, res };
    } catch (err) {
      if (signal?.aborted || err instanceof StreamError) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchText(url) {
  const { bytes } = await fetchBytes(url, null);
  return new TextDecoder().decode(bytes);
}

// ---------- Choices from what the tab played ----------

function label(height, fallback) {
  return height ? `${height}p` : fallback;
}

async function resolveHls(stream, seen) {
  const pl = parseM3u8(await fetchText(stream.url), stream.url);
  if (pl.type === 'master') {
    const out = [];
    for (const v of pl.variants) {
      seen.add(v.url);
      const group = pl.audio[v.audio] || [];
      const audio = group.find((a) => a.isDefault) || group[0] || null;
      if (audio) seen.add(audio.url);
      out.push({ kind: 'hls', height: v.width && v.height ? Math.min(v.width, v.height) : v.height, bandwidth: v.bandwidth, video: v.url, audio: audio?.url || '' });
    }
    return out;
  }
  if (pl.encrypted) return [{ kind: 'refused', reason: 'encrypted' }];
  if (pl.live) return [{ kind: 'refused', reason: 'live' }];
  return [{ kind: 'hls', height: 0, bandwidth: 0, video: stream.url, audio: '', media: true }];
}

async function resolveDash(stream) {
  const text = stream.text || (await fetchText(stream.url));
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = parseMpd(doc, stream.url || stream.base || '');
  if (mpd.protected) return [{ kind: 'refused', reason: 'encrypted' }];
  if (mpd.live) return [{ kind: 'refused', reason: 'live' }];
  const audio = mpd.audio.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  const out = mpd.video.map((v) => ({ kind: 'dash', height: v.width && v.height ? Math.min(v.width, v.height) : v.height, bandwidth: v.bandwidth, video: v, audio }));
  if (audio) out.push({ kind: 'dash', audioOnly: true, height: 0, bandwidth: audio.bandwidth, video: null, audio });
  return out;
}

/** Index of a 4-letter box type in bytes, searching from the end. */
function lastIndexOfType(bytes, type) {
  const c = [...type].map((ch) => ch.charCodeAt(0));
  for (let i = bytes.length - 4; i >= 4; i -= 1) {
    if (bytes[i] === c[0] && bytes[i + 1] === c[1] && bytes[i + 2] === c[2] && bytes[i + 3] === c[3]) return i - 4;
  }
  return -1;
}

/**
 * What an MP4 address holds: its tracks from the header at the start, or at the
 * end of the file for MP4s written without "fast start". Null if unknown.
 */
async function probeMp4(url, knownTotal = 0) {
  const { bytes, res } = await fetchBytes(url, { start: 0, end: PROBE_BYTES - 1 }, AbortSignal.timeout(PROBE_MS));
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '')?.[1]) ||
    (res.status === 200 ? bytes.length : knownTotal || 0);
  let info = readInit(bytes);
  if (!info && total > PROBE_BYTES) {
    const start = Math.max(0, total - TAIL_BYTES);
    const tail = (await fetchBytes(url, { start, end: total - 1 }, AbortSignal.timeout(PROBE_MS))).bytes;
    const at = lastIndexOfType(tail, 'moov');
    if (at >= 0) info = readInit(tail.subarray(at));
  }
  return { info, total, mime: (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() };
}

/** A piece a player fetched bit by bit: one track (to be joined) or a whole file with sound. */
async function probePiece(stream) {
  const { info, total } = await probeMp4(stream.url, stream.total);
  if (!info || !info.tracks.length) {
    // Header not found: offer the address as one whole file, quality from its address.
    if (!(total > 0)) return null;
    return { url: stream.url, at: stream.at, total, encrypted: false, type: 'file', height: sizeFromUrl(stream.url).height, sound: null };
  }
  const video = info.tracks.find((t) => t.handler === 'vide');
  const sound = info.tracks.some((t) => t.handler === 'soun');
  if (info.tracks.length > 1) {
    // Video and sound in one file (LinkedIn, plain MP4 players): save it as it is.
    return { url: stream.url, at: stream.at, total, encrypted: info.encrypted, type: 'file', height: video ? shortSide(video) : 0, sound };
  }
  const t = info.tracks[0];
  return { url: stream.url, at: stream.at, total, encrypted: info.encrypted, type: t.handler, height: t.height };
}

function shortSide(t) {
  return t.width && t.height ? Math.min(t.width, t.height) : t.height || 0;
}

/** "720" from "1280x720" (or 720x1280 for an upright video) written in a URL. */
function sizeFromUrl(url) {
  const wh = /[/_-](\d{3,4})x(\d{3,4})[/_.-]/.exec(url);
  if (wh) return { height: Math.min(Number(wh[1]), Number(wh[2])) };
  const p = /[/_-](\d{3,4})p[/_.-]/i.exec(url);
  return { height: p ? Number(p[1]) : 0 };
}

async function resolvePieces(streams) {
  const probed = (await Promise.all(streams.map((s) => probePiece(s).catch(() => null)))).filter(Boolean);
  if (probed.some((p) => p.encrypted)) return [{ kind: 'refused', reason: 'encrypted' }];
  const files = probed.filter((p) => p.type === 'file');
  const videos = probed.filter((p) => p.type === 'vide');
  const audios = probed.filter((p) => p.type === 'soun');
  // Feeds load pieces of many videos: pair each video with the audio seen closest in time.
  const nearest = (v) => audios.slice().sort((a, b) => Math.abs(a.at - v.at) - Math.abs(b.at - v.at))[0] || null;
  const out = videos.map((v) => {
    const a = nearest(v);
    return { kind: 'pieces', height: v.height, at: v.at, size: v.total + (a?.total || 0), video: v, audio: a };
  });
  for (const f of files) {
    out.push({ kind: 'file', height: f.height, at: f.at, size: f.total, url: f.url, sound: f.sound });
  }
  if (!videos.length && !files.length && audios.length) {
    const a = audios.sort((x, y) => y.at - x.at)[0];
    out.push({ kind: 'pieces', audioOnly: true, height: 0, at: a.at, size: a.total, video: null, audio: a });
  }
  return out;
}

function hostPath(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.length > 60 ? `${u.pathname.slice(0, 60)}…` : u.pathname}`;
  } catch {
    return '';
  }
}

/** Choices from the video addresses in the page's own data (page-sources.js). */
async function resolvePageSources(sources, diag, seen) {
  const out = [];
  const files = sources.filter((p) => p.kind === 'file').slice(0, 12);
  const probes = await Promise.all(files.map((f) => probeMp4(f.url).catch((err) => ({ error: err }))));
  files.forEach((f, i) => {
    const p = probes[i];
    const fromData = f.width && f.height ? Math.min(f.width, f.height) : f.height || 0;
    if (p.error) {
      diag.push({ from: 'page', kind: 'file', at: hostPath(f.url), result: String(p.error.code || p.error.message || p.error) });
      if (p.error.code === 'gone') return;
      // Could not look inside (the site may only answer its player): still offer it.
      out.push({ kind: 'file', height: fromData, bandwidth: f.bitrate, size: 0, url: f.url, sound: null, page: true });
      return;
    }
    if (p.info?.encrypted) {
      out.push({ kind: 'refused', reason: 'encrypted' });
      return;
    }
    const video = p.info?.tracks.find((t) => t.handler === 'vide');
    const sound = p.info ? p.info.tracks.some((t) => t.handler === 'soun') : null;
    if (p.info && !video) return; // sound only: the video's own sound is part of another choice
    const height = video ? shortSide(video) || fromData : fromData;
    diag.push({ from: 'page', kind: 'file', at: hostPath(f.url), result: `ok ${height}p${sound === false ? ' no sound' : ''}` });
    out.push({ kind: 'file', height, bandwidth: f.bitrate, size: p.total, url: f.url, sound, page: true, ext: extOf(f.url, p.mime) });
  });
  for (const src of sources.filter((p) => p.kind !== 'file').slice(0, 6)) {
    if (src.url && seen.has(src.url)) continue;
    try {
      const found = src.kind === 'hls' ? await resolveHls(src, seen) : await resolveDash(src);
      out.push(...found.map((o) => ({ ...o, page: true })));
      diag.push({ from: 'page', kind: src.kind, at: src.url ? hostPath(src.url) : 'manifest in page data', result: `ok ${found.length}` });
    } catch (err) {
      diag.push({ from: 'page', kind: src.kind, at: src.url ? hostPath(src.url) : 'manifest in page data', result: String(err?.message || err) });
    }
  }
  return out;
}

function extOf(url, mime) {
  try {
    const ext = /\.(mp4|m4v|webm|mov)$/i.exec(new URL(url).pathname)?.[1];
    if (ext) return ext.toLowerCase();
  } catch {
    // fall through
  }
  return /webm/.test(mime || '') ? 'webm' : 'mp4';
}

/**
 * Choices, best first, for one video: the page's own data for that video
 * (`page.matched`), the streams the tab played, then the page's other videos.
 */
async function resolveStreams(streams, page = {}) {
  const seen = new Set();
  const diag = [];
  const matched = await resolvePageSources(page.matched || [], diag, seen);
  const network = [];
  const byKind = (k) => streams.filter((s) => s.kind === k).sort((a, b) => b.at - a.at);
  for (const s of byKind('hls')) {
    if (seen.has(s.url)) continue;
    try {
      network.push(...(await resolveHls(s, seen)).map((o) => ({ ...o, at: s.at })));
      diag.push({ from: 'network', kind: 'hls', at: hostPath(s.url), result: 'ok' });
    } catch (err) {
      diag.push({ from: 'network', kind: 'hls', at: hostPath(s.url), result: String(err?.message || err) });
    }
  }
  for (const s of byKind('dash')) {
    try {
      network.push(...(await resolveDash(s)).map((o) => ({ ...o, at: s.at })));
      diag.push({ from: 'network', kind: 'dash', at: hostPath(s.url), result: 'ok' });
    } catch (err) {
      diag.push({ from: 'network', kind: 'dash', at: hostPath(s.url), result: String(err?.message || err) });
    }
  }
  const pieces = byKind('piece').slice(0, 16);
  const fromPieces = await resolvePieces(pieces);
  diag.push(...pieces.map((s) => ({ from: 'network', kind: 'piece', at: hostPath(s.url), result: '' })));
  network.push(...fromPieces);
  const others = matched.length || network.some((o) => o.kind !== 'refused') ? [] : await resolvePageSources((page.other || []).slice(0, 8), diag, seen);

  const all = [...matched, ...network, ...others.map((o) => ({ ...o, other: true }))];
  const refused = all.find((o) => o.kind === 'refused');
  const pageFiles = new Set(matched.filter((o) => o.kind === 'file').map((o) => o.url));
  const usable = all.filter((o) => o.kind !== 'refused' && !(o.media && seen.has(o.video)) && !(o.kind === 'file' && !o.page && pageFiles.has(o.url)));
  for (const o of usable) {
    o.label = o.audioOnly ? 'audio' : label(o.height, '');
    o.hasAudio = o.kind === 'file' ? o.sound !== false : Boolean(o.audio) || o.kind === 'hls';
  }
  // This video's own data first, then what the tab played (newest first), then other videos.
  // Within each: the highest quality first, with sound before without.
  const rank = (o) => (o.other ? 2 : o.page ? 0 : 1);
  usable.sort((a, b) => rank(a) - rank(b) ||
    (rank(a) === 1 ? (b.at - a.at > 3000 ? 1 : a.at - b.at > 3000 ? -1 : 0) : 0) ||
    Number(Boolean(a.audioOnly)) - Number(Boolean(b.audioOnly)) ||
    b.height - a.height || Number(b.hasAudio) - Number(a.hasAudio) || (b.bandwidth || 0) - (a.bandwidth || 0));
  const unique = [];
  const keys = new Set();
  for (const o of usable) {
    const key = `${rank(o)}:${o.kind === 'file' ? 'file' : o.kind}:${o.label}:${o.kind === 'pieces' ? o.video?.url : ''}:${o.hasAudio}`;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(o);
  }
  const options = unique.slice(0, 10);
  const best = options.find((o) => !o.audioOnly && !o.other);
  if (best) best.best = true;
  return { options, refused: refused?.reason || '', diag };
}

// ---------- Downloading ----------

/** Pieces to fetch for one track: [{ url, range }] with the header first. */
async function hlsTrack(url) {
  const pl = parseM3u8(await fetchText(url), url);
  if (pl.type !== 'media') throw new StreamError('format', 'nested playlist');
  if (pl.encrypted) throw new StreamError('encrypted');
  if (pl.live) throw new StreamError('live');
  const pieces = pl.map ? [pl.map, ...pl.segments] : pl.segments.slice();
  return { pieces, ts: !pl.map };
}

function dashTrack(rep) {
  return { pieces: rep.init ? [rep.init, ...rep.segments] : rep.segments.slice(), ts: false };
}

function pieceTrack(piece) {
  // One whole MP4 file, fetched in 4 MB parts so several requests run at once.
  const part = 4 * 1024 * 1024;
  const pieces = [];
  if (piece.total > 0) {
    for (let start = 0; start < piece.total; start += part) {
      pieces.push({ url: piece.url, range: { start, end: Math.min(piece.total, start + part) - 1 }, glue: true });
    }
  } else {
    pieces.push({ url: piece.url, range: null });
  }
  return { pieces, ts: false, glue: true };
}

async function tracksFor(option) {
  if (option.kind === 'hls') {
    const tracks = [await hlsTrack(option.video)];
    if (option.audio) {
      const audio = await hlsTrack(option.audio);
      if (tracks[0].ts || audio.ts) return tracks; // cannot join MPEG-TS: keep the video playlist only
      tracks.push(audio);
    }
    return tracks;
  }
  if (option.kind === 'dash') return [option.video, option.audio].filter(Boolean).map(dashTrack);
  if (option.kind === 'pieces') return [option.video, option.audio].filter(Boolean).map(pieceTrack);
  throw new StreamError('format', 'unknown stream');
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

async function runJob(job) {
  const state = { controller: new AbortController(), paused: false, waiting: [], canceled: false };
  jobs.set(job.id, state);
  const { signal } = state.controller;
  try {
    const tracks = await tracksFor(job.option);
    const all = [];
    tracks.forEach((track, ti) => track.pieces.forEach((p, pi) => all.push({ ...p, ti, pi })));
    const results = tracks.map((t) => new Array(t.pieces.length));
    let done = 0;
    let downloaded = 0;
    let lastSent = 0;
    let speedFrom = { time: Date.now(), bytes: 0 };
    let speed = 0;
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastSent < PROGRESS_MS) return;
      if (now - speedFrom.time >= 1000) {
        speed = ((downloaded - speedFrom.bytes) * 1000) / (now - speedFrom.time);
        speedFrom = { time: now, bytes: downloaded };
      }
      lastSent = now;
      const total = done ? Math.round((downloaded / done) * all.length) : 0;
      send({ type: 'streamProgress', id: job.id, downloaded, total, speed: Math.round(speed), pieces: done, of: all.length });
    };
    let next = 0;
    const worker = async () => {
      while (next < all.length) {
        while (state.paused) await new Promise((r) => state.waiting.push(r));
        if (signal.aborted) return;
        const p = all[next];
        next += 1;
        const { bytes } = await fetchBytes(p.url, p.range, signal);
        results[p.ti][p.pi] = bytes;
        done += 1;
        downloaded += bytes.length;
        report(false);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, all.length) }, worker));
    } catch (err) {
      state.controller.abort(); // stop the other requests
      throw err;
    }
    if (state.canceled) throw new StreamError('canceled');
    report(true);

    let parts;
    let ext;
    if (tracks.length === 1) {
      parts = results[0];
      ext = tracks[0].ts ? 'ts' : job.option.audioOnly ? 'm4a' : 'mp4';
      if (!tracks[0].ts) {
        const head = tracks[0].glue ? new Blob(parts.slice(0, 2)) : null;
        const first = head ? new Uint8Array(await head.arrayBuffer()) : parts[0];
        if (readInit(first)?.encrypted) throw new StreamError('encrypted');
      }
    } else {
      const inputs = [];
      for (let i = 0; i < tracks.length; i += 1) {
        inputs.push(tracks[i].glue ? [new Uint8Array(await new Blob(results[i]).arrayBuffer())] : results[i]);
      }
      parts = joinTracks(inputs);
      ext = 'mp4';
    }
    const blob = new Blob(parts, { type: ext === 'ts' ? 'video/mp2t' : ext === 'm4a' ? 'audio/mp4' : 'video/mp4' });
    const url = URL.createObjectURL(blob);
    send({ type: 'streamReady', id: job.id, url, ext, size: blob.size });
  } catch (err) {
    const code = state.canceled ? 'canceled' : err?.code || (err?.message === 'encrypted' ? 'encrypted' : 'network');
    send({ type: 'streamFailed', id: job.id, code, message: String(err?.message || err) });
  } finally {
    jobs.delete(job.id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'streamResolve') {
    resolveStreams(msg.streams || [], msg.page || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ options: [], refused: '', error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === 'streamStart') {
    runJob(msg.job);
    sendResponse({ ok: true });
  } else if (msg.type === 'streamPause' || msg.type === 'streamResume') {
    const state = jobs.get(msg.id);
    if (state) {
      state.paused = msg.type === 'streamPause';
      if (!state.paused) state.waiting.splice(0).forEach((r) => r());
    }
    sendResponse({ ok: Boolean(state) });
  } else if (msg.type === 'streamCancel') {
    const state = jobs.get(msg.id);
    if (state) {
      state.canceled = true;
      state.controller.abort();
      state.paused = false;
      state.waiting.splice(0).forEach((r) => r());
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'streamRevoke') {
    URL.revokeObjectURL(msg.url);
    sendResponse({ ok: true });
  } else if (msg.type === 'streamPing') {
    sendResponse({ ok: true, running: jobs.size });
  } else {
    return false;
  }
  return false;
});
