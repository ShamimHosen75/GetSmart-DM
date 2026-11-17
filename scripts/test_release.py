#!/usr/bin/env python3
"""Tests for scripts/release.py and scripts/bump.py.

Each test copies the parts of the repo the scripts read into a temporary
folder and runs the scripts there, so the real repo is never changed.
Standard library only.

    python scripts/test_release.py
"""

import datetime
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import bump  # noqa: E402
import release  # noqa: E402

SITE_HTML = """<!doctype html>
<html><body>
  <!-- release.py rewrites: <a data-release="windows-zip" href="x"> and
       <span data-release="version">x.y.z</span> -->
  <h1>GetSmart DM <span id="release-version" data-release="version">0.0.0</span></h1>
  <a id="download-link" class="button" data-release="windows-zip" href="downloads/old.zip">Download</a>
  <p>Size: <span data-release="windows-size">size to be confirmed</span></p>
  <p>SHA-256: <code data-release='windows-sha256'>published with the release</code></p>
  <footer>Version <span data-release="version">0.0.0</span></footer>
</body></html>
"""


class RepoCopy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gsdm-release-")
        self.root = os.path.join(self.tmp, "repo")
        os.makedirs(self.root)
        shutil.copytree(os.path.join(ROOT, "extension"), os.path.join(self.root, "extension"),
                        ignore=shutil.ignore_patterns("*.pem", "*.zip"))
        shutil.copytree(os.path.join(ROOT, "companion"), os.path.join(self.root, "companion"),
                        ignore=shutil.ignore_patterns("python", "*.exe", "*.log", "*.zip"))
        # Things that must never reach the ZIP.
        self.write("extension/extension-key.pem", "PRIVATE KEY")
        self.write("extension/tests/popup.spec.js", "test")
        self.write("extension/popup.test.js", "test")
        self.write("companion/host.log", "log")
        self.write("companion/yt-dlp.exe", "binary")
        self.write("companion/python/python.exe", "binary")
        self.write("companion/run_host.bat", "@echo off\r\n")
        self.write("site/index.html", SITE_HTML)
        self.set_versions("1.2.3")
        self.out = io.StringIO()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def write(self, rel, text):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def read(self, rel):
        with open(self.path(rel), encoding="utf-8", newline="") as f:
            return f.read()

    def set_versions(self, version, host_version=None):
        bump.bump_manifest(self.root, version)
        bump.bump_host(self.root, host_version or version)

    def run_release(self, **kwargs):
        return release.release(self.root, ["windows"], out=self.out.write, **kwargs)


