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
//   - the <video> element's own file address when it is a plain http(s) file.
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

  /** The address of the post or video page this <video> belongs to. */
  function videoPageUrl(video) {
    if (isPostLink(location.href)) return location.href;
    let node = video;
    // Walk up, stepping out of shadow roots into their host element.
    const up = (el) => el.parentElement || el.getRootNode?.().host || null;
    for (let depth = 0; node && depth < 14; depth += 1, node = up(node)) {
      const own = node.closest?.('a[href]');
      if (own && isPostLink(own.href)) return own.href;
      for (const a of node.querySelectorAll?.('a[href]') || []) {
        if (isPostLink(a.href)) return a.href;
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
      return r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    });
  }

  function videoAt(x, y) {
    for (const video of visibleVideos()) {
      const r = video.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return video;
    }
    return null;
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

  function item(name, meta, onClick, { closeOnly = false } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'item';
    el.setAttribute('role', 'menuitem');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    el.append(n);
    if (meta) {
      const m = document.createElement('span');
      m.className = 'meta';
      m.textContent = meta;
      el.append(m);
    }
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (closeOnly) {
        await onClick();
        hide();
        return;
      }
      const result = await onClick();
      menu.replaceChildren(note(result?.error || s('overlayStarted'), !result?.error));
      setTimeout(hide, 1600);
    });
    return el;
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

    const reply = await send({ type: 'overlayMedia' });
    const parts = [];
    const options = reply?.streams?.options || [];
    if (options.length) {
      // Saved by the browser itself, no install needed (M15).
      parts.push(head(s('overlayQualities')));
      for (const o of options) {
        const name = o.audioOnly ? s('qualityAudio') : o.label || s('overlayVideoSite');
        const meta = [formatSize(o.size), o.hasAudio || o.audioOnly ? '' : s('overlayNoSound')].filter(Boolean).join(' · ');
        parts.push(item(name, meta, () => send({ type: 'addStream', optionId: o.id, title: document.title })));
      }
    } else if (reply?.streams?.refused) {
      parts.push(note(s(reply.streams.refused === 'live' ? 'overlayLive' : 'overlayEncrypted')));
    }
    if (reply?.companion === 'connected' && (reply.site === 'video' || reply.site === 'generic')) {
      // The optional companion app, when it is installed: YouTube and other sites the browser cannot save.
      parts.push(head(s('overlayViaCompanion')));
      const pageUrl = videoPageUrl(currentVideo);
      for (const [quality, key] of QUALITIES) {
        const meta = quality === info.quality ? s('overlayDefault') : '';
        parts.push(item(s(key), meta, () => send({ type: 'addVideo', url: pageUrl, quality, title: document.title })));
      }
    } else if (!options.length && reply?.youtube) {
      parts.push(note(s('overlayYouTubeCompanion')));
      parts.push(item(s('overlayInstallHelp'), '', () => send({ type: 'overlayCompanionHelp' }), { closeOnly: true }));
    }
    const seen = new Set();
    const files = [];
    for (const m of reply?.media || []) files.push(m); // detected files first: they carry size and type
    const own = currentVideo?.currentSrc || currentVideo?.src || '';
    if (/^https?:/i.test(own)) {
      let name = document.title;
      try {
        name = decodeURIComponent(new URL(own).pathname.split('/').pop()) || name;
      } catch {
        // keep the page title
      }
      files.push({ url: own, name, size: -1, mime: '' });
    }
    const unique = files.filter((f) => !seen.has(f.url) && seen.add(f.url));
    if (unique.length) {
      parts.push(head(s('overlayFiles')));
      for (const f of unique.slice(0, 12)) {
        parts.push(item(f.name, [formatSize(f.size), f.mime].filter(Boolean).join(' · '), () => send({ type: 'enqueue', items: [{ url: f.url, filename: f.name }] }).then((r) => (r?.added ? r : { error: r?.error || s('overlayFailed') }))));
      }
    }
    if (!parts.length) parts.push(note(s('overlayNothing')));
    menu.replaceChildren(...parts);
    place();
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
