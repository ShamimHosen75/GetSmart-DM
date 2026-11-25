#!/usr/bin/env python3
"""SIDM companion: native-messaging host ``com.sidm.host``.

Speaks the protocol defined in shared/protocol.md (v1) on stdin/stdout and runs
yt-dlp (plus ffmpeg for merging) to download videos. It also downloads files
over several HTTP connections at once (add_file).

Rules (see CLAUDE.md): Python 3 standard library only, logs to host.log next to
this file, never deletes user files (only its own partial files of a canceled or
failed job), no YouTube unless the extension says the user enabled it, no DRM.
"""

import collections
import importlib.util
import json
import logging
import logging.handlers
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse

VERSION = "0.5.2"
PROTOCOL_V = 1
HOST_NAME = "com.sidm.host"

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000 if IS_WIN else 0
INSTALLER = "install.bat" if IS_WIN else "install.sh"
UPDATER = "Update SIDM tools (Start menu) or update.bat" if IS_WIN else "install.sh"
DOWNLOADS_GUID = "{374DE290-123F-4565-9164-39C4925E51D8}"

PROGRESS_INTERVAL = 0.5  # seconds between progress messages per job
MAX_INCOMING = 64 * 1024 * 1024
QUALITIES = ("best", "1080", "720", "480", "360", "audio")

YOUTUBE_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com")
DRM_HOSTS = (
    "netflix.com", "primevideo.com", "disneyplus.com", "hulu.com", "max.com",
    "hbomax.com", "spotify.com", "tidal.com", "deezer.com", "peacocktv.com",
    "paramountplus.com", "tv.apple.com", "music.apple.com", "hotstar.com",
)

PROGRESS_TEMPLATE = (
    "download:GSDM %(progress.downloaded_bytes)s "
    "%(progress.total_bytes,progress.total_bytes_estimate)s "
    "%(progress.speed)s %(progress.eta)s"
)

log = logging.getLogger("gsdm")


