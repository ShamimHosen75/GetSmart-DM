#!/usr/bin/env python3
"""Automated QA for the SIDM extension (extension/).

Starts a local test HTTP server, launches real Chromium headless with the
extension loaded (--load-extension), drives the extension pages with
Playwright and checks:

   1. media detection + green badge (HLS/DASH, small files and XHR 206 skipped)
   2. YouTube is never detected (and video downloads there are refused)
   3. folder sorting (SIDM/<Category>/<name>)
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
    # A social-media-like feed: the video sits in an open shadow root, appears after load,
    # has no plain file address, and its post link is next to it.
    "/feed.html": """<!doctype html><html><head><title>Feed</title></head><body style="margin:0">
<article style="margin:30px"><a href="/u/status/12345">A post</a><div id="player"></div></article>
<script>setTimeout(() => {
  const root = document.getElementById('player').attachShadow({mode: 'open'});
  const v = document.createElement('video');
  v.style.cssText = 'width:480px;height:270px;display:block;background:#123';
  root.append(v);
}, 1200);</script></body></html>""",
    # A watch page (its own address is a post link) with another video's preview in the sidebar.
    "/watch": """<!doctype html><html><head><title>Watch</title></head><body style="margin:0">
<video style="width:480px;height:270px;display:block;background:#000"></video>
<p><a href="/watch?v=AAA&t=5">0:05</a></p>
<aside style="margin:20px"><a href="/watch?v=BBB"><div id="player"></div></a> <a href="/watch?v=CCC">Next</a></aside>
<script>setTimeout(() => {
  const root = document.getElementById('player').attachShadow({mode: 'open'});
  const v = document.createElement('video');
  v.style.cssText = 'width:480px;height:270px;display:block;background:#123';
  root.append(v);
}, 1200);</script></body></html>""",
    "/empty.html": """<!doctype html><html><head><title>Nothing</title></head><body>No links.</body></html>""",
}

# Video pages for the in-browser engine (M15): each plays like a real player
# would (fetches a playlist, a manifest or pieces of MP4 files) next to a
# <video> in a shadow root. Files come from /sv/, made with ffmpeg at start.
STREAM_PAGE = """<!doctype html><html><head><title>%s</title></head><body style="margin:0">
<article style="margin:30px"><div id="player"></div></article>
<script>
const root = document.getElementById('player').attachShadow({mode: 'open'});
const v = document.createElement('video');
v.style.cssText = 'width:480px;height:270px;display:block;background:#123';
root.append(v);
%s
</script></body></html>"""
PAGES.update({
    "/s-hls.html": STREAM_PAGE % ("HLS Test", "fetch('/sv/master.m3u8'); fetch('/sv/v360.m3u8');"),
    "/s-ts.html": STREAM_PAGE % ("TS Test", "fetch('/sv/ts.m3u8');"),
    "/s-dash.html": STREAM_PAGE % ("DASH Test", "fetch('/sv/dash.mpd');"),
    "/s-pieces.html": STREAM_PAGE % ("Pieces Test",
        "fetch('/sv/v.mp4?bytestart=0&byteend=9999'); fetch('/sv/a.mp4?bytestart=0&byteend=9999');"),
    # A feed: the tab played this 6 s video, then preloaded the next one (8 s).
    "/s-feed.html": STREAM_PAGE % ("Feed Test", "fetch('/sv/v360.m3u8').then(() => setTimeout(() => fetch('/sv/o8.m3u8'), 300));"),
    # Two videos of the same length played in one tab (a gallery of loops): 360p and 240p.
    "/s-twins.html": STREAM_PAGE % ("Twins Test", "fetch('/sv/one240.m3u8').then(() => setTimeout(() => fetch('/sv/one360.m3u8'), 300));"),
    "/s-enc.html": STREAM_PAGE % ("Encrypted Test", "fetch('/sv/enc.m3u8');"),
    # LinkedIn-style (M16): the player shows a blob: URL; every quality is in the page's API reply.
    "/s-linkedin.html": STREAM_PAGE % ("LinkedIn Test",
        "v.poster = '/sv/thumb-li-abcdef123.jpg'; v.muted = true;"
        "fetch('/sv/m360.mp4').then((r) => r.blob()).then((b) => { v.src = URL.createObjectURL(b); });"
        "setTimeout(() => fetch('/api/li-feed.json').then((r) => r.json()), 300);"),
    # A design gallery (owner's report 2026-11-26): several short looping animations of the same
    # length, each a plain MP4 in <video src>. The clicked (first) one must be saved, not a neighbour.
    "/s-gallery.html": """<!doctype html><html><head><title>Gallery Test</title></head><body style="margin:0">
