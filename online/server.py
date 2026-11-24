#!/usr/bin/env python3
"""SIDM Online: the service behind the website's online downloader page.

The page (site/online-downloader.html) sends a pasted link here. This service
asks yt-dlp what the link offers, downloads the format the visitor picks into
a temporary folder (joining video and sound with ffmpeg, or making an MP3) and
hands the finished file back. Files are deleted a short while after they are
ready. Nothing is stored for longer and no account is needed.

Endpoints (JSON unless noted; CORS limited to SIDM_ORIGINS):

    GET  /api/health                  {"ok": true, "ytdlp": "<version>"}
    POST /api/info   {"url"}          title, thumbnail, duration, options[]
    POST /api/jobs   {"info", "option"}  -> {"job"}
    GET  /api/jobs/<job>              state, percent, bytes, total, speed, eta, error
    GET  /api/jobs/<job>/file         the finished file (attachment)

Standard library only; yt-dlp and ffmpeg are external programs (see Dockerfile).
Settings come from environment variables, listed in online/README.md.
"""

import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


PORT = env_int("PORT", 8080)
ORIGINS = [o.strip() for o in os.environ.get(
    "SIDM_ORIGINS", "https://sidm.online,https://www.sidm.online,https://*.sidm.pages.dev").split(",") if o.strip()]
WORK_DIR = os.environ.get("SIDM_WORK_DIR") or os.path.join(tempfile.gettempdir(), "sidm-online")
MAX_DURATION = env_int("SIDM_MAX_DURATION", 3 * 3600)          # seconds of video
MAX_FILESIZE = env_int("SIDM_MAX_FILESIZE", 2 * 1024 ** 3)      # bytes per file
MAX_JOBS = env_int("SIDM_MAX_JOBS", 4)                           # downloads running at once
MAX_JOBS_PER_IP = env_int("SIDM_MAX_JOBS_PER_IP", 2)
INFO_PER_IP = env_int("SIDM_INFO_PER_IP", 40)                    # link checks per IP per window
RATE_WINDOW = env_int("SIDM_RATE_WINDOW", 600)
KEEP_FILES = env_int("SIDM_KEEP_FILES", 30 * 60)                 # seconds a finished file stays
INFO_TIMEOUT = env_int("SIDM_INFO_TIMEOUT", 60)
JOB_TIMEOUT = env_int("SIDM_JOB_TIMEOUT", 60 * 60)
ALLOW_PRIVATE = os.environ.get("SIDM_ALLOW_PRIVATE") == "1"      # tests only: allow localhost links
TRUST_PROXY = os.environ.get("SIDM_TRUST_PROXY", "1") == "1"     # read the visitor IP from proxy headers
AUTO_UPDATE = os.environ.get("SIDM_AUTO_UPDATE") == "1"          # pip install -U yt-dlp once a day

YOUTUBE_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com")
DRM_HOSTS = (
    "netflix.com", "primevideo.com", "disneyplus.com", "hulu.com", "max.com",
    "hbomax.com", "spotify.com", "tidal.com", "deezer.com", "peacocktv.com",
    "paramountplus.com", "tv.apple.com", "music.apple.com", "hotstar.com",
)
HEIGHTS = (2160, 1440, 1080, 720, 480, 360, 240, 144)

PROGRESS_TEMPLATE = (
    "download:SIDM %(progress.downloaded_bytes)s "
    "%(progress.total_bytes,progress.total_bytes_estimate)s "
    "%(progress.speed)s %(progress.eta)s"
)

log = logging.getLogger("sidm-online")


