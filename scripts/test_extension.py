#!/usr/bin/env python3
"""Automated QA for the GetSmart DM extension (extension/).

Starts a local test HTTP server, launches real Chromium headless with the
extension loaded (--load-extension), drives the extension pages with
Playwright and checks:

   1. media detection + green badge (HLS/DASH, small files and XHR 206 skipped)
   2. YouTube is never detected (and video downloads there are refused)
   3. folder sorting (GetSmart DM/<Category>/<name>)
   4. custom and Bangla file names, Windows-safe names
   5. queue limit with max simultaneous = 2
   6. pause / resume from the popup UI
   7. link grabber: select + download
   8. settings save (options page)
   9. category filter in the popup
  10. "Clear finished"
  11. no console errors on the pages and no runtime errors in the worker

The test server serves files with Range support, a slow mode,
Content-Disposition, HLS playlist/segment URLs and a 404.

Needs:  pip install playwright   then   python -m playwright install chromium
Run:    python scripts/test_extension.py            (headless)
        python scripts/test_extension.py --headed   (watch it)
Env:    CHROME_PATH=/path/to/chrome to use another Chromium build.

Chromium is started as a separate process and Playwright connects over CDP,
because Playwright's own launch renames every download to a random id, which
would hide folder sorting and file names. Branded Google Chrome 137+ ignores
--load-extension, so use Playwright's Chromium (or Chrome for Testing).

Exit code 0 = every check passed.
"""

import argparse
import glob
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION = os.path.join(ROOT, "extension")
EXT_ID = "ejkhmcfjnohjikdgfgkhjficmiaoghma"
HOST_PY = os.path.join(ROOT, "companion", "host.py")


# --------------------------------------------------------------------------- test server

PAGES = {
    "/media.html": """<!doctype html><html><head><title>Media Test Page</title></head><body>
<video src="/f/clip.mp4?size=400000&mime=video/mp4" autoplay muted></video>
<audio src="/f/tiny.mp3?size=50000&mime=audio/mpeg" autoplay muted></audio>
<audio src="/f/noext?size=300000&mime=audio/ogg" autoplay muted></audio>
<script>
fetch("/hls/stream.m3u8"); fetch("/hls/seg1.ts"); fetch("/dash/seg2.m4s");
fetch("/f/octet.webm?size=300000&mime=application/octet-stream");
fetch("/f/disp?size=300000&mime=application/octet-stream&cd=bangla");
fetch("/f/part.mp4?size=300000&mime=video/mp4", {headers: {Range: "bytes=0-99"}});
</script></body></html>""",
    "/links.html": """<!doctype html><html><head><title>Links Test Page</title></head><body>
<a href="/f/manual.pdf?size=120000&mime=application/pdf">Manual</a>
<a href="/f/pack.zip?size=120000&mime=application/zip">Pack</a>
<a href="/f/pack.zip?size=120000&mime=application/zip#again">Pack again</a>
<a href="mailto:someone@example.com">mail</a> <a href="javascript:void 0">js</a>
<img src="/f/photo.png?size=2000&mime=image/png" alt="Photo">
<video src="/f/movie.mp4?size=2000&mime=video/mp4"></video>
<audio><source src="/f/song.mp3?size=2000&mime=audio/mpeg"></audio>
<iframe src="/frame.html"></iframe>
</body></html>""",
    "/frame.html": """<!doctype html><html><body><a href="/f/setup.exe?size=2000&mime=application/octet-stream">Setup</a></body></html>""",
    "/empty.html": """<!doctype html><html><head><title>Nothing</title></head><body>No links.</body></html>""",
}