<div style="display:grid;grid-template-columns:420px 420px;gap:20px;padding:20px">
<video id="first" src="/sv/m360.mp4" autoplay muted loop playsinline style="width:420px;height:236px;background:#123"></video>
<video id="second" src="/sv/m720.mp4" autoplay muted loop playsinline style="width:420px;height:236px;background:#321"></video>
</div></body></html>""",
    # A landing-page slider: the slides' videos sit on top of each other and only the shown one is
    # visible (the others have opacity 0). The hidden one comes first in the page, the shown one is "first".
    "/s-slides.html": """<!doctype html><html><head><title>Gallery Test</title></head><body style="margin:0">
<div style="position:relative;width:640px;height:360px;margin:20px">
<div style="position:absolute;inset:0;opacity:0"><video id="second" src="/sv/m720.mp4" autoplay muted loop playsinline style="width:640px;height:360px"></video></div>
<div style="position:absolute;inset:0"><video id="first" src="/sv/m360.mp4" autoplay muted loop playsinline style="width:640px;height:360px"></video></div>
</div></body></html>""",
    # The same, but the slides are both opaque and the shown one is simply drawn on top, under a
    # transparent layer that takes the pointer.
    "/s-stack.html": """<!doctype html><html><head><title>Gallery Test</title></head><body style="margin:0">