class Refusal(Exception):
    """A request we answer with a friendly message and an HTTP status."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------- yt-dlp

def ytdlp_base():
    exe = os.environ.get("SIDM_YTDLP") or shutil.which("yt-dlp")
    return [exe] if exe else [sys.executable, "-m", "yt_dlp"]


def ffmpeg_path():
    return os.environ.get("SIDM_FFMPEG") or shutil.which("ffmpeg")


def ytdlp_version():
    try:
        out = subprocess.run(ytdlp_base() + ["--version"], capture_output=True, timeout=20)
        return out.stdout.decode().strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None


ERROR_RULES = (
    (re.compile(r"confirm you.?re not a bot|not a robot|Sign in to confirm", re.I),
     "This site asked our server to prove it is not a robot, so it can't be downloaded online right now. "
     "Try again later, or use the free SIDM extension, which downloads from your own computer."),
    (re.compile(r"\bDRM\b", re.I),
     "This video is DRM-protected. SIDM does not download DRM-protected content."),
    (re.compile(r"private|log ?in|sign ?in|cookies|registered users|members only|"
                r"authentication|requires? (an )?account|age.restricted", re.I),
     "This video is private or needs a login, so it can't be downloaded online."),
    (re.compile(r"not available in your country|geo.?restrict|blocked it in your country", re.I),
     "This video isn't available in the country where our server is."),
    (re.compile(r"File is larger than max-filesize|max-filesize", re.I),
     "This file is too big for the online downloader. Use the free SIDM extension for big files."),
    (re.compile(r"Unsupported URL|no suitable (info)?extractor|is not a valid URL", re.I),
     "This link isn't supported. Paste the link of a page with a video, or a direct video file link."),
    (re.compile(r"HTTP Error 404|404:? Not Found|\b404\b", re.I),
     "Video not found. The link may be broken or the post was deleted."),
    (re.compile(r"Unable to download webpage|urlopen error|getaddrinfo|Name or service not known|"
                r"timed? ?out|Connection (refused|reset|aborted)|Network is unreachable|"
                r"Temporary failure in name resolution|RemoteDisconnected|IncompleteRead", re.I),
     "We couldn't reach that site. Check the link and try again."),
)


def friendly_error(text):
    lines = text.splitlines()
    errors = [ln for ln in lines if ln.startswith("ERROR:")]
    haystack = "\n".join(errors) if errors else text
    for pattern, message in ERROR_RULES:
        if pattern.search(haystack):
            return message
    return "We couldn't get this video. The site may have changed; please try again later."


# ---------------------------------------------------------------- link checks

def _host_matches(host, domains):
    host = (host or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in domains)


URL_IN_TEXT = re.compile(r"https?://[^\s<>\"']+", re.I)


def clean_url(text):
    """Take the first http(s) link out of pasted text ("share text" often wraps it)."""
    text = (text or "").strip()
    if len(text) > 4000:
        raise Refusal("That link is too long.")
    match = URL_IN_TEXT.search(text)
    if not match and re.match(r"^[\w.-]+\.[a-z]{2,}(/\S*)?$", text, re.I):
        match = URL_IN_TEXT.search("https://" + text)
    if not match:
        raise Refusal("Paste a video link that starts with http:// or https://.")
    url = match.group(0).rstrip(".,);]")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Refusal("Paste a video link that starts with http:// or https://.")
    if _host_matches(parsed.hostname, DRM_HOSTS):
        raise Refusal("This site uses DRM protection. SIDM does not download DRM-protected content.", 451)
    if not ALLOW_PRIVATE:
        check_public_host(parsed.hostname)
    return url


def check_public_host(host):
    """Refuse links to this server's own network (localhost, LAN, cloud metadata)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        raise Refusal("We couldn't find that website. Check the link and try again.")
    for info in infos:
        addr = ipaddress.ip_address(info[4][0].split("%")[0])
        if not addr.is_global:
            raise Refusal("This link points to a private network address, which can't be downloaded.")


def is_youtube(url):
    return _host_matches(urllib.parse.urlparse(url).hostname, YOUTUBE_HOSTS)


# ---------------------------------------------------------------- formats