BANGLA_CD = "attachment; filename=\"fallback.mp4\"; filename*=UTF-8''%E0%A6%AD%E0%A6%BF%E0%A6%A1%E0%A6%BF%E0%A6%93.mp4"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send_simple(self, code, body=b"", mime="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        if url.path in PAGES:
            return self._send_simple(200, PAGES[url.path].encode("utf-8"), "text/html; charset=utf-8")
        if url.path == "/404" or url.path.startswith("/missing"):
            return self._send_simple(404, b"not found")
        if url.path.endswith(".m3u8"):
            return self._send_simple(200, b"#EXTM3U\n#EXTINF:4,\nseg1.ts\n" + b"#" * 300000, "application/vnd.apple.mpegurl")
        if url.path.endswith(".ts"):
            return self._send_simple(200, b"\0" * 300000, "video/mp2t")
        if url.path.endswith(".m4s"):
            return self._send_simple(200, b"\0" * 300000, "video/iso.segment")
        if url.path.startswith("/f/"):
            return self.serve_file(query)
        return self._send_simple(404, b"not found")

    def serve_file(self, query):
        size = int(query.get("size", "100000"))
        mime = query.get("mime", "application/octet-stream")
        slow = query.get("slow") == "1"
        start, end = 0, size - 1
        match = None if query.get("norange") else re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = min(int(match.group(2)), size - 1)
        self.send_response(206 if match else 200)
        self.send_header("Content-Type", mime)
        if not query.get("norange"):
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", '"gsdm-test"')
        if query.get("cd") == "bangla":
            self.send_header("Content-Disposition", BANGLA_CD)
        if match:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        chunk = b"\0" * 16384
        sent = start
        try:
            while sent <= end:
                n = min(len(chunk), end - sent + 1)
                self.wfile.write(chunk[:n])
                sent += n
                if slow:
                    time.sleep(0.05)  # about 320 KB/s
        except (BrokenPipeError, ConnectionResetError):
            pass


def start_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.handle_error = lambda request, address: None  # clients that hang up mid-transfer are expected
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


# --------------------------------------------------------------------------- browser

def find_chrome(playwright):
    if os.environ.get("CHROME_PATH"):
        return os.environ["CHROME_PATH"]
    path = playwright.chromium.executable_path
    if path and os.path.exists(path):
        return path
    for pattern in ("/opt/pw-browsers/chromium-*/chrome-linux*/chrome",
                    os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    sys.exit("Chromium not found. Run: python -m playwright install chromium (or set CHROME_PATH)")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Browser:
    def __init__(self, playwright, headed):
        self.tmp = tempfile.mkdtemp(prefix="gsdm-test-")
        self.downloads = os.path.join(self.tmp, "downloads")
        profile = os.path.join(self.tmp, "profile")
        os.makedirs(os.path.join(profile, "Default"))
        os.makedirs(self.downloads)
        with open(os.path.join(profile, "Default", "Preferences"), "w", encoding="utf-8") as f:
            # Safe Browsing off: archive scans would wait for a network check.
            json.dump({"download": {"default_directory": self.downloads, "prompt_for_download": False,
                                    "directory_upgrade": True},
                       "safebrowsing": {"enabled": False}}, f)
        port = free_port()
        args = [find_chrome(playwright), "--no-first-run", "--no-default-browser-check", "--no-sandbox",
                "--remote-debugging-port=%d" % port, "--user-data-dir=" + profile,
                "--disable-extensions-except=" + EXTENSION, "--load-extension=" + EXTENSION,
                "--host-resolver-rules=MAP www.youtube.com 127.0.0.1:%s" % os.environ.get("GSDM_PORT", "1"),
                "about:blank"]
        if not headed:
            args.insert(1, "--headless=new")
        env = dict(os.environ, LANG="C.UTF-8", LC_ALL="C.UTF-8")  # non-ASCII file names on Linux
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=1).read()
                break
            except OSError:
                if time.time() > deadline:
                    raise RuntimeError("Chromium did not start")
                time.sleep(0.2)
        self.browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:%d" % port)
        self.context = self.browser.contexts[0]
        cdp = self.browser.new_browser_cdp_session()
        cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
        self.console_errors = []
        self.ext = self.page("popup.html")  # an extension page to call chrome.* from

    def page(self, path=None):
        page = self.context.new_page()
        label = path or "page"

        def on_console(msg):
            if msg.type in ("error", "warning") and path:
                self.console_errors.append("%s: %s" % (label, msg.text))

        page.on("console", on_console)
        page.on("pageerror", lambda err: self.console_errors.append("%s pageerror: %s" % (label, err)))
        if path:
            page.goto("chrome-extension://%s/%s" % (EXT_ID, path))
        return page

    def call(self, script, arg=None):
        """Evaluate `script` (an async arrow function) in an extension page."""
        return self.ext.evaluate(script, arg)

    def message(self, msg):
        return self.call("(m) => chrome.runtime.sendMessage(m)", msg)

    def worker_errors(self):
        page = self.context.new_page()
        page.goto("chrome://extensions")
        info = page.evaluate("""() => new Promise((resolve) => chrome.developerPrivate.getExtensionsInfo(
            {includeDisabled: true, includeTerminated: true}, resolve))""")
        page.close()
        for ext in info:
            if ext["id"] == EXT_ID:
                return [e.get("message") for e in ext.get("runtimeErrors", []) + ext.get("manifestErrors", [])]
        return ["extension not loaded"]

    def close(self):
        try:
            self.browser.close()
        except Exception:
            pass
        self.proc.kill()
        self.proc.wait(10)
        shutil.rmtree(self.tmp, ignore_errors=True)


# --------------------------------------------------------------------------- helpers

def wait_for(predicate, timeout=15, interval=0.25, what="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError("timed out waiting for %s (last value: %r)" % (what, last))


def files_on_disk(root):
    out = []
    for folder, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".crdownload"):
                out.append(os.path.relpath(os.path.join(folder, name), root).replace(os.sep, "/"))
    return sorted(out)


def reset(b):
    """Cancel and erase every download, clear the queue and the settings."""
    b.call("""async () => {
        await chrome.storage.local.set({queue: [], queuePaused: false});
        for (const d of await chrome.downloads.search({state: 'in_progress'})) { try { await chrome.downloads.cancel(d.id); } catch {} }
        await chrome.downloads.erase({});
        await chrome.storage.sync.clear();
    }""")
    time.sleep(0.3)
    close_progress_windows(b)


def tab_id_for(b, url):
    return b.call("async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id", url)


# --------------------------------------------------------------------------- checks

def check_media_detection(b, base):
    page = b.page()
    page.goto(base + "/media.html")
    tab = tab_id_for(b, base + "/media.html")
    key = "media:%d" % tab
    items = wait_for(lambda: (len(b.call("(k) => chrome.storage.session.get(k)", key).get(key, [])) >= 4
                              and b.call("(k) => chrome.storage.session.get(k)", key)[key]),
                     what="4 detected media files")
    time.sleep(1)  # let anything that should NOT be detected arrive too
    items = b.call("(k) => chrome.storage.session.get(k)", key)[key]
    names = sorted(i["name"] for i in items)
    expected = sorted(["clip.mp4", "octet.webm", "ভিডিও.mp4", "Media Test Page.ogg"])
    assert names == expected, "detected %r, expected %r" % (names, expected)
    badge = b.call("(id) => chrome.action.getBadgeText({tabId: id})", tab)
    assert badge == "4", "badge %r" % badge

    popup = b.page("popup.html?tab=%d" % tab)
    popup.click("#tab-page")
    popup.wait_for_selector(".media-row")
    rows = popup.eval_on_selector_all(".media-row .dl-name", "els => els.map(e => e.textContent)")
    assert sorted(rows) == expected, rows
    popup.close()

    page.goto(base + "/empty.html")
    wait_for(lambda: not b.call("(k) => chrome.storage.session.get(k)", key).get(key), what="list cleared on navigation")
    page.close()
    return "4 found (HLS, DASH, small file and XHR 206 skipped); badge 4; cleared on navigation"


def check_youtube_blocked(b, base):
    page = b.page()
    loaded = False
    try:
        page.goto("http://www.youtube.com/media.html", timeout=8000)
        loaded = "Media Test Page" in page.title()
    except Exception:
        loaded = False
    if loaded:
        time.sleep(2)
        tab = tab_id_for(b, "http://www.youtube.com/media.html")
        key = "media:%d" % tab
        assert not b.call("(k) => chrome.storage.session.get(k)", key).get(key), "media detected on YouTube"
    page.close()
    state = b.message({"type": "getVideoState", "url": "https://www.youtube.com/watch?v=abc"})
    assert state["site"] == "youtube-off", state
    refused = b.message({"type": "addVideo", "url": "https://www.youtube.com/watch?v=abc", "quality": "best"})
    assert "error" in refused, refused
    drm = b.message({"type": "addVideo", "url": "https://www.netflix.com/watch/1", "quality": "best"})
    assert "error" in drm, drm
    how = "real page served as www.youtube.com" if loaded else "host mapping refused here; checked the worker's decisions"
    return "nothing detected, video download refused, DRM refused (%s)" % how


def enqueue(b, items):
    return b.message({"type": "enqueue", "items": items})


def check_folder_sorting(b, base):
    reset(b)
    reply = enqueue(b, [{"url": base + "/f/report.pdf?size=50000&mime=application/pdf"},
                        {"url": base + "/f/tool.zip?size=50000&mime=application/zip"},
                        {"url": base + "/f/track?size=50000&mime=audio/mpeg"}])
    assert reply["added"] == 3, reply
    want = ["GetSmart DM/Archives/tool.zip", "GetSmart DM/Documents/report.pdf", "GetSmart DM/Music/track.mp3"]
    wait_for(lambda: all(w in files_on_disk(b.downloads) for w in want),
             what="sorted files %r (on disk: %r, downloads %r, queue %r)" % (want, files_on_disk(b.downloads),
                 [(d["filename"][-30:], d["state"], d.get("danger"), d.get("bytesReceived"), d.get("paused")) for d in b.call("() => chrome.downloads.search({})")], queued(b)))
    return ", ".join(want)


def check_names(b, base):
    reply = enqueue(b, [{"url": base + "/f/x1?size=1000&mime=application/pdf", "filename": "a:b?.pdf"},
                        {"url": base + "/f/x2?size=1000&mime=audio/mpeg", "filename": "বাংলা গান.mp3"},
                        {"url": base + "/f/x3?size=1000&mime=text/plain", "filename": "CON.txt"},
                        {"url": "ftp://example.com/nope"}])
    assert reply == {"added": 3, "rejected": 1}, reply
    want = ["GetSmart DM/Documents/a_b_.pdf", "GetSmart DM/Music/বাংলা গান.mp3", "GetSmart DM/Documents/_CON.txt"]
    wait_for(lambda: all(w in files_on_disk(b.downloads) for w in want), what="named files")
    return ", ".join(want) + "; ftp:// rejected"


def running(b):
    return b.call("async () => (await chrome.downloads.search({state: 'in_progress', paused: false})).length")


def queued(b):
    return len(b.call("async () => (await chrome.storage.local.get('queue')).queue || []"))


def check_queue_limit(b, base):
    reset(b)
    b.call("() => chrome.storage.sync.set({maxSimultaneous: 2})")
    time.sleep(0.3)
    items = [{"url": base + "/f/slow%d.mp4?size=3000000&mime=video/mp4&slow=1" % i} for i in range(4)]
    enqueue(b, items)
    wait_for(lambda: running(b) == 2 and queued(b) == 2, what="2 running + 2 queued")
    time.sleep(1.5)
    assert running(b) == 2 and queued(b) == 2, (running(b), queued(b))
    return "2 running, 2 waiting"


def check_pause_resume_ui(b, base):
    # Continues from the queue check: 2 running, 2 queued.
    popup = b.page("popup.html")
    popup.click("#tab-downloads")
    popup.wait_for_selector(".dl-row[data-state=downloading]")
    row = popup.locator(".dl-row[data-state=downloading]").first
    row_id = row.get_attribute("data-id")
    row.locator("button[data-action=pause]").click()
    target = popup.locator('.dl-row[data-id="%s"]' % row_id)
    wait_for(lambda: target.get_attribute("data-state") == "paused", what="row paused")
    wait_for(lambda: queued(b) == 1 and running(b) == 2, what="pause frees a slot")
    target.locator("button[data-action=resume]").click()
    wait_for(lambda: target.get_attribute("data-state") == "downloading", what="row resumed")
    meta = target.locator(".dl-meta").inner_text()
    assert "/s" in meta or "of" in meta, meta
    popup.close()
    reset(b)
    return "paused from the row (next queued item started), resumed"


def progress_windows(b):
    """Popup windows showing progress.html (Playwright does not list them as pages)."""
    return b.call("""async () => [...new Set((await chrome.runtime.getContexts({contextTypes: ['TAB']}))
        .filter((c) => c.documentUrl.includes('/progress.html')).map((c) => c.windowId))]""")


def close_progress_windows(b):
    b.call("async (ids) => { for (const id of ids) await chrome.windows.remove(id); }", progress_windows(b))


def check_progress_window(b, base):
    reset(b)
    enqueue(b, [{"url": base + "/f/big.zip?size=6000000&slow=1"}])
    wait_for(lambda: len(progress_windows(b)) == 1, what="progress window opened on start")
    did = b.call("async () => (await chrome.downloads.search({}))[0].id")
    # The popup's details button focuses that window instead of opening another one.
    b.call("async (id) => { const m = await import('./common.js'); await m.openProgressWindow(id); }", did)
    time.sleep(0.5)
    assert len(progress_windows(b)) == 1, progress_windows(b)
    close_progress_windows(b)
    page = b.page("progress.html?id=%d" % did)
    wait_for(lambda: page.locator("#f-rate").inner_text().endswith("/s"), what="transfer rate")
    assert page.locator("#p-name").inner_text() == "big.zip", page.locator("#p-name").inner_text()
    assert "5.7 MB" in page.locator("#f-size").inner_text(), page.locator("#f-size").inner_text()
    wait_for(lambda: page.locator("#f-resume").inner_text() == "Yes", what="resume probe says Yes")
    page.click("#b-pause")
    wait_for(lambda: page.locator("body").get_attribute("data-state") == "paused", what="paused")
    page.click("#b-resume")
    wait_for(lambda: page.locator("body").get_attribute("data-state") == "downloading", what="resumed")
    page.click("#b-details")
    assert page.locator("#p-details").is_hidden()
    page.click("#b-details")
    page.click("#b-cancel")
    wait_for(lambda: page.locator("body").get_attribute("data-state") == "cancelled", what="cancelled")
    page.close()
    reset(b)
    return "opened on start, one window per download; size, rate, resume probe; pause, resume, hide details, cancel"


def check_manager(b, base):
    reset(b)
    b.call("() => chrome.storage.sync.set({maxSimultaneous: 1, progressWindow: 'off'})")
    time.sleep(0.3)
    enqueue(b, [{"url": base + "/f/m%d.zip?size=4000000&slow=1" % i} for i in range(3)])
    wait_for(lambda: running(b) == 1 and queued(b) == 2, what="1 running + 2 queued")
    m = b.page("manager.html")
    m.wait_for_selector("#m-rows tr[data-state=downloading]")
    assert m.locator("#m-rows tr").count() == 3
    m.click('.m-node[data-view="queue"]')
    wait_for(lambda: m.locator("#m-rows tr").count() == 2, what="queue view")
    m.click('.m-node[data-view="all"]')
    m.click('[data-tool="queue"]')
    wait_for(lambda: b.call("async () => (await chrome.storage.local.get('queuePaused')).queuePaused") is True, what="queue stopped")
    m.click("#m-rows tr[data-state=downloading]")
    m.click('[data-tool="stop"]')
    wait_for(lambda: m.locator("#m-rows tr[data-state=paused]").count() == 1, what="stopped from toolbar")
    time.sleep(1)
    assert running(b) == 0 and queued(b) == 2, "stopped queue must not start the next item"
    m.click('[data-tool="resume"]')
    wait_for(lambda: running(b) == 1, what="resumed from toolbar")
    m.click('[data-tool="stopAll"]')
    wait_for(lambda: running(b) == 0, what="stop all")
    m.click('th[data-sort="name"]')
    names = m.eval_on_selector_all("#m-rows .m-name", "els => els.map(e => e.textContent)")
    assert names == sorted(names), names
    m.click("#m-rows tr >> nth=0")
    m.keyboard.press("Control+a")
    assert m.locator('#m-rows tr[aria-selected="true"]').count() == 3
    m.keyboard.press("Delete")
    m.click('#delete-dialog button[value="delete"]')
    wait_for(lambda: m.locator("#m-rows tr").count() == 0, what="all deleted")
    assert queued(b) == 0 and not b.call("() => chrome.downloads.search({})")
    m.click('[data-tool="queue"]')
    wait_for(lambda: b.call("async () => (await chrome.storage.local.get('queuePaused')).queuePaused") is False, what="queue started")
    m.close()
    reset(b)
    return "category tree, stop/start queue, stop and resume, stop all, sort, Ctrl+A, delete dialog"


def check_grabber(b, base):
    reset(b)
    page = b.page()
    page.goto(base + "/links.html")
    tab = tab_id_for(b, base + "/links.html")
    grabber = b.page("grabber.html?tab=%d" % tab)
    grabber.wait_for_selector("#g-rows tr")
    names = grabber.eval_on_selector_all("#g-rows tr", "rs => rs.map(r => r.children[1].textContent)")
    expected = sorted(["manual.pdf", "pack.zip", "photo.png", "movie.mp4", "song.mp3", "setup.exe"])
    assert sorted(names) == expected, names
    grabber.click('.chip[data-category="documents"]')
    shown = grabber.eval_on_selector_all("#g-rows tr:not([hidden])", "rs => rs.map(r => r.children[1].textContent)")
    assert shown == ["manual.pdf"], shown
    grabber.click('.chip[data-category="all"]')
    grabber.fill("#g-filter", "pack")
    grabber.check("#g-all")
    grabber.click("#g-download")
    wait_for(lambda: "GetSmart DM/Archives/pack.zip" in files_on_disk(b.downloads), what="grabbed file")

    closed = b.page("grabber.html?tab=999999999")
    closed.wait_for_selector("#g-status:not([hidden])")
    assert closed.locator("#g-status-title").inner_text() == "The tab is gone"
    closed.close()
    empty_page = b.page()
    empty_page.goto(base + "/empty.html")
    empty = b.page("grabber.html?tab=%d" % tab_id_for(b, base + "/empty.html"))
    empty.wait_for_selector("#g-status:not([hidden])")
    assert empty.locator("#g-status-title").inner_text() == "No links found"
    for p in (empty, empty_page, grabber, page):
        p.close()
    return "6 links from page + iframe, category chip, filter, select all shown, download; closed tab; no links"


def check_settings(b, base):
    reset(b)
    options = b.page("options.html")
    options.wait_for_selector("#maxSimultaneous")
    options.fill("#maxSimultaneous", "25")
    options.press("#maxSimultaneous", "Tab")
    options.uncheck("#sortIntoFolders")
    options.fill("#disabledSites", "https://www.Example.com/x\nfoo.org\nfoo.org\nnot a host")
    options.press("#disabledSites", "Tab")
    options.select_option("#defaultQuality", "720")
    options.click("#allowYouTube")
    options.click("#yt-dialog button[value=cancel]")
    time.sleep(0.5)
    saved = b.call("() => chrome.storage.sync.get(null)")
    assert saved["maxSimultaneous"] == 10, saved
    assert saved["sortIntoFolders"] is False, saved
    assert saved["disabledSites"] == ["example.com", "foo.org"], saved
    assert saved["defaultQuality"] == "720", saved
    assert not saved.get("allowYouTube"), saved
    options.click("#allowYouTube")
    options.click("#yt-accept")
    wait_for(lambda: b.call("() => chrome.storage.sync.get('allowYouTube')").get("allowYouTube") is True,
             what="allowYouTube after accepting the warning")
    options.reload()
    options.wait_for_selector("#maxSimultaneous")
    time.sleep(0.3)
    assert options.input_value("#maxSimultaneous") == "10"
    options.close()

    # Sorting off really applies.
    enqueue(b, [{"url": base + "/f/plain.pdf?size=2000&mime=application/pdf"}])
    wait_for(lambda: "plain.pdf" in files_on_disk(b.downloads), what="unsorted file")
    reset(b)
    return "clamped max (25 -> 10), sorting off applied, sites cleaned, quality, YouTube needs the warning"


def check_filter_and_clear(b, base):
    reset(b)
    enqueue(b, [{"url": base + "/f/song.mp3?size=2000&mime=audio/mpeg"},
                {"url": base + "/f/paper.pdf?size=2000&mime=application/pdf"},
                {"url": base + "/f/clip.mp4?size=2000&mime=video/mp4"},
                {"url": base + "/missing/gone.zip"}])
    wait_for(lambda: b.call("async () => (await chrome.downloads.search({state: 'in_progress'})).length") == 0
             and len(b.call("() => chrome.downloads.search({})")) == 4, what="4 finished downloads")
    popup = b.page("popup.html")
    popup.click("#tab-downloads")
    popup.wait_for_selector(".dl-row")
    visible = lambda: popup.eval_on_selector_all(".dl-row", "rs => rs.map(r => r.querySelector('.dl-name').textContent)")
    popup.click('.chip[data-category="music"]')
    wait_for(lambda: visible() == ["song.mp3"], what="music filter")
    popup.click('.chip[data-category="documents"]')
    wait_for(lambda: visible() == ["paper.pdf"], what="documents filter")
    popup.click('.chip[data-category="all"]')
    popup.fill("#dl-search", "clip")
    wait_for(lambda: visible() == ["clip.mp4"], what="search")
    popup.fill("#dl-search", "")
    failed = popup.locator(".dl-row[data-state=failed]")
    assert failed.count() == 1, "404 row should show as failed"

    # One still running: Clear finished must keep it.
    enqueue(b, [{"url": base + "/f/long.mp4?size=5000000&mime=video/mp4&slow=1"}])
    wait_for(lambda: popup.locator(".dl-row[data-state=downloading]").count() == 1, what="running row")
    popup.click("#dl-clear")
    wait_for(lambda: popup.locator(".dl-row").count() == 1, what="only the running row left")
    assert popup.locator(".dl-row[data-state=downloading]").count() == 1
    popup.close()
    reset(b)
    return "music/documents chips, search, failed row; Clear finished kept the running download"


def check_scheduler(b, base):
    reset(b)
    b.call("() => chrome.storage.sync.set({maxSimultaneous: 1, progressWindow: 'off', whenQueueDone: 'notify'})")
    time.sleep(0.3)
    # Settings page: turning the schedule on plans the alarms.
    opts = b.page("options.html#scheduler")
    opts.check("#scheduleEnabled")
    opts.fill("#scheduleStart", "03:30")
    opts.locator("#scheduleStart").dispatch_event("change")
    opts.fill("#scheduleStop", "07:00")
    opts.locator("#scheduleStop").dispatch_event("change")
    opts.click('#scheduleDays label:has(input[value="0"])')  # Sunday off
    days = wait_for(lambda: b.call("async () => (await chrome.storage.sync.get('scheduleDays')).scheduleDays") == [1, 2, 3, 4, 5, 6] and [1, 2, 3, 4, 5, 6],
                    what="days saved")
    opts.close()
    alarms = wait_for(lambda: (lambda a: len(a) == 2 and a)(b.call("() => chrome.alarms.getAll()")), what="two alarms")
    for alarm in alarms:
        hhmm = b.call("(w) => { const d = new Date(w); return [d.getHours(), d.getMinutes(), d.getDay()]; }", alarm["scheduledTime"])
        want = (3, 30) if alarm["name"].endswith("start") else (7, 0)
        assert tuple(hhmm[:2]) == want and hhmm[2] in days, (alarm, hhmm)
    # Stop the queue, then let the start alarm fire now.
    b.message({"type": "setQueuePaused", "paused": True})
    enqueue(b, [{"url": base + "/f/s%d.bin?size=200000&slow=1" % i} for i in range(2)])
    time.sleep(1)
    assert running(b) == 0 and queued(b) == 2, "stopped queue started something"
    b.call("() => chrome.alarms.create('gsdm-schedule-start', {when: Date.now() + 300})")
    wait_for(lambda: running(b) == 1, what="schedule started the queue")
    wait_for(lambda: queued(b) == 0 and running(b) == 0, timeout=30, what="queue ran through")
    note = wait_for(lambda: [n for n in b.call("() => new Promise((r) => chrome.notifications.getAll(r))") if n.startswith("gsdm-queue-done")],
                    what="queue done notification")
    b.call("() => chrome.storage.sync.set({scheduleEnabled: false})")
    wait_for(lambda: not b.call("() => chrome.alarms.getAll()"), what="alarms cleared when off")
    reset(b)
    return "alarms at 03:30/07:00 Mon-Sat; start alarm ran the stopped queue; queue-done notification; off clears alarms"


def register_companion(b):
    """Register companion/host.py for this profile, saving into the test Downloads folder."""
    config = os.path.join(b.tmp, "xdg")
    os.makedirs(config, exist_ok=True)
    with open(os.path.join(config, "user-dirs.dirs"), "w", encoding="utf-8") as f:
        f.write('XDG_DOWNLOAD_DIR="%s"\n' % b.downloads)
    wrapper = os.path.join(b.tmp, "host.sh")
    with open(wrapper, "w", encoding="utf-8") as f:
        f.write('#!/bin/sh\nXDG_CONFIG_HOME="%s" exec "%s" "%s" "$@"\n' % (config, sys.executable, HOST_PY))
    os.chmod(wrapper, 0o755)
    folder = os.path.join(b.tmp, "profile", "NativeMessagingHosts")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "com.getsmartdm.host.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "com.getsmartdm.host", "description": "test", "path": wrapper, "type": "stdio",
                   "allowed_origins": ["chrome-extension://%s/" % EXT_ID]}, f)


