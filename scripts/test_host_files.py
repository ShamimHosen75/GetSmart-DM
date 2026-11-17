#!/usr/bin/env python3
"""Test of the companion's multi-connection file downloads (add_file).

Starts a local HTTP server with Range support, runs companion/host.py like the
browser does (4-byte length + JSON on stdin/stdout) with a temporary Downloads
folder, and checks:

- hello reports features=["files"] and the Downloads folder
- a file downloads over several connections, byte for byte, into the folder
- progress carries segments and connections
- pause keeps the partial file; add_file with the same id resumes and finishes
- cancel removes only the companion's own partial files
- a server without Range support answers error_code "no_range" (so the
  extension lets the browser download it), 403 answers "auth"
- the speed limit slows a download down
- folder ".." is refused

Standard library only.

    python scripts/test_host_files.py
"""

import hashlib
import http.server
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_PY = os.path.join(ROOT, "companion", "host.py")

DATA = os.urandom(6 * 1024 * 1024 + 12345)
RANGES_SEEN = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        slow = "slow" in self.path
        if path == "/forbidden.bin":
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        m = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range") or "")
        if path == "/norange.bin" or not m:
            body = DATA
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.send_body(body, slow)
            return
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else len(DATA) - 1
        end = min(end, len(DATA) - 1)
        RANGES_SEEN.append((start, end))
        self.send_response(206)
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(DATA)))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("ETag", '"v1"')
        if path == "/named":
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE.bin")
        self.end_headers()
        self.send_body(DATA[start:end + 1], slow)

    def send_body(self, body, slow):
        try:
            for i in range(0, len(body), 32768):
                self.wfile.write(body[i:i + 32768])
                if slow:
                    time.sleep(0.02)
        except (BrokenPipeError, ConnectionResetError):
            pass


