#!/usr/bin/env python3
"""Build the SIDM download ZIP(s) and update the website.

    python scripts/release.py              # build every platform, remove older ZIPs
    python scripts/release.py --keep       # keep older ZIPs in site/downloads/
    python scripts/release.py --platform extension

What it does:
1. Reads the version from extension/manifest.json and checks that
   companion/host.py VERSION is the same (use scripts/bump.py to change both).
2. Builds site/downloads/sidm-v<version>-<platform>.zip for each
   entry in PLATFORMS. Each ZIP has one top folder, sidm/, holding
   START-HERE.txt and extension/ (the main "extension" ZIP) or companion/
   (the optional "companion-windows" and "companion-macos-linux" ZIPs).
   The Windows setup program (scripts/build_setup.py, needs NSIS) goes inside
   the extension ZIP as extension/setup/SIDM-Setup.exe and, as the
   "companion-setup" platform, to site/downloads/sidm-v<version>-companion-setup.exe.
   --no-setup skips it.
3. Prints each ZIP's size and SHA-256.
4. Writes site/version.json ({"version": "x.y.z"}), which the extension checks
   once a day to show "Update available".
5. With --apk-dir, copies the signed Android APKs (built by GitHub Actions or
   ./gradlew :app:assembleRelease in mobile/android) to
   site/downloads/sidm-v<version>-android.apk (64-bit ARM, nearly every phone)
   and sidm-v<version>-android-32bit.apk (older 32-bit phones). See APK_PLATFORMS.
6. Updates the version, size, SHA-256 and download link on site/index.html.
   It only touches elements marked with data-release="..." attributes:
       data-release="version"            text = 1.2.3 (any number of these)
       data-release="<platform>-zip"     href = downloads/<zip name>
       data-release="<platform>-size"    text = e.g. 1.2 MB
       data-release="<platform>-sha256"  text = hex SHA-256
   The marked elements must hold plain text only (no nested tags).

The ZIPs are reproducible: same files in, same bytes and SHA-256 out.
Standard library only.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOP_FOLDER = "sidm"
ZIP_NAME = "sidm-v{version}-{platform}.zip"
SETUP_NAME = "sidm-v{version}-companion-setup.exe"
# Fixed timestamp for every ZIP entry, so rebuilding gives identical bytes.
ZIP_DATE = (2024, 1, 1, 0, 0, 0)

# Never shipped, wherever they appear under extension/.
EXTENSION_EXCLUDE_DIRS = {"tests", "test", "__pycache__", "node_modules"}
EXTENSION_EXCLUDE_FILES = re.compile(
    r"(\.pem$|\.zip$|\.log$|\.test\.js$|\.spec\.js$|^\.|^Thumbs\.db$|^desktop\.ini$)", re.I
)

# One entry per download. "extension": True ships extension/; "companion_files"
# lists the companion files it ships. Each has its START-HERE.txt lines, the line
# ending those text files need, and "unix": True if it needs executable bits.
# To add a download, add an entry here, then mark its size/SHA/link on
# site/index.html with data-release="<key>-size" and so on.
#
# The main download is "extension": the extension alone, which is all most
# people need (videos are saved by the extension itself since M15). The
# companion ZIPs are optional extras for YouTube and multi-connection downloads.
SETUP_IN_EXTENSION = "setup/SIDM-Setup.exe"  # inside extension/: Settings can save it for the user

PLATFORMS = {
    "extension": {
        "extension": True,
        "bundle_setup": True,  # the Windows setup program rides along, so the ZIP is still the only download
        "companion_files": [],
        "newline": "\r\n",
        "start_here": [
            "SIDM - Smart Internet Download Manager. Nothing else to install.",
            "1. Extract this ZIP to a folder you will keep, for example Documents\\sidm (Windows) or ~/sidm (Mac, Linux).",
            "2. In Chrome, Edge or Brave open chrome://extensions, turn on Developer mode, "
            "click Load unpacked and choose the sidm/extension folder.",
            "3. Pin SIDM from the puzzle-piece menu. Play a video on Facebook, X, LinkedIn and other sites, "
            "then click Download on the video.",
            "Optional, Windows: for YouTube and multi-connection downloads, open SIDM Settings and click "
            "Install SIDM for Windows (or run sidm\\extension\\setup\\SIDM-Setup.exe).",
        ],
    },
    "companion-setup": {
        "setup_file": True,  # the same SIDM-Setup.exe as its own download on the website
        "extension": False,
        "companion_files": [],
    },
    "companion-windows": {
        "extension": False,
        "companion_files": ["host.py", "install.bat", "update.bat", "uninstall.bat", "README.md"],
        "newline": "\r\n",
        "start_here": [
            "SIDM companion app (optional): adds YouTube and multi-connection downloads.",
            "1. Install the SIDM extension first (the main ZIP).",
            "2. Extract this ZIP next to it, for example Documents\\sidm, so you get sidm\\companion.",
            "3. Double-click sidm\\companion\\install.bat, wait for Done, then restart the browser.",
        ],
    },
    "companion-macos-linux": {
        "extension": False,
        "companion_files": ["host.py", "install.sh", "uninstall.sh", "README.md"],
        "newline": "\n",
        "unix": True,  # Unix ZIP entries, so unzip / Archive Utility keep the executable bit
        "start_here": [
            "SIDM companion app (optional): adds YouTube and multi-connection downloads.",
            "1. Install the SIDM extension first (the main ZIP).",
            "2. Extract this ZIP next to it, for example ~/sidm, so you get sidm/companion.",
            "3. Open Terminal in sidm/companion, run: bash install.sh, wait for Done, "
            "then restart the browser.",
        ],
    },
}

# Android APKs: platform key -> processor type of the Gradle split APK
# (app-<abi>-release.apk). They are copied, not built, by --apk-dir, because the
# Android build needs the Android SDK (GitHub Actions has it).
APK_PLATFORMS = {
    "android": "arm64-v8a",
    "android-32bit": "armeabi-v7a",
}
APK_NAME = "sidm-v{version}-{platform}.apk"
ANDROID_GRADLE = os.path.join("mobile", "android", "app", "build.gradle.kts")


class ReleaseError(Exception):
    pass


# --- versions -----------------------------------------------------------------

def read_extension_version(root):
    with open(os.path.join(root, "extension", "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ReleaseError(f"extension/manifest.json version {version!r} is not x.y.z")
    return version


HOST_VERSION_RE = re.compile(r'^VERSION\s*=\s*["\']([^"\']+)["\']', re.M)


def read_companion_version(root):
    with open(os.path.join(root, "companion", "host.py"), encoding="utf-8") as f:
        match = HOST_VERSION_RE.search(f.read())
    if not match:
        raise ReleaseError("could not find VERSION = \"...\" in companion/host.py")
    return match.group(1)


ANDROID_VERSION_RE = re.compile(r'^val sidmVersionName\s*=\s*"([^"]+)"', re.M)


def read_android_version(root):
    """The Android app's versionName, or None if the Android app is not in this tree."""
    path = os.path.join(root, ANDROID_GRADLE)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        match = ANDROID_VERSION_RE.search(f.read())
    if not match:
        raise ReleaseError(f'could not find val sidmVersionName = "..." in {ANDROID_GRADLE}')
    return match.group(1)


