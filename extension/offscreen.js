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
      out.push({ kind: 'hls', height: v.height, bandwidth: v.bandwidth, video: v.url, audio: audio?.url || '' });
    }
    return out;
  }
  if (pl.encrypted) return [{ kind: 'refused', reason: 'encrypted' }];
  if (pl.live) return [{ kind: 'refused', reason: 'live' }];
  return [{ kind: 'hls', height: 0, bandwidth: 0, video: stream.url, audio: '', media: true }];
}

async function resolveDash(stream) {
  const doc = new DOMParser().parseFromString(await fetchText(stream.url), 'application/xml');
  const mpd = parseMpd(doc, stream.url);
  if (mpd.protected) return [{ kind: 'refused', reason: 'encrypted' }];
  if (mpd.live) return [{ kind: 'refused', reason: 'live' }];
  const audio = mpd.audio.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  const out = mpd.video.map((v) => ({ kind: 'dash', height: v.height, bandwidth: v.bandwidth, video: v, audio }));
  if (audio) out.push({ kind: 'dash', audioOnly: true, height: 0, bandwidth: audio.bandwidth, video: null, audio });
  return out;
}

/** First bytes of an MP4 piece: track type and size. */
async function probePiece(stream) {
  const { bytes, res } = await fetchBytes(stream.url, { start: 0, end: PROBE_BYTES - 1 });
  const info = readInit(bytes);
  if (!info || info.tracks.length !== 1) return null;
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '')?.[1]) ||
    (res.status === 200 ? bytes.length : stream.total || 0);
  const t = info.tracks[0];
  return { url: stream.url, at: stream.at, total, encrypted: info.encrypted, type: t.handler, height: t.height };
}

async function resolvePieces(streams) {
  const probed = (await Promise.all(streams.map((s) => probePiece(s).catch(() => null)))).filter(Boolean);
  if (probed.some((p) => p.encrypted)) return [{ kind: 'refused', reason: 'encrypted' }];
  const videos = probed.filter((p) => p.type === 'vide');
  const audios = probed.filter((p) => p.type === 'soun');
  // Feeds load pieces of many videos: pair each video with the audio seen closest in time.
  const nearest = (v) => audios.slice().sort((a, b) => Math.abs(a.at - v.at) - Math.abs(b.at - v.at))[0] || null;
  const out = videos.map((v) => {
    const a = nearest(v);
    return { kind: 'pieces', height: v.height, at: v.at, size: v.total + (a?.total || 0), video: v, audio: a };
  });
  if (!videos.length && audios.length) {
    const a = audios.sort((x, y) => y.at - x.at)[0];
    out.push({ kind: 'pieces', audioOnly: true, height: 0, at: a.at, size: a.total, video: null, audio: a });
  }
  return out;
}

/** Choices, best first, for the streams captured in one tab. */
async function resolveStreams(streams) {
  const seen = new Set();
  const out = [];
  const byKind = (k) => streams.filter((s) => s.kind === k).sort((a, b) => b.at - a.at);
  for (const s of byKind('hls')) {
    if (seen.has(s.url)) continue;
    try {
      out.push(...(await resolveHls(s, seen)).map((o) => ({ ...o, at: s.at })));
    } catch {
      // A playlist that cannot be read is left out.
    }
  }
  for (const s of byKind('dash')) {
    try {
      out.push(...(await resolveDash(s)).map((o) => ({ ...o, at: s.at })));
    } catch {
      // A manifest that cannot be read is left out.
    }
  }
  out.push(...(await resolvePieces(byKind('piece').slice(0, 16))));

  const refused = out.find((o) => o.kind === 'refused');
  const usable = out.filter((o) => o.kind !== 'refused' && !(o.media && seen.has(o.video)));
  // Newest stream first, then the highest quality.
  usable.sort((a, b) => (b.at - a.at > 3000 ? 1 : a.at - b.at > 3000 ? -1 : 0) || b.height - a.height || b.bandwidth - a.bandwidth);
  for (const o of usable) {
    o.label = o.audioOnly ? 'audio' : label(o.height, '');
    o.hasAudio = Boolean(o.audio) || o.kind === 'hls';
  }
  const unique = [];
  const keys = new Set();
  for (const o of usable) {
    const key = `${o.kind}:${o.label}:${o.kind === 'pieces' ? o.video?.url : ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(o);
  }
  return { options: unique.slice(0, 8), refused: refused?.reason || '' };
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
    resolveStreams(msg.streams || [])
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
