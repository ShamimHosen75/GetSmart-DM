#!/usr/bin/env python3
"""End-to-end test: extension + companion in a real Chromium.

Launches headless Chromium with the unpacked extension and a native-messaging
host manifest (inside the test profile) that points at companion/host.py, then
talks to the extension's service worker the way the popup does
(chrome.runtime.sendMessage) and checks:

- getVideoState on a Facebook URL reports site "video" and the companion as
  connected (with its yt-dlp version)
- YouTube is off by default (site "youtube-off", addVideo refused)
- addVideo progresses to done with a .mp4 on disk in Downloads/SIDM/Video
- a 404 gives the friendly "not found" error
- cancelVideo cancels a running download and leaves no partial files
- no console errors in the extension page or the service worker

www.facebook.com is mapped to the local test server with --host-resolver-rules,
and a Facebook tab is opened on it. The video URLs given to addVideo point at
the local server directly, because yt-dlp resolves hosts itself and does not
see Chromium's mapping.

Linux and macOS only: Chromium reads <profile>/NativeMessagingHosts there.
On Windows the host is found through the registry (install.bat); use QA.md.

Needs: pip install playwright yt-dlp   then   python -m playwright install chromium
"""

import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import test_host  # noqa: E402  (reuses its local HTTP test server)

EXTENSION = ROOT / "extension"
HOST_PY = ROOT / "companion" / "host.py"
EXTENSION_ID = "ejkhmcfjnohjikdgfgkhjficmiaoghma"
HOST_NAME = "com.sidm.host"
CHROMIUM_FALLBACKS = [os.environ.get("CHROMIUM_PATH", ""), "/opt/pw-browsers/chromium"]


def launch_kwargs(pw):
    if Path(pw.chromium.executable_path).exists():
        return {}
    for path in CHROMIUM_FALLBACKS:
        if path and Path(path).exists():
            return {"executable_path": path}
    raise unittest.SkipTest("Chromium not found. Run: python -m playwright install chromium")


