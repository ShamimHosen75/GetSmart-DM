#!/usr/bin/env python3
"""Direct test of companion/host.py over the native-messaging framing.

Starts a local HTTP test server, launches host.py as a subprocess exactly like
the browser would (4-byte little-endian length + UTF-8 JSON on stdin/stdout),
and checks hello, ping, a direct .mp4 download with progress, a 404, cancel and
the YouTube-off policy.

Needs yt-dlp reachable by host.py (yt-dlp.exe next to host.py, yt-dlp on PATH,
or the yt_dlp Python module). Standard library only.

    python scripts/test_host.py
"""

import http.server
import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_PY = os.path.join(ROOT, "companion", "host.py")

CHUNK = 64 * 1024
VIDEO = os.urandom(3 * 1024 * 1024)  # content is never decoded for a direct link
OTHER_VIDEO = os.urandom(1024 * 1024)
FILES = {
    # path: (bytes, seconds to sleep between chunks)
    "/clip.mp4": (VIDEO, 0.06),          # ~3 s, enough for several progress messages
    "/slow.mp4": (VIDEO * 4, 0.25),      # ~50 s, canceled long before the end
    "/second.mp4": (OTHER_VIDEO, 0.02),  # a different video, for two downloads at once
}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _head(self):
        item = FILES.get(self.path.split("?")[0])
        if item is None:
            self.send_error(404, "Not Found")
            return None
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(item[0])))
        self.end_headers()
        return item

    def do_HEAD(self):
        self._head()

    def do_GET(self):
        item = self._head()
        if item is None:
            return
        data, delay = item
        try:
            for i in range(0, len(data), CHUNK):
                self.wfile.write(data[i:i + CHUNK])
                time.sleep(delay)
        except (BrokenPipeError, ConnectionResetError):
            pass