class ReleaseTest(RepoCopy):
    def test_zip_contents(self):
        version, builds = self.run_release()
        info = builds["windows"]
        self.assertEqual(version, "1.2.3")
        self.assertEqual(info["name"], "getsmart-dm-v1.2.3-windows.zip")
        with zipfile.ZipFile(info["path"]) as zf:
            names = zf.namelist()
            start_here = zf.read("getsmart-dm/START-HERE.txt").decode()
            install_bat = zf.read("getsmart-dm/companion/install.bat")

        self.assertTrue(all(n.startswith("getsmart-dm/") for n in names), names)
        self.assertIn("getsmart-dm/extension/manifest.json", names)
        self.assertIn("getsmart-dm/extension/popup.html", names)
        self.assertIn("getsmart-dm/extension/icons/icon128.png", names)
        companion = sorted(n for n in names if n.startswith("getsmart-dm/companion/"))
        self.assertEqual(companion, [f"getsmart-dm/companion/{n}" for n in
                                     ["README.md", "host.py", "install.bat", "uninstall.bat", "update.bat"]])
        for forbidden in (".pem", "tests/", ".test.js", ".log", ".exe", "python/", "run_host"):
            self.assertFalse([n for n in names if forbidden in n], forbidden)

        self.assertEqual(len(start_here.strip().splitlines()), 3)
        self.assertIn("\r\n", start_here)
        self.assertNotIn(b"\n", install_bat.replace(b"\r\n", b""))  # CRLF only

    def test_bat_files_get_crlf_even_if_checked_out_with_lf(self):
        self.write("companion/update.bat", "@echo off\necho hi\n")
        _, builds = self.run_release()
        with zipfile.ZipFile(builds["windows"]["path"]) as zf:
            self.assertEqual(zf.read("getsmart-dm/companion/update.bat"), b"@echo off\r\necho hi\r\n")

    def test_size_and_sha_are_reported_and_reproducible(self):
        _, first = self.run_release()
        path = first["windows"]["path"]
        with open(path, "rb") as f:
            data = f.read()
        self.assertEqual(first["windows"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(first["windows"]["size"], len(data))
        self.assertIn(first["windows"]["sha256"], self.out.getvalue())
        _, second = self.run_release()
        self.assertEqual(first["windows"]["sha256"], second["windows"]["sha256"])

    def test_site_and_version_json_updated(self):
        _, builds = self.run_release()
        info = builds["windows"]
        html = self.read("site/index.html")
        self.assertEqual(html.count(">1.2.3</span>"), 2)
        self.assertIn('href="downloads/getsmart-dm-v1.2.3-windows.zip"', html)
        self.assertIn('id="download-link"', html)
        self.assertIn(f">{info['size_text']}</span>", html)
        self.assertIn(f">{info['sha256']}</code>", html)
        self.assertIn('<span data-release="version">x.y.z</span> -->', html)  # comments untouched
        self.assertIn('<a data-release="windows-zip" href="x">', html)
        self.assertEqual(json.loads(self.read("site/version.json")), {"version": "1.2.3"})
        self.assertNotIn("warning", self.out.getvalue())

    def test_real_site_page(self):
        real = os.path.join(ROOT, "site", "index.html")
        if not os.path.isfile(real):
            self.skipTest("site/index.html not built yet")
        shutil.copy(real, self.path("site/index.html"))
        _, builds = self.run_release()
        html = self.read("site/index.html")
        self.assertNotIn("warning", self.out.getvalue())
        self.assertIn(builds["windows"]["sha256"], html)
        self.assertIn('href="downloads/getsmart-dm-v1.2.3-windows.zip"', html)

    def test_missing_site_markers_warn(self):
        self.write("site/index.html", "<html><body>nothing marked</body></html>")
        self.run_release()
        self.assertIn('no data-release="windows-sha256"', self.out.getvalue())

    def test_old_zips_removed_unless_keep(self):
        downloads = self.path("site/downloads")
        os.makedirs(downloads)
        for name in ("getsmart-dm-v1.2.2-windows.zip", "getsmart-dm-v1.2.2-macos-linux.zip", "notes.txt"):
            self.write(f"site/downloads/{name}", "x")

        self.run_release(keep=True)
        self.assertIn("getsmart-dm-v1.2.2-windows.zip", os.listdir(downloads))

        self.run_release()
        self.assertEqual(sorted(os.listdir(downloads)), [
            "getsmart-dm-v1.2.2-macos-linux.zip",  # other platforms are not touched
            "getsmart-dm-v1.2.3-windows.zip",
            "notes.txt",
        ])

    def test_version_mismatch_fails(self):
        self.set_versions("1.2.3", host_version="1.2.4-dev")
        with self.assertRaisesRegex(release.ReleaseError, "mismatch"):
            self.run_release()
        self.assertFalse(os.path.exists(self.path("site/downloads/getsmart-dm-v1.2.3-windows.zip")))

    def test_cli_exit_codes(self):
        self.assertEqual(release.main(["--root", self.root]), 0)
        self.set_versions("1.2.3", host_version="9.9.9")
        self.assertEqual(release.main(["--root", self.root]), 1)


class BumpTest(RepoCopy):
    def test_next_version(self):
        self.assertEqual(bump.next_version("1.2.3", "patch"), "1.2.4")
        self.assertEqual(bump.next_version("1.2.3", "minor"), "1.3.0")
        self.assertEqual(bump.next_version("1.2.3", "major"), "2.0.0")
        self.assertEqual(bump.next_version("1.2.3", "0.1.0"), "0.1.0")
        with self.assertRaises(release.ReleaseError):
            bump.next_version("1.2.3", "huge")

    def test_bump_everything(self):
        manifest_before = self.read("extension/manifest.json")
        bump.bump(self.root, "minor", today=datetime.date(2026, 11, 17), out=self.out.write)

        manifest = self.read("extension/manifest.json")
        self.assertEqual(json.loads(manifest)["version"], "1.3.0")
        # only the version line changed, formatting and "key" kept
        self.assertEqual(manifest.replace('"1.3.0"', '"1.2.3"'), manifest_before)
        self.assertEqual(release.read_companion_version(self.root), "1.3.0")
        self.assertEqual(self.read("site/index.html").count(">1.3.0</span>"), 2)

        changelog = self.read("CHANGELOG.md")
        self.assertIn("## [1.3.0] - 2026-11-17", changelog)
        section = changelog.split("## [1.3.0] - 2026-11-17", 1)[1]
        self.assertEqual(re.findall(r"^### (\w+)", section, re.M), ["Extension", "Companion", "Website"])

        # release works straight after a bump
        version, _ = self.run_release()
        self.assertEqual(version, "1.3.0")

    def test_new_section_goes_above_older_ones(self):
        self.write("CHANGELOG.md", "# Changelog\n\nIntro.\n\n## [1.2.3] - 2026-01-01\n\n### Extension\n\n- old\n")
        bump.bump(self.root, "patch", today=datetime.date(2026, 11, 17), out=self.out.write)
        changelog = self.read("CHANGELOG.md")
        self.assertLess(changelog.index("## [1.2.4]"), changelog.index("## [1.2.3]"))
        self.assertTrue(changelog.startswith("# Changelog\n\nIntro.\n\n## [1.2.4]"))
        bump.bump(self.root, "1.2.4", today=datetime.date(2026, 11, 18), out=self.out.write)
        self.assertEqual(self.read("CHANGELOG.md").count("## [1.2.4]"), 1)  # not duplicated

    def test_repo_changelog_has_the_three_subheadings(self):
        with open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8") as f:
            text = f.read()
        for section in re.split(r"^## ", text, flags=re.M)[1:]:
            self.assertEqual(re.findall(r"^### (\w+)", section, re.M),
                             ["Extension", "Companion", "Website"], section.splitlines()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