def file_jobs(b):
    return b.call("async () => Object.values((await chrome.storage.local.get('fileJobs')).fileJobs || {})")


def check_companion_files(b, base):
    if sys.platform == "win32":
        return "skipped on Windows (the test registers the host for Linux/macOS)"
    reset(b)
    register_companion(b)
    b.message({"type": "getVideoState", "url": ""})
    wait_for(lambda: (b.call("async () => (await chrome.storage.session.get('companion')).companion") or {}).get("status") == "connected",
             what="companion connected")
    enqueue(b, [{"url": base + "/f/bigfile.zip?size=8000000&slow=1"}])
    job = wait_for(lambda: next((j for j in file_jobs(b) if j.get("connections", 0) >= 2), None),
                   what="companion job with several connections (jobs: %r)" % file_jobs(b))
    assert not b.call("() => chrome.downloads.search({})"), "the browser downloaded it too"
    close_progress_windows(b)  # it may have opened on its own (at most 3 per 10 s)
    page = b.page("progress.html?id=f:%s" % job["id"])
    wait_for(lambda: page.locator("#p-segbar > div").count() >= 2, what="segment bar")
    assert page.locator("#p-conn-rows tr").count() >= 2
    page.click("#b-pause")
    wait_for(lambda: page.locator("body").get_attribute("data-state") == "paused", what="companion paused")
    page.click("#b-resume")
    done = wait_for(lambda: next((j for j in file_jobs(b) if j["id"] == job["id"] and j["state"] == "done"), None),
                    timeout=60, what="companion job done")
    path = os.path.join(b.downloads, "GetSmart DM", "Archives", "bigfile.zip")
    assert os.path.getsize(path) == 8000000, os.path.getsize(path)
    assert os.path.realpath(done["filename"]) == os.path.realpath(path), done["filename"]
    page.close()
    popup = b.page("popup.html")
    popup.click("#tab-downloads")
    popup.wait_for_selector('.dl-row[data-id="f:%s"][data-state=complete]' % job["id"])
    popup.close()
    # The global speed limit reaches the companion.
    b.call("() => chrome.storage.sync.set({speedLimitKBps: 500, progressWindow: 'off'})")
    time.sleep(0.5)
    enqueue(b, [{"url": base + "/f/limited.bin?size=3000000"}])
    limited = wait_for(lambda: next((j for j in file_jobs(b) if j.get("name") == "limited.bin"), None), what="limited job")
    started = time.time()
    wait_for(lambda: next((j for j in file_jobs(b) if j["id"] == limited["id"] and j["state"] == "done"), None),
             timeout=30, what="limited job done")
    took = time.time() - started
    assert took > 4, "3 MB at 500 KB/s took only %.1f s" % took
    b.call("() => chrome.storage.sync.set({speedLimitKBps: 0})")
    b.call("() => chrome.storage.local.set({fileJobs: {}})")
    # A server without ranges goes to the browser.
    enqueue(b, [{"url": base + "/f/plain.zip?size=3000000&norange=1"}])
    wait_for(lambda: b.call("() => chrome.downloads.search({})"), what="browser took the no-range file")
    assert not file_jobs(b), file_jobs(b)
    b.call("() => chrome.storage.local.set({fileJobs: {}})")
    reset(b)
    return "8 MB over several connections into GetSmart DM/Archives, parts shown, pause/resume, popup row; 500 KB/s limit; no-range file went to the browser"


