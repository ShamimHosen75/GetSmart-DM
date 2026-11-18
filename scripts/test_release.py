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
  <!-- release.py rewrites: <a data-release="extension-zip" href="x"> and
       <span data-release="version">x.y.z</span> -->
  <h1>SIDM <span id="release-version" data-release="version">0.0.0</span></h1>
  <a id="download-link" class="button" data-release="extension-zip" href="downloads/old.zip">Download</a>
  <p>Size: <span data-release="extension-size">size to be confirmed</span></p>
  <p>SHA-256: <code data-release='extension-sha256'>published with the release</code></p>
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
        return release.release(self.root, ["extension"], out=self.out.write, **kwargs)


class ReleaseTest(RepoCopy):
    def test_zip_contents(self):
        version, builds = self.run_release()
        info = builds["extension"]
        self.assertEqual(version, "1.2.3")
        self.assertEqual(info["name"], "sidm-v1.2.3-extension.zip")
        with zipfile.ZipFile(info["path"]) as zf:
            names = zf.namelist()
            start_here = zf.read("sidm/START-HERE.txt").decode()

        self.assertTrue(all(n.startswith("sidm/") for n in names), names)
        self.assertIn("sidm/extension/manifest.json", names)
        self.assertIn("sidm/extension/popup.html", names)
        self.assertIn("sidm/extension/offscreen.html", names)
        self.assertIn("sidm/extension/icons/icon128.png", names)
        # The main download is the extension alone: no companion, nothing to install.
        self.assertFalse([n for n in names if n.startswith("sidm/companion/")])
        for forbidden in (".pem", "tests/", ".test.js", ".log", "python/", "run_host"):
            self.assertFalse([n for n in names if forbidden in n], forbidden)
        # The Windows setup program rides along (Settings saves it for the user); no other .exe.
        self.assertEqual([n for n in names if n.endswith(".exe")], ["sidm/extension/setup/SIDM-Setup.exe"])
        self.assertIn("Load unpacked", start_here)
        self.assertNotIn("install.bat", start_here)
        self.assertIn("\r\n", start_here)

    def test_setup_program(self):
        _, builds = release.release(self.root, ["companion-setup"], out=self.out.write)
        info = builds["companion-setup"]
        self.assertEqual(info["name"], "sidm-v1.2.3-companion-setup.exe")
        with open(info["path"], "rb") as f:
            data = f.read()
        self.assertEqual(data[:2], b"MZ")
        self.assertIn(b"Nullsoft", data)
        _, again = release.release(self.root, ["companion-setup"], out=self.out.write)
        self.assertEqual(info["sha256"], again["companion-setup"]["sha256"])  # reproducible

    def test_no_setup(self):
        _, builds = release.release(self.root, ["extension", "companion-setup"], out=self.out.write, setup=False)
        self.assertEqual(list(builds), ["extension"])
        with zipfile.ZipFile(builds["extension"]["path"]) as zf:
            self.assertFalse([n for n in zf.namelist() if n.endswith(".exe")])

    def test_companion_windows_zip(self):
        self.write("companion/update.bat", "@echo off\necho hi\n")  # LF checkout
        _, builds = release.release(self.root, ["companion-windows"], out=self.out.write)
        info = builds["companion-windows"]
        self.assertEqual(info["name"], "sidm-v1.2.3-companion-windows.zip")
        with zipfile.ZipFile(info["path"]) as zf:
            names = zf.namelist()
            start_here = zf.read("sidm/START-HERE.txt").decode()
            install_bat = zf.read("sidm/companion/install.bat")
            update_bat = zf.read("sidm/companion/update.bat")
        self.assertEqual(sorted(n for n in names if n != "sidm/START-HERE.txt"), [f"sidm/companion/{n}" for n in
                         ["README.md", "host.py", "install.bat", "uninstall.bat", "update.bat"]])
        for forbidden in (".pem", ".log", ".exe", "python/", "run_host", "extension/"):
            self.assertFalse([n for n in names if forbidden in n], forbidden)
        self.assertIn("install.bat", start_here)
        self.assertNotIn(b"\n", install_bat.replace(b"\r\n", b""))  # CRLF only
        self.assertEqual(update_bat, b"@echo off\r\necho hi\r\n")

    def test_macos_linux_zip(self):
        self.write("companion/install.sh", "#!/usr/bin/env bash\r\necho hi\r\n")  # CRLF checkout
        self.write("companion/yt-dlp", "binary")
        self.write("companion/ffmpeg", "binary")
        self.write("companion/run_host.sh", "#!/bin/sh\n")
        _, builds = release.release(self.root, ["companion-macos-linux"], out=self.out.write)
        info = builds["companion-macos-linux"]
        self.assertEqual(info["name"], "sidm-v1.2.3-companion-macos-linux.zip")
        with zipfile.ZipFile(info["path"]) as zf:
            names = zf.namelist()
            infos = {i.filename: i for i in zf.infolist()}
            start_here = zf.read("sidm/START-HERE.txt").decode()
            install_sh = zf.read("sidm/companion/install.sh")
        companion = sorted(n for n in names if n.startswith("sidm/companion/"))
        self.assertEqual(companion, [f"sidm/companion/{n}" for n in
                                     ["README.md", "host.py", "install.sh", "uninstall.sh"]])
        for forbidden in (".pem", ".bat", ".exe", "yt-dlp", "ffmpeg", "run_host", ".log", "extension/"):
            self.assertFalse([n for n in names if forbidden in n], forbidden)
        self.assertEqual(install_sh, b"#!/usr/bin/env bash\necho hi\n")
        self.assertNotIn("\r", start_here)
        self.assertIn("bash install.sh", start_here)
        for name, zi in infos.items():
            self.assertEqual(zi.create_system, 3, name)
            want = 0o755 if name.endswith((".sh", ".py")) else 0o644
            self.assertEqual((zi.external_attr >> 16) & 0o777, want, name)

    def test_all_platforms_share_one_site_update(self):
        extra = "".join('<a data-release="%s-zip" href="x">z</a><span data-release="%s-size">?</span>'
                        '<code data-release="%s-sha256">?</code>' % (k, k, k)
                        for k in ("companion-windows", "companion-macos-linux", "companion-setup"))
        self.write("site/index.html", SITE_HTML.replace("</body>", extra + "</body>"))
        _, builds = release.release(self.root, list(release.PLATFORMS), out=self.out.write)
        html = self.read("site/index.html")
        self.assertIn('href="downloads/sidm-v1.2.3-companion-macos-linux.zip"', html)
        self.assertIn('href="downloads/sidm-v1.2.3-extension.zip"', html)
        for key in release.PLATFORMS:
            self.assertIn(builds[key]["sha256"], html)
        self.assertNotIn("warning", self.out.getvalue())

    def test_size_and_sha_are_reported_and_reproducible(self):
        _, first = self.run_release()
        path = first["extension"]["path"]
        with open(path, "rb") as f:
            data = f.read()
        self.assertEqual(first["extension"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(first["extension"]["size"], len(data))
        self.assertIn(first["extension"]["sha256"], self.out.getvalue())
        _, second = self.run_release()
        self.assertEqual(first["extension"]["sha256"], second["extension"]["sha256"])

    def test_site_and_version_json_updated(self):
        _, builds = self.run_release()
        info = builds["extension"]
        html = self.read("site/index.html")
        self.assertEqual(html.count(">1.2.3</span>"), 2)
        self.assertIn('href="downloads/sidm-v1.2.3-extension.zip"', html)
        self.assertIn('id="download-link"', html)
        self.assertIn(f">{info['size_text']}</span>", html)
        self.assertIn(f">{info['sha256']}</code>", html)
        self.assertIn('<span data-release="version">x.y.z</span> -->', html)  # comments untouched
        self.assertIn('<a data-release="extension-zip" href="x">', html)
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
        self.assertIn(builds["extension"]["sha256"], html)
        self.assertIn('href="downloads/sidm-v1.2.3-extension.zip"', html)

    def test_missing_site_markers_warn(self):
        self.write("site/index.html", "<html><body>nothing marked</body></html>")
        self.run_release()
        self.assertIn('no data-release="extension-sha256"', self.out.getvalue())

    def test_old_zips_removed_unless_keep(self):
        downloads = self.path("site/downloads")
        os.makedirs(downloads)
        for name in ("sidm-v1.2.2-extension.zip", "sidm-v1.2.2-companion-windows.zip", "notes.txt"):
            self.write(f"site/downloads/{name}", "x")

        self.run_release(keep=True)
        self.assertIn("sidm-v1.2.2-extension.zip", os.listdir(downloads))

        self.run_release()
        self.assertEqual(sorted(os.listdir(downloads)), [
            "notes.txt",
            "sidm-v1.2.2-companion-windows.zip",  # other downloads are not touched
            "sidm-v1.2.3-extension.zip",
        ])

    def test_version_mismatch_fails(self):
        self.set_versions("1.2.3", host_version="1.2.4-dev")
        with self.assertRaisesRegex(release.ReleaseError, "mismatch"):
            self.run_release()
        self.assertFalse(os.path.exists(self.path("site/downloads/sidm-v1.2.3-extension.zip")))

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
        self.assertEqual(re.findall(r"^### (\w+)", section, re.M), ["Extension", "Companion", "Website", "Android"])

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

    def _android(self, version="1.2.3", code=4):
        self.write(release.ANDROID_GRADLE.replace(os.sep, "/"),
                   f'plugins {{}}\n\nval sidmVersionName = "{version}"\nval sidmVersionCode = {code}\n')

    def _apk(self, rel, signed=True):
        path = self.path(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("AndroidManifest.xml", "x")
            if signed:
                zf.writestr("META-INF/CERT.RSA", "sig")
        return path

    def test_android_version_is_checked_and_bumped(self):
        self._android("1.2.3", 4)
        self.run_release()  # same version: fine
        self._android("1.2.2", 4)
        with self.assertRaises(release.ReleaseError):
            self.run_release()
        self._android("1.2.3", 4)
        bump.bump(self.root, "patch", today=datetime.date(2026, 11, 18), out=self.out.write)
        gradle = self.read(release.ANDROID_GRADLE.replace(os.sep, "/"))
        self.assertIn('val sidmVersionName = "1.2.4"', gradle)
        self.assertIn("val sidmVersionCode = 5", gradle)

    def test_android_apks_copied_and_marked(self):
        self._android()
        self._apk("apks/app-arm64-v8a-release.apk")
        self._apk("apks/app-armeabi-v7a-release.apk")
        extra = "".join('<a data-release="%s-zip" href="x">z</a><span data-release="%s-size">?</span>'
                        '<code data-release="%s-sha256">?</code>' % (k, k, k) for k in release.APK_PLATFORMS)
        self.write("site/index.html", SITE_HTML.replace("</body>", extra + "</body>"))
        _, builds = release.release(self.root, ["extension"], out=self.out.write, apk_dir=self.path("apks"))
        html = self.read("site/index.html")
        self.assertIn('href="downloads/sidm-v1.2.3-android.apk"', html)
        self.assertIn('href="downloads/sidm-v1.2.3-android-32bit.apk"', html)
        self.assertIn(builds["android"]["sha256"], html)
        self.assertTrue(os.path.isfile(self.path("site/downloads/sidm-v1.2.3-android.apk")))
        self.assertNotIn("warning", self.out.getvalue())

    def test_unsigned_apk_refused(self):
        self._android()
        self._apk("apks/app-arm64-v8a-release.apk", signed=False)
        self._apk("apks/app-armeabi-v7a-release.apk")
        with self.assertRaises(release.ReleaseError):
            release.release(self.root, ["extension"], out=self.out.write, apk_dir=self.path("apks"))

    def test_repo_changelog_has_the_three_subheadings(self):
        with open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8") as f:
            text = f.read()
        for section in re.split(r"^## ", text, flags=re.M)[1:]:
            # Versions before the Android app (0.5.0) have three parts, later ones four.
            self.assertIn(re.findall(r"^### (\w+)", section, re.M),
                          (["Extension", "Companion", "Website"], ["Extension", "Companion", "Website", "Android"]),
                          section.splitlines()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