@unittest.skipIf(os.name == "nt", "uses <profile>/NativeMessagingHosts, which Chromium reads on Linux/macOS only")
class CompanionEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright not installed: pip install playwright")

        cls.server = test_host.http.server.ThreadingHTTPServer(("127.0.0.1", 0), test_host.Handler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.port = cls.server.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port

        cls.tmp = tempfile.mkdtemp(prefix="gsdm-e2e-")
        cls.home = os.path.join(cls.tmp, "home")
        cls.profile = os.path.join(cls.tmp, "profile")
        os.makedirs(cls.home)
        cls.video_dir = os.path.join(cls.home, "Downloads", "SIDM", "Video")

        # Launcher + host manifest inside the profile.
        launcher = os.path.join(cls.tmp, "run_host.sh")
        with open(launcher, "w") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, HOST_PY))
        os.chmod(launcher, os.stat(launcher).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        hosts = os.path.join(cls.profile, "NativeMessagingHosts")
        os.makedirs(hosts)
        with open(os.path.join(hosts, HOST_NAME + ".json"), "w") as f:
            json.dump({"name": HOST_NAME, "description": "SIDM companion (test)",
                       "path": launcher, "type": "stdio",
                       "allowed_origins": ["chrome-extension://%s/" % EXTENSION_ID]}, f)

        cls.pw = sync_playwright().start()
        env = dict(os.environ, HOME=cls.home, LANG="C.UTF-8", LC_ALL="C.UTF-8",
                   XDG_CONFIG_HOME=os.path.join(cls.home, ".config"))
        ext = str(EXTENSION)
        cls.ctx = cls.pw.chromium.launch_persistent_context(
            cls.profile,
            channel="chromium",  # new headless mode, which can load extensions
            headless=True,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  f"--host-resolver-rules=MAP www.facebook.com 127.0.0.1:{cls.port}"],
            env=env,
            locale="en-US",
            **launch_kwargs(cls.pw),
        )
        cls.console_errors = []
        cls.sw = cls.ctx.service_workers[0] if cls.ctx.service_workers else \
            cls.ctx.wait_for_event("serviceworker", timeout=15_000)
        cls.sw.evaluate("""() => {
            self.__gsdmErrors = [];
            const orig = console.error.bind(console);
            console.error = (...a) => { self.__gsdmErrors.push(a.map(String).join(' ')); orig(...a); };
            self.addEventListener('error', (e) => self.__gsdmErrors.push(String(e.message)));
            self.addEventListener('unhandledrejection', (e) => self.__gsdmErrors.push(String(e.reason)));
        }""")
        cls.page = cls.ctx.new_page()
        cls.page.on("console", lambda m: m.type == "error" and cls.console_errors.append(m.text))
        cls.page.on("pageerror", lambda e: cls.console_errors.append(str(e)))
        cls.page.goto(f"chrome-extension://{EXTENSION_ID}/popup.html")

    @classmethod
    def tearDownClass(cls):
        for closer in (lambda: cls.ctx.close(), lambda: cls.pw.stop(), cls.server.shutdown,
                       cls.server.server_close):
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------------------------------------------------------------- helpers

    def send(self, msg):
        return self.page.evaluate("m => chrome.runtime.sendMessage(m)", msg)

    def state(self, url="https://www.facebook.com/watch/?v=1234567890"):
        return self.send({"type": "getVideoState", "url": url})

    def wait_connected(self):
        deadline = time.time() + 20
        while time.time() < deadline:
            st = self.state()
            if st["companion"]["status"] == "connected":
                return st
            if st["companion"]["status"] in ("missing", "error"):
                self.fail("companion not connected: %r" % st["companion"])
            time.sleep(0.2)
        self.fail("companion did not connect: %r" % st["companion"])

    def job(self, job_id):
        for job in self.state()["jobs"]:
            if job["id"] == job_id:
                return job
        self.fail("job %s not in getVideoState" % job_id)

    def wait_job(self, job_id, until, timeout=90):
        seen = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.job(job_id)
            seen.append(job)
            if until(job):
                return job, seen
            time.sleep(0.2)
        self.fail("job %s timed out: %r" % (job_id, seen[-1] if seen else None))

    def add(self, url, quality="best"):
        # The folder dialog has its own check in test_extension.py; here videos go to the default folder.
        self.page.evaluate("() => chrome.storage.sync.set({askVideoFolder: false})")
        time.sleep(0.2)
        reply = self.send({"type": "addVideo", "url": url, "quality": quality, "title": "test"})
        self.assertIn("id", reply, reply)
        return reply["id"]

    # ---------------------------------------------------------------- tests (run in name order)

    def test_1_site_and_companion(self):
        st = self.wait_connected()
        self.assertEqual(st["site"], "video")
        self.assertFalse(st["drm"])
        comp = st["companion"]
        self.assertTrue(comp.get("version"), comp)
        self.assertTrue(comp.get("ytdlp"), "host.py found no yt-dlp: %r" % comp)
        self.assertTrue(comp["dir"].replace("\\", "/").endswith("SIDM/Video"), comp)

        # A real Facebook tab, served by the local test server through the mapping.
        tab = self.ctx.new_page()
        try:
            resp = tab.goto("http://www.facebook.com/clip.mp4", wait_until="commit", timeout=15_000)
            facebook_ok = resp is not None and resp.status == 200
        except Exception:  # noqa: BLE001  (HSTS upgrade or sandbox block)
            facebook_ok = False
        finally:
            tab.close()
        if not facebook_ok:
            print("\n  note: could not open www.facebook.com through --host-resolver-rules "
                  "(HSTS or network policy); site detection is checked by URL only", flush=True)

    def test_2_youtube_on_by_default_and_off_refuses(self):
        st = self.state("https://www.youtube.com/watch?v=abc")
        self.assertEqual(st["site"], "video")  # owner's decision: on by default
        self.page.evaluate("() => chrome.storage.sync.set({allowYouTube: false})")
        time.sleep(0.3)
        try:
            st = self.state("https://www.youtube.com/watch?v=abc")
            self.assertEqual(st["site"], "youtube-off")
            reply = self.send({"type": "addVideo", "url": "https://www.youtube.com/watch?v=abc",
                               "quality": "best", "title": "yt"})
            self.assertIn("error", reply)
            self.assertNotIn("id", reply)
        finally:
            self.page.evaluate("() => chrome.storage.sync.remove('allowYouTube')")

    def test_3_download_done(self):
        self.wait_connected()
        job_id = self.add(self.base + "/clip.mp4")
        job, seen = self.wait_job(job_id, lambda j: j["state"] != "running")
        self.assertEqual(job["state"], "done", job)
        self.assertTrue(any(0 < s.get("downloaded", 0) < len(test_host.VIDEO) for s in seen),
                        "no progress seen before done")
        path = job["filename"]
        self.assertTrue(path.endswith(".mp4"), path)
        self.assertTrue(os.path.isfile(path), path)
        self.assertEqual(os.path.dirname(path), self.video_dir)
        self.assertEqual(os.path.getsize(path), len(test_host.VIDEO))

    def test_4_404_is_friendly(self):
        job_id = self.add(self.base + "/missing.mp4")
        job, _ = self.wait_job(job_id, lambda j: j["state"] != "running")
        self.assertEqual(job["state"], "error")
        self.assertIn("404", job["error"])
        self.assertIn("not found", job["error"].lower())

    def test_5_cancel(self):
        before = set(os.listdir(self.video_dir)) if os.path.isdir(self.video_dir) else set()
        job_id = self.add(self.base + "/slow.mp4")
        self.wait_job(job_id, lambda j: j.get("downloaded", 0) > 0, timeout=30)
        self.assertEqual(self.send({"type": "cancelVideo", "id": job_id}).get("ok"), True)
        job, _ = self.wait_job(job_id, lambda j: j["state"] != "running", timeout=20)
        self.assertEqual(job["state"], "canceled", job)
        time.sleep(0.5)
        self.assertEqual(set(os.listdir(self.video_dir)), before, "partial files left behind")

    def test_9_no_console_errors(self):
        errors = list(self.console_errors) + self.sw.evaluate("() => self.__gsdmErrors || []")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