def apk_is_signed(path):
    """True if the APK has a v1 (META-INF/*.RSA) or v2+ (APK Signing Block) signature."""
    with open(path, "rb") as f:
        data = f.read()
    if b"APK Sig Block 42" in data[-(4 << 20):] or b"APK Sig Block 42" in data:
        return True
    with zipfile.ZipFile(path) as zf:
        return any(re.match(r"META-INF/[^/]+\.(RSA|DSA|EC)$", n) for n in zf.namelist())


# --- ZIP contents -------------------------------------------------------------

def extension_files(root):
    """Yield (path on disk, path inside extension/) for every shipped file."""
    base = os.path.join(root, "extension")
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames
                             if d.lower() not in EXTENSION_EXCLUDE_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            if EXTENSION_EXCLUDE_FILES.search(name):
                continue
            path = os.path.join(dirpath, name)
            yield path, os.path.relpath(path, base).replace(os.sep, "/")


def text_with_newline(data, newline):
    """Normalise a text file's line endings (a .bat with LF endings breaks cmd.exe)."""
    text = data.replace(b"\r\n", b"\n")
    return text.replace(b"\n", newline.encode()) if newline != "\n" else text


def zip_entries(root, platform, setup_bytes=None):
    """Return a sorted list of (name inside the ZIP, bytes)."""
    spec = PLATFORMS[platform]
    entries = []
    if spec.get("bundle_setup") and setup_bytes:
        entries.append((f"{TOP_FOLDER}/extension/{SETUP_IN_EXTENSION}", setup_bytes))

    if spec["extension"]:
        for path, rel in extension_files(root):
            with open(path, "rb") as f:
                entries.append((f"{TOP_FOLDER}/extension/{rel}", f.read()))

    for name in spec["companion_files"]:
        path = os.path.join(root, "companion", name)
        if not os.path.isfile(path):
            raise ReleaseError(f"companion/{name} is missing")
        with open(path, "rb") as f:
            data = f.read()
        if name.lower().endswith((".bat", ".cmd")):
            data = text_with_newline(data, "\r\n")
        elif name.lower().endswith(".sh"):
            data = text_with_newline(data, "\n")  # a CRLF shell script fails with "$'\r': command not found"
        entries.append((f"{TOP_FOLDER}/companion/{name}", data))

    newline = spec["newline"]
    start_here = newline.join(spec["start_here"]) + newline
    entries.append((f"{TOP_FOLDER}/START-HERE.txt", start_here.encode("utf-8")))

    entries.sort(key=lambda item: item[0])
    check_entries(entries, spec["extension"])
    return entries


