// Video addresses found in a page's own data (M16). Classic script, loaded in
// two worlds: the page's world (page-hook.js, which reads the site's API
// replies) and the content-script world (overlay.js, which reads the DOM).
//
// Social sites list every quality of a video in the data their player gets:
// LinkedIn ("progressiveStreams"), X ("variants"), Instagram
// ("video_versions"), Facebook ("browser_native_hd_url", a DASH manifest in a
// string), TikTok ("bitrateInfo"), Vimeo ("progressive", "hls"), and many
// sites use <video data-sources>, og:video or JSON-LD "contentUrl". Reading
// that data gives the original resolution even when the player only shows a
// lower one, and works before the video plays.
//
// A source is { url, kind: 'file' | 'hls' | 'dash', text?, width, height,
// bitrate, duration, mime, images: [thumbnail urls] }. Nothing here sends
// anything anywhere; the callers pass sources to the extension only.

(() => {
  if (globalThis.__sidmSources) return;

  const MAX_DEPTH = 40;
  const MAX_SOURCES = 200;
  const IMAGE_DEPTH = 3; // how far below an object its thumbnail may sit
  const MAX_TEXT = 12 * 1024 * 1024;
  const HINT = /\.mp4|\.m3u8|\.mpd|\.webm|\.m4v|playlist\/vid|<MPD|video_versions|playAddr/i;
  const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)(\?|$)|\/(thumb|poster|img|image)/i;
  const HINT_KEYS = /^(width|height|bitrate|bitRate|bit_rate|bandwidth|averageBandwidth|duration|duration_millis|durationInMs|durationMs|video_duration|lengthSeconds|content_type|contentType|mimeType|mime_type|type)$/;

  function num(v) {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }

  function isHttp(s) {
    return typeof s === 'string' && s.length < 4096 && /^https?:\/\/[^\s"'<>]+$/i.test(s);
  }

  /** 'file' | 'hls' | 'dash' | '' for a URL, from its address and the hints around it. */
  function kindOf(url, key = '', mime = '') {
    let path = '';
    let host = '';
    try {
      const u = new URL(url);
      path = u.pathname.toLowerCase();
      host = u.hostname.toLowerCase();
    } catch {
      return '';
    }
    const m = String(mime).toLowerCase();
    if (/\.m3u8$/.test(path) || /mpegurl/.test(m)) return 'hls';
    if (/\.mpd$/.test(path) || /dash\+xml/.test(m)) return 'dash';
    if (/\.(jpe?g|png|webp|avif|gif|svg|css|js|json|html?|vtt|srt|ts|m4s)$/.test(path)) return '';
    if (/\.(mp4|m4v|webm|mov)$/.test(path) || /^video\/(mp4|webm|quicktime)/.test(m)) return 'file';
    if (host.endsWith('licdn.com') && path.includes('/playlist/vid/')) return /hls/.test(path) ? 'hls' : 'file';
    if (/(^|\.)(video\.twimg\.com)$/.test(host)) return /\.m3u8/.test(path) ? 'hls' : 'file';
    if (/(playable_url|browser_native_(hd|sd)_url|video_url|videourl|playaddr|downloadaddr|contenturl|progressive_url|mp4_url|hd_src|sd_src)/i.test(key)) {
      return 'file';
    }
    return '';
  }

  /** Width and height written in a URL ("1280x720", "mp4-720p"). */
  function sizeFromUrl(url) {
    const wh = /[/_-](\d{3,4})x(\d{3,4})[/_.-]/.exec(url);
    if (wh) return { width: Number(wh[1]), height: Number(wh[2]) };
    const p = /[/_-](\d{3,4})p[/_.-]/i.exec(url);
    if (p) return { width: 0, height: Number(p[1]) };
    return { width: 0, height: 0 };
  }

  /** Thumbnail URLs at most IMAGE_DEPTH levels below `node`. */
  function imagesBelow(node, depth, out) {
    if (!node || typeof node !== 'object' || depth > IMAGE_DEPTH || out.length >= 6) return out;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (isHttp(v) && IMAGE_RE.test(v) && !kindOf(v, k)) out.push(v);
      } else if (v && typeof v === 'object') {
        imagesBelow(v, depth + 1, out);
      }
      if (out.length >= 6) break;
    }
    return out;
  }

  function hintsOf(obj, ctx) {
    const h = { ...ctx };
    let localImages = null;
    for (const [k, v] of Object.entries(obj)) {
      if (!HINT_KEYS.test(k)) continue;
      if (k === 'width' && num(v)) h.width = num(v);
      else if (k === 'height' && num(v)) h.height = num(v);
      else if (/bit_?rate|bandwidth/i.test(k) && num(v)) h.bitrate = num(v);
      else if (/millis|InMs|Ms$/.test(k) && num(v)) h.duration = num(v) / 1000;
      else if (/duration|lengthSeconds/i.test(k) && num(v)) h.duration = num(v) > 36000 ? num(v) / 1000 : num(v);
      else if (/type/i.test(k) && typeof v === 'string' && /\//.test(v)) h.mime = v;
    }
    localImages = imagesBelow(obj, 0, []);
    if (localImages.length) h.images = localImages;
    return h;
  }

  function add(out, seen, src) {
    if (out.length >= MAX_SOURCES) return;
    const key = src.text ? `text:${src.text.length}:${src.text.slice(0, 200)}` : src.url;
    if (seen.has(key)) return;
    seen.add(key);
    const fromUrl = src.url ? sizeFromUrl(src.url) : { width: 0, height: 0 };
    out.push({
      url: src.url || '',
      kind: src.kind,
      text: src.text || undefined,
      width: src.width || fromUrl.width || 0,
      height: src.height || fromUrl.height || 0,
      bitrate: src.bitrate || 0,
      duration: src.duration || 0,
      mime: src.mime || '',
      images: (src.images || []).slice(0, 6),
    });
  }

  /** Every video source in parsed JSON. */
  function walk(node, ctx, out, seen, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || out.length >= MAX_SOURCES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx, out, seen, depth + 1);
      return;
    }
    const h = hintsOf(node, ctx);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (isHttp(v)) {
          const kind = kindOf(v, k, h.mime);
          if (kind) add(out, seen, { ...h, url: v, kind });
        } else if (v.length > 200 && v.includes('<MPD') && /manifest|mpd|dash/i.test(k)) {
          add(out, seen, { ...h, url: '', kind: 'dash', text: v });
        }
      } else if (v && typeof v === 'object') {
        walk(v, h, out, seen, depth + 1);
      }
    }
  }

  /** Video URLs written in plain text or JavaScript (JSON-escaped slashes allowed). */
  function scanText(text, out, seen) {
    const re = /https?:(?:\\?\/){2}[^\s"'<>\\]*(?:\\\/[^\s"'<>\\]*)*/g;
    let m;
    let count = 0;
    while ((m = re.exec(text)) && count < 2000) {
      count += 1;
      const url = m[0].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      if (!isHttp(url)) continue;
      const kind = kindOf(url);
      if (kind) add(out, seen, { url, kind });
    }
  }

  /** Sources in a reply body or a script's text: JSON first, then a plain scan. */
  function fromText(text, out = [], seen = new Set()) {
    if (typeof text !== 'string' || text.length > MAX_TEXT || !HINT.test(text)) return out;
    let body = text.trim().replace(/^for\s*\(;;\);/, '').replace(/^\)\]\}',?/, '');
    const parsed = [];
    try {
      parsed.push(JSON.parse(body));
    } catch {
      // Several JSON documents, one per line (Facebook, some GraphQL replies).
      for (const line of body.split('\n')) {
        const l = line.trim();
        if (!l || (l[0] !== '{' && l[0] !== '[')) continue;
        try {
          parsed.push(JSON.parse(l));
        } catch {
          // not JSON
        }
      }
    }
    if (parsed.length) {
      for (const p of parsed) walk(p, {}, out, seen, 0);
    } else {
      body = null;
      scanText(text, out, seen);
    }
    return out;
  }

  function fromJson(value, out = [], seen = new Set()) {
    walk(value, {}, out, seen, 0);
    return out;
  }

  /** Last part of a URL path, used to compare thumbnails in different sizes. */
  function imageKey(url) {
    try {
      const u = new URL(url, location.href);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      return last.length >= 8 ? last.replace(/\.(jpe?g|png|webp|avif|gif)$/i, '') : u.pathname;
    } catch {
      return '';
    }
  }

  globalThis.__sidmSources = Object.freeze({ fromText, fromJson, kindOf, sizeFromUrl, imageKey, isHttp });
})();
