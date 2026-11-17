#!/usr/bin/env python3
"""GetSmart DM companion: native-messaging host ``com.getsmartdm.host``.

Speaks the protocol defined in shared/protocol.md (v1) on stdin/stdout and runs
yt-dlp (plus ffmpeg for merging) to download videos.

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

VERSION = "0.1.0-dev"
PROTOCOL_V = 1
HOST_NAME = "com.getsmartdm.host"

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000 if IS_WIN else 0
INSTALLER = "install.bat" if IS_WIN else "install.sh"
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
    return os.path.join(downloads_folder(), "GetSmart DM", "Video")


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
        return "This site uses DRM protection. GetSmart DM does not download DRM-protected content."
    if _host_matches(parsed.hostname, YOUTUBE_HOSTS) and youtube_allowed is not True:
        return "YouTube downloads are off. You can turn them on in Settings after reading the Terms of Service warning."
    return None


ERROR_RULES = (
    (re.compile(r"\bDRM\b", re.I),
     "This video is DRM-protected. GetSmart DM does not download DRM-protected content."),
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

        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
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
        else:
            log.warning("ignoring unknown message type %r", mtype)

    def on_hello(self):
        ffmpeg = find_binary("ffmpeg")
        reply = {"type": "hello", "version": VERSION, "ytdlp": ytdlp_version(),
                 "ffmpeg": ffmpeg_version(ffmpeg), "dir": default_dir()}
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
        if msg.get("dir") is not None and not isinstance(msg.get("dir"), str):
            msg = dict(msg, dir=None)
        with self.lock:
            if job_id in self.jobs:
                log.warning("add_video: id %s is already running, ignored", job_id)
                return
            job = Job(self, msg)
            self.jobs[job_id] = job
        job.thread.start()

    def on_cancel(self, msg):
        with self.lock:
            job = self.jobs.get(msg.get("id"))
        if job is None:
            log.info("cancel: no running job %r", msg.get("id"))
            return
        job.cancel()

    def shutdown(self):
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel()
        for job in jobs:
            job.thread.join(10)


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
