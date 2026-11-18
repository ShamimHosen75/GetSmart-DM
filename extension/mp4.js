// MP4 helpers for in-browser video downloads (M15). Pure functions, no
// Chrome APIs, so they run in the offscreen page and in tests.
//
// - readInit(bytes): tracks in an MP4 header (type, id, timescale, size) and
//   whether it is encrypted.
// - joinTracks(inputs): one MP4 from a separate video file and audio file,
//   the way sites like Facebook, Reddit, X and DASH players send them.
//   Works for fragmented MP4 (init + moof/mdat pieces, the usual case) and for
//   plain MP4 files (moov + one mdat).
// Nothing here decrypts anything: encrypted (DRM) tracks are reported so the
// caller can refuse them.

const te = new TextEncoder();

function u32(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b, o) {
  return u32(b, o) * 4294967296 + u32(b, o + 4);
}

function setU32(b, o, v) {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}

function setU64(b, o, v) {
  setU32(b, o, Math.floor(v / 4294967296));
  setU32(b, o + 4, v % 4294967296);
}

function type4(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Boxes between start and end: [{ type, start, size, hdr }]. Stops at a cut-off box. */
export function boxes(b, start = 0, end = b.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = type4(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = u64(b, o + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < hdr) break;
    out.push({ type, start: o, size, hdr, complete: o + size <= end });
    if (o + size > end) break;
    o += size;
  }
  return out;
}

function kids(b, box) {
  return boxes(b, box.start + box.hdr, Math.min(b.length, box.start + box.size));
}

function kid(b, box, type) {
  return kids(b, box).find((k) => k.type === type) || null;
}

function path(b, box, types) {
  let cur = box;
  for (const t of types) {
    cur = cur && kid(b, cur, t);
  }
  return cur;
}

function slice(b, box) {
  return b.subarray(box.start, box.start + box.size);
}

function contains(b, box, word) {
  const w = te.encode(word);
  const end = Math.min(b.length, box.start + box.size) - 4;
  for (let i = box.start; i <= end; i += 1) {
    if (b[i] === w[0] && b[i + 1] === w[1] && b[i + 2] === w[2] && b[i + 3] === w[3]) return true;
  }
  return false;
}

function trakInfo(b, trak) {
  const tkhd = kid(b, trak, 'tkhd');
  const mdhd = path(b, trak, ['mdia', 'mdhd']);
  const hdlr = path(b, trak, ['mdia', 'hdlr']);
  const tv = b[tkhd.start + tkhd.hdr];
  const idAt = tkhd.start + tkhd.hdr + (tv === 1 ? 20 : 12);
  const end = tkhd.start + tkhd.size;
  const mv = mdhd ? b[mdhd.start + mdhd.hdr] : 0;
  return {
    id: u32(b, idAt),
    idAt,
    handler: hdlr ? type4(b, hdlr.start + hdlr.hdr + 8) : '',
    timescale: mdhd ? u32(b, mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12)) : 1000,
    width: u32(b, end - 8) >>> 16,
    height: u32(b, end - 4) >>> 16,
  };
}

/**
 * What is in the MP4 header in `b` (the start of a file is enough as long as
 * the moov box is complete). Returns null if there is no complete moov.
 */
export function readInit(b) {
  const top = boxes(b);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov || !moov.complete) return null;
  const tracks = kids(b, moov).filter((x) => x.type === 'trak').map((trak) => trakInfo(b, trak));
  return {
    tracks,
    fragmented: Boolean(kid(b, moov, 'mvex')),
    encrypted: contains(b, moov, 'encv') || contains(b, moov, 'enca') || contains(b, moov, 'pssh'),
  };
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function box(type, ...payload) {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  setU32(out, 0, out.length);
  out.set(te.encode(type), 4);
  out.set(body, 8);
  return out;
}

/** One input file (array of Uint8Array pieces) as its header and its fragments. */
function splitInput(chunks) {
  let ftyp = null;
  let moov = null;
  let mdats = [];
  const frags = [];
  let current = null;
  let pos = 0;
  for (const chunk of chunks) {
    for (const x of boxes(chunk)) {
      const bytes = slice(chunk, x);
      if (x.type === 'ftyp' && !ftyp) ftyp = bytes;
      else if (x.type === 'moov' && !moov) moov = bytes;
      else if (x.type === 'moof') {
        current = { moof: bytes, at: pos + x.start, data: [] };
        frags.push(current);
      } else if (x.type === 'mdat') {
        if (current) current.data.push(bytes);
        else mdats.push({ bytes, at: pos + x.start });
      }
    }
    pos += chunk.length;
  }
  if (!moov) throw new Error('no MP4 header');
  return { ftyp, moov, frags, mdats };
}

function firstTrak(moov) {
  const top = boxes(moov)[0];
  const trak = kids(moov, top).find((x) => x.type === 'trak');
  if (!trak) throw new Error('no track');
  return { top, trak, info: trakInfo(moov, trak) };
}

function patchedTrak(moov, trak, newId) {
  const copy = slice(moov, trak).slice();
  const info = trakInfo(copy, boxes(copy)[0]);
  setU32(copy, info.idAt, newId);
  return copy;
}

function trex(trackId, from) {
  const body = new Uint8Array(24);
  if (from) body.set(from.subarray(from.length - 24));
  body[0] = 0;
  body[1] = body[2] = body[3] = 0;
  setU32(body, 4, trackId);
  if (!from) setU32(body, 8, 1); // default sample description index
  return box('trex', body);
}