def _size(f, duration):
    size = f.get("filesize") or f.get("filesize_approx")
    if not size and f.get("tbr") and duration:
        size = f["tbr"] * 1000 / 8 * duration
    return int(size) if size else 0


def _has_video(f):
    return f.get("vcodec") not in (None, "none") and (f.get("height") or 0) > 0


def _has_audio(f):
    return f.get("acodec") not in (None, "none")


def build_options(info):
    """The choices shown on the page: one per video height, plus MP3 and original audio."""
    duration = info.get("duration") or 0
    formats = [f for f in info.get("formats") or [] if f.get("ext") != "mhtml" and f.get("protocol") != "mhtml"]
    if not formats:
        formats = [info]  # a single direct file
    videos = [f for f in formats if _has_video(f)]
    audios = [f for f in formats if _has_audio(f) and not _has_video(f)]
    muxed_audio = any(_has_audio(f) for f in videos)
    unknown = [f for f in formats if f.get("vcodec") is None and f.get("acodec") is None]
    best_audio = max(audios, key=lambda f: f.get("abr") or f.get("tbr") or 0, default=None)
    audio_size = _size(best_audio, duration) if best_audio else 0

    options = []
    seen = set()
    for f in sorted(videos, key=lambda f: -(f.get("height") or 0)):
        height = f.get("height") or 0
        step = next((h for h in HEIGHTS if height >= h * 0.9), None)
        if not step or step in seen:
            continue
        seen.add(step)
        fits = [v for v in videos if (v.get("height") or 0) <= height]
        best = max(fits, key=lambda v: (v.get("height") or 0, v.get("tbr") or 0))
        size = _size(best, duration) + (0 if _has_audio(best) else audio_size)
        options.append({"id": "v%d" % height, "kind": "video", "label": "%dp" % step,
                        "note": "4K" if step == 2160 else ("HD" if step >= 720 else ""),
                        "ext": "mp4", "size": size or None})
        if len(options) >= 6:
            break
    if not options and unknown:
        # A direct link or a site that doesn't say what it holds: offer it as it is.
        ext = (info.get("ext") or "mp4").lower()
        options.append({"id": "best", "kind": "video", "label": "Original", "note": "",
                        "ext": ext, "size": _size(unknown[-1], duration) or None})
    if best_audio or muxed_audio or unknown:
        options.append({"id": "mp3", "kind": "audio", "label": "Audio only", "note": "192 kbps",
                        "ext": "mp3", "size": int(duration * 24000) if duration else None})
    if best_audio:
        ext = best_audio.get("ext") or "m4a"
        options.append({"id": "audio", "kind": "audio", "label": "Original audio",
                        "note": (best_audio.get("acodec") or "").split(".")[0], "ext": ext,
                        "size": audio_size or None})
    return options


def format_args(option, ffmpeg):
    if option == "mp3":
        return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "192K"]
    if option == "audio":
        return ["-f", "ba/b"]
    if option == "best":
        return ["-f", "b/bv*+ba", "--merge-output-format", "mp4"] if ffmpeg else ["-f", "b"]
    height = int(option[1:])
    return ["-f", "bv*[height<=%d]+ba/b[height<=%d]/b" % (height, height),
            "-S", "res,vcodec:h264,acodec:aac", "--merge-output-format", "mp4"]


# ---------------------------------------------------------------- state