class HostProcess:
    def __init__(self, env=None):
        self.proc = subprocess.Popen(
            [sys.executable, HOST_PY], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.messages = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        out = self.proc.stdout
        while True:
            header = out.read(4)
            if len(header) < 4:
                return
            (n,) = struct.unpack("<I", header)
            self.messages.put(json.loads(out.read(n).decode("utf-8")))

    def send(self, msg):
        data = json.dumps(msg).encode("utf-8")
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()

    def next(self, timeout=30, pred=lambda m: True):
        deadline = time.time() + timeout
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise AssertionError("timed out waiting for a message")
            msg = self.messages.get(timeout=left)
            msg["_t"] = time.monotonic()
            if pred(msg):
                return msg

    def job(self, job_id, timeout=120):
        """Collect progress messages for job_id until a final state."""
        seen = []
        while True:
            msg = self.next(timeout, lambda m: m.get("type") == "progress" and m.get("id") == job_id)
            seen.append(msg)
            if msg["state"] in ("done", "error", "canceled"):
                return seen

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdout.close()


class HostTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.host = HostProcess()

    def tearDown(self):
        self.host.close()
        self.tmp.cleanup()

    def add(self, job_id, path, **extra):
        msg = {"type": "add_video", "v": 1, "id": job_id, "url": self.base + path,
               "quality": "best", "dir": self.dir}
        msg.update(extra)
        self.host.send(msg)

    def test_hello_and_ping(self):
        self.host.send({"type": "hello", "v": 1})
        hello = self.host.next(pred=lambda m: m["type"] == "hello")
        self.assertEqual(hello["v"], 1)
        self.assertTrue(hello["version"])
        self.assertTrue(hello["ytdlp"], "yt-dlp not found by host.py")
        self.assertIn("ffmpeg", hello)
        self.assertIn("js_runtime", hello)
        self.assertTrue(hello["dir"].replace("\\", "/").endswith("SIDM/Video"), hello["dir"])
        self.host.send({"type": "ping", "v": 1})
        self.assertEqual(self.host.next(pred=lambda m: m["type"] != "hello")["type"], "pong")

    def test_download_with_progress(self):
        self.add("job-ok", "/clip.mp4")
        seen = self.host.job("job-ok")
        final = seen[-1]
        self.assertEqual(final["state"], "done", final)
        self.assertTrue(os.path.isfile(final["filename"]), final)
        self.assertEqual(os.path.getsize(final["filename"]), len(VIDEO))
        self.assertTrue(final["filename"].endswith(".mp4"))
        ticks = [m for m in seen if m["state"] == "running" and "downloaded" in m]
        self.assertGreaterEqual(len(ticks), 2, seen)
        self.assertTrue(all(m["total"] == len(VIDEO) for m in ticks), ticks)
        self.assertEqual([m["downloaded"] for m in ticks], sorted(m["downloaded"] for m in ticks))
        gaps = [b["_t"] - a["_t"] for a, b in zip(ticks, ticks[1:])]
        self.assertTrue(all(g >= 0.4 for g in gaps), "progress not throttled: %s" % gaps)
        leftovers = [n for n in os.listdir(self.dir) if n.endswith((".part", ".ytdl"))]
        self.assertEqual(leftovers, [])

    def test_two_videos_each_saved_as_itself(self):
        # The program saves exactly the video each request names, even when two run at once
        # (owner's report 2026-11-25: "downloads previous or random video").
        self.add("job-first", "/clip.mp4")
        self.add("job-second", "/second.mp4")
        finals = {}
        while len(finals) < 2:
            msg = self.host.next(120, lambda m: m.get("type") == "progress" and m.get("id") in ("job-first", "job-second"))
            if msg["state"] in ("done", "error", "canceled"):
                finals[msg["id"]] = msg
        for job_id, data in (("job-first", VIDEO), ("job-second", OTHER_VIDEO)):
            final = finals[job_id]
            self.assertEqual(final["state"], "done", final)
            with open(final["filename"], "rb") as f:
                self.assertEqual(f.read(), data, "%s saved another video's bytes" % job_id)
        self.assertNotEqual(finals["job-first"]["filename"], finals["job-second"]["filename"])

    def test_404_is_friendly(self):
        self.add("job-404", "/missing.mp4")
        final = self.host.job("job-404")[-1]
        self.assertEqual(final["state"], "error")
        self.assertIn("404", final["error"])
        self.assertIn("not found", final["error"].lower())

    def test_cancel(self):
        self.add("job-cancel", "/slow.mp4")
        self.host.next(pred=lambda m: m.get("id") == "job-cancel" and "downloaded" in m)
        self.host.send({"type": "cancel", "v": 1, "id": "job-cancel"})
        started = time.time()
        final = self.host.job("job-cancel", timeout=30)[-1]
        self.assertEqual(final["state"], "canceled")
        self.assertLess(time.time() - started, 20)
        self.assertEqual(os.listdir(self.dir), [], "partial files left behind")

    def test_youtube_off_by_default(self):
        self.host.send({"type": "add_video", "v": 1, "id": "job-yt", "quality": "best",
                        "url": "https://www.youtube.com/watch?v=abc", "dir": self.dir})
        final = self.host.job("job-yt")[-1]
        self.assertEqual(final["state"], "error")
        self.assertIn("YouTube", final["error"])

    def test_drm_refused(self):
        self.host.send({"type": "add_video", "v": 1, "id": "job-drm", "quality": "best",
                        "url": "https://www.netflix.com/watch/1", "dir": self.dir})
        final = self.host.job("job-drm")[-1]
        self.assertEqual(final["state"], "error")
        self.assertIn("DRM", final["error"])

    def test_hello_lists_features_and_caches_versions(self):
        self.host.send({"type": "hello", "v": 1})
        hello = self.host.next(pred=lambda m: m["type"] == "hello")
        for feature in ("files", "video_info", "pick_folder"):
            self.assertIn(feature, hello["features"])
        self.assertTrue(os.path.isfile(os.path.join(os.path.dirname(HOST_PY), "versions.json")))
        again = HostProcess()
        try:
            started = time.time()
            again.send({"type": "hello", "v": 1})
            second = again.next(pred=lambda m: m["type"] == "hello")
            self.assertEqual(second["ytdlp"], hello["ytdlp"])
            self.assertLess(time.time() - started, 5)
        finally:
            again.close()

    def test_video_info(self):
        self.host.send({"type": "video_info", "v": 1, "id": "info-1", "url": self.base + "/clip.mp4"})
        reply = self.host.next(60, lambda m: m["type"] == "video_info")
        self.assertEqual(reply["id"], "info-1")
        self.assertNotIn("error", reply, reply)
        self.assertIsInstance(reply["sizes"], dict)

    def test_video_info_youtube_needs_the_setting(self):
        self.host.send({"type": "video_info", "v": 1, "id": "info-yt", "url": "https://www.youtube.com/watch?v=abc"})
        reply = self.host.next(30, lambda m: m["type"] == "video_info")
        self.assertIn("YouTube", reply["error"])

    def test_pick_folder_and_save_there(self):
        # A stand-in for the system dialog (zenity) that "chooses" a folder.
        chosen = os.path.join(self.dir, "Chosen folder")
        os.makedirs(chosen)
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        fake = os.path.join(bindir, "zenity")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\necho \"$SIDM_TEST_CHOICE\"\n")
        os.chmod(fake, 0o755)
        folders = os.path.join(os.path.dirname(HOST_PY), "folders.json")
        backup = open(folders).read() if os.path.isfile(folders) else None
        env = dict(os.environ, PATH=bindir + os.pathsep + os.environ.get("PATH", ""), SIDM_TEST_CHOICE=chosen)
        self.host.close()
        self.host = HostProcess(env)
        try:
            self.host.send({"type": "pick_folder", "v": 1, "id": "pick-1", "title": "Where?"})
            reply = self.host.next(30, lambda m: m["type"] == "folder")
            self.assertEqual(reply, dict(reply, id="pick-1", path=chosen))
            with open(folders) as f:
                self.assertIn(chosen, json.load(f))
            self.host.send({"type": "add_video", "v": 1, "id": "job-dir", "url": self.base + "/clip.mp4",
                            "quality": "best", "dir": chosen})
            final = self.host.job("job-dir")[-1]
            self.assertEqual(final["state"], "done", final)
            self.assertEqual(os.path.dirname(final["filename"]), chosen)
            # Canceled dialog: path null.
            env["SIDM_TEST_CHOICE"] = ""
            self.host.close()
            self.host = HostProcess(env)
            self.host.send({"type": "pick_folder", "v": 1, "id": "pick-2"})
            reply = self.host.next(30, lambda m: m["type"] == "folder")
            self.assertIsNone(reply["path"])
        finally:
            if backup is None:
                if os.path.isfile(folders):
                    os.remove(folders)
            else:
                with open(folders, "w") as f:
                    f.write(backup)

    def test_missing_folder_refused(self):
        self.add("job-nodir", "/clip.mp4", dir=os.path.join(self.dir, "does-not-exist"))
        final = self.host.job("job-nodir")[-1]
        self.assertEqual(final["state"], "error")
        self.assertIn("does not exist", final["error"])

    def test_wrong_version(self):
        self.host.send({"type": "add_video", "v": 2, "id": "job-v2", "quality": "best",
                        "url": self.base + "/clip.mp4", "dir": self.dir})
        final = self.host.job("job-v2")[-1]
        self.assertEqual(final["state"], "error")


