#!/usr/bin/env python3
"""Tests for the online downloader: online/server.py and site/online-downloader.html.

  1. Unit checks of server.py: link cleaning, DRM and private-network refusals,
     CORS origins, the format choices built from a yt-dlp info dict.
  2. End to end in Chromium: test videos made with ffmpeg are served on a local
     port (a plain MP4 and a two-quality HLS stream); server.py runs on another
     port with SIDM_ALLOW_PRIVATE=1; the page is opened with ?api=... and
       - a pasted share text with an HLS link lists 720p, 360p and MP3,
       - "720p" downloads an MP4 that is really 1280x720 with sound,
       - "Audio only" downloads a real MP3,
       - a Netflix link is refused on the page,
       - the MP4 to MP3 tab converts a local MP4 in the browser,
       - with no service address in the page, only MP4 to MP3 shows.

Needs: yt-dlp (pip install yt-dlp), ffmpeg, ffprobe, playwright + Chromium.

    python scripts/test_online.py
"""

import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
SERVER = ROOT / "online" / "server.py"

failures = []


def check(cond, name, detail=""):
    print(("[PASS] " if cond else "[FAIL] ") + name + (": " + detail if detail and not cond else ""), flush=True)
    if not cond:
        failures.append(name)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(folder):
    port = free_port()
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(folder))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,height",
                          "-of", "json", str(path)], capture_output=True, check=True)
    return json.loads(out.stdout)["streams"]


def make_media(folder):
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=500",
           "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(folder / "my clip.mp4"))
    (folder / "hls").mkdir()
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=330",
           "-t", "6", "-filter_complex", "[0:v]split=2[a][b];[b]scale=640:360[b2]",
           "-map", "[a]", "-map", "[b2]", "-map", "1:a", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-f", "hls", "-hls_time", "3", "-hls_playlist_type", "vod",
           "-master_pl_name", "master.m3u8", "-var_stream_map", "v:0,a:0 v:1,a:1",
           str(folder / "hls" / "v%v" / "index.m3u8"))


# ---------------------------------------------------------------- unit checks

def unit_checks():
    sys.path.insert(0, str(SERVER.parent))
    os.environ.pop("SIDM_ALLOW_PRIVATE", None)
    import server  # noqa: E402

    check(server.clean_url("Look at this https://8.8.8.8/v/1, wow") == "https://8.8.8.8/v/1",
          "share text: the link is taken out of it")
    for bad, name in (("https://www.netflix.com/watch/1", "DRM site refused"),
                      ("http://127.0.0.1:8080/x.mp4", "localhost refused"),
                      ("http://169.254.169.254/latest", "cloud metadata address refused"),
                      ("not a link", "text without a link refused")):
        try:
            server.clean_url(bad)
            check(False, name)
        except server.Refusal:
            check(True, name)
    server.ORIGINS[:] = ["https://sidm.online", "https://*.sidm.pages.dev"]
    check(server.origin_allowed("https://sidm.online"), "CORS: sidm.online allowed")
    check(server.origin_allowed("https://abc123.sidm.pages.dev"), "CORS: Pages previews allowed")
    check(not server.origin_allowed("https://evil.example"), "CORS: other sites not allowed")
    info = {"duration": 100, "formats": [
        {"format_id": "a", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 128, "filesize": 1_600_000},
        {"format_id": "v1", "vcodec": "avc1", "acodec": "none", "height": 1080, "ext": "mp4", "filesize": 20_000_000},
        {"format_id": "v2", "vcodec": "vp9", "acodec": "none", "height": 1080, "ext": "webm", "filesize": 15_000_000},
        {"format_id": "v3", "vcodec": "avc1", "acodec": "none", "height": 720, "ext": "mp4", "filesize": 9_000_000},
        {"format_id": "v4", "vcodec": "avc1", "acodec": "none", "height": 360, "ext": "mp4", "filesize": 3_000_000},
    ]}
    options = server.build_options(info)
    check([o["id"] for o in options] == ["v1080", "v720", "v360", "mp3", "audio"],
          "format choices: one per height, then MP3 and original audio", str([o["id"] for o in options]))
    check(options[0]["size"] == 21_600_000, "1080p size counts video plus sound", str(options[0]["size"]))


# ---------------------------------------------------------------- end to end

def wait_health(port):
    for _ in range(60):
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=2) as r:
                return json.load(r)
        except OSError:
            time.sleep(0.5)
    return None