def check_entries(entries, has_extension=True):
    names = [name for name, _ in entries]
    if has_extension and not any(n == f"{TOP_FOLDER}/extension/manifest.json" for n in names):
        raise ReleaseError("extension/manifest.json is not in the ZIP")
    bad = [n for n in names if n.lower().endswith(".pem") or n.lower().endswith(".log")]
    bad += [n for n in names if n.lower().endswith(".exe") and n != f"{TOP_FOLDER}/extension/{SETUP_IN_EXTENSION}"]
    if bad:  # belt and braces: the private key must never ship
        raise ReleaseError(f"refusing to ship {bad}")


EXECUTABLE = re.compile(r"\.(sh|py)$", re.I)


def write_zip(path, entries, unix=False):
    """Write the ZIP. unix=True marks entries as made on Unix, so unzip and macOS
    Archive Utility apply the file modes: .sh and .py get 0755, the rest 0644.
    (Mode bits in "MS-DOS" entries are ignored by those tools.)"""
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            if unix:
                mode = 0o755 if EXECUTABLE.search(name) else 0o644
                info.external_attr = (0o100000 | mode) << 16  # regular file + mode
                info.create_system = 3  # Unix
            else:
                info.external_attr = 0o644 << 16
                info.create_system = 0  # "MS-DOS", so Windows Explorer shows no odd attributes
            zf.writestr(info, data)
    os.replace(tmp, path)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def human_size(size):
    if size < 1024 * 1024:
        return f"{max(1, round(size / 1024))} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def remove_old_zips(downloads, platform, keep_name):
    removed = []
    ext = "apk" if platform in APK_PLATFORMS else "exe" if PLATFORMS[platform].get("setup_file") else "zip"
    for path in glob.glob(os.path.join(downloads, f"sidm-v*-{platform}.{ext}")):
        if os.path.basename(path) != keep_name:
            os.remove(path)
            removed.append(os.path.basename(path))
    return sorted(removed)


# --- website ------------------------------------------------------------------

def _element_re(key):
    # <tag ... data-release="key" ...>plain text</tag>
    return re.compile(
        r'(<(?P<tag>[a-zA-Z][\w-]*)\b[^>]*\bdata-release\s*=\s*["\']' + re.escape(key)
        + r'["\'][^>]*>)(?P<text>[^<]*)(</(?P=tag)\s*>)'
    )


COMMENT_RE = re.compile(r"(<!--.*?-->)", re.S)


def _outside_comments(html, sub):
    """Apply sub(text) -> (text, count) to everything except <!-- comments -->."""
    parts = COMMENT_RE.split(html)
    total = 0
    for i in range(0, len(parts), 2):  # even indexes are outside comments
        parts[i], n = sub(parts[i])
        total += n
    return "".join(parts), total


def set_text(html, key, value):
    pattern = _element_re(key)
    return _outside_comments(html, lambda part: pattern.subn(lambda m: m.group(1) + value + m.group(4), part))


def set_href(html, key, value):
    pattern = re.compile(
        r'<[a-zA-Z][\w-]*\b[^>]*\bdata-release\s*=\s*["\']' + re.escape(key) + r'["\'][^>]*>'
    )

    def fix(match):
        tag = match.group(0)
        if re.search(r'\bhref\s*=', tag):
            return re.sub(r'\bhref\s*=\s*(["\']).*?\1', f'href="{value}"', tag, count=1)
        return tag[:-1].rstrip("/").rstrip() + f' href="{value}">'

    return _outside_comments(html, lambda part: pattern.subn(fix, part))


def update_site_html(path, version, builds):
    """Rewrite the data-release elements. Returns a list of warnings."""
    with open(path, encoding="utf-8") as f:
        html = f.read()
    warnings = []

    html, n = set_text(html, "version", version)
    if not n:
        warnings.append('no data-release="version" element')
    for platform, info in builds.items():
        for key, setter, value in (
            (f"{platform}-zip", set_href, f"downloads/{info['name']}"),
            (f"{platform}-size", set_text, info["size_text"]),
            (f"{platform}-sha256", set_text, info["sha256"]),
        ):
            html, n = setter(html, key, value)
            if not n:
                warnings.append(f'no data-release="{key}" element')

    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    return warnings