class HostProcess:
    def __init__(self, env):
        self.proc = subprocess.Popen([sys.executable, HOST_PY], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.messages = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            header = self.proc.stdout.read(4)
            if len(header) < 4:
                return
            (n,) = struct.unpack("<I", header)
            self.messages.put(json.loads(self.proc.stdout.read(n).decode("utf-8")))

    def send(self, msg):
        data = json.dumps(dict(msg, v=1)).encode("utf-8")
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()

    def wait(self, predicate, timeout=30):
        deadline = time.time() + timeout
        seen = []
        while time.time() < deadline:
            try:
                msg = self.messages.get(timeout=0.5)
            except queue.Empty:
                continue
            seen.append(msg)
            if predicate(msg):
                return msg, seen
        raise AssertionError("timed out; last messages: %r" % seen[-3:])

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(15)


class FileDownloadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.tmp = tempfile.mkdtemp(prefix="gsdm-files-")
        cls.downloads = os.path.join(cls.tmp, "Downloads")
        os.makedirs(cls.downloads)
        config = os.path.join(cls.tmp, "config")
        os.makedirs(config)
        with open(os.path.join(config, "user-dirs.dirs"), "w") as f:
            f.write('XDG_DOWNLOAD_DIR="%s"\n' % cls.downloads)
        env = dict(os.environ, HOME=cls.tmp, XDG_CONFIG_HOME=config, USERPROFILE=cls.tmp)
        cls.host = HostProcess(env)
        cls.host.send({"type": "hello"})
        cls.hello, _ = cls.host.wait(lambda m: m["type"] == "hello")

    @classmethod
    def tearDownClass(cls):
        cls.host.close()
        cls.server.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def final(self, job_id, timeout=60):
        return self.host.wait(lambda m: m.get("id") == job_id and m.get("state") in ("done", "error", "canceled", "paused"), timeout)

    def test_hello(self):
        self.assertIn("files", self.hello.get("features", []))
        self.assertEqual(os.path.realpath(self.hello["downloads"]), os.path.realpath(self.downloads))

    def test_multi_connection(self):
        RANGES_SEEN.clear()
        self.host.send({"type": "add_file", "id": "multi", "url": self.base + "/big.bin?slow", "filename": "big.bin",
                        "folder": "SIDM/Archives", "connections": 6})
        done, seen = self.final("multi")
        self.assertEqual(done["state"], "done", done)
        path = os.path.join(self.downloads, "SIDM", "Archives", "big.bin")
        self.assertEqual(os.path.realpath(done["filename"]), os.path.realpath(path))
        with open(path, "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), hashlib.sha256(DATA).hexdigest())
        running = [m for m in seen if m.get("state") == "running"]
        self.assertTrue(running, "no running progress")
        self.assertTrue(max(m.get("connections", 0) for m in running) >= 4, "fewer than 4 connections at once")
        self.assertTrue(any(len(m.get("segments", [])) >= 6 for m in running), "no segments")
        self.assertGreaterEqual(len(RANGES_SEEN), 7)  # the probe plus 6 parts
        self.assertFalse([n for n in os.listdir(os.path.dirname(path)) if "gsdmpart" in n])

    def test_name_from_server(self):
        self.host.send({"type": "add_file", "id": "named", "url": self.base + "/named"})
        done, _ = self.final("named")
        self.assertEqual(done["state"], "done", done)
        self.assertEqual(os.path.basename(done["filename"]), "বাংলা.bin")

    def test_pause_resume(self):
        msg = {"type": "add_file", "id": "pr", "url": self.base + "/pr.bin?slow", "filename": "pr.bin", "connections": 4}
        self.host.send(msg)
        self.host.wait(lambda m: m.get("id") == "pr" and m.get("downloaded", 0) > 500000)
        self.host.send({"type": "pause_file", "id": "pr"})
        paused, _ = self.final("pr")
        self.assertEqual(paused["state"], "paused", paused)
        part = os.path.join(self.downloads, "pr.bin.gsdmpart")
        self.assertTrue(os.path.isfile(part) and os.path.isfile(part + ".json"))
        before = paused["downloaded"]
        RANGES_SEEN.clear()
        self.host.send(msg)
        done, _ = self.final("pr")
        self.assertEqual(done["state"], "done", done)
        with open(os.path.join(self.downloads, "pr.bin"), "rb") as f:
            self.assertEqual(f.read(), DATA)
        fetched = sum(e - s + 1 for s, e in RANGES_SEEN) - 1  # minus the probe byte
        self.assertLess(fetched, len(DATA) - before + 4 * 65536, "resume downloaded the file again")

    def test_cancel_removes_own_partial(self):
        keep = os.path.join(self.downloads, "keep.txt")
        with open(keep, "w") as f:
            f.write("user file")
        self.host.send({"type": "add_file", "id": "cx", "url": self.base + "/cx.bin?slow", "filename": "cx.bin", "connections": 1})
        self.host.wait(lambda m: m.get("id") == "cx" and m.get("state") == "running")
        self.host.send({"type": "cancel", "id": "cx"})
        result, _ = self.final("cx")
        self.assertEqual(result["state"], "canceled")
        names = os.listdir(self.downloads)
        self.assertFalse([n for n in names if n.startswith("cx.bin")], names)
        self.assertIn("keep.txt", names)

    def test_cancel_paused_after_restart(self):
        self.host.send({"type": "add_file", "id": "cp", "url": self.base + "/cp.bin?slow", "filename": "cp.bin", "connections": 1})
        self.host.wait(lambda m: m.get("id") == "cp" and m.get("downloaded", 0) > 100000)
        self.host.send({"type": "pause_file", "id": "cp"})
        self.final("cp")
        self.host.send({"type": "cancel", "id": "cp", "url": self.base + "/cp.bin?slow", "filename": "cp.bin", "connections": 1})
        result, _ = self.final("cp")
        self.assertEqual(result["state"], "canceled")
        self.assertFalse([n for n in os.listdir(self.downloads) if n.startswith("cp.bin")])

    def test_no_range_and_auth(self):
        self.host.send({"type": "add_file", "id": "nr", "url": self.base + "/norange.bin"})
        result, _ = self.final("nr")
        self.assertEqual((result["state"], result.get("error_code")), ("error", "no_range"), result)
        self.host.send({"type": "add_file", "id": "au", "url": self.base + "/forbidden.bin"})
        result, _ = self.final("au")
        self.assertEqual((result["state"], result.get("error_code")), ("error", "auth"), result)

    def test_bad_folder(self):
        self.host.send({"type": "add_file", "id": "bf", "url": self.base + "/x.bin", "folder": "../outside"})
        result, _ = self.final("bf")
        self.assertEqual(result.get("error_code"), "bad_request", result)

    def test_speed_limit(self):
        self.host.send({"type": "add_file", "id": "lim", "url": self.base + "/lim.bin", "filename": "lim.bin",
                        "speed_limit": 1024 * 1024})
        start = time.time()
        done, seen = self.final("lim")
        elapsed = time.time() - start
        self.assertEqual(done["state"], "done", done)
        self.assertGreater(elapsed, 4.5, "6 MB at 1 MB/s took only %.1f s" % elapsed)
        speeds = [m["speed"] for m in seen if m.get("speed")]
        self.assertTrue(speeds and max(speeds) < 1.6 * 1024 * 1024, speeds)


if __name__ == "__main__":
    unittest.main(verbosity=2)
