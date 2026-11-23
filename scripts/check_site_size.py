#!/usr/bin/env python3
"""Fail if any file in site/ is 25 MiB or larger.

    python scripts/check_site_size.py

Cloudflare Pages, which serves sidm.online, refuses to deploy a file of 25 MiB
or more. Big release files (the Android APKs) go in the GitHub Release instead;
see scripts/release.py. Standard library only.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIMIT = 25 * 1024 * 1024  # Cloudflare Pages' per-file limit


def too_big(site, limit=LIMIT):
    """Return [(path relative to site, size)] for every file at or over the limit."""
    found = []
    for dirpath, dirnames, filenames in os.walk(site):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            size = os.path.getsize(path)
            if size >= limit:
                found.append((os.path.relpath(path, site).replace(os.sep, "/"), size))
    return found


def main(argv=None):
    site = (argv or sys.argv[1:] or [os.path.join(ROOT, "site")])[0]
    big = too_big(site)
    for rel, size in big:
        print(f"check_site_size.py: {rel} is {size / 1048576:.1f} MiB; the website host "
              f"(Cloudflare Pages) refuses files of 25 MiB or more. Put it in the GitHub Release.",
              file=sys.stderr)
    if not big:
        print(f"site/: every file is under 25 MiB")
    return 1 if big else 0


if __name__ == "__main__":
    sys.exit(main())
