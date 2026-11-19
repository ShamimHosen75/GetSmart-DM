#!/usr/bin/env python3
"""Write site/sitemap.xml, site/robots.txt and each page's address tags.

Search engines and link previews need absolute addresses, so this script owns
everything that names the domain. Run it again whenever a page is added or the
domain changes:

    python scripts/build_sitemap.py                      # https://sidm.online
    python scripts/build_sitemap.py https://other.domain
    SIDM_SITE_URL=https://other.domain python scripts/build_sitemap.py

In every site/*.html page it rewrites the block between <!-- seo:start --> and
<!-- seo:end --> (added after the theme-color tag if missing): canonical link,
Open Graph tags (title and description taken from the page) and the Twitter
card, with assets/og-card.jpg as the share image.

Every site/*.html page is listed. Addresses are "clean" (no .html), matching
"cleanUrls": true in site/vercel.json; pass --keep-html for hosts without clean
URLs. Standard library only.
"""

import argparse
import html
import re
import datetime
import os
from pathlib import Path
from xml.sax.saxutils import escape

SITE = Path(__file__).resolve().parent.parent / "site"
DEFAULT_BASE = "https://sidm.online"
OG_IMAGE = "assets/og-card.jpg"
# Pages that are less important for search get a lower priority.
PRIORITY = {"index.html": "1.0", "guides.html": "0.8", "privacy.html": "0.3", "terms.html": "0.3"}


def page_url(base, name, keep_html):
    if name == "index.html":
        return base + "/"
    return f"{base}/{name if keep_html else name[:-5]}"


SEO_BLOCK = re.compile(r"\n *<!-- seo:start -->.*?<!-- seo:end -->", re.S)
OLD_OG = re.compile(r'\n *<meta property="og:[^"]+" content="[^"]*">')


def write_head_tags(path, base, url):
    page = path.read_text(encoding="utf-8")
    title = html.unescape(re.search(r"<title>(.*?)</title>", page, re.S).group(1).strip())
    desc = html.unescape(re.search(r'<meta name="description" content="([^"]*)">', page).group(1))
    kind = "website" if path.name in ("index.html", "guides.html") else "article"
    esc = lambda v: html.escape(v, quote=True)
    tags = [
        f'<link rel="canonical" href="{esc(url)}">',
        f'<meta property="og:type" content="{kind}">',
        '<meta property="og:site_name" content="SIDM">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(desc)}">',
        f'<meta property="og:url" content="{esc(url)}">',
        f'<meta property="og:image" content="{base}/{OG_IMAGE}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:alt" content="SIDM - Smart Internet Download Manager. Download Smarter. Faster. Better.">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    block = "\n    <!-- seo:start -->\n" + "".join(f"    {t}\n" for t in tags) + "    <!-- seo:end -->"
    page = OLD_OG.sub("", SEO_BLOCK.sub("", page))
    anchor = re.search(r'\n *<meta name="theme-color"[^>]*>', page)
    page = page[: anchor.end()] + block + page[anchor.end():]
    path.write_text(page, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("base_url", nargs="?", default=os.environ.get("SIDM_SITE_URL") or DEFAULT_BASE)
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
    for name in pages:
        write_head_tags(SITE / name, base, page_url(base, name, args.keep_html))
    print(f"{len(pages)} pages -> site/sitemap.xml, site/robots.txt, page tags ({base})")


if __name__ == "__main__":
    main()