class HelperTest(unittest.TestCase):
    """Pure functions of host.py: quality map, ffmpeg fallback, friendly errors."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.dirname(HOST_PY))
        import host
        cls.h = host

    def test_sizes_from_info(self):
        info = {"duration": 100, "formats": [
            {"ext": "mhtml", "vcodec": "none", "acodec": "none"},
            {"vcodec": "none", "acodec": "mp4a", "abr": 129, "filesize": 1600000},
            {"vcodec": "none", "acodec": "opus", "abr": 135, "filesize": 1700000},
            {"vcodec": "avc1", "acodec": "mp4a", "height": 360, "tbr": 500},
            {"vcodec": "avc1.640028", "acodec": "none", "height": 1080, "fps": 30, "filesize": 40000000},
            {"vcodec": "vp9", "acodec": "none", "height": 1080, "fps": 30, "filesize": 30000000},
            {"vcodec": "avc1", "acodec": "none", "height": 720, "fps": 30, "filesize_approx": 20000000},
        ]}
        out = self.h.sizes_from_info(info)
        self.assertEqual(out["max_height"], 1080)
        self.assertEqual(out["sizes"]["best"], 30000000 + 1700000)  # vp9 is preferred over avc1, like yt-dlp
        self.assertEqual(out["sizes"]["720"], 20000000 + 1700000)
        self.assertEqual(out["sizes"]["360"], 6250000)  # one file with sound: no extra audio
        self.assertEqual(out["sizes"]["audio"], 1700000)

    def test_quality_map(self):
        args, note = self.h.format_args("720", "/x/ffmpeg")
        self.assertEqual(args[:2], ["-f", "bv*[height<=720]+ba/b[height<=720]/b"])
        self.assertIn("--merge-output-format", args)
        self.assertIsNone(note)
        self.assertEqual(self.h.format_args("best", "/x/ffmpeg")[0][1], "bv*+ba/b")
        args, _ = self.h.format_args("audio", "/x/ffmpeg")
        self.assertEqual(args[:5], ["-f", "ba/b", "-x", "--audio-format", "mp3"])

    def test_no_ffmpeg_fallback(self):
        args, note = self.h.format_args("480", None)
        self.assertEqual(args, ["-f", "b[height<=480]/b"])
        self.assertIn("ffmpeg", note)
        self.assertEqual(self.h.format_args("best", None)[0], ["-f", "b"])

    def test_command_flags(self):
        cmd, _ = self.h.build_command(["yt-dlp"], "https://x/y", "best", "/out", None)
        for flag in ("--no-playlist", "--newline", "--no-quiet", "--windows-filenames",
                     "--progress-template", "--print", "--retries", "--fragment-retries"):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[-1], "https://x/y")

    def test_friendly_errors(self):
        f = self.h.friendly_error
        self.assertIn("DRM", f(["ERROR: [generic] This video is DRM protected"]))
        self.assertIn("log in", f(["ERROR: [instagram] abc: Requested content is not available, "
                                   "rate-limit reached or login required"]))
        self.assertIn("not supported", f(["ERROR: Unsupported URL: https://example.com/"]))
        self.assertIn("404", f(["ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found"]))
        self.assertIn("Network", f(["ERROR: [generic] Unable to download webpage: "
                                    "<urlopen error [Errno 11001] getaddrinfo failed>"]))
        self.assertIn("ffmpeg", f(["ERROR: Postprocessing: ffprobe and ffmpeg not found"]))
        self.assertEqual(f(["something", "ERROR: weird thing"]), "weird thing")

    @unittest.skipUnless(sys.platform.startswith("linux"), "XDG user dirs are Linux only")
    def test_xdg_download_dir(self):
        with tempfile.TemporaryDirectory() as cfg:
            old = os.environ.get("XDG_CONFIG_HOME")
            os.environ["XDG_CONFIG_HOME"] = cfg
            try:
                home = os.path.expanduser("~")
                self.assertIsNone(self.h.xdg_download_dir())  # no user-dirs.dirs
                path = os.path.join(cfg, "user-dirs.dirs")
                with open(path, "w", encoding="utf-8") as f:
                    f.write('# comment\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n')
                self.assertEqual(self.h.downloads_folder(), os.path.join(home, "Téléchargements"))
                with open(path, "w", encoding="utf-8") as f:
                    f.write('XDG_DOWNLOAD_DIR="$HOME/"\n')  # disabled: falls back to ~/Downloads
                self.assertEqual(self.h.downloads_folder(), os.path.join(home, "Downloads"))
            finally:
                if old is None:
                    os.environ.pop("XDG_CONFIG_HOME", None)
                else:
                    os.environ["XDG_CONFIG_HOME"] = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
