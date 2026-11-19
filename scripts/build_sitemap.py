#!/usr/bin/env python3
"""Write site/sitemap.xml and site/robots.txt for the website's domain.

Search engines need absolute addresses, so run this once the domain is known
(and again whenever a page is added):

    python scripts/build_sitemap.py https://sidm.example.com
    SIDM_SITE_URL=https://sidm.example.com python scripts/build_sitemap.py

Every site/*.html page is listed. Addresses are "clean" (no .html), matching
"cleanUrls": true in site/vercel.json; pass --keep-html for hosts without clean
URLs. Until the domain is decided the committed files use the placeholder
https://sidm.example. Standard library only.
"""

import argparse
import datetime
import os
from pathlib import Path
from xml.sax.saxutils import escape

SITE = Path(__file__).resolve().parent.parent / "site"
PLACEHOLDER = "https://sidm.example"
# Pages that are less important for search get a lower priority.
PRIORITY = {"index.html": "1.0", "guides.html": "0.8", "privacy.html": "0.3", "terms.html": "0.3"}


def page_url(base, name, keep_html):
    if name == "index.html":
        return base + "/"
    return f"{base}/{name if keep_html else name[:-5]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("base_url", nargs="?", default=os.environ.get("SIDM_SITE_URL") or PLACEHOLDER)
    ap.add_argument("--keep-html", action="store_true", help="list page.html instead of /page")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")
    if not base.startswith("https://"):
        raise SystemExit("base URL must start with https://")

    today = datetime.date.today().isoformat()
    pages = sorted(p.name for p in SITE.glob("*.html"))
    rows = []
    for name in pages:
        rows.append(
            "  <url>\n"
            f"    <loc>{escape(page_url(base, name, args.keep_html))}</loc>\n"
            f"    <lastmod>{today}</lastmod>\n"
            f"    <priority>{PRIORITY.get(name, '0.7')}</priority>\n"
            "  </url>"
        )
    (SITE / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(rows) + "\n</urlset>\n",
        encoding="utf-8",
    )
    (SITE / "robots.txt").write_text(
        "User-agent: *\nAllow: /\nDisallow: /downloads/\n\n" f"Sitemap: {base}/sitemap.xml\n",
        encoding="utf-8",
    )
    print(f"{len(pages)} pages -> site/sitemap.xml, site/robots.txt ({base})")
    if base == PLACEHOLDER:
        print("Placeholder domain: run again with the real https:// address before launch.")


if __name__ == "__main__":
    main()