def write_version_json(site, version):
    with open(os.path.join(site, "version.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"version": version}) + "\n")


# --- main ---------------------------------------------------------------------

def build_setup_bytes(root, version):
    """The Windows setup program (scripts/build_setup.py), as bytes."""
    import tempfile
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from build_setup import SetupError, build_setup
    with tempfile.TemporaryDirectory(prefix="sidm-release-setup-") as tmp:
        try:
            path = build_setup(root, version, tmp)
        except SetupError as err:
            raise ReleaseError(f"{err}. Use --no-setup to build without the Windows setup program.")
        with open(path, "rb") as f:
            return f.read()


def release(root, platforms, keep=False, out=print, setup=True, apk_dir=None):
    version = read_extension_version(root)
    companion_version = read_companion_version(root)
    if companion_version != version:
        raise ReleaseError(
            f"version mismatch: extension/manifest.json is {version}, companion/host.py is "
            f"{companion_version}. Run scripts/bump.py to set both."
        )
    android_version = read_android_version(root)
    if android_version is not None and android_version != version:
        raise ReleaseError(
            f"version mismatch: extension/manifest.json is {version}, {ANDROID_GRADLE} is "
            f"{android_version}. Run scripts/bump.py to set all of them."
        )

    site = os.path.join(root, "site")
    downloads = os.path.join(site, "downloads")
    os.makedirs(downloads, exist_ok=True)

    out(f"SIDM {version}")
    if not setup:
        platforms = [p for p in platforms if not PLATFORMS[p].get("setup_file")]
    needs_setup = setup and any(PLATFORMS[p].get("bundle_setup") or PLATFORMS[p].get("setup_file") for p in platforms)
    setup_bytes = build_setup_bytes(root, version) if needs_setup else None
    builds = {}
    for platform in platforms:
        if PLATFORMS[platform].get("setup_file"):
            name = SETUP_NAME.format(version=version)
            path = os.path.join(downloads, name)
            with open(path, "wb") as f:
                f.write(setup_bytes)
            entries = [(name, setup_bytes)]
        else:
            name = ZIP_NAME.format(version=version, platform=platform)
            path = os.path.join(downloads, name)
            entries = zip_entries(root, platform, setup_bytes)
            write_zip(path, entries, unix=PLATFORMS[platform].get("unix", False))
        size = os.path.getsize(path)
        info = {"name": name, "path": path, "size": size, "size_text": human_size(size),
                "sha256": sha256_of(path), "files": len(entries)}
        builds[platform] = info
        out(f"  {os.path.relpath(path, root)}")
        out(f"    files:   {info['files']}")
        out(f"    size:    {size} bytes ({info['size_text']})")
        out(f"    sha256:  {info['sha256']}")
        if not keep:
            for old in remove_old_zips(downloads, platform, name):
                out(f"    removed old {old}")

    if apk_dir:
        for platform, abi in APK_PLATFORMS.items():
            source = os.path.join(apk_dir, f"app-{abi}-release.apk")
            if not os.path.isfile(source):
                raise ReleaseError(f"{source} not found (expected the signed release APK for {abi})")
            if not apk_is_signed(source):
                raise ReleaseError(f"{source} is not signed; sign it with the SIDM release key first")
            name = APK_NAME.format(version=version, platform=platform)
            path = os.path.join(downloads, name)
            with open(source, "rb") as src, open(path, "wb") as dst:
                dst.write(src.read())
            size = os.path.getsize(path)
            info = {"name": name, "path": path, "size": size, "size_text": human_size(size),
                    "sha256": sha256_of(path), "files": 1}
            builds[platform] = info
            out(f"  {os.path.relpath(path, root)}")
            out(f"    size:    {size} bytes ({info['size_text']})")
            out(f"    sha256:  {info['sha256']}")
            if not keep:
                for old in remove_old_zips(downloads, platform, name):
                    out(f"    removed old {old}")

    write_version_json(site, version)
    out("  site/version.json updated")

    index = os.path.join(site, "index.html")
    if os.path.isfile(index):
        warnings = update_site_html(index, version, builds)
        out("  site/index.html updated")
        for warning in warnings:
            out(f"    warning: {warning}")
    else:
        out("  warning: site/index.html not found, website text not updated")
    return version, builds


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--keep", action="store_true", help="keep older ZIPs in site/downloads/")
    parser.add_argument("--platform", choices=sorted(PLATFORMS), action="append",
                        help="build only this platform (repeatable); default: all")
    parser.add_argument("--no-setup", action="store_true",
                        help="skip the Windows setup program (when NSIS is not installed)")
    parser.add_argument("--apk-dir", help="folder with the signed app-<abi>-release.apk files; "
                        "adds the Android downloads (sidm-v<version>-android.apk, -android-32bit.apk)")
    parser.add_argument("--root", default=ROOT, help=argparse.SUPPRESS)  # used by tests
    args = parser.parse_args(argv)
    try:
        release(args.root, args.platform or list(PLATFORMS), keep=args.keep, setup=not args.no_setup,
                apk_dir=args.apk_dir)
    except ReleaseError as err:
        print(f"release.py: error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
