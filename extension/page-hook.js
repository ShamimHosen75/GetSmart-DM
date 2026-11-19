// Page-world part of the video finder (M16). Runs in the page's own JavaScript
// world (manifest "world": "MAIN"), after page-sources.js.
//
// Sites load the list of a video's qualities with fetch/XMLHttpRequest. This
// script reads copies of those replies (only text or JSON replies that mention
// a video address), finds the video sources in them with page-sources.js, and
// hands them to overlay.js with a "sidm-sources" DOM event. The page's own
// requests and replies are never changed or delayed, and nothing leaves the
// browser.

(() => {
  if (window.__sidmHook) return;
  Object.defineProperty(window, '__sidmHook', { value: true });
  const S = globalThis.__sidmSources;
  if (!S) return;

  const MAX_BODY = 12 * 1024 * 1024;
  const TEXT_TYPE = /json|javascript|text\/plain|text\/html|graphql|x-www-form/i;
  let queue = [];
  let timer = 0;

  function emit(sources) {
    if (!sources.length) return;
    queue.push(...sources);
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      const batch = queue.splice(0, queue.length);
      document.dispatchEvent(new CustomEvent('sidm-sources', { detail: JSON.stringify(batch) }));
    }, 200);
  }

  function look(text) {
    try {
      emit(S.fromText(text));
    } catch {
      // never disturb the page
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function sidmFetch(...args) {
      const result = origFetch.apply(this, args);
      result.then((res) => {
        try {
          const type = res.headers.get('content-type') || '';
          const size = Number(res.headers.get('content-length')) || 0;
          if (!TEXT_TYPE.test(type) || size > MAX_BODY) return;
          res.clone().text().then(look, () => {});
        } catch {
          // ignore
        }
      }, () => {});
      return result;
    };
  }

  const proto = XMLHttpRequest.prototype;
  const origSend = proto.send;
  proto.send = function sidmSend(...args) {
    try {
      this.addEventListener('load', () => {
        try {
          const type = this.getResponseHeader('content-type') || '';
          if (!TEXT_TYPE.test(type)) return;
          if (this.responseType === '' || this.responseType === 'text') look(this.responseText);
          else if (this.responseType === 'json' && this.response) emit(S.fromJson(this.response));
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
    return origSend.apply(this, args);
  };

  /** Data the page was sent with: JSON script tags, LinkedIn's hidden <code> blocks, player configs. */
  function scanDocument() {
    const nodes = document.querySelectorAll('script:not([src]), code');
    for (const node of nodes) {
      if (node.__sidmSeen) continue;
      node.__sidmSeen = true;
      const text = node.textContent || '';
      if (text.length < 40 || text.length > MAX_BODY) continue;
      look(text);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanDocument, { once: true });
  else scanDocument();
  addEventListener('load', scanDocument, { once: true });
  // Single-page sites add new data blocks as you scroll or open a post.
  setInterval(scanDocument, 3000);
})();