class Limiter:
    """Counts events per key inside a sliding window."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, key):
        now = time.time()
        with self.lock:
            hits = [t for t in self.hits.get(key, []) if now - t < self.window]
            if len(hits) >= self.limit:
                self.hits[key] = hits
                return False
            hits.append(now)
            self.hits[key] = hits
            return True


class Info:
    def __init__(self, url, path, title, duration, options):
        self.id = secrets.token_urlsafe(12)
        self.url, self.path, self.title, self.duration = url, path, title, duration
        self.options = {o["id"]: o for o in options}
        self.created = time.time()


class Job:
    def __init__(self, info, option, ip):
        self.id = secrets.token_urlsafe(12)
        self.info, self.option, self.ip = info, option, ip
        self.dir = os.path.join(WORK_DIR, "jobs", self.id)
        self.state = "queued"
        self.done = 0
        self.total = 0
        self.speed = 0
        self.eta = None
        self.file = None
        self.error = None
        self.finished_at = None
        self.proc = None

    def status(self):
        out = {"job": self.id, "state": self.state, "bytes": self.done, "total": self.total or None,
               "speed": self.speed or None, "eta": self.eta}
        if self.total:
            out["percent"] = round(min(100.0, self.done * 100.0 / self.total), 1)
        if self.state == "done":
            out["filename"] = os.path.basename(self.file)
            out["size"] = os.path.getsize(self.file)
        if self.error:
            out["error"] = self.error
        return out


INFOS = {}
JOBS = {}
STATE_LOCK = threading.Lock()
JOB_SLOTS = threading.BoundedSemaphore(MAX_JOBS)
INFO_LIMIT = Limiter(INFO_PER_IP, RATE_WINDOW)


def _num(token):
    try:
        return int(float(token))
    except (TypeError, ValueError):
        return 0


def safe_name(title, ext):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title or "video")
    name = re.sub(r"\s+", " ", name).strip(" .")[:120] or "video"
    return "%s.%s" % (name, ext)


def run_job(job):
    with JOB_SLOTS:
        if job.state == "canceled":
            return
        job.state = "downloading"
        os.makedirs(job.dir, exist_ok=True)
        ffmpeg = ffmpeg_path()
        cmd = ytdlp_base() + [
            "--load-info-json", job.info.path,
            "--no-playlist", "--newline", "--no-colors", "--no-warnings", "--no-quiet",
            "--restrict-filenames", "--no-part", "--encoding", "utf-8",
            "-o", os.path.join(job.dir, "file.%(ext)s"),
            "--progress-template", PROGRESS_TEMPLATE,
            "--print", "after_move:SIDM-FILE %(filepath)s",
            "--max-filesize", str(MAX_FILESIZE),
            "--retries", "5", "--fragment-retries", "10",
        ] + (["--ffmpeg-location", ffmpeg] if ffmpeg else []) + format_args(job.option, ffmpeg)
        log.info("job %s: %s %s", job.id, job.option, job.info.url)
        tail = []
        try:
            job.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, cwd=job.dir)
            killer = threading.Timer(JOB_TIMEOUT, job.proc.kill)
            killer.start()
            path = None
            for raw in job.proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                if line.startswith("SIDM "):
                    parts = line.split()
                    job.done, job.total = _num(parts[1]), _num(parts[2]) or job.total
                    job.speed, job.eta = _num(parts[3]), (_num(parts[4]) if parts[4] != "NA" else None)
                elif line.startswith("SIDM-FILE "):
                    path = line[len("SIDM-FILE "):].strip()
                elif "[ExtractAudio]" in line or "[Merger]" in line or "[FixupM3u8]" in line:
                    job.state = "converting"
                else:
                    tail = (tail + [line])[-40:]
            code = job.proc.wait()
            killer.cancel()
        except OSError as exc:
            code, tail = -1, [str(exc)]
        if job.state == "canceled":
            shutil.rmtree(job.dir, ignore_errors=True)
            return
        if code == 0 and path and os.path.isfile(path):
            job.file = path
            job.done = job.total = os.path.getsize(path)
            job.state = "done"
        elif code == 0 and not path:
            job.error = "This file is too big for the online downloader. Use the free SIDM extension for big files."
            job.state = "error"
        else:
            log.warning("job %s failed: %s", job.id, " | ".join(tail[-5:]))
            job.error = friendly_error("\n".join(tail))
            job.state = "error"
        job.finished_at = time.time()


def get_info(url):
    os.makedirs(os.path.join(WORK_DIR, "info"), exist_ok=True)
    cmd = ytdlp_base() + ["-J", "--no-playlist", "--no-warnings", "--no-colors", "--encoding", "utf-8", "--", url]
    try:
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=INFO_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Refusal("The site took too long to answer. Please try again.", 504)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")
        log.info("info failed for %s: %s", url, err.strip().splitlines()[-1:] or "")
        raise Refusal(friendly_error(err), 422)
    data = json.loads(proc.stdout.decode("utf-8", "replace"))
    if data.get("_type") == "playlist":
        entries = [e for e in data.get("entries") or [] if e]
        if not entries:
            raise Refusal("This link is a list with no videos in it.", 422)
        data = entries[0]
    if data.get("_has_drm") or any(f.get("has_drm") for f in data.get("formats") or []):
        raise Refusal("This video is DRM-protected. SIDM does not download DRM-protected content.", 451)
    duration = data.get("duration") or 0
    if MAX_DURATION and duration > MAX_DURATION:
        raise Refusal("This video is longer than %d hours, which is too long for the online downloader. "
                      "Use the free SIDM extension instead." % (MAX_DURATION // 3600), 413)
    options = build_options(data)
    if not options:
        raise Refusal("We found the page, but no video or sound in it.", 422)
    info = Info(url, "", data.get("title") or "video", duration, options)
    info.path = os.path.join(WORK_DIR, "info", info.id + ".json")
    with open(info.path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    with STATE_LOCK:
        INFOS[info.id] = info
    thumb = data.get("thumbnail")
    if not thumb:
        thumbs = [t for t in data.get("thumbnails") or [] if t.get("url")]
        thumb = thumbs[-1]["url"] if thumbs else None
    return {
        "info": info.id,
        "title": info.title,
        "thumbnail": thumb if thumb and thumb.startswith("https://") else None,
        "duration": duration or None,
        "uploader": data.get("uploader") or data.get("channel") or None,
        "site": data.get("extractor_key") if data.get("extractor_key") != "Generic" else None,
        "youtube": is_youtube(url),
        "options": options,
    }


def sweep():
    """Delete finished files and old link checks."""
    while True:
        time.sleep(60)
        now = time.time()
        with STATE_LOCK:
            for key, job in list(JOBS.items()):
                if job.finished_at and now - job.finished_at > KEEP_FILES:
                    shutil.rmtree(job.dir, ignore_errors=True)
                    del JOBS[key]
            for key, info in list(INFOS.items()):
                busy = any(j.info is info and not j.finished_at for j in JOBS.values())
                if now - info.created > KEEP_FILES * 2 and not busy:
                    try:
                        os.remove(info.path)
                    except OSError:
                        pass
                    del INFOS[key]


def auto_update():
    while True:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "-U", "-q", "yt-dlp[default]"],
                           capture_output=True, timeout=600)
            log.info("yt-dlp is %s", ytdlp_version())
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("yt-dlp update failed: %s", exc)
        time.sleep(24 * 3600)


# ---------------------------------------------------------------- HTTP

def origin_allowed(origin):
    if not origin:
        return False
    for allowed in ORIGINS:
        if allowed == "*" or allowed == origin:
            return True
        if "*." in allowed:
            scheme, _, pattern = allowed.partition("://*.")
            if origin.startswith(scheme + "://") and origin.endswith("." + pattern):
                return True
    return False


def content_disposition(name):
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, urllib.parse.quote(name))


class Handler(BaseHTTPRequestHandler):
    server_version = "SIDM-Online/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log.debug("%s %s", self.client_ip(), fmt % args)

    def client_ip(self):
        if TRUST_PROXY:
            ip = self.headers.get("CF-Connecting-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[0]
            if ip.strip():
                return ip.strip()
        return self.client_address[0]

    def cors(self):
        origin = self.headers.get("Origin")
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length")

    def send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 16 * 1024:
            raise Refusal("Request too large.", 413)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise Refusal("Bad request.")
        if not isinstance(body, dict):
            raise Refusal("Bad request.")
        return body

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def handle_errors(self, fn):
        try:
            fn()
        except Refusal as exc:
            self.send_json(exc.status, {"error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # noqa: BLE001 - never leak a traceback to the page
            log.exception("request failed: %s", self.path)
            self.send_json(500, {"error": "Something went wrong on our side. Please try again."})

    def do_GET(self):
        self.handle_errors(self._get)

    def do_POST(self):
        self.handle_errors(self._post)

    def do_DELETE(self):
        self.handle_errors(self._delete)

    def _job(self, job_id):
        with STATE_LOCK:
            job = JOBS.get(job_id)
        if not job:
            raise Refusal("This download has expired. Get the download links again.", 404)
        return job

    def _get(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        if path in ("/api/health", "/health", ""):
            self.send_json(200, {"ok": True, "version": VERSION, "ytdlp": ytdlp_version(),
                                 "ffmpeg": bool(ffmpeg_path())})
            return
        m = re.fullmatch(r"/api/jobs/([\w-]+)(/file)?", path)
        if not m:
            raise Refusal("Not found.", 404)
        job = self._job(m.group(1))
        if not m.group(2):
            self.send_json(200, job.status())
            return
        if job.state != "done":
            raise Refusal("This file isn't ready yet.", 409)
        ext = os.path.splitext(job.file)[1].lstrip(".") or "bin"
        name = safe_name(job.info.title, ext)
        size = os.path.getsize(job.file)
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", content_disposition(name))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(job.file, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile, 1024 * 1024)

    def _post(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        body = self.read_json()
        ip = self.client_ip()
        if path == "/api/info":
            if not INFO_LIMIT.allow(ip):
                raise Refusal("Too many links in a short time. Please wait a few minutes.", 429)
            url = clean_url(str(body.get("url") or ""))
            self.send_json(200, get_info(url))
            return
        if path == "/api/jobs":
            with STATE_LOCK:
                info = INFOS.get(str(body.get("info") or ""))
                running = sum(1 for j in JOBS.values() if j.ip == ip and not j.finished_at)
            if not info:
                raise Refusal("This link has expired. Get the download links again.", 404)
            option = str(body.get("option") or "")
            if option not in info.options:
                raise Refusal("That format isn't available for this video.")
            if running >= MAX_JOBS_PER_IP:
                raise Refusal("You already have %d downloads running. Wait for one to finish." % running, 429)
            job = Job(info, option, ip)
            with STATE_LOCK:
                JOBS[job.id] = job
            threading.Thread(target=run_job, args=(job,), daemon=True).start()
            self.send_json(202, job.status())
            return
        raise Refusal("Not found.", 404)

    def _delete(self):
        m = re.fullmatch(r"/api/jobs/([\w-]+)", urllib.parse.urlparse(self.path).path.rstrip("/"))
        if not m:
            raise Refusal("Not found.", 404)
        job = self._job(m.group(1))
        if not job.finished_at:
            job.state = "canceled"
            if job.proc and job.proc.poll() is None:
                job.proc.kill()
            job.finished_at = time.time()
        self.send_json(200, {"job": job.id, "state": job.state})


def main():
    logging.basicConfig(level=os.environ.get("SIDM_LOG", "INFO"),
                        format="%(asctime)s %(levelname)s %(message)s")
    shutil.rmtree(os.path.join(WORK_DIR, "jobs"), ignore_errors=True)
    os.makedirs(WORK_DIR, exist_ok=True)
    threading.Thread(target=sweep, daemon=True).start()
    if AUTO_UPDATE:
        threading.Thread(target=auto_update, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log.info("SIDM Online %s on port %d, yt-dlp %s, ffmpeg %s, origins %s",
             VERSION, PORT, ytdlp_version(), ffmpeg_path() or "missing", ", ".join(ORIGINS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