function mvhd(moov, nextId) {
  const top = boxes(moov)[0];
  const src = kid(moov, top, 'mvhd');
  const copy = slice(moov, src).slice();
  setU32(copy, copy.length - 4, nextId);
  return copy;
}

/** Copy of a moof with new sequence number and track id; base offsets moved by `shift`. */
function patchMoof(moof, seq, trackId, shift) {
  const copy = moof.slice();
  const top = boxes(copy)[0];
  let decodeTime = 0;
  for (const x of kids(copy, top)) {
    if (x.type === 'mfhd') setU32(copy, x.start + x.hdr + 4, seq);
    if (x.type !== 'traf') continue;
    for (const y of kids(copy, x)) {
      const at = y.start + y.hdr;
      if (y.type === 'tfhd') {
        setU32(copy, at + 4, trackId);
        const flags = u32(copy, at) & 0xffffff;
        if (flags & 1) setU64(copy, at + 8, u64(copy, at + 8) + shift);
      } else if (y.type === 'tfdt') {
        decodeTime = copy[at] === 1 ? u64(copy, at + 4) : u32(copy, at + 4);
      }
    }
  }
  return { bytes: copy, decodeTime };
}

function defaultFtyp() {
  const body = concat([te.encode('isom'), new Uint8Array([0, 0, 2, 0]), te.encode('isomiso6mp41')]);
  return box('ftyp', body);
}

/**
 * Join separate tracks (each an array of Uint8Array pieces holding one MP4
 * file, usually one video and one audio) into one MP4. Returns an array of
 * Uint8Array parts to put in a Blob.
 */
export function joinTracks(inputs) {
  const parsed = inputs.map(splitInput);
  for (const p of parsed) {
    const info = readInit(p.moov);
    if (info?.encrypted) throw new Error('encrypted');
  }
  const fragmented = parsed.every((p) => p.frags.length > 0);
  if (!fragmented && parsed.some((p) => p.frags.length > 0)) throw new Error('mixed MP4 kinds');
  return fragmented ? joinFragmented(parsed) : joinPlain(parsed);
}

function joinFragmented(parsed) {
  const ftyp = parsed[0].ftyp || defaultFtyp();
  const traks = [];
  const trexes = [];
  const timescales = [];
  parsed.forEach((p, i) => {
    const { top, trak, info } = firstTrak(p.moov);
    traks.push(patchedTrak(p.moov, trak, i + 1));
    const mvex = kid(p.moov, top, 'mvex');
    const own = mvex && kids(p.moov, mvex).find((x) => x.type === 'trex' && u32(p.moov, x.start + x.hdr + 4) === info.id);
    trexes.push(trex(i + 1, own ? slice(p.moov, own) : null));
    timescales.push(info.timescale || 1);
  });
  const moov = box('moov', mvhd(parsed[0].moov, parsed.length + 1), ...traks, box('mvex', ...trexes));

  // Interleave the fragments by decode time.
  const queue = [];
  parsed.forEach((p, i) => {
    for (const f of p.frags) {
      const { decodeTime } = patchMoof(f.moof, 0, i + 1, 0);
      queue.push({ f, track: i, time: decodeTime / timescales[i] });
    }
  });
  queue.sort((a, b) => a.time - b.time || a.track - b.track);

  const parts = [ftyp, moov];
  let pos = ftyp.length + moov.length;
  let seq = 1;
  for (const { f, track } of queue) {
    const { bytes } = patchMoof(f.moof, seq, track + 1, pos - f.at);
    seq += 1;
    parts.push(bytes);
    pos += bytes.length;
    for (const d of f.data) {
      parts.push(d);
      pos += d.length;
    }
  }
  return parts;
}

/** Chunk offset tables (stco/co64) inside a trak copy, moved by `shift`. */
function shiftChunkOffsets(trak, shift) {
  const stbl = path(trak, boxes(trak)[0], ['mdia', 'minf', 'stbl']);
  if (!stbl) throw new Error('no sample table');
  for (const x of kids(trak, stbl)) {
    const at = x.start + x.hdr;
    const count = u32(trak, at + 4);
    if (x.type === 'stco') {
      for (let i = 0; i < count; i += 1) {
        const v = u32(trak, at + 8 + i * 4) + shift;
        if (v > 0xffffffff || v < 0) throw new Error('file too large');
        setU32(trak, at + 8 + i * 4, v);
      }
    } else if (x.type === 'co64') {
      for (let i = 0; i < count; i += 1) setU64(trak, at + 8 + i * 8, u64(trak, at + 8 + i * 8) + shift);
    }
  }
}

function joinPlain(parsed) {
  const ftyp = parsed[0].ftyp || defaultFtyp();
  const traks = parsed.map((p, i) => {
    if (p.mdats.length !== 1) throw new Error('unexpected MP4 layout');
    return patchedTrak(p.moov, firstTrak(p.moov).trak, i + 1);
  });
  const header = (list) => box('moov', mvhd(parsed[0].moov, parsed.length + 1), ...list);
  // Sizes do not change when offsets are patched, so the layout is known up front.
  const moovSize = header(traks).length;
  let pos = ftyp.length + moovSize;
  const data = [];
  parsed.forEach((p, i) => {
    const mdat = p.mdats[0];
    shiftChunkOffsets(traks[i], pos - mdat.at);
    data.push(mdat.bytes);
    pos += mdat.bytes.length;
  });
  return [ftyp, header(traks), ...data];
}