CHECKS = [
    ("media detection and badge", check_media_detection),
    ("YouTube blocked", check_youtube_blocked),
    ("progress window", check_progress_window),  # before other downloads: auto-open allows 3 per 10 s
    ("folder sorting", check_folder_sorting),
    ("custom and Bangla file names", check_names),
    ("queue limit (max 2)", check_queue_limit),
    ("pause/resume from the UI", check_pause_resume_ui),
    ("manager page", check_manager),
    ("link grabber select + download", check_grabber),
    ("settings save", check_settings),
    ("category filter + clear finished", check_filter_and_clear),
    ("scheduler + queue done", check_scheduler),
    ("companion multi-connection download", check_companion_files),  # last: the companion stays registered
]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright is missing: pip install playwright && python -m playwright install chromium")

    server, base = start_server()
    os.environ["GSDM_PORT"] = str(server.server_address[1])
    failures = 0
    with sync_playwright() as playwright:
        b = Browser(playwright, args.headed)
        try:
            time.sleep(1)
            for name, check in CHECKS:
                try:
                    detail = check(b, base)
                    print("PASS  %-36s %s" % (name, detail))
                except Exception as err:  # report and keep going
                    failures += 1
                    print("FAIL  %-36s %s" % (name, err))
                    traceback.print_exc()
            errors = b.console_errors + b.worker_errors()
            if errors:
                failures += 1
                print("FAIL  %-36s %s" % ("no console errors", "; ".join(errors)))
            else:
                print("PASS  %-36s %s" % ("no console errors", "pages and service worker clean"))
        finally:
            b.close()
            server.shutdown()
    print("\n%s" % ("ALL PASSED" if not failures else "%d FAILED" % failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