def setup_logging():
    log.setLevel(logging.INFO)
    try:
        handler = logging.handlers.RotatingFileHandler(
            os.path.join(HERE, "host.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    except OSError:
        handler = logging.NullHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(message)s"))
    log.addHandler(handler)


# ---------------------------------------------------------------- transport

class Channel:
    """Native-messaging framing: 4-byte little-endian length + UTF-8 JSON."""

    def __init__(self, inp, out):
        self.inp = inp
        self.out = out
        self.lock = threading.Lock()

    def read(self):
        """Return the next message (dict), or None at EOF."""
        header = self.inp.read(4)
        if len(header) < 4:
            return None
        (length,) = struct.unpack("<I", header)
        if length > MAX_INCOMING:
            raise ValueError("message too large: %d bytes" % length)
        data = self.inp.read(length)
        if len(data) < length:
            return None
        return json.loads(data.decode("utf-8"))

    def send(self, msg):
        msg = dict(msg)
        msg["v"] = PROTOCOL_V
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        with self.lock:
            try:
                self.out.write(struct.pack("<I", len(data)))
                self.out.write(data)
                self.out.flush()
            except (OSError, ValueError):
                log.warning("could not write to browser (pipe closed): %s", msg.get("type"))


# ---------------------------------------------------------------- tools

def _run_quiet(cmd, timeout=20):
    return subprocess.run(
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        timeout=timeout, creationflags=CREATE_NO_WINDOW)


def find_binary(name):
    """Look next to host.py first, then on PATH."""
    local = os.path.join(HERE, name + (".exe" if IS_WIN else ""))
    if os.path.isfile(local):
        return local
    return shutil.which(name)


def tool_env():
    """Environment for yt-dlp: UTF-8 output, and the companion folder first on PATH so
    yt-dlp finds the Deno JavaScript runtime installed next to it (needed for YouTube)."""
    path = os.environ.get("PATH", "")
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1",
                PATH=HERE + (os.pathsep + path if path else ""))


def ytdlp_base():
    """Command prefix that runs yt-dlp, or None."""
    exe = find_binary("yt-dlp")
    if exe:
        return [exe]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


def ytdlp_version():
    base = ytdlp_base()
    if not base:
        return None
    try:
        out = _run_quiet(base + ["--version"]).stdout.decode("utf-8", "replace").strip()
        return out.splitlines()[-1].strip() if out else None
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("yt-dlp --version failed: %s", e)
        return None


VERSIONS_FILE = os.path.join(HERE, "versions.json")


def _stamp(path):
    try:
        st = os.stat(path)
        return [path, int(st.st_mtime), st.st_size]
    except (OSError, TypeError):
        return [path]


def tool_versions():
    """(yt-dlp version, ffmpeg version). Asking yt-dlp.exe takes seconds on Windows,
    so the answers are kept in versions.json until the tools' files change."""
    ytdlp = find_binary("yt-dlp")
    ffmpeg = find_binary("ffmpeg")
    key = [_stamp(ytdlp) if ytdlp else None, _stamp(ffmpeg) if ffmpeg else None]
    try:
        with open(VERSIONS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("key") == key and (saved.get("ytdlp") or not ytdlp):
            return saved.get("ytdlp"), saved.get("ffmpeg")
    except (OSError, ValueError, AttributeError):
        pass
    versions = (ytdlp_version(), ffmpeg_version(ffmpeg))
    try:
        with open(VERSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump({"key": key, "ytdlp": versions[0], "ffmpeg": versions[1]}, f)
    except OSError as e:
        log.warning("could not save %s: %s", VERSIONS_FILE, e)
    return versions


def ffmpeg_version(path):
    if not path:
        return None
    try:
        out = _run_quiet([path, "-version"]).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("ffmpeg -version failed: %s", e)
        return None
    m = re.search(r"ffmpeg version (\S+)", out)
    return m.group(1) if m else None


def downloads_folder():
    if IS_WIN:
        try:
            import winreg
            key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
                value, _ = winreg.QueryValueEx(k, DOWNLOADS_GUID)
                if value:
                    return os.path.expandvars(value)
        except OSError as e:
            log.warning("could not read Downloads folder from registry: %s", e)
    elif sys.platform.startswith("linux"):
        xdg = xdg_download_dir()
        if xdg:
            return xdg
    return os.path.join(os.path.expanduser("~"), "Downloads")


def xdg_download_dir():
    """XDG_DOWNLOAD_DIR from user-dirs.dirs (Linux desktops may name it e.g. "Téléchargements")."""
    home = os.path.expanduser("~")
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    try:
        with open(os.path.join(config, "user-dirs.dirs"), encoding="utf-8") as f:
            for line in f:
                m = re.match(r'\s*XDG_DOWNLOAD_DIR\s*=\s*"(.*)"\s*$', line)
                if m:
                    value = m.group(1).replace("$HOME", home)
                    if os.path.isabs(value) and os.path.normpath(value) != os.path.normpath(home):
                        return value
    except OSError:
        pass
    return None


def default_dir():
    return os.path.join(downloads_folder(), "SIDM", "Video")


# ---------------------------------------------------------------- policy

def _host_matches(host, domains):
    host = (host or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in domains)


def policy_error(url, youtube_allowed):
    """Return a user-facing refusal message, or None if the URL may be tried."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return "This link is not valid."
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "This link is not valid. Only http and https links can be downloaded."
    if _host_matches(parsed.hostname, DRM_HOSTS):
        return "This site uses DRM protection. SIDM does not download DRM-protected content."
    if _host_matches(parsed.hostname, YOUTUBE_HOSTS) and youtube_allowed is not True:
        return "YouTube downloads are off. You can turn them on in Settings after reading the Terms of Service warning."
    return None


ERROR_RULES = (
    (re.compile(r"confirm you.?re not a bot|not a robot", re.I),
     "YouTube asked to confirm you are not a bot. Wait a few minutes and try again, or open the video in "
     "the browser first."),
    (re.compile(r"JavaScript runtime|JS runtime|n challenge|nsig|signature extraction failed|"
                r"Requested format is not available|Only images are available", re.I),
     "YouTube needs a newer yt-dlp or the Deno helper. Run " + UPDATER + ", then try again."),
    (re.compile(r"\bDRM\b", re.I),
     "This video is DRM-protected. SIDM does not download DRM-protected content."),
    (re.compile(r"private|log ?in|sign ?in|cookies|registered users|members only|"
                r"authentication|requires? (an )?account|age.restricted|not available in your country", re.I),
     "This video is private or needs you to log in, so it cannot be downloaded."),
    (re.compile(r"Unsupported URL|no suitable (info)?extractor", re.I),
     "This site or link is not supported."),
    (re.compile(r"HTTP Error 404|404:? Not Found|\b404\b", re.I),
     "Video not found (404). The link may be broken or the post was deleted."),
    (re.compile(r"ffmpeg|ffprobe", re.I),
     "ffmpeg is missing or failed. Run " + INSTALLER + " in the companion folder again."),
    (re.compile(r"Unable to download webpage|urlopen error|getaddrinfo|Name or service not known|"
                r"timed? ?out|Connection (refused|reset|aborted)|Network is unreachable|"
                r"No route to host|Temporary failure in name resolution|SSL|ConnectionError|"
                r"RemoteDisconnected|IncompleteRead", re.I),
     "Network error. Check your internet connection and try again."),
)


def friendly_error(lines):
    errors = [ln for ln in lines if ln.startswith("ERROR:")]
    haystack = "\n".join(errors) if errors else "\n".join(lines)
    for pattern, message in ERROR_RULES:
        if pattern.search(haystack):
            return message
    for ln in reversed(errors or lines):
        if ln.strip():
            text = ln.strip()
            if text.startswith("ERROR:"):
                text = text[len("ERROR:"):].strip()
            return text[:300]
    return "The download failed for an unknown reason. See host.log."


# ---------------------------------------------------------------- jobs

def format_args(quality, ffmpeg):
    """Return (yt-dlp args, note) for a quality and ffmpeg path (or None)."""
    if quality == "audio":
        if ffmpeg:
            return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--ffmpeg-location", ffmpeg], None
        return ["-f", "ba/b"], ("ffmpeg was not found, so the audio was saved in its original "
                                "format instead of MP3. Run " + INSTALLER + " to fix this.")
    if ffmpeg:
        fmt = "bv*+ba/b" if quality == "best" else "bv*[height<={0}]+ba/b[height<={0}]/b".format(quality)
        return ["-f", fmt, "--merge-output-format", "mp4", "--ffmpeg-location", ffmpeg], None
    fmt = "b" if quality == "best" else "b[height<={0}]/b".format(quality)
    return ["-f", fmt], ("ffmpeg was not found, so a single file with video and sound was "
                         "downloaded; quality may be lower. Run " + INSTALLER + " to fix this.")


def build_command(base, url, quality, outdir, ffmpeg):
    fmt_args, note = format_args(quality, ffmpeg)
    cmd = list(base) + [
        "--no-playlist", "--newline", "--no-colors", "--no-warnings", "--no-quiet",
        "--windows-filenames", "--encoding", "utf-8",
        "-o", os.path.join(outdir, "%(title).150B [%(id)s].%(ext)s"),
        "--progress-template", PROGRESS_TEMPLATE,
        "--print", "after_move:GSDM-FILE %(filepath)s",
        "--retries", "5", "--fragment-retries", "10",
    ] + fmt_args + ["--", url]
    return cmd, note


def _num(token):
    if token in (None, "", "NA", "None"):
        return None
    try:
        return int(float(token))
    except ValueError:
        return None


RE_DEST = re.compile(r"^\[(?:download|ExtractAudio)\] Destination: (.+)$")
RE_MERGE = re.compile(r'^\[Merger\] Merging formats into "(.+)"$')
RE_INTERMEDIATE = re.compile(r"\.(f[0-9A-Za-z_-]+|temp)\.[0-9A-Za-z]+$")


class Job:
    def __init__(self, host, msg):
        self.host = host
        self.id = msg["id"]
        self.url = msg["url"]
        self.quality = msg["quality"]
        self.dir = msg.get("dir") or default_dir()
        self.youtube = msg.get("youtube")
        self.proc = None
        self.canceled = False
        self.lock = threading.Lock()
        self.started = time.time()
        self.paths = []          # files yt-dlp said it is writing for this job
        self.final_path = None
        self.lines = collections.deque(maxlen=200)
        self.thread = threading.Thread(target=self.run, name="job-" + str(self.id)[:16], daemon=True)

    def progress(self, state, **fields):
        msg = {"type": "progress", "id": self.id, "state": state}
        msg.update({k: v for k, v in fields.items() if v is not None})
        self.host.channel.send(msg)

    # -- lifecycle

    def run(self):
        try:
            self._run()
        except Exception as e:  # never let a job kill the host
            log.exception("job %s crashed", self.id)
            self._cleanup()
            self.progress("error", error="Internal error in the companion: %s" % e)
        finally:
            self.host.job_finished(self)

    def _run(self):
        refusal = policy_error(self.url, self.youtube)
        if refusal:
            log.info("job %s refused: %s (%s)", self.id, refusal, self.url)
            self.progress("error", error=refusal)
            return
        base = ytdlp_base()
        if not base:
            log.error("job %s: yt-dlp not found", self.id)
            self.progress("error", error="yt-dlp is missing. Run " + INSTALLER + " in the companion folder.")
            return
        ffmpeg = find_binary("ffmpeg")
        cmd, note = build_command(base, self.url, self.quality, self.dir, ffmpeg)
        log.info("job %s start: %s", self.id, subprocess.list2cmdline(cmd))

        env = tool_env()
        with self.lock:
            if self.canceled:
                self.progress("canceled")
                return
            self.proc = subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                env=env, creationflags=CREATE_NO_WINDOW, start_new_session=not IS_WIN)
            if CHILD_JOB is not None:
                CHILD_JOB.add(self.proc)
        self.progress("running", note=note)

        last_sent = 0.0
        filename = None
        for raw in iter(self.proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("GSDM "):
                parts = line.split(" ")
                if len(parts) < 5 or _num(parts[1]) is None:
                    continue  # the final "finished" line reports NA
                now = time.monotonic()
                if now - last_sent < PROGRESS_INTERVAL:
                    continue
                last_sent = now
                self.progress("running", downloaded=_num(parts[1]), total=_num(parts[2]),
                              speed=_num(parts[3]), eta=_num(parts[4]), filename=filename)
                continue
            if line.startswith("GSDM-FILE "):
                self.final_path = line[len("GSDM-FILE "):].strip()
                continue
            if line.strip():
                self.lines.append(line)
            m = RE_DEST.match(line) or RE_MERGE.match(line)
            if m:
                path = m.group(1).strip()
                self.paths.append(path)
                filename = os.path.basename(path)
        rc = self.proc.wait()
        tail = "\n".join(self.lines)[-500:]
        log.info("job %s end: rc=%s canceled=%s file=%s\n%s", self.id, rc, self.canceled, self.final_path, tail)

        if self.canceled:
            self._cleanup()
            self.progress("canceled")
        elif rc == 0 and self.final_path and os.path.isfile(self.final_path):
            size = os.path.getsize(self.final_path)
            self.progress("done", filename=self.final_path, downloaded=size, total=size, note=note)
        else:
            message = friendly_error(list(self.lines))
            if rc == 0:
                message = "The download finished but the output file was not found."
            log.error("job %s error: %s", self.id, message)
            self._cleanup()
            self.progress("error", error=message)

    def cancel(self):
        with self.lock:
            self.canceled = True
            proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        log.info("job %s: canceling pid %s", self.id, proc.pid)
        try:
            if IS_WIN:
                # /T also stops ffmpeg started by yt-dlp.
                _run_quiet(["taskkill", "/PID", str(proc.pid), "/T", "/F"], timeout=15)
            else:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(3)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
        except (OSError, subprocess.SubprocessError) as e:
            log.warning("job %s: kill failed (%s), falling back to proc.kill", self.id, e)
            try:
                proc.kill()
            except OSError:
                pass

    # -- cleanup of our own partial files only

    def _cleanup(self):
        outdir = os.path.realpath(self.dir)
        candidates = set()
        for path in self.paths:
            candidates.update([path + ".part", path + ".ytdl"])
            if RE_INTERMEDIATE.search(path):
                candidates.add(path)  # format part that was going to be merged
            root, ext = os.path.splitext(path)
            candidates.add(root + ".temp" + ext)  # merger output in progress
            folder = os.path.dirname(path) or "."
            base = os.path.basename(path)
            try:
                for name in os.listdir(folder):
                    if name.startswith(base + ".part-Frag"):
                        candidates.add(os.path.join(folder, name))
            except OSError:
                pass
        for path in sorted(candidates):
            real = os.path.realpath(path)
            if os.path.dirname(real) != outdir or not os.path.isfile(real):
                continue
            try:
                if os.path.getmtime(real) < self.started - 2:
                    continue  # older than this job: not ours
            except OSError:
                continue
            for attempt in range(5):
                try:
                    os.remove(real)
                    log.info("job %s: removed partial file %s", self.id, real)
                    break
                except OSError as e:
                    if attempt == 4:
                        log.warning("job %s: could not remove %s: %s", self.id, real, e)
                    time.sleep(0.5)


# ---------------------------------------------------------------- Windows job object

class KillOnExitJob:
    """Windows Job Object with KILL_ON_JOB_CLOSE.

    yt-dlp (and the ffmpeg it starts, which inherits the job) is stopped by
    Windows as soon as the host process ends, even if the host is killed from
    Task Manager, so no download keeps running without a companion.
    Does nothing on other systems, where cancel/shutdown kill the process group.
    """

    def __init__(self):
        self.handle = None
        if not IS_WIN:
            return
        try:
            import ctypes
            from ctypes import wintypes

            class Basic(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class IoCounters(ctypes.Structure):
                _fields_ = [(name, ctypes.c_uint64) for name in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class Extended(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IoCounters),
                            ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
            k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
            k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
            job = k32.CreateJobObjectW(None, None)
            if not job:
                raise ctypes.WinError(ctypes.get_last_error())
            info = Extended()
            info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            self.k32, self.handle = k32, job
        except Exception as e:  # never fatal: cancel still works through taskkill
            log.warning("could not create the Windows job object: %s", e)

    def add(self, proc):
        if self.handle is None:
            return
        try:
            if not self.k32.AssignProcessToJobObject(self.handle, int(proc._handle)):
                log.warning("could not add pid %s to the job object", proc.pid)
        except Exception as e:
            log.warning("could not add pid %s to the job object: %s", proc.pid, e)


CHILD_JOB = None  # KillOnExitJob, created in main()


# ---------------------------------------------------------------- video_info, pick_folder

VIDEO_FEATURES = ["video_info", "pick_folder"]
INFO_TIMEOUT = 60
FOLDERS_FILE = os.path.join(HERE, "folders.json")
MAX_FOLDERS = 20
# yt-dlp prefers these codecs, best first (its default format sorting).
VCODEC_RANK = (("av01", 6), ("vp09", 5), ("vp9", 5), ("hev1", 4), ("hvc1", 4), ("h265", 4),
               ("avc1", 3), ("h264", 3), ("vp8", 2))


def _format_size(f, duration):
    size = f.get("filesize") or f.get("filesize_approx")
    if not size and f.get("tbr") and duration:
        size = f["tbr"] * 1000 / 8 * duration
    return int(size) if size else None


def _has_video(f):
    return f.get("vcodec") not in (None, "none") and (f.get("height") or 0) > 0


def _has_audio(f):
    return f.get("acodec") not in (None, "none")


def _codec_rank(f):
    codec = (f.get("vcodec") or "").lower()
    return next((rank for prefix, rank in VCODEC_RANK if codec.startswith(prefix)), 1)


def sizes_from_info(info):
    """Estimated bytes per add_video quality, picked the way format_args() asks yt-dlp."""
    duration = info.get("duration")
    formats = [f for f in info.get("formats") or [] if f.get("ext") != "mhtml" and _format_size(f, duration)]
    if not formats and _format_size(info, duration):
        formats = [info]  # a single-file video
    videos = [f for f in formats if _has_video(f)]
    audios = [f for f in formats if _has_audio(f) and not _has_video(f)]
    best_audio = max(audios, key=lambda f: (f.get("abr") or f.get("tbr") or 0), default=None)
    audio_size = _format_size(best_audio, duration) if best_audio else 0
    sizes = {}
    for quality in QUALITIES:
        if quality == "audio":
            if best_audio:
                sizes["audio"] = audio_size
            continue
        limit = None if quality == "best" else int(quality)
        fits = [f for f in videos if limit is None or (f.get("height") or 0) <= limit]
        if not fits:
            continue
        video = max(fits, key=lambda f: (f.get("height") or 0, f.get("fps") or 0, _codec_rank(f), f.get("tbr") or 0))
        sizes[quality] = _format_size(video, duration) + (0 if _has_audio(video) else audio_size)
    out = {"sizes": sizes}
    heights = [f.get("height") for f in videos if f.get("height")]
    if heights:
        out["max_height"] = max(heights)
    if info.get("title"):
        out["title"] = str(info["title"])[:300]
    if info.get("duration"):
        out["duration"] = int(info["duration"])
    return out


def video_info(url, youtube):
    """What a page offers: {"sizes": {...}, "max_height", "title", "duration"} or {"error"}."""
    refusal = policy_error(url, youtube)
    if refusal:
        return {"error": refusal}
    base = ytdlp_base()
    if not base:
        return {"error": "yt-dlp is missing. Run " + INSTALLER + " in the companion folder."}
    cmd = list(base) + ["-J", "--no-playlist", "--no-warnings", "--no-colors", "--encoding", "utf-8", "--", url]
    env = tool_env()
    try:
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=INFO_TIMEOUT, env=env, creationflags=CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired:
        return {"error": "The site took too long to answer."}
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").splitlines()
        return {"error": friendly_error(lines)}
    return sizes_from_info(json.loads(proc.stdout.decode("utf-8", "replace")))


class NoDialog(Exception):
    pass


# Windows: the Explorer-style "Select folder" dialog (IFileOpenDialog with
# FOS_PICKFOLDERS), shown on top of the browser. Falls back to the older
# FolderBrowserDialog if the C# part cannot be compiled.
WIN_PICKER = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class SidmFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogClass {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, out IShellItem item);
  public static string Pick(IntPtr owner, string title, string start) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogClass();
    dialog.SetOptions(0x20 | 0x40 | 0x800); // pick folders, file system only, path must exist
    if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!String.IsNullOrEmpty(start)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      } catch (Exception) { }
    }
    if (dialog.Show(owner) != 0) return null; // canceled
    IShellItem result;
    dialog.GetResult(out result);
    IntPtr name;
    result.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
    string path = Marshal.PtrToStringUni(name);
    Marshal.FreeCoTaskMem(name);
    return path;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$path = $null
try {
  Add-Type -TypeDefinition $cs -Language CSharp
  $path = [SidmFolderPicker]::Pick($owner.Handle, $env:SIDM_TITLE, $env:SIDM_START)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $env:SIDM_TITLE
  $d.ShowNewFolderButton = $true
  if ($env:SIDM_START) { $d.SelectedPath = $env:SIDM_START }
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $d.SelectedPath }
}
$owner.Close()
if ($path) { [Console]::Out.Write($path) }
"""


def _encoded_powershell(script):
    import base64
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def pick_folder_dialog(title, start):
    """Show the system's folder dialog. Returns the chosen path, or None if canceled."""
    env = dict(os.environ, SIDM_TITLE=title, SIDM_START=start or "")
    if IS_WIN:
        cmd = ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
               "-EncodedCommand", _encoded_powershell(WIN_PICKER)]
    elif sys.platform == "darwin":
        script = ('set p to POSIX path of (choose folder with prompt (system attribute "SIDM_TITLE")'
                  ' default location POSIX file (system attribute "SIDM_START"))\nreturn p')
        cmd = ["osascript", "-e", 'tell application "System Events" to activate', "-e", script]
    elif shutil.which("zenity"):
        cmd = ["zenity", "--file-selection", "--directory", "--title", title, "--filename", (start or "") + os.sep]
    elif shutil.which("kdialog"):
        cmd = ["kdialog", "--getexistingdirectory", start or os.path.expanduser("~"), "--title", title]
    else:
        raise NoDialog()
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, creationflags=CREATE_NO_WINDOW)
    path = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not path:
        if proc.stderr:
            log.info("folder dialog: %s", proc.stderr.decode("utf-8", "replace").strip()[:300])
        return None
    if len(path) > 3:  # keep "C:\\" and "/" as they are
        path = path.rstrip("/\\") or path
    return path if os.path.isdir(path) else None


def chosen_folders():
    try:
        with open(FOLDERS_FILE, encoding="utf-8") as f:
            folders = json.load(f)
        return [p for p in folders if isinstance(p, str)]
    except (OSError, ValueError):
        return []


def remember_folder(path):
    folders = [path] + [p for p in chosen_folders() if p != path]
    try:
        with open(FOLDERS_FILE, "w", encoding="utf-8") as f:
            json.dump(folders[:MAX_FOLDERS], f)
    except OSError as e:
        log.warning("could not save %s: %s", FOLDERS_FILE, e)


# ---------------------------------------------------------------- host

class Host:
    def __init__(self, channel):
        self.channel = channel
        self.jobs = {}
        self.lock = threading.Lock()

    def job_finished(self, job):
        with self.lock:
            if self.jobs.get(job.id) is job:
                del self.jobs[job.id]

    def handle(self, msg):
        if not isinstance(msg, dict):
            log.warning("ignoring non-object message")
            return
        mtype = msg.get("type")
        if msg.get("v") != PROTOCOL_V:
            log.warning("unsupported protocol version %r in %r", msg.get("v"), mtype)
            if msg.get("id") is not None:
                self.channel.send({"type": "progress", "id": msg["id"], "state": "error",
                                   "error": "Protocol version mismatch. Update the extension and the companion."})
            return
        if mtype == "hello":
            self.on_hello()
        elif mtype == "ping":
            self.channel.send({"type": "pong"})
        elif mtype == "add_video":
            self.on_add_video(msg)
        elif mtype == "cancel":
            self.on_cancel(msg)
        elif mtype == "add_file":
            self.on_add_file(msg)
        elif mtype == "pause_file":
            self.on_pause_file(msg)
        elif mtype == "set_speed_limit":
            self.on_speed_limit(msg)
        elif mtype == "open_file":
            open_path(msg.get("path"), bool(msg.get("reveal")))
        elif mtype == "video_info":
            self.on_video_info(msg)
        elif mtype == "pick_folder":
            self.on_pick_folder(msg)
        else:
            log.warning("ignoring unknown message type %r", mtype)

    def on_hello(self):
        ytdlp, ffmpeg = tool_versions()
        reply = {"type": "hello", "version": VERSION, "ytdlp": ytdlp,
                 "ffmpeg": ffmpeg, "dir": default_dir(),
                 "downloads": downloads_folder(), "features": FILE_FEATURES + VIDEO_FEATURES,
                 "js_runtime": bool(find_binary("deno"))}
        log.info("hello: %s", reply)
        self.channel.send(reply)

    def on_add_video(self, msg):
        job_id = msg.get("id")
        if not isinstance(job_id, str) or not job_id:
            log.warning("add_video without a valid id: %r", msg)
            return
        url, quality = msg.get("url"), msg.get("quality")
        if not isinstance(url, str) or quality not in QUALITIES:
            self.channel.send({"type": "progress", "id": job_id, "state": "error",
                               "error": "Invalid request (url or quality missing)."})
            return
        target = msg.get("dir")
        if target is not None and not isinstance(target, str):
            msg = dict(msg, dir=None)
        elif target and not (os.path.isabs(target) and os.path.isdir(target)):
            self.channel.send({"type": "progress", "id": job_id, "state": "error",
                               "error": "The folder %s does not exist." % target})
            return
        with self.lock:
            if job_id in self.jobs:
                log.warning("add_video: id %s is already running, ignored", job_id)
                return
            job = Job(self, msg)
            self.jobs[job_id] = job
        job.thread.start()

    def on_video_info(self, msg):
        req_id = msg.get("id")
        url = msg.get("url")
        if not isinstance(req_id, str) or not req_id or not isinstance(url, str):
            log.warning("video_info without id or url: %r", msg)
            return
        threading.Thread(target=self._video_info, args=(req_id, url, msg.get("youtube")),
                         name="info-" + req_id[:16], daemon=True).start()

    def _video_info(self, req_id, url, youtube):
        reply = {"type": "video_info", "id": req_id}
        try:
            reply.update(video_info(url, youtube))
        except Exception as e:  # never let a request kill the host
            log.exception("video_info %s failed", req_id)
            reply["error"] = "Could not read the video page: %s" % e
        self.channel.send(reply)

    def on_pick_folder(self, msg):
        req_id = msg.get("id")
        if not isinstance(req_id, str) or not req_id:
            log.warning("pick_folder without id: %r", msg)
            return
        title = msg.get("title") if isinstance(msg.get("title"), str) else "Choose a folder"
        start = msg.get("start") if isinstance(msg.get("start"), str) else ""
        threading.Thread(target=self._pick_folder, args=(req_id, title[:200], start),
                         name="folder-" + req_id[:16], daemon=True).start()

    def _pick_folder(self, req_id, title, start):
        reply = {"type": "folder", "id": req_id, "path": None}
        try:
            path = pick_folder_dialog(title, start if os.path.isdir(start) else default_dir())
            if path:
                reply["path"] = path
                remember_folder(path)
        except NoDialog:
            reply["error"] = "no_dialog"
        except Exception:
            log.exception("pick_folder %s failed", req_id)
            reply["error"] = "no_dialog"
        log.info("pick_folder %s -> %s", req_id, reply.get("path") or reply.get("error") or "canceled")
        self.channel.send(reply)

    def on_cancel(self, msg):
        with self.lock:
            job = self.jobs.get(msg.get("id"))
        if job is None:
            log.info("cancel: no running job %r", msg.get("id"))
            if msg.get("filename"):
                cancel_paused_file(msg)
                self.channel.send({"type": "progress", "id": msg.get("id"), "state": "canceled"})
            return
        job.cancel()

    def on_add_file(self, msg):
        job_id = msg.get("id")
        if not isinstance(job_id, str) or not job_id:
            log.warning("add_file without a valid id: %r", msg)
            return
        if not isinstance(msg.get("url"), str):
            self.channel.send({"type": "progress", "id": job_id, "state": "error", "error_code": "bad_request",
                               "error": "Invalid request (url missing)."})
            return
        with self.lock:
            if job_id in self.jobs:
                log.warning("add_file: id %s is already running, ignored", job_id)
                return
            job = FileJob(self, msg)
            self.jobs[job_id] = job
        job.thread.start()

    def on_pause_file(self, msg):
        with self.lock:
            job = self.jobs.get(msg.get("id"))
        if isinstance(job, FileJob):
            job.pause()

    def on_speed_limit(self, msg):
        limit = msg.get("limit") if isinstance(msg.get("limit"), int) else 0
        if msg.get("id") is None:
            GLOBAL_LIMIT.set(limit)
            log.info("speed limit for all files: %s B/s", limit)
            return
        with self.lock:
            job = self.jobs.get(msg.get("id"))
        if isinstance(job, FileJob):
            job.limiter.set(limit)

    def shutdown(self):
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            # Files keep their partial data so the extension can resume them later.
            if isinstance(job, FileJob):
                job.pause()
            else:
                job.cancel()
        for job in jobs:
            job.thread.join(10)


# ---------------------------------------------------------------- file downloads (add_file)
#
# Multi-connection downloads with HTTP Range requests. The file is written to
# "<name>.gsdmpart" (pre-sized, each connection writes at its own offset) and
# its parts are saved to "<name>.gsdmpart.json", so a paused or interrupted
# download continues where it stopped. When a connection finishes its part, it
# takes over half of the largest part still left, so all connections stay busy
# until the end.

FILE_FEATURES = ["files"]
PART_SUFFIX = ".gsdmpart"
STATE_SUFFIX = ".gsdmpart.json"
MAX_CONNECTIONS = 16
DEFAULT_CONNECTIONS = 8
MIN_PART = 512 * 1024           # never split below this
CHUNK = 64 * 1024
REQUEST_TIMEOUT = 30
RETRIES = 5
STATE_SAVE_INTERVAL = 2.0
ALLOWED_HEADERS = ("Referer", "User-Agent", "Accept-Language")
WIN_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", re.I)


class FileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class RateLimiter:
    """Token bucket shared by connections. rate 0 = no limit."""

    def __init__(self, rate=0):
        self.lock = threading.Lock()
        self.rate = 0
        self.tokens = 0.0
        self.stamp = time.monotonic()
        self.set(rate)

    def set(self, rate):
        with self.lock:
            self.rate = max(0, int(rate or 0))
            self.tokens = min(self.tokens, float(self.rate))
            self.stamp = time.monotonic()

    def take(self, n):
        while True:
            with self.lock:
                if self.rate <= 0:
                    return
                now = time.monotonic()
                self.tokens = min(float(self.rate), self.tokens + (now - self.stamp) * self.rate)
                self.stamp = now
                if self.tokens >= n or self.tokens >= self.rate:
                    self.tokens -= n
                    return
                wait = (min(n, self.rate) - self.tokens) / self.rate
            time.sleep(min(wait, 0.5))


GLOBAL_LIMIT = RateLimiter()


def safe_filename(name):
    """A file name that is valid on Windows, macOS and Linux (max 150 characters)."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or "")).strip().rstrip(". ")
    if not name:
        name = "download"
    if WIN_RESERVED.match(name):
        name = "_" + name
    if len(name) > 150:
        root, ext = os.path.splitext(name)
        ext = ext if len(ext) <= 16 else ""
        name = root[:150 - len(ext)] + ext
    return name


def name_from_disposition(value):
    if not value:
        return None
    m = re.search(r"filename\*\s*=\s*([^']*)'[^']*'([^;]+)", value, re.I)
    if m:
        from urllib.parse import unquote
        try:
            return unquote(m.group(2).strip().strip('"'), encoding=m.group(1) or "utf-8")
        except LookupError:
            return unquote(m.group(2).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"([^"]*)"', value, re.I) or re.search(r"filename\s*=\s*([^;]+)", value, re.I)
    return m.group(1).strip() if m else None


def name_from_url(url):
    from urllib.parse import unquote
    path = urlparse(url).path
    return unquote(path.rsplit("/", 1)[-1]) if path else ""


def resolve_folder(folder):
    """Absolute folder for an add_file `folder` (relative to Downloads), or raise."""
    root = os.path.realpath(downloads_folder())
    if not folder:
        return root
    if not isinstance(folder, str) or os.path.isabs(folder) or re.match(r"^[A-Za-z]:", folder):
        raise FileError("bad_request", "The folder must be relative to the Downloads folder.")
    parts = [p for p in re.split(r"[\\/]+", folder) if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise FileError("bad_request", "The folder must stay inside the Downloads folder.")
    path = os.path.realpath(os.path.join(root, *[safe_filename(p) for p in parts]))
    if path != root and not path.startswith(root + os.sep):
        raise FileError("bad_request", "The folder must stay inside the Downloads folder.")
    return path


def unique_path(path):
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    n = 1
    while os.path.exists("%s (%d)%s" % (root, n, ext)):
        n += 1
    return "%s (%d)%s" % (root, n, ext)


def http_request(url, headers, start=None, end=None):
    import urllib.request
    req = urllib.request.Request(url, headers=dict(headers))
    req.add_header("Accept-Encoding", "identity")  # byte ranges of the real file
    if start is not None:
        req.add_header("Range", "bytes=%d-%s" % (start, "" if end is None else end))
    return urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT)


def probe(url, headers):
    """Ask for byte 0. Returns (total, final_url, filename, validator) or raises FileError."""
    import urllib.error
    try:
        with http_request(url, headers, 0, 0) as res:
            status = res.status
            content_range = res.headers.get("Content-Range") or ""
            disposition = res.headers.get("Content-Disposition")
            validator = res.headers.get("ETag") or res.headers.get("Last-Modified") or ""
            final_url = res.geturl()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 407):
            raise FileError("auth", "The server asked for a login (HTTP %d)." % e.code)
        if e.code == 416:
            raise FileError("no_range", "The server cannot send parts of this file.")
        raise FileError("http", "The server answered HTTP %d." % e.code)
    except (OSError, ValueError) as e:
        raise FileError("network", "Could not reach the server: %s" % getattr(e, "reason", e))
    m = re.match(r"bytes\s+0-0/(\d+)", content_range)
    if status != 206 or not m:
        raise FileError("no_range", "The server cannot send parts of this file.")
    name = name_from_disposition(disposition) or name_from_url(final_url) or name_from_url(url)
    return int(m.group(1)), final_url, name, validator


class Part:
    __slots__ = ("start", "end", "pos", "busy")

    def __init__(self, start, end, pos=None):
        self.start, self.end = start, end
        self.pos = start if pos is None else pos
        self.busy = False

    def left(self):
        return self.end - self.pos + 1


class FileJob:
    """One add_file download. Thread-safe; runs in its own thread."""

    def __init__(self, host, msg):
        self.host = host
        self.id = msg["id"]
        self.url = msg["url"]
        self.filename = msg.get("filename")
        self.folder = msg.get("folder")
        connections = msg.get("connections") or DEFAULT_CONNECTIONS
        self.connections = max(1, min(MAX_CONNECTIONS, int(connections) if isinstance(connections, int) else DEFAULT_CONNECTIONS))
        headers = msg.get("headers") if isinstance(msg.get("headers"), dict) else {}
        self.headers = {k: str(v) for k, v in headers.items() if k in ALLOWED_HEADERS and v}
        self.headers.setdefault("User-Agent", "Mozilla/5.0 SIDM/" + VERSION)
        self.limiter = RateLimiter(msg.get("speed_limit") or 0)
        self.lock = threading.Lock()
        self.stop = None              # None, "pause" or "cancel"
        self.parts = []
        self.total = 0
        self.final = None             # final path (target name before the rename)
        self.part_path = None
        self.validator = ""
        self.active = 0
        self.errors = []
        self.samples = collections.deque(maxlen=12)
        self.thread = threading.Thread(target=self.run, name="file-" + str(self.id)[:16], daemon=True)

    # -- messages

    def progress(self, state, **fields):
        msg = {"type": "progress", "id": self.id, "state": state}
        msg.update({k: v for k, v in fields.items() if v is not None})
        self.host.channel.send(msg)

    def done_bytes(self):
        return sum(p.pos - p.start for p in self.parts)

    def snapshot(self):
        with self.lock:
            parts = sorted(self.parts, key=lambda p: p.start)
            segs = [[p.start, p.end, p.pos - p.start] for p in parts]
            active = self.active
        if len(segs) > 32:  # merge neighbours so the message stays small
            step = (len(segs) + 31) // 32
            segs = [[g[0][0], g[-1][1], sum(s[2] for s in g)] for g in (segs[i:i + step] for i in range(0, len(segs), step))]
        return segs, active

    def speed(self):
        now = time.monotonic()
        self.samples.append((now, self.done_bytes()))
        while len(self.samples) > 2 and now - self.samples[0][0] > 5:
            self.samples.popleft()
        (t0, b0), (t1, b1) = self.samples[0], self.samples[-1]
        return int((b1 - b0) / (t1 - t0)) if t1 - t0 >= 0.5 else None

    # -- state file

    def save_state(self):
        with self.lock:
            data = {"id": self.id, "url": self.url, "total": self.total, "validator": self.validator,
                    "parts": [[p.start, p.end, p.pos] for p in self.parts]}
        tmp = self.part_path + ".json.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.part_path[:-len(PART_SUFFIX)] + STATE_SUFFIX)
        except OSError as e:
            log.warning("file %s: could not save state: %s", self.id, e)

    def load_state(self):
        try:
            with open(self.final + STATE_SUFFIX, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return False
        if data.get("url") != self.url or data.get("total") != self.total or data.get("validator") != self.validator:
            log.info("file %s: saved state does not match the server file, starting over", self.id)
            return False
        if not os.path.isfile(self.part_path) or os.path.getsize(self.part_path) != self.total:
            return False
        self.parts = [Part(s, e, p) for s, e, p in data.get("parts", []) if s <= p <= e + 1]
        return bool(self.parts)

    def remove_own_files(self):
        for path in (self.part_path, self.final + STATE_SUFFIX if self.final else None):
            if path and os.path.isfile(path):
                try:
                    os.remove(path)
                    log.info("file %s: removed partial file %s", self.id, path)
                except OSError as e:
                    log.warning("file %s: could not remove %s: %s", self.id, path, e)

    # -- lifecycle

    def run(self):
        try:
            self._run()
        except FileError as e:
            log.info("file %s error (%s): %s", self.id, e.code, e)
            self.progress("error", error=str(e), error_code=e.code, filename=self.final)
        except Exception as e:  # never let a job kill the host
            log.exception("file %s crashed", self.id)
            self.progress("error", error="Internal error in the companion: %s" % e, error_code="network")
        finally:
            self.host.job_finished(self)

    def _run(self):
        if urlparse(self.url).scheme not in ("http", "https"):
            raise FileError("bad_request", "Only http and https links can be downloaded.")
        if policy_error(self.url, False):
            raise FileError("bad_request", policy_error(self.url, False))
        folder = resolve_folder(self.folder)
        self.total, final_url, server_name, self.validator = probe(self.url, self.headers)
        name = safe_filename(self.filename or server_name)
        try:
            os.makedirs(folder, exist_ok=True)
        except OSError as e:
            raise FileError("disk", "Could not create the folder: %s" % e)
        self.final = os.path.join(folder, name)
        self.part_path = self.final + PART_SUFFIX
        resumed = self.load_state()
        if not resumed:
            self.new_parts()
            try:
                with open(self.part_path, "wb") as f:
                    f.truncate(self.total)
            except OSError as e:
                raise FileError("disk", "Could not create the file: %s" % e)
        self.fetch_url = final_url
        log.info("file %s start: %s -> %s (%d bytes, %d connections, %s)", self.id, self.url, self.final,
                 self.total, self.connections, "resumed" if resumed else "new")
        self.save_state()

        workers = [threading.Thread(target=self.worker, name="conn-%s-%d" % (str(self.id)[:8], i), daemon=True)
                   for i in range(self.connections)]
        for w in workers:
            w.start()
        last_save = time.monotonic()
        while any(w.is_alive() for w in workers):
            time.sleep(PROGRESS_INTERVAL)
            segs, active = self.snapshot()
            done = self.done_bytes()
            speed = self.speed()
            eta = int((self.total - done) / speed) if speed else None
            if self.stop is None:
                self.progress("running", downloaded=done, total=self.total, speed=speed, eta=eta,
                              filename=self.final, segments=segs, connections=active, resumable=True)
            if time.monotonic() - last_save > STATE_SAVE_INTERVAL:
                self.save_state()
                last_save = time.monotonic()

        done = self.done_bytes()
        if self.stop == "cancel":
            self.remove_own_files()
            self.progress("canceled")
            return
        self.save_state()
        if self.stop == "pause":
            segs, _ = self.snapshot()
            self.progress("paused", downloaded=done, total=self.total, filename=self.final, segments=segs,
                          connections=0, resumable=True)
            return
        if done < self.total:
            code, message = self.errors[-1] if self.errors else ("network", "The download stopped.")
            raise FileError(code, message)
        target = unique_path(self.final)
        try:
            os.replace(self.part_path, target)
        except OSError as e:
            raise FileError("disk", "Could not rename the finished file: %s" % e)
        try:
            os.remove(self.final + STATE_SUFFIX)
        except OSError:
            pass
        log.info("file %s done: %s", self.id, target)
        self.progress("done", downloaded=self.total, total=self.total, filename=target, resumable=True)

    def new_parts(self):
        count = max(1, min(self.connections, self.total // MIN_PART or 1))
        size = self.total // count
        self.parts = []
        for i in range(count):
            start = i * size
            end = self.total - 1 if i == count - 1 else start + size - 1
            self.parts.append(Part(start, end))

    def next_part(self):
        """A part for a free connection: an untouched one, or half of the largest one left."""
        with self.lock:
            free = [p for p in self.parts if not p.busy and p.left() > 0]
            if free:
                part = max(free, key=Part.left)
                part.busy = True
                return part
            busy = [p for p in self.parts if p.busy and p.left() >= 2 * MIN_PART]
            if not busy:
                return None
            big = max(busy, key=Part.left)
            mid = big.pos + big.left() // 2
            part = Part(mid, big.end)
            big.end = mid - 1
            part.busy = True
            self.parts.append(part)
            return part

    def worker(self):
        with self.lock:
            self.active += 1
        try:
            with open(self.part_path, "r+b") as out:
                while self.stop is None:
                    part = self.next_part()
                    if part is None:
                        return
                    try:
                        self.fetch(part, out)
                    finally:
                        with self.lock:
                            part.busy = False
        except OSError as e:
            self.errors.append(("disk", "Could not write the file: %s" % e))
            log.warning("file %s: write error %s", self.id, e)
        finally:
            with self.lock:
                self.active -= 1

    def fetch(self, part, out):
        """Download one part, retrying network errors. Returns when done, stopped or out of retries."""
        import urllib.error
        attempt = 0
        while self.stop is None and part.left() > 0:
            try:
                with http_request(self.fetch_url, self.headers, part.pos, part.end) as res:
                    if res.status != 206:
                        raise FileError("no_range", "The server stopped sending parts of this file.")
                    out.seek(part.pos)
                    while self.stop is None:
                        with self.lock:
                            want = min(CHUNK, part.end - part.pos + 1)
                        if want <= 0:
                            return  # another connection took the rest of this part
                        GLOBAL_LIMIT.take(want)
                        self.limiter.take(want)
                        data = res.read(want)
                        if not data:
                            break
                        with self.lock:
                            data = data[:max(0, part.end - part.pos + 1)]
                        out.write(data)
                        with self.lock:
                            part.pos += len(data)
                        attempt = 0
            except FileError as e:
                self.errors.append((e.code, str(e)))
                return
            except urllib.error.HTTPError as e:
                code = "auth" if e.code in (401, 403, 407) else "http"
                self.errors.append((code, "The server answered HTTP %d." % e.code))
                if e.code < 500:
                    return
            except (OSError, ValueError) as e:
                self.errors.append(("network", "Connection problem: %s" % getattr(e, "reason", e)))
            if part.left() > 0 and self.stop is None:
                attempt += 1
                if attempt > RETRIES:
                    return
                time.sleep(min(8, 2 ** (attempt - 1)))

    def pause(self):
        self.stop = "pause"

    def cancel(self):
        self.stop = "cancel"


def cancel_paused_file(msg):
    """Remove the own partial files of a paused download the companion no longer runs."""
    try:
        folder = resolve_folder(msg.get("folder"))
    except FileError:
        return
    name = msg.get("filename")
    if not isinstance(name, str) or not name:
        return
    final = os.path.join(folder, safe_filename(name))
    try:
        with open(final + STATE_SUFFIX, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    if data.get("id") != msg.get("id"):
        return  # not the download the extension means: leave it alone
    for path in (final + PART_SUFFIX, final + STATE_SUFFIX):
        try:
            os.remove(path)
            log.info("cancel %s: removed partial file %s", msg.get("id"), path)
        except OSError:
            pass


def open_path(path, reveal):
    """Open a finished file, or its folder. Only inside the Downloads folder."""
    if not isinstance(path, str) or not path:
        return False
    roots = [os.path.realpath(r) for r in [downloads_folder()] + chosen_folders()]
    real = os.path.realpath(path)
    inside = any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots)
    if not inside or not os.path.exists(real):
        log.warning("open_file refused: %s", path)
        return False
    try:
        if IS_WIN:
            if reveal:
                subprocess.Popen(["explorer", "/select,", real], creationflags=CREATE_NO_WINDOW)
            else:
                os.startfile(real)  # noqa: the user clicked "Open file"
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", real] if reveal else ["open", real])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(real) if reveal else real],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return True
    except OSError as e:
        log.warning("open_file failed: %s", e)
        return False


def check():
    """``host.py --check``: print what hello would report, for install.bat / install.sh."""
    ffmpeg = find_binary("ffmpeg")
    print(json.dumps({"version": VERSION, "python": sys.version.split()[0], "ytdlp": ytdlp_version(),
                      "ffmpeg": ffmpeg_version(ffmpeg), "dir": default_dir()}, indent=2))
    return 0


def main():
    global CHILD_JOB
    setup_logging()
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    if IS_WIN:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    log.info("host %s starting (python %s, pid %s)", VERSION, sys.version.split()[0], os.getpid())
    CHILD_JOB = KillOnExitJob()
    channel = Channel(sys.stdin.buffer, sys.stdout.buffer)
    host = Host(channel)
    try:
        while True:
            try:
                msg = channel.read()
            except (ValueError, UnicodeDecodeError) as e:
                log.error("bad message: %s", e)
                continue
            if msg is None:
                log.info("browser disconnected")
                break
            try:
                host.handle(msg)
            except Exception:
                log.exception("error handling message %r", msg.get("type") if isinstance(msg, dict) else msg)
    finally:
        host.shutdown()
        log.info("host exiting")


if __name__ == "__main__":
    main()