<div style="position:relative;width:640px;height:360px;margin:20px">
<video id="second" src="/sv/m720.mp4" autoplay muted loop playsinline style="position:absolute;inset:0;width:640px;height:360px"></video>
<video id="first" src="/sv/m360.mp4" autoplay muted loop playsinline style="position:absolute;inset:0;width:640px;height:360px"></video>
<div style="position:absolute;inset:0"></div>
</div></body></html>""",
    # A plain MP4 (sound inside, header at the end) that the player fetches in parts with Range.
    "/s-progressive.html": STREAM_PAGE % ("Progressive Test",
        "const x = new XMLHttpRequest(); x.open('GET', '/sv/mend.mp4'); x.setRequestHeader('Range', 'bytes=0-99999'); x.send();"),
})
STREAM_DIR = None  # set by make_stream_fixtures()
STREAM_MIME = {".jpg": "image/jpeg", ".m3u8": "application/vnd.apple.mpegurl", ".mpd": "application/dash+xml", ".m4s": "video/iso.segment",
               ".mp4": "video/mp4", ".ts": "video/mp2t"}


def make_stream_fixtures():
    """HLS (fMP4 with a separate audio playlist, and MPEG-TS), DASH and plain MP4 pieces, made with ffmpeg."""
    global STREAM_DIR
    if not shutil.which("ffmpeg"):
        return False
    d = tempfile.mkdtemp(prefix="gsdm-sv-")
    def ff(*args):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], cwd=d, check=True)
    frag = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]
    for size, name in (("640x360", "v.mp4"), ("426x240", "v240.mp4")):
        ff("-f", "lavfi", "-i", "testsrc=duration=6:size=%s:rate=25" % size, "-c:v", "libx264", "-g", "25",
           "-pix_fmt", "yuv420p", *frag, name)
    ff("-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "aac", *frag, "a.mp4")
    hls = ["-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod"]
    for src, name in (("v.mp4", "v360"), ("v240.mp4", "v240"), ("a.mp4", "aud")):
        ff("-i", src, *hls, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", name + "-init.mp4",
           "-hls_segment_filename", name + "-%d.m4s", name + ".m3u8")
    ff("-i", "v.mp4", "-i", "a.mp4", "-map", "0", "-map", "1", *hls, "-hls_segment_filename", "ts-%d.ts", "ts.m3u8")
    # Another video in the same feed, 8 s long: the one that must not be saved for a 6 s video.
    ff("-f", "lavfi", "-i", "testsrc=duration=8:size=640x360:rate=25", "-c:v", "libx264", "-g", "25", "-pix_fmt", "yuv420p", *frag, "o8.mp4")
    ff("-i", "o8.mp4", *hls, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "o8-init.mp4",
       "-hls_segment_filename", "o8-%d.m4s", "o8.m3u8")
    ff("-i", "v.mp4", "-i", "a.mp4", "-map", "0", "-map", "1", "-c", "copy", "-f", "dash", "-seg_duration", "2",
       "-use_template", "1", "-use_timeline", "1", "dash.mpd")
    # Plain MP4 files with sound (M16): fast start (header first), and one with the header at the end.
    for size, name in (("640x360", "m360.mp4"), ("1280x720", "m720.mp4")):
        ff("-f", "lavfi", "-i", "testsrc=duration=6:size=%s:rate=25" % size, "-f", "lavfi", "-i", "sine=duration=6",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", name)
    ff("-f", "lavfi", "-i", "testsrc=duration=8:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=duration=8",
       "-vf", "noise=alls=60:allf=t", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "3M", "-c:a", "aac", "-shortest", "mend.mp4")
    with open(os.path.join(d, "thumb-li-abcdef123.jpg"), "wb") as f:
        f.write(b"\xff\xd8\xff\xd9")
    with open(os.path.join(d, "master.m3u8"), "w") as f:
        f.write('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="aud.m3u8"\n'
                '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"\nv360.m3u8\n'
                '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,AUDIO="aud"\nv240.m3u8\n')
    # One master playlist per video, as players fetch them: the resolution says how big each plays.
    for name, res in (("one360", "640x360"), ("one240", "426x240")):
        with open(os.path.join(d, name + ".m3u8"), "w") as f:
            f.write('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=%s\nv%s.m3u8\n' % (res, res.split("x")[1]))
    with open(os.path.join(d, "enc.m3u8"), "w") as f:
        f.write('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nts-0.ts\n#EXT-X-ENDLIST\n')
    STREAM_DIR = d
    return True

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
        if url.path == "/api/li-feed.json":  # like LinkedIn's API reply: every quality of each video in the feed
            root = "http://%s/sv/" % self.headers.get("Host")
            other = {"progressiveStreams": [{"width": 1920, "height": 1080, "streamingLocations": [{"url": root + "other-1080p.mp4"}]}],
                     "duration": 99000, "thumbnail": {"rootUrl": root + "thumb-other-999999.jpg"}}
            mine = {"progressiveStreams": [
                        {"width": 640, "height": 360, "bitRate": 400000, "streamingLocations": [{"url": root + "m360.mp4?e=1&t=token"}]},
                        {"width": 1280, "height": 720, "bitRate": 1500000, "streamingLocations": [{"url": root + "m720.mp4?e=1&t=token"}]}],
                    "duration": 6000, "thumbnail": {"rootUrl": root + "thumb-li-abcdef123.jpg"}}
            body = json.dumps({"elements": [{"content": {"video": other}}, {"content": {"video": mine}}]}).encode()
            return self._send_simple(200, body, "application/json")
        if url.path.startswith("/sv/") and STREAM_DIR:
            return self.serve_stream_file(url.path[4:], query)
        if url.path.endswith(".m3u8"):
            return self._send_simple(200, b"#EXTM3U\n#EXTINF:4,\nseg1.ts\n" + b"#" * 300000, "application/vnd.apple.mpegurl")
        if url.path.endswith(".ts"):
            return self._send_simple(200, b"\0" * 300000, "video/mp2t")
        if url.path.endswith(".m4s"):
            return self._send_simple(200, b"\0" * 300000, "video/iso.segment")
        if url.path.startswith("/f/"):
            return self.serve_file(query)
        return self._send_simple(404, b"not found")

    def serve_stream_file(self, name, query):
        path = os.path.join(STREAM_DIR, os.path.basename(name))
        if not os.path.isfile(path):
            return self._send_simple(404, b"not found")
        with open(path, "rb") as f:
            data = f.read()
        mime = STREAM_MIME.get(os.path.splitext(path)[1], "application/octet-stream")
        if "bytestart" in query:  # Facebook-style pieces: the range is in the address
            data = data[int(query["bytestart"]):int(query.get("byteend", len(data) - 1)) + 1]
            return self._send_simple(200, data, mime)
        match = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
        if not match:
            return self._send_simple(200, data, mime)
        start = int(match.group(1))
        end = min(int(match.group(2)), len(data) - 1) if match.group(2) else len(data) - 1
        self.send_response(206)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(data)))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.wfile.write(data[start:end + 1])

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


SITE_HOST = "sidm.online"  # extension/update-check.js SITE_URL


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
        port = self.port = free_port()
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
        # The popup's update check asks the real website; answer it here (no network in tests).
        self.context.route("https://sidm.online/**", lambda route: route.fulfill(
            status=200, content_type="application/json", body='{"version": "0.0.0"}'))
        cdp = self.browser.new_browser_cdp_session()
        cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
        self.console_errors = []
        self.ext = self.page("popup.html")  # an extension page to call chrome.* from

    def page(self, path=None):
        page = self.context.new_page()
        label = path or "page"

        def on_console(msg):
            # The popup's daily update check fetches the real website, which
            # this sandbox may not reach; a failed check is silent for users.
            if SITE_HOST in (msg.location or {}).get("url", ""):
                return
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


def check_youtube(b, base):
    reset(b)
    # On by default: YouTube counts as a video site for the companion.
    state = b.message({"type": "getVideoState", "url": "https://www.youtube.com/watch?v=abc"})
    assert state["site"] == "video", state
    # Turned off: refused.
    b.call("() => chrome.storage.sync.set({allowYouTube: false})")
    time.sleep(0.3)
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
    reset(b)
    how = "real page served as www.youtube.com" if loaded else "host mapping refused here; checked the worker's decisions"
    return "on by default; when off: nothing detected, video download refused; DRM refused (%s)" % how


def enqueue(b, items):
    return b.message({"type": "enqueue", "items": items})


def check_folder_sorting(b, base):
    reset(b)
    reply = enqueue(b, [{"url": base + "/f/report.pdf?size=50000&mime=application/pdf"},
                        {"url": base + "/f/tool.zip?size=50000&mime=application/zip"},
                        {"url": base + "/f/track?size=50000&mime=audio/mpeg"}])
    assert reply["added"] == 3, reply
    want = ["SIDM/Archives/tool.zip", "SIDM/Documents/report.pdf", "SIDM/Music/track.mp3"]
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
    want = ["SIDM/Documents/a_b_.pdf", "SIDM/Music/বাংলা গান.mp3", "SIDM/Documents/_CON.txt"]
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
    wait_for(lambda: "SIDM/Archives/pack.zip" in files_on_disk(b.downloads), what="grabbed file")

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
    options.click("#allowYouTube")  # on by default: this turns it off, no dialog
    wait_for(lambda: b.call("() => chrome.storage.sync.get('allowYouTube')").get("allowYouTube") is False, what="YouTube off")
    options.click("#allowYouTube")  # turning it on again shows the warning
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


def open_video_menu(page):
    """Hover the feed video, click the Download button, focus the first menu entry."""
    page.wait_for_function("() => document.getElementById('player').shadowRoot?.querySelector('video')")
    time.sleep(2.5)  # the button's scan runs every 2 s
    box = page.evaluate("() => { const r = document.getElementById('player').shadowRoot.querySelector('video').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }")
    page.mouse.move((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    time.sleep(0.4)
    page.mouse.move(box[2] - 30, box[1] + 24)
    page.mouse.click(box[2] - 30, box[1] + 24)
    time.sleep(3)  # the menu asks the worker, which waits up to 2.5 s for the companion
    page.keyboard.press("Tab")


def check_video_button(b, base):
    reset(b)
    page = b.page()
    page.set_viewport_size({"width": 900, "height": 600})
    page.goto(base + "/feed.html")
    tab = tab_id_for(b, base + "/feed.html")
    open_video_menu(page)
    wait_for(lambda: b.call("(k) => chrome.storage.session.get(k)", "video:%d" % tab).get("video:%d" % tab),
             what="page reported a video")
    # Nothing played yet and no companion: the menu says to play the video; it does not push an install.
    text = page.evaluate("() => document.querySelector('gsdm-video-button') ? 'present' : ''")
    assert text == "present", "video button not added"
    popup = b.page("popup.html?tab=%d" % tab)
    popup.click("#tab-page")
    popup.wait_for_selector("#video-card:not([hidden]) .v-help")
    help_text = popup.inner_text("#video-card .v-help")
    assert "install" not in help_text.lower(), help_text
    popup.close()
    page.close()
    return "found in a shadow root after load; with nothing played it asks to play the video (no install prompt)"


def ffprobe_streams(path):
    if not shutil.which("ffprobe"):
        return None
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.split()
    return sorted(out)


def stream_download(b, base, page_path, pick, expect_name, expect_streams):
    """Open a stream page, ask for the choices, download one, check the saved file."""
    page = b.page()
    page.goto(base + page_path)
    tab = tab_id_for(b, base + page_path)
    seen = {}

    def wanted():
        seen["reply"] = b.message({"type": "streamOptions", "tabId": tab})
        return pick(seen["reply"].get("options") or [])

    option = wait_for(wanted, what="wanted stream choice on %s (have %r)" % (page_path, seen))
    labels = [o["label"] or "video" for o in seen["reply"]["options"]]
    added = b.message({"type": "addStream", "optionId": option["id"], "tabId": tab, "title": page.title()})
    assert added.get("id"), added
    rel = wait_for(lambda: next((f for f in files_on_disk(b.downloads) if f == expect_name), None), timeout=60,
                   what=expect_name + " on disk (have %r)" % files_on_disk(b.downloads))
    streams = ffprobe_streams(os.path.join(b.downloads, rel))
    if streams is not None:
        # Joined MPEG-TS pieces repeat their program table, so ffprobe may list each stream twice.
        got = sorted(set(streams)) if rel.endswith(".ts") else streams
        assert got == expect_streams, "%s has %r" % (rel, streams)
    page.close()
    return labels


def media_seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out or 0)


def check_feed_picks_clicked_video(b, base):
    """A feed tab played the clicked 6 s video, then preloaded an 8 s one: only the 6 s one is offered."""
    page = b.page()
    page.goto(base + "/s-feed.html")
    tab = tab_id_for(b, base + "/s-feed.html")
    wait_for(lambda: len(b.call("(k) => chrome.storage.session.get(k).then((r) => r[k] || [])", "streams:%d" % tab) or []) >= 2,
             what="both feed streams seen")
    clicked = {"matched": [], "other": [], "duration": 6.0, "single": True}
    reply = b.message({"type": "streamOptions", "tabId": tab, "page": clicked})
    mine = [o for o in reply.get("options") or [] if not o.get("other")]
    assert len(mine) == 1, "only the clicked video's stream may be offered, got %r (%r)" % (reply, b.message({"type": "streamDebug", "tabId": tab}))
    added = b.message({"type": "addStream", "optionId": mine[0]["id"], "tabId": tab, "title": "Feed Test"})
    assert added.get("id"), added
    rel = wait_for(lambda: next((f for f in files_on_disk(b.downloads) if f.startswith("SIDM/Video/Feed Test")), None), timeout=60,
                   what="feed video on disk (have %r)" % files_on_disk(b.downloads))
    if shutil.which("ffprobe"):
        seconds = media_seconds(os.path.join(b.downloads, rel))
        assert abs(seconds - 6) < 1, "saved the wrong video: %s is %.1f s long, the clicked one is 6 s (%r %r)" % (
            rel, seconds, reply, b.message({"type": "streamDebug", "tabId": tab}))
    # Two videos on screen and no length known: what the tab played may be either, so it is listed as "other".
    unsure = b.message({"type": "streamOptions", "tabId": tab, "page": {"matched": [], "other": [], "duration": 0, "single": False}})
    assert unsure.get("options") and all(o.get("other") for o in unsure["options"]), unsure
    page.close()

    # Two videos of the same length, several on screen: the clicked one plays at 240p, so that one is it.
    page = b.page()
    page.goto(base + "/s-twins.html")
    tab = tab_id_for(b, base + "/s-twins.html")
    wait_for(lambda: len(b.call("(k) => chrome.storage.session.get(k).then((r) => r[k] || [])", "streams:%d" % tab) or []) >= 2,
             what="both twin streams seen")
    twins = {"matched": [], "other": [], "duration": 6.0, "single": False}
    reply = b.message({"type": "streamOptions", "tabId": tab, "page": dict(twins, height=240)})
    mine = [o["label"] for o in reply.get("options") or [] if not o.get("other")]
    assert mine == ["240p"], "the 240p video playing on screen must be the only choice, got %r (%r)" % (reply, b.message({"type": "streamDebug", "tabId": tab}))
    # Nothing tells them apart: neither is offered as this video, both are listed as other videos.
    reply = b.message({"type": "streamOptions", "tabId": tab, "page": twins})
    assert reply.get("options") and all(o.get("other") for o in reply["options"]), reply
    page.close()


def check_gallery_picks_clicked_video(b, base, path="/s-gallery.html"):
    """Two same-length animations on one page: the button on the shown one saves that one."""
    page = b.page()
    page.set_viewport_size({"width": 1000, "height": 600})
    page.goto(base + path)
    tab = tab_id_for(b, base + path)
    page.wait_for_function("() => [...document.querySelectorAll('video')].every((v) => v.readyState >= 2)")
    time.sleep(2.5)  # the button's scan runs every 2 s
    box = page.evaluate("() => { const r = document.getElementById('first').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }")
    page.mouse.move((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    time.sleep(0.4)
    page.mouse.move(box[2] - 30, box[1] + 24)
    page.mouse.click(box[2] - 30, box[1] + 24)
    time.sleep(3)
    page.keyboard.press("Tab")
    page.keyboard.press("Enter")
    debug = lambda: b.message({"type": "streamDebug", "tabId": tab})
    rel = wait_for(lambda: next((f for f in files_on_disk(b.downloads) if f.startswith("SIDM/Video/Gallery Test") and not f.endswith(".crdownload")), None),
                   timeout=60, what="gallery video on disk (have %r, %r)" % (files_on_disk(b.downloads), debug()))
    if shutil.which("ffprobe"):
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0",
                              os.path.join(b.downloads, rel)], capture_output=True, text=True).stdout.strip()
        assert out == "360", "saved the neighbour: %s is %sp, the clicked video is 360p (%r)" % (rel, out, debug())
    page.close()


def check_stream_videos(b, base):
    if not STREAM_DIR:
        return "skipped: ffmpeg not installed"
    reset(b)
    with_audio = lambda height: (lambda opts: next((o for o in opts if o["label"] == height and o["hasAudio"]), None))
    hls = stream_download(b, base, "/s-hls.html", with_audio("360p"), "SIDM/Video/HLS Test (360p).mp4", ["audio", "video"])
    assert hls[:2] == ["360p", "240p"] and len(hls) == 2, "HLS choices %r (variant playlist must not repeat)" % hls
    dash = stream_download(b, base, "/s-dash.html", with_audio("360p"), "SIDM/Video/DASH Test (360p).mp4", ["audio", "video"])
    assert "audio" in dash, dash
    stream_download(b, base, "/s-pieces.html", with_audio("360p"), "SIDM/Video/Pieces Test (360p).mp4", ["audio", "video"])
    stream_download(b, base, "/s-ts.html", lambda opts: opts[0] if opts else None, "SIDM/Video/TS Test.ts", ["audio", "video"])
    check_feed_picks_clicked_video(b, base)
    check_gallery_picks_clicked_video(b, base)
    check_gallery_picks_clicked_video(b, base, "/s-slides.html")
    check_gallery_picks_clicked_video(b, base, "/s-stack.html")

    # Encrypted HLS is refused, never downloaded.
    page = b.page()
    page.goto(base + "/s-enc.html")
    tab = tab_id_for(b, base + "/s-enc.html")
    reply = wait_for(lambda: (lambda r: r if r.get("refused") else None)(b.message({"type": "streamOptions", "tabId": tab})),
                     what="encrypted stream refused")
    assert reply["refused"] == "encrypted" and not reply["options"], reply
    page.close()

    # The video button offers the same choices and downloads from the menu.
    page = b.page()
    page.set_viewport_size({"width": 900, "height": 600})
    page.goto(base + "/s-pieces.html")
    time.sleep(1)
    open_video_menu(page)
    page.keyboard.press("Enter")
    wait_for(lambda: len([f for f in files_on_disk(b.downloads) if f.startswith("SIDM/Video/Pieces Test (360p)")]) >= 2,
             timeout=60, what="second download from the video button")
    page.close()
    # A plain MP4 with sound fetched in parts (header at the end): offered as one whole file.
    stream_download(b, base, "/s-progressive.html", with_audio("360p"), "SIDM/Video/Progressive Test (360p).mp4", ["audio", "video"])

    # LinkedIn-style page data: the menu's first choice is the highest quality of the video under the pointer.
    page = b.page()
    page.set_viewport_size({"width": 900, "height": 600})
    page.goto(base + "/s-linkedin.html")
    page.wait_for_function("() => document.getElementById('player').shadowRoot?.querySelector('video')?.duration > 0")
    open_video_menu(page)
    page.keyboard.press("Enter")
    rel = wait_for(lambda: next((f for f in files_on_disk(b.downloads) if f.startswith("SIDM/Video/LinkedIn Test")), None),
                   timeout=60, what="LinkedIn-style download (have %r)" % files_on_disk(b.downloads))
    assert rel == "SIDM/Video/LinkedIn Test (720p).mp4", rel
    wait_for(lambda: not any(f.endswith(".crdownload") for f in files_on_disk(b.downloads)), what="download finished")
    assert ffprobe_streams(os.path.join(b.downloads, rel)) in (None, ["audio", "video"]), rel
    page.close()
    return "page data (LinkedIn-style) gives the highest quality first; plain MP4 with sound saved whole; HLS fMP4 + separate audio, DASH, Facebook-style MP4 pieces joined into one MP4 (video+audio); TS saved as .ts; encrypted refused; video button menu works"


def register_companion(b):
    """Register companion/host.py for this profile, saving into the test Downloads folder."""
    config = os.path.join(b.tmp, "xdg")
    os.makedirs(config, exist_ok=True)
    with open(os.path.join(config, "user-dirs.dirs"), "w", encoding="utf-8") as f:
        f.write('XDG_DOWNLOAD_DIR="%s"\n' % b.downloads)
    # A stand-in for the system folder dialog (zenity): "chooses" the folder written in b.tmp/choice.
    bindir = os.path.join(b.tmp, "bin")
    os.makedirs(bindir, exist_ok=True)
    with open(os.path.join(bindir, "zenity"), "w", encoding="utf-8") as f:
        f.write('#!/bin/sh\ncat "%s"\n' % os.path.join(b.tmp, "choice"))
    os.chmod(os.path.join(bindir, "zenity"), 0o755)
    with open(os.path.join(b.tmp, "choice"), "w", encoding="utf-8") as f:
        f.write("")
    wrapper = os.path.join(b.tmp, "host.sh")
    with open(wrapper, "w", encoding="utf-8") as f:
        f.write('#!/bin/sh\nPATH="%s:$PATH" XDG_CONFIG_HOME="%s" exec "%s" "%s" "$@"\n' % (bindir, config, sys.executable, HOST_PY))
    os.chmod(wrapper, 0o755)
    folder = os.path.join(b.tmp, "profile", "NativeMessagingHosts")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "com.sidm.host.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "com.sidm.host", "description": "test", "path": wrapper, "type": "stdio",
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
    path = os.path.join(b.downloads, "SIDM", "Archives", "bigfile.zip")
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

    # Installed once: remembered, so the install offer is never shown again.
    assert b.call("async () => (await chrome.storage.local.get('companionSeen')).companionSeen") is True
    # Video download through the desktop program: the folder dialog chooses where it goes.
    chosen = os.path.join(b.downloads, "Picked folder")
    os.makedirs(chosen, exist_ok=True)
    with open(os.path.join(b.tmp, "choice"), "w", encoding="utf-8") as f:
        f.write(chosen + "\n")
    video_url = base + "/f/clip.mp4?size=300000&mime=video/mp4"
    added = b.message({"type": "addVideo", "url": video_url, "quality": "best", "title": "Clip"})
    assert added.get("id"), added
    video = wait_for(lambda: next((j for j in b.call("async () => Object.values((await chrome.storage.session.get('videoJobs')).videoJobs || {})")
                                   if j["id"] == added["id"] and j["state"] in ("done", "error")), None),
                     timeout=60, what="video job finished")
    assert video["state"] == "done", video
    assert os.path.dirname(os.path.realpath(video["filename"])) == os.path.realpath(chosen), video["filename"]
    assert b.call("async () => (await chrome.storage.local.get('lastVideoFolder')).lastVideoFolder") == chosen
    # The video menu follows the job after the click (shows "Saved" or the error instead of going silent).
    state = b.message({"type": "videoJob", "id": added["id"]})
    assert state.get("state") == "done", state
    # Closing the dialog without a folder cancels the download.
    with open(os.path.join(b.tmp, "choice"), "w", encoding="utf-8") as f:
        f.write("")
    assert b.message({"type": "addVideo", "url": video_url, "quality": "best"}).get("canceled") is True
    # Sizes for the quality menu.
    info = b.message({"type": "videoInfo", "url": video_url})
    assert isinstance(info.get("sizes"), dict) and not info.get("error"), info
    # A server without ranges goes to the browser.
    enqueue(b, [{"url": base + "/f/plain.zip?size=3000000&norange=1"}])
    wait_for(lambda: b.call("() => chrome.downloads.search({})"), what="browser took the no-range file")
    assert not file_jobs(b), file_jobs(b)
    b.call("() => chrome.storage.local.set({fileJobs: {}})")
    # Video button with the companion: qualities; the first (Best) uses the post's own address.
    with open(os.path.join(b.tmp, "choice"), "w", encoding="utf-8") as f:
        f.write(chosen + "\n")
    b.call("() => chrome.storage.session.set({videoJobs: {}})")
    page = b.page()
    page.set_viewport_size({"width": 900, "height": 600})
    page.goto(base + "/feed.html")
    open_video_menu(page)
    page.keyboard.press("Enter")
    jobs = wait_for(lambda: b.call("async () => Object.values((await chrome.storage.session.get('videoJobs')).videoJobs || {})"),
                    what="video job from the button")
    assert jobs[0]["url"] == base + "/u/status/12345" and jobs[0]["quality"] == "best", jobs[0]
    page.close()
    # On a watch page, a preview in the sidebar is that video, not the page's own one.
    b.call("() => chrome.storage.session.set({videoJobs: {}})")
    page = b.page()
    page.set_viewport_size({"width": 900, "height": 800})
    page.goto(base + "/watch?v=AAA")
    open_video_menu(page)
    page.keyboard.press("Enter")
    jobs = wait_for(lambda: b.call("async () => Object.values((await chrome.storage.session.get('videoJobs')).videoJobs || {})"),
                    what="video job from the sidebar preview")
    assert jobs[0]["url"] == base + "/watch?v=BBB", "downloaded %s instead of the hovered preview" % jobs[0]["url"]
    page.close()
    reset(b)
    return "video button: Best quality for the post address, the hovered preview on a watch page; 8 MB over several connections into SIDM/Archives, parts shown, pause/resume, popup row; 500 KB/s limit; no-range file went to the browser; video saved into the folder picked in the dialog, job state for the menu, cancel, sizes"


CHECKS = [
    ("media detection and badge", check_media_detection),
    ("YouTube on by default, off refuses, DRM", check_youtube),
    ("progress window", check_progress_window),  # before other downloads: auto-open allows 3 per 10 s
    ("folder sorting", check_folder_sorting),
    ("custom and Bangla file names", check_names),
    ("queue limit (max 2)", check_queue_limit),
    ("pause/resume from the UI", check_pause_resume_ui),
    ("manager page", check_manager),
    ("video button on any site", check_video_button),
    ("videos without the companion", check_stream_videos),
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

    make_stream_fixtures()
    server, base = start_server()
    os.environ["GSDM_PORT"] = str(server.server_address[1])
    failures = 0
    with sync_playwright() as playwright:
        b = Browser(playwright, args.headed)
        try:
            time.sleep(1)
            only = os.environ.get("GSDM_ONLY", "")  # run only checks whose name contains this text
            for name, check in CHECKS:
                if only and only not in name:
                    continue
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
            if STREAM_DIR:
                shutil.rmtree(STREAM_DIR, ignore_errors=True)
    print("\n%s" % ("ALL PASSED" if not failures else "%d FAILED" % failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