def end_to_end(tmp):
    from playwright.sync_api import sync_playwright

    media = tmp / "media"
    media.mkdir()
    make_media(media)
    media_httpd, media_port = serve(media)
    site_httpd, site_port = serve(SITE)
    api_port = free_port()
    env = dict(os.environ, PORT=str(api_port), SIDM_ALLOW_PRIVATE="1", SIDM_ORIGINS="http://localhost:%d" % site_port,
               SIDM_WORK_DIR=str(tmp / "work"))
    proc = subprocess.Popen([sys.executable, str(SERVER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        health = wait_health(api_port)
        check(bool(health and health.get("ok") and health.get("ytdlp")), "service starts and finds yt-dlp", str(health))
        with sync_playwright() as p:
            kwargs = {}
            if not Path(p.chromium.executable_path).exists() and Path("/opt/pw-browsers/chromium").exists():
                kwargs["executable_path"] = "/opt/pw-browsers/chromium"
            browser = p.chromium.launch(**kwargs)
            ctx = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto("http://localhost:%d/online-downloader.html" % site_port)
            if page.get_attribute('meta[name="sidm-api"]', "content"):
                check(page.is_visible("#tab-link"), "with the service address set, the paste-a-link tab shows")
            else:
                check(not page.is_visible("#link-input") and not page.is_visible("#tab-link") and page.is_visible("#mp3-drop"),
                      "without the service address, only MP4 to MP3 shows")
            page.goto("http://localhost:%d/online-downloader.html?api=http://127.0.0.1:%d" % (site_port, api_port))
            check(page.is_visible("#link-input"), "with ?api= the paste-a-link tab shows")

            page.fill("#link-input", "Watch this! http://127.0.0.1:%d/hls/master.m3u8" % media_port)
            page.click("#link-go")
            page.wait_for_selector("#link-result:not([hidden])", timeout=60000)
            labels = page.eval_on_selector_all(".od-opt-label", "els => els.map(e => e.textContent)")
            check(labels == ["720p", "360p", "Audio only"], "HLS link lists 720p, 360p and MP3", str(labels))

            with page.expect_download(timeout=90000) as dl:
                page.click(".od-option >> nth=0 >> button")
            path = tmp / "video.mp4"
            dl.value.save_as(path)
            streams = probe(path)
            heights = [s.get("height") for s in streams if s["codec_type"] == "video"]
            check(heights == [720] and any(s["codec_type"] == "audio" for s in streams),
                  "720p download is a 720p MP4 with sound", str(streams))
            check(dl.value.suggested_filename == "master.mp4", "file is named after the video",
                  dl.value.suggested_filename)

            with page.expect_download(timeout=90000) as dl:
                page.click(".od-option >> nth=2 >> button")
            path = tmp / "audio.mp3"
            dl.value.save_as(path)
            check([s["codec_name"] for s in probe(path)] == ["mp3"], "Audio only download is an MP3")

            page.fill("#link-input", "https://www.netflix.com/watch/123")
            page.click("#link-go")
            check("DRM" in page.text_content("#link-status"), "Netflix link refused on the page")

            page.click("#tab-mp3")
            page.set_input_files("#mp3-file", str(media / "my clip.mp4"))
            page.click("#mp3-go")
            page.wait_for_selector("#mp3-result:not([hidden]), #mp3-status.is-error", timeout=60000)
            with page.expect_download() as dl:
                page.click("#mp3-save")
            path = tmp / "converted.mp3"
            dl.value.save_as(path)
            check(dl.value.suggested_filename == "my clip.mp3" and [s["codec_name"] for s in probe(path)] == ["mp3"],
                  "MP4 to MP3 converts in the browser", page.text_content("#mp3-status"))
            check(not errors, "no script errors on the page", "; ".join(errors))
            browser.close()
    finally:
        proc.terminate()
        log = proc.communicate(timeout=10)[0].decode("utf-8", "replace")
        media_httpd.shutdown()
        site_httpd.shutdown()
        if failures:
            print("--- service log ---\n" + log[-3000:])


def main():
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print("[FAIL] %s is needed" % tool)
            return 1
    unit_checks()
    tmp = Path(tempfile.mkdtemp(prefix="sidm-online-test-"))
    try:
        end_to_end(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%s" % ("all checks passed" if not failures else "%d failed: %s" % (len(failures), ", ".join(failures))))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
