// Playlist parsers for in-browser video downloads (M15). Pure functions.
//
// parseM3u8(text, url): HLS master or media playlist.
// parseMpd(doc, url):   DASH manifest (an XML Document from DOMParser).
// Encrypted or DRM streams are marked so the caller refuses them; nothing here
// tries to get around protection.

function resolve(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Attribute list of an HLS tag: KEY=VALUE,KEY="quoted, value". */
export function hlsAttributes(text) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function byteRange(text, nextOffset) {
  const m = /^(\d+)(?:@(\d+))?$/.exec((text || '').trim());
  if (!m) return null;
  const length = Number(m[1]);
  const start = m[2] !== undefined ? Number(m[2]) : nextOffset;
  return { start, end: start + length - 1 };
}

/**
 * HLS playlist. Master: { type: 'master', variants: [{ url, bandwidth, width,
 * height, codecs, audio }], audio: { groupId: [{ url, name, isDefault }] } }.
 * Media: { type: 'media', segments: [{ url, range }], map, duration, live,
 * encrypted }.
 */
export function parseM3u8(text, url) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('not an HLS playlist');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audio = {};
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = hlsAttributes(line.slice(18));
        const next = lines.slice(i + 1).find((l) => !l.startsWith('#'));
        if (!next) continue;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          url: resolve(next, url),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: w || 0,
          height: h || 0,
          codecs: a.CODECS || '',
          audio: a.AUDIO || '',
        });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = hlsAttributes(line.slice(13));
        if (a.TYPE !== 'AUDIO' || !a.URI) continue;
        (audio[a['GROUP-ID']] ||= []).push({ url: resolve(a.URI, url), name: a.NAME || '', isDefault: a.DEFAULT === 'YES' });
      }
    }
    return { type: 'master', variants, audio };
  }

  const segments = [];
  let map = null;
  let encrypted = false;
  let duration = 0;
  let pendingRange = null;
  let nextOffset = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration += parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = byteRange(line.slice(17), nextOffset);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = hlsAttributes(line.slice(11));
      map = { url: resolve(a.URI, url), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = hlsAttributes(line.slice(line.indexOf(':') + 1));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolve(line, url), range: pendingRange });
      if (pendingRange) nextOffset = pendingRange.end + 1;
      pendingRange = null;
    }
  }
  return {
    type: 'media',
    segments,
    map,
    duration,
    live: !lines.includes('#EXT-X-ENDLIST') && !lines.some((l) => l === '#EXT-X-PLAYLIST-TYPE:VOD'),
    encrypted,
  };
}

// ---------- DASH ----------

function children(el, name) {
  return el ? Array.from(el.children).filter((c) => c.localName === name) : [];
}

function first(el, name) {
  return children(el, name)[0] || null;
}

/** ISO 8601 duration ("PT1H2M3.5S") in seconds. */
export function isoSeconds(text) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text || '');
  if (!m) return 0;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

function baseUrl(el, base) {
  const b = first(el, 'BaseURL');
  return b ? resolve(b.textContent.trim(), base) : base;
}

