// SIDM video button (M10). Content script, classic script (not a module).
//
// Shows a small "Download" button at the top-right corner of a video while the
// pointer is over it, or for a moment when a video starts playing. Clicking
// opens a short menu with what can be saved:
//   - the qualities SIDM can save by itself from the streams the page played
//     (HLS, DASH, MP4 pieces; joined into one MP4 in the browser, M15),
//   - when the optional companion app is installed: its qualities too (needed
//     for YouTube, whose streams the browser cannot save by itself),
//   - the video/audio files this tab played (from media detection),
//   - the qualities listed in the page's own data for that video (M16: the
//     site's API replies, <video data-sources>, og:video...), highest first,
//   - "Copy debug info", for reporting a site that does not work.
// In feeds (Facebook, X, Instagram...) the video's own post link is used.
// It never runs where the service worker says no: YouTube (when turned off),
// DRM services, sites the user disabled, or when the setting is off.
// Everything lives in a closed shadow root so page CSS cannot touch it.

(() => {
  if (window.__gsdmOverlay) return;
  window.__gsdmOverlay = true;

  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 112;
  const HIDE_AFTER_MS = 2500;
  const SCAN_MS = 2000;
  const QUALITIES = [
    ['best', 'qualityBest'],
    ['1080', 'quality1080'],
    ['720', 'quality720'],
    ['480', 'quality480'],
    ['360', 'quality360'],
    ['audio', 'qualityAudio'],
  ];

  let info = null; // { enabled, site, strings, quality }
  let host;
  let root;
  let button;
  let menu;
  let currentVideo = null;
  let hideTimer = 0;
  let menuOpen = false;
  let videos = []; // every <video> on the page, including open shadow roots
  let reportedVideo = false;
  let scanQueued = false;

  // Video addresses from the page's own data (page-hook.js / page-sources.js, M16).
  const S = globalThis.__sidmSources;
  const MAX_PAGE_SOURCES = 300;
  const pageSources = new Map(); // key -> source, newest last
  document.addEventListener('sidm-sources', (event) => {
    let list;
    try {
      list = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const src of list) {
      if (!src || (src.kind !== 'file' && src.kind !== 'hls' && src.kind !== 'dash')) continue;
      if (src.url ? !S?.isHttp(src.url) : typeof src.text !== 'string') continue;
      const key = src.url || `text:${src.text.length}:${src.text.slice(0, 200)}`;
      pageSources.delete(key);
      pageSources.set(key, { ...src, at: Date.now() });
    }
    while (pageSources.size > MAX_PAGE_SOURCES) pageSources.delete(pageSources.keys().next().value);
  });

  /** Sources written on the <video> itself or the elements around it (src, <source>, data-sources...). */
  function domSources(video) {
    if (!S || !video) return [];
    const out = [];
    const seen = new Set();
    const own = video.currentSrc || video.src || '';
    if (/^https?:/i.test(own)) {
      const kind = S.kindOf(own, 'src', '') || 'file';
      out.push({ url: own, kind, width: video.videoWidth, height: video.videoHeight, duration: video.duration || 0, images: [], mime: '' });
      seen.add(own);
    }
    for (const source of video.querySelectorAll('source[src]')) {
      const kind = S.kindOf(source.src, 'src', source.type) || (/^video\//.test(source.type) ? 'file' : '');
      if (kind && !seen.has(source.src)) {
        seen.add(source.src);
        out.push({ url: source.src, kind, width: 0, height: 0, duration: 0, images: [], mime: source.type || '' });
      }
    }
    let el = video;
    for (let depth = 0; el && depth < 5; depth += 1, el = el.parentElement) {
      for (const attr of el.attributes || []) {
        const v = attr.value;
        if (v.length < 12 || v.length > 200000 || !/https?:/i.test(v) || attr.name === 'src' || attr.name === 'poster') continue;
        for (const src of S.fromText(v)) {
          if (src.url && seen.has(src.url)) continue;
          if (src.url) seen.add(src.url);
          out.push(src);
        }
      }
    }
    return out;
  }

  function metaSources() {
    if (!S) return [];
    const out = [];
    for (const m of document.querySelectorAll('meta[property^="og:video"], meta[name^="twitter:player:stream"], meta[itemprop="contentUrl"]')) {
      const url = m.content || '';
      const kind = S.isHttp(url) ? S.kindOf(url, 'contentUrl', '') : '';
      if (kind) out.push({ url, kind, width: 0, height: 0, duration: 0, images: [], mime: '' });
    }
    return out;
  }

  /**
   * Page sources for one <video>: { matched, other }. A source matches when it
   * sits on the element, or its thumbnail is the video's poster, or its length
   * is the video's length.
   */
  function sourcesFor(video) {
    const own = domSources(video);
    const poster = video?.poster && S ? S.imageKey(video.poster) : '';
    const length = Number(video?.duration) || 0;
    const matched = [...own];
    const other = [];
    const ownUrls = new Set(own.map((o) => o.url));
    const ownFile = /^https?:/i.test(video?.currentSrc || video?.src || '');
    const all = [...pageSources.values()].reverse(); // newest first
    const single = visibleVideos().length <= 1;
    const known = length > 1 && Number.isFinite(length);
    const sameLength = (d) => Math.abs(d - length) < 1.5 || Math.abs(d / 1000 - length) < 1.5; // some sites give milliseconds
    const candidates = []; // not tied to this video, but not another video's length either
    for (const src of [...metaSources(), ...all]) {
      if (src.url && ownUrls.has(src.url)) continue;
      const byPoster = poster && (src.images || []).some((img) => S.imageKey(img) === poster);
      // When the video plays a real file address, that file is the video: another source that only
      // has the same length is a neighbour (galleries are full of loops of the same length).
      const byLength = !ownFile && known && src.duration > 0 && sameLength(src.duration);
      if (byPoster || byLength) matched.push(src);
      else other.push(src);
      if (!byPoster && !byLength && !(known && src.duration > 0)) candidates.push(src);
    }
    // One video on screen (a post or watch page) and nothing tied to it: the page data may be about
    // it, but feeds and single-page sites keep earlier and next videos' data too. A source with
    // another length is another video, so only sources of unknown length are offered for it.
    const page = { duration: known ? length : 0, single, height: Math.min(Number(video?.videoWidth) || 0, Number(video?.videoHeight) || 0) };
    if (single && !matched.length && candidates.length) return { ...page, matched: candidates.slice(0, 40), other: [] };
    return { ...page, matched: matched.slice(0, 40), other: other.slice(0, 20) };
  }

  let pageSaveTimer = 0;
  /** Tell the extension about the video that is playing, for the popup's video card. */
  function savePageSources(video) {
    clearTimeout(pageSaveTimer);
    pageSaveTimer = setTimeout(() => send({ type: 'savePageSources', page: sourcesFor(video) }), 1500);
  }

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          resolve(chrome.runtime.lastError ? null : reply);
        });
      } catch {
        resolve(null); // extension reloaded: this old script is orphaned
      }
    });

  const s = (key) => info?.strings?.[key] || key;

  function buildUi() {
    host = document.createElement('gsdm-video-button');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, 'Noto Sans Bengali', 'Nirmala UI', sans-serif; }
        .btn {
          position: fixed; display: none; align-items: center; gap: 6px;
          padding: 6px 12px 6px 8px; border: 0; border-radius: 999px; cursor: pointer;
          background: rgba(30, 22, 58, 0.88); color: #fff; font-size: 13px; font-weight: 600; line-height: 1;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); backdrop-filter: blur(6px);
          transition: background-color .15s, transform .15s;
        }
        .btn:hover { background: #6c3ff0; }
        .btn:active { transform: scale(0.96); }
        .btn.show { display: inline-flex; }
        .ico { width: 20px; height: 20px; border-radius: 6px; background: #7c4dff; display: grid; place-items: center; flex: none; }
        .ico svg { width: 14px; height: 14px; }
        .menu {
          position: fixed; display: none; min-width: 240px; max-width: 380px; max-height: 320px; overflow-y: auto;
          padding: 6px; border-radius: 12px; background: #1e1b28; color: #ece9f5;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45); font-size: 13px;
        }
        .menu.show { display: block; }
        .head { padding: 6px 10px 4px; color: #a29db5; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
        .item { display: grid; gap: 2px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
        .item:hover, .item:focus-visible { background: #2d2547; outline: none; }
        .name { font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .meta { color: #a29db5; font-size: 11.5px; }
        .note { padding: 8px 10px; color: #a29db5; }
        .done { color: #3ddc97; }
      </style>
      <button class="btn" part="button" type="button">
        <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M6 20h12" stroke="#3ddc97"/></svg></span>
        <span class="label"></span>
      </button>
      <div class="menu" role="menu"></div>`;
    button = root.querySelector('.btn');
    menu = root.querySelector('.menu');
    root.querySelector('.label').textContent = s('overlayButton');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu();
    });
    button.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    menu.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    (document.documentElement || document.body).append(host);
  }

  // Links that point at one video or post, per site, so a video in a feed is
  // downloaded from its own page instead of the feed's address.
  const POST_LINKS = [
    /\/watch\?v=|\/shorts\/|youtu\.be\//, // YouTube
    /\/videos\/|\/reel\/|\/watch\/?\?v=|\/share\/[vr]\/|fb\.watch\//, // Facebook
    /\/status\/\d+/, // X / Twitter
    /\/(p|reel|reels|tv)\/[\w-]+/, // Instagram
    /\/video\/\d+/, // TikTok
  ];

  function isPostLink(href) {
    return POST_LINKS.some((re) => re.test(href));
  }

  /** One key per post, so "?v=abc&t=10" and "?v=abc" count as the same video. */
  function postKey(href) {
    try {
      const u = new URL(href, location.href);
      const v = u.searchParams.get('v');
      return v ? `${u.hostname.replace(/^(www|m)\./, '')}|v=${v}` : `${u.hostname.replace(/^(www|m)\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return href;
    }
  }

  /**
   * The address of the post or video page this <video> belongs to. Walks up from the video
   * and takes a post link only while the surrounding box holds links to one post: once a box
   * holds links to several posts it is the feed, and its first link is some other video.
   */
  function videoPageUrl(video) {
    let node = video;
    // Walk up, stepping out of shadow roots into their host element.
    const up = (el) => el.parentElement || el.getRootNode?.().host || null;
    for (let depth = 0; node && depth < 14; depth += 1, node = up(node)) {
      // Inside a link to a post (a thumbnail with a preview playing in it): that post.
      if (node.matches?.('a[href]') && isPostLink(node.href)) return node.href;
      const links = new Map();
      for (const a of node.querySelectorAll?.('a[href]') || []) {
        if (isPostLink(a.href) && !links.has(postKey(a.href))) links.set(postKey(a.href), a.href);
        if (links.size > 1) break;
      }
      if (links.size > 1) break; // past this video's own box
      if (links.size === 1) {
        const [href] = links.values();
        // On a post page, a link to the same post (a timestamp, a share link) is that post.
        if (isPostLink(location.href) && postKey(href) === postKey(location.href)) return location.href;
        return href;
      }
    }
    return location.href;
  }

  /** All <video> elements, also inside open shadow roots (custom players). */
  function findVideos(root, out) {
    for (const v of root.querySelectorAll('video')) out.push(v);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) findVideos(el.shadowRoot, out);
    return out;
  }

  function scan() {
    scanQueued = false;
    if (!alive()) return;
    videos = findVideos(document, []);
    if (!reportedVideo && videos.some(bigEnough)) {
      reportedVideo = true;
      send({ type: 'overlaySawVideo' });
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 300);
  }

  function bigEnough(v) {
    const r = v.getBoundingClientRect();
    return r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT;
  }

  /** False once the extension was reloaded or removed: then this copy removes itself. */
  function alive() {
    if (globalThis.chrome?.runtime?.id) return true;
    host?.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('play', onPlay, true);
    return false;
  }

  function visibleVideos() {
    return videos.filter((v) => {
      if (!v.isConnected) return false;
      const r = v.getBoundingClientRect();
      return r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && shown(v);
    });
  }

  /**
   * False for a video the user cannot see although it has a size: sliders and landing pages
   * stack their slides' videos in one place and hide all but one with opacity or visibility.
   */
  function shown(video) {
    if (typeof video.checkVisibility === 'function') {
      try {
        // Chrome 121+; older versions ignore the options they do not know, so check by hand too.
        if (!video.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      } catch {
        // fall through to the manual check
      }
    }
    let el = video;
    for (let depth = 0; el && depth < 40; depth += 1) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) < 0.05) return false;
      el = el.parentElement || el.getRootNode?.()?.host || null; // step out of shadow roots
    }
    return true;
  }

  /** Elements under a point, topmost first, also inside open shadow roots. */
  function stackAt(x, y) {
    const out = [];
    const walk = (scope, depth) => {
      for (const el of scope.elementsFromPoint(x, y)) {
        if (out.includes(el)) continue;
        out.push(el);
        if (el.shadowRoot && depth < 4) walk(el.shadowRoot, depth + 1);
      }
    };
    try {
      walk(document, 0);
    } catch {
      // elementsFromPoint is missing or failed: keep page order
    }
    return out;
  }

  /** The video under the pointer: the one drawn on top, not the first one in the page. */
  function videoAt(x, y) {
    const under = visibleVideos().filter((video) => {
      const r = video.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (under.length <= 1) return under[0] || null;
    const stack = stackAt(x, y);
    // A video's place in the stack: itself, or else the closest box around it (players often put
    // a transparent layer over the video that takes the pointer).
    const depth = (video) => {
      for (let el = video, i = 0; el && i < 12; i += 1, el = el.parentElement || el.getRootNode?.()?.host || null) {
        const at = stack.indexOf(el);
        if (at >= 0) return at;
      }
      return Infinity;
    };
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    return under
      .map((video, order) => ({ video, order, depth: depth(video), playing: !video.paused && !video.ended }))
      .sort((a, b) => a.depth - b.depth || Number(b.playing) - Number(a.playing) || area(b.video) - area(a.video) || a.order - b.order)[0].video;
  }

  function place() {
    if (!currentVideo || !currentVideo.isConnected) return hide();
    const r = currentVideo.getBoundingClientRect();
    const top = Math.max(8, r.top + 10);
    const right = Math.min(innerWidth - 8, r.right - 10);
    button.style.top = `${top}px`;
    button.style.left = `${right - button.offsetWidth}px`;
    if (menuOpen) {
      menu.style.top = `${top + button.offsetHeight + 6}px`;
      menu.style.left = `${Math.max(8, right - menu.offsetWidth)}px`;
    }
    return undefined;
  }

  function show(video) {
    if (!host) buildUi();
    currentVideo = video;
    button.classList.add('show');
    place();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!menuOpen) hide();
    }, HIDE_AFTER_MS);
  }

  function hide() {
    if (!button) return;
    button.classList.remove('show');
    menu.classList.remove('show');
    menuOpen = false;
    currentVideo = null;
  }

  function item(name, meta, onClick, { closeOnly = false, done = '', pending = '' } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'item';
    el.setAttribute('role', 'menuitem');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    el.append(n);
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta || '';
    m.hidden = !meta;
    el.append(m);
    el.metaEl = m;
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (closeOnly) {
        await onClick();
        hide();
        return;
      }
      // While the desktop program's folder dialog is open, say so.
      if (pending) menu.replaceChildren(note(pending, false));
      const result = await onClick();
      if (result?.reopen) {
        menuOpen = false;
        toggleMenu();
        return;
      }
      if (result?.canceled) {
        menu.replaceChildren(note(s('overlayCanceled'), false));
        setTimeout(hide, 1000);
        return;
      }
      menu.replaceChildren(note(result?.error || done || s('overlayStarted'), !result?.error));
      if (result?.id && !result.error) {
        followJob(result.id);
        return;
      }
      setTimeout(hide, result?.error ? 6000 : 1600);
    });
    return el;
  }

  /** After a desktop-program download starts, show its progress for a while, and its error if it fails. */
  async function followJob(id) {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!menuOpen) return;
      const job = await send({ type: 'videoJob', id });
      if (!job || !job.state) continue;
      if (job.state === 'error') {
        menu.replaceChildren(note(job.error || s('overlayFailed'), false));
        setTimeout(hide, 8000);
        return;
      }
      if (job.state === 'done') {
        menu.replaceChildren(note(s('overlaySaved'), true));
        setTimeout(hide, 1600);
        return;
      }
      if (job.state === 'canceled') {
        menu.replaceChildren(note(s('overlayCanceled'), false));
        setTimeout(hide, 1000);
        return;
      }
      const pct = job.total > 0 ? ` ${Math.floor((100 * job.downloaded) / job.total)}%` : '';
      menu.replaceChildren(note(s('overlayDownloading') + pct, true));
      if (job.downloaded > 0 && Date.now() > until - 35000) {
        setTimeout(hide, 2500); // it is clearly running; the progress window and popup take over
        return;
      }
    }
    hide();
  }

  /** Ask the desktop program what each quality weighs, then show it ("98 MB"); hide qualities the video does not have. */
  async function fillSizes(pageUrl, rows) {
    const infoReply = await send({ type: 'videoInfo', url: pageUrl });
    const sizes = infoReply?.sizes || {};
    const maxHeight = Number(infoReply?.maxHeight) || 0;
    for (const [quality, row] of rows) {
      if (!row.isConnected) continue;
      const height = Number(quality);
      if (maxHeight && height && height > maxHeight && quality !== 'best') {
        row.hidden = true; // same file as "Best available"
        continue;
      }
      const size = sizes[quality] > 0 ? `≈ ${formatSize(sizes[quality])}` : '';
      const text = [row.defaultText, size].filter(Boolean).join(' · ');
      row.metaEl.textContent = text;
      row.metaEl.hidden = !text;
    }
    if (infoReply?.error && !Object.keys(sizes).length && rows.size) {
      const last = [...rows.values()].pop();
      if (last?.isConnected) last.after(note(s('overlaySizeError').replace('{error}', infoReply.error), false));
    }
    if (menuOpen) place();
  }

  function note(text, ok) {
    const el = document.createElement('div');
    el.className = ok ? 'note done' : 'note';
    el.textContent = text;
    return el;
  }

  function head(text) {
    const el = document.createElement('div');
    el.className = 'head';
    el.textContent = text;
    return el;
  }

  function formatSize(bytes) {
    if (!(bytes > 0)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${v.toFixed(u && v < 100 ? 1 : 0)} ${units[u]}`;
  }

  async function toggleMenu() {
    if (menuOpen) {
      menu.classList.remove('show');
      menuOpen = false;
      return;
    }
    menuOpen = true;
    clearTimeout(hideTimer);
    menu.replaceChildren(note(s('overlayLoading')));
    menu.classList.add('show');
    place();

    const video = currentVideo; // the video the menu was opened on; it stays the target
    const page = sourcesFor(video);
    const reply = await send({ type: 'overlayMedia', page });
    const parts = [];
    const options = reply?.streams?.options || [];
    const addOptions = (list) => {
      for (const o of list) {
        const name = o.audioOnly ? s('qualityAudio') : o.label || s('overlayVideoSite');
        const meta = [o.best ? s('overlayBest') : '', formatSize(o.size), o.hasAudio || o.audioOnly ? '' : s('overlayNoSound')].filter(Boolean).join(' · ');
        parts.push(item(name, meta, () => send({ type: 'addStream', optionId: o.id, title: document.title })));
      }
    };
    const mine = options.filter((o) => !o.other);
    const others = options.filter((o) => o.other);
    if (mine.length) {
      // Saved by the browser itself, no install needed (M15, M16).
      parts.push(head(s('overlayQualities')));
      addOptions(mine);
    }
    if (others.length) {
      parts.push(head(s('overlayOther')));
      addOptions(others);
    }
    if (!options.length && reply?.streams?.refused) {
      parts.push(note(s(reply.streams.refused === 'live' ? 'overlayLive' : 'overlayEncrypted')));
    }
    if (reply?.companion === 'connected' && (reply.site === 'video' || reply.site === 'generic')) {
      // The optional companion app, when it is installed: YouTube and other sites the browser cannot save.
      parts.push(head(reply.programVersion ? `${s('overlayViaCompanion')} ${reply.programVersion}` : s('overlayViaCompanion')));
      if (reply.outdated) {
        parts.push(note(s('overlayProgramOld').replace('{old}', reply.programVersion || '?').replace('{new}', reply.extensionVersion || '')));
        parts.push(item(s('overlayInstallUpdate'), '', () => send({ type: 'overlayCompanionHelp' }), { closeOnly: true }));
      }
      const pageUrl = videoPageUrl(video);
      const rows = new Map();
      for (const [quality, key] of QUALITIES) {
        const defaultText = quality === info.quality ? s('overlayDefault') : '';
        const row = item(s(key), [defaultText, s('overlaySizeLoading')].filter(Boolean).join(' · '),
          () => send({ type: 'addVideo', url: pageUrl, quality, title: document.title }),
          { pending: reply.askFolder ? s('overlayChooseFolder') : '' });
        row.defaultText = defaultText;
        rows.set(quality, row);
        parts.push(row);
      }
      fillSizes(pageUrl, rows);
    } else if (!options.length && reply?.youtube && reply.companionSeen && reply.companion !== 'missing') {
      // Installed before: it is still starting (after a restart, for example). Never ask to install again.
      parts.push(note(s('overlayCompanionStarting')));
      parts.push(item(s('overlayTryAgain'), '', async () => ({ reopen: true })));
    } else if (!options.length && reply?.youtube) {
      parts.push(note(s('overlayYouTubeCompanion')));
      parts.push(item(s('overlayInstallHelp'), '', () => send({ type: 'overlayCompanionHelp' }), { closeOnly: true }));
    }
    const seen = new Set();
    const files = [];
    for (const m of reply?.media || []) files.push(m); // detected files first: they carry size and type
    // When the video plays a file address, only that file is this video; the others are its neighbours.
    const ownPath = /^https?:/i.test(video?.currentSrc || '') ? cleanUrl(video.currentSrc) : '';
    const unique = files.filter((f) => !seen.has(f.url) && seen.add(f.url) && (!ownPath || cleanUrl(f.url) === ownPath));
    if (unique.length) {
      parts.push(head(s('overlayFiles')));
      for (const f of unique.slice(0, 12)) {
        parts.push(item(f.name, [formatSize(f.size), f.mime].filter(Boolean).join(' · '), () => send({ type: 'enqueue', items: [{ url: f.url, filename: f.name }] }).then((r) => (r?.added ? r : { error: r?.error || s('overlayFailed') }))));
      }
    }
    if (!parts.length) parts.push(note(s('overlayNothing')));
    parts.push(item(s('overlayCopyDebug'), '', () => copyDebug(page, reply), { closeOnly: false, done: s('overlayCopied') }));
    menu.replaceChildren(...parts);
    place();
  }

  function cleanUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === 'blob:') return 'blob:';
      return `${u.protocol}//${u.hostname}${u.pathname}`;
    } catch {
      return '';
    }
  }

  /** Copy what SIDM saw on this page, without query strings (they can hold sign-in tokens). */
  async function copyDebug(page, reply) {
    const ext = (await send({ type: 'overlayDebug' })) || {};
    const v = currentVideo;
    const brief = (src) => ({ kind: src.kind, url: src.url ? cleanUrl(src.url) : '(manifest text)', size: `${src.width || 0}x${src.height || 0}`, duration: Math.round(src.duration || 0) });
    const info = {
      page: cleanUrl(location.href),
      frame: window !== top ? 'iframe' : 'top',
      time: new Date().toISOString(),
      video: v ? { src: cleanUrl(v.currentSrc || v.src || ''), poster: v.poster ? cleanUrl(v.poster) : '', size: `${v.videoWidth}x${v.videoHeight}`, duration: Math.round(v.duration || 0), sources: v.querySelectorAll('source').length } : null,
      videosOnPage: videos.length,
      pageDataSources: pageSources.size,
      matched: (page?.matched || []).slice(0, 15).map(brief),
      other: (page?.other || []).length,
      options: (reply?.streams?.options || []).map((o) => `${o.kind} ${o.label || '?'}${o.hasAudio ? '' : ' no-sound'}${o.other ? ' other' : ''}`),
      refused: reply?.streams?.refused || '',
      extension: ext,
    };
    const text = `SIDM debug info\n${JSON.stringify(info, null, 2)}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      root.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    return { ok: true };
  }

  function onMove(event) {
    if (menuOpen || !alive()) return;
    if (host && event.composedPath().includes(host)) return;
    const video = videoAt(event.clientX, event.clientY);
    if (video) show(video);
  }

  /** A video started playing: show the button on it for a moment. */
  function onPlay(event) {
    const video = event.target;
    if (menuOpen || !(video instanceof HTMLVideoElement) || !alive()) return;
    if (!videos.includes(video)) videos.push(video);
    savePageSources(video);
    if (visibleVideos().includes(video)) show(video);
  }

  async function start() {
    info = await send({ type: 'overlayInfo' });
    if (!info?.enabled) return;
    scan();
    setInterval(scan, SCAN_MS); // feeds add videos all the time
    new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('play', onPlay, true);
    document.addEventListener('mousemove', onMove, { passive: true, capture: true });
    addEventListener('scroll', () => place(), { passive: true, capture: true });
    addEventListener('resize', () => place(), { passive: true });
    document.addEventListener('click', (event) => {
      if (menuOpen && host && !event.composedPath().includes(host)) hide();
    }, true);
    document.addEventListener('fullscreenchange', () => {
      // A fullscreen element hides our fixed button; move it inside.
      const full = document.fullscreenElement;
      const target = full && full.tagName !== 'VIDEO' ? full : document.documentElement;
      if (host && host.parentNode !== target) target.append(host);
    });
  }

  start();
})();
