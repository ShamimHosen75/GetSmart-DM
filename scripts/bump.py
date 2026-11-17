#!/usr/bin/env python3
"""Bump the GetSmart DM version everywhere it is written.

    python scripts/bump.py patch     # 0.1.0 -> 0.1.1
    python scripts/bump.py minor     # 0.1.1 -> 0.2.0
    python scripts/bump.py major     # 0.2.0 -> 1.0.0
    python scripts/bump.py 0.1.0     # set an exact version

The current version is read from extension/manifest.json. The new one is
written to:
- extension/manifest.json  "version"
- companion/host.py        VERSION = "..."
- site/index.html          every data-release="version" element (if the page exists)
- CHANGELOG.md             a new empty section with today's date, on top

It does not build ZIPs, write site/version.json or tag anything; that is
release.py and RELEASE.md. Standard library only.
"""

import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release  # noqa: E402  (shares the version readers and the site markers)

ROOT = release.ROOT
CHANGELOG_SECTIONS = ("Extension", "Companion", "Website")


def next_version(current, part):
    if re.fullmatch(r"\d+\.\d+\.\d+", part):
        return part
    major, minor, patch = (int(n) for n in current.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    if part == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise release.ReleaseError(f"expected major, minor, patch or x.y.z, got {part!r}")


def _rewrite(path, pattern, replacement, what):
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    new, n = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if n != 1:
        raise release.ReleaseError(f"could not find {what} in {os.path.relpath(path, ROOT)}")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(new)


def bump_manifest(root, version):
    path = os.path.join(root, "extension", "manifest.json")
    # Edit the text, not json.dump, so key order and formatting stay as they are.
    _rewrite(path, r'("version"\s*:\s*")[^"]*(")', rf"\g<1>{version}\g<2>", '"version"')
    with open(path, encoding="utf-8") as f:
        json.load(f)  # still valid JSON


def bump_host(root, version):
    path = os.path.join(root, "companion", "host.py")
    _rewrite(path, r'^(VERSION\s*=\s*)(["\'])[^"\']*\2', rf'\g<1>"{version}"', "VERSION = \"...\"")


def bump_site(root, version):
    path = os.path.join(root, "site", "index.html")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", newline="") as f:
        html = f.read()
    html, n = release.set_text(html, "version", version)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    return n


def changelog_section(version, date):
    lines = [f"## [{version}] - {date}", ""]
    for name in CHANGELOG_SECTIONS:
        lines += [f"### {name}", "", "- ", ""]
    return "\n".join(lines) + "\n"


def bump_changelog(root, version, date):
    path = os.path.join(root, "CHANGELOG.md")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            text = f.read()
    else:
        text = "# Changelog\n\n"
    if re.search(rf"^## \[{re.escape(version)}\]", text, re.M):
        return False  # already there, leave it alone
    section = changelog_section(version, date)
    match = re.search(r"^## ", text, re.M)
    if match:
        text = text[:match.start()] + section + "\n" + text[match.start():]
    else:
        text = text.rstrip("\n") + "\n\n" + section
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def bump(root, part, today=None, out=print):
    current = release.read_extension_version(root)
    version = next_version(current, part)
    date = (today or datetime.date.today()).isoformat()

    bump_manifest(root, version)
    bump_host(root, version)
    site = bump_site(root, version)
    added = bump_changelog(root, version, date)

    out(f"{current} -> {version}")
    out("  extension/manifest.json")
    out("  companion/host.py")
    if site is None:
        out("  site/index.html not found, skipped")
    else:
        out(f"  site/index.html ({site} version element(s))")
    out(f"  CHANGELOG.md ({'new section ' + date if added else 'section already existed'})")
    return version


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("part", help="major, minor, patch, or an exact x.y.z")
    parser.add_argument("--root", default=ROOT, help=argparse.SUPPRESS)  # used by tests
    args = parser.parse_args(argv)
    try:
        bump(args.root, args.part)
    except release.ReleaseError as err:
        print(f"bump.py: error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