function fillTemplate(template, vars) {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (all, name, width) => {
    if (!name) return '$';
    const value = String(vars[name]);
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function rangeOf(text) {
  const m = /^(\d+)-(\d+)$/.exec(text || '');
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/** Merged attribute from the Representation, then its AdaptationSet. */
function attr(name, ...els) {
  for (const el of els) {
    const v = el?.getAttribute(name);
    if (v) return v;
  }
  return '';
}

function segmentsFor(rep, set, period, repBase, periodSeconds) {
  const vars = { RepresentationID: rep.getAttribute('id') || '', Bandwidth: rep.getAttribute('bandwidth') || '' };
  const tpl = first(rep, 'SegmentTemplate') || first(set, 'SegmentTemplate') || first(period, 'SegmentTemplate');
  if (tpl) {
    const t = (name) => attr(name, first(rep, 'SegmentTemplate'), first(set, 'SegmentTemplate'), first(period, 'SegmentTemplate'));
    const timescale = Number(t('timescale')) || 1;
    const startNumber = Number(t('startNumber') || 1);
    const media = t('media');
    const initTpl = t('initialization');
    const init = initTpl ? { url: resolve(fillTemplate(initTpl, vars), repBase), range: null } : null;
    const segments = [];
    const timeline = first(tpl, 'SegmentTimeline') ||
      first(first(set, 'SegmentTemplate'), 'SegmentTimeline') || first(first(period, 'SegmentTemplate'), 'SegmentTimeline');
    if (timeline) {
      let time = 0;
      let number = startNumber;
      for (const s of children(timeline, 'S')) {
        if (s.getAttribute('t')) time = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        let repeat = Number(s.getAttribute('r') || 0);
        if (repeat < 0) repeat = Math.max(0, Math.ceil((periodSeconds * timescale - time) / d) - 1);
        for (let i = 0; i <= repeat; i += 1) {
          segments.push({ url: resolve(fillTemplate(media, { ...vars, Number: number, Time: time }), repBase), range: null });
          time += d;
          number += 1;
        }
      }
    } else {
      const duration = Number(t('duration'));
      if (!duration || !periodSeconds) throw new Error('unknown DASH length');
      const count = Math.ceil((periodSeconds * timescale) / duration);
      for (let i = 0; i < count; i += 1) {
        segments.push({ url: resolve(fillTemplate(media, { ...vars, Number: startNumber + i, Time: i * duration }), repBase), range: null });
      }
    }
    return { init, segments };
  }
  const list = first(rep, 'SegmentList') || first(set, 'SegmentList');
  if (list) {
    const initEl = first(list, 'Initialization');
    const init = initEl ? { url: resolve(initEl.getAttribute('sourceURL') || '', repBase), range: rangeOf(initEl.getAttribute('range')) } : null;
    const segments = children(list, 'SegmentURL').map((s) => ({
      url: resolve(s.getAttribute('media') || '', repBase),
      range: rangeOf(s.getAttribute('mediaRange')),
    }));
    return { init, segments };
  }
  // SegmentBase or nothing: the BaseURL is one whole file.
  return { init: null, segments: [{ url: repBase, range: null }] };
}

/**
 * DASH manifest: { live, protected, duration, video: [rep], audio: [rep] }
 * with rep = { id, bandwidth, width, height, codecs, mime, init, segments }.
 */
export function parseMpd(doc, url) {
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('not a DASH manifest');
  const live = mpd.getAttribute('type') === 'dynamic';
  const period = first(mpd, 'Period');
  const duration = isoSeconds(period?.getAttribute('duration')) || isoSeconds(mpd.getAttribute('mediaPresentationDuration'));
  const out = { live, protected: false, duration, video: [], audio: [] };
  if (!period) return out;
  const periodBase = baseUrl(period, baseUrl(mpd, url));
  for (const set of children(period, 'AdaptationSet')) {
    const setBase = baseUrl(set, periodBase);
    if (children(set, 'ContentProtection').length) out.protected = true;
    for (const rep of children(set, 'Representation')) {
      if (children(rep, 'ContentProtection').length) out.protected = true;
      const mime = attr('mimeType', rep, set);
      const contentType = attr('contentType', rep, set) || mime.split('/')[0];
      if (contentType !== 'video' && contentType !== 'audio') continue;
      const { init, segments } = segmentsFor(rep, set, period, baseUrl(rep, setBase), duration);
      out[contentType].push({
        id: rep.getAttribute('id') || '',
        bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
        width: Number(attr('width', rep, set)) || 0,
        height: Number(attr('height', rep, set)) || 0,
        codecs: attr('codecs', rep, set),
        mime,
        init,
        segments,
      });
    }
  }
  return out;
}
