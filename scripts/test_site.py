#!/usr/bin/env python3
"""QA for the static website in site/.

What it does, in order:

  1. Popup screenshots: loads extension/ unpacked in Chromium, opens the real
     popup page and saves two quantised PNGs into site/assets/
     (popup-downloads.png light, popup-this-page.png dark). Re-run any time the
     popup changes. Skip with --no-popup.
  2. Page renders: index.html, privacy.html and terms.html at 1280 px and
     390 px wide, light and dark, saved to test-results/site/ (gitignored).
     Fails if any page scrolls sideways at either width.
  3. Links: serves site/ on a local port and requests every internal href/src
     on every page. Fails on any non-200 or a #fragment with no matching id.
     External links are listed, not fetched.
  4. Download links: every data-release="<platform>-zip" link (Windows in the
     hero, macOS/Linux in the FAQ) must point at
     downloads/getsmart-dm-v<version>-<platform>.zip, matching #release-version.
     A missing ZIP is reported as EXPECTED-MISSING (the Step 4 release script
     creates it) and does not fail the run, unless --strict is given.
  5. HTML validation with html5validator (needs Java) if it is installed;
     otherwise skipped.

Needs: pip install playwright pillow   then   python -m playwright install chromium
       (optional) pip install html5validator

    python scripts/test_site.py            # everything
    python scripts/test_site.py --no-popup # keep the current screenshots
    python scripts/test_site.py --strict   # release check: ZIP must exist

Exit code 0 = all checks passed (missing ZIP allowed without --strict).
"""

import argparse
import functools
import html.parser
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
EXTENSION = ROOT / "extension"
OUT = ROOT / "test-results" / "site"
PAGES = ["index.html", "privacy.html", "terms.html"]
EXTENSION_ID = "ejkhmcfjnohjikdgfgkhjficmiaoghma"  # fixed by the "key" in manifest.json
WIDTHS = [1280, 390]
POPUP_COLORS = 64  # palette size for the quantised screenshots

# Fallback Chromium locations, used only when Playwright's own browser is missing.
CHROMIUM_FALLBACKS = [os.environ.get("CHROMIUM_PATH", ""), "/opt/pw-browsers/chromium"]

results = []  # (status, check, detail)


def report(status, check, detail=""):
    results.append((status, check, detail))
    print(f"[{status}] {check}" + (f": {detail}" if detail else ""), flush=True)


# ---------------------------------------------------------------------------
# Browser launch
# ---------------------------------------------------------------------------

def launch_kwargs():
    """Extra kwargs for launch(): an explicit executable only when needed."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        if Path(p.chromium.executable_path).exists():
            return {}
    for path in CHROMIUM_FALLBACKS:
        if path and Path(path).exists():
            return {"executable_path": path}
    sys.exit("Chromium not found. Run: python -m playwright install chromium")


# ---------------------------------------------------------------------------
# 1. Popup screenshots
# ---------------------------------------------------------------------------

def quantise(path):
    try:
        from PIL import Image
    except ImportError:
        report("WARN", "quantise " + path.name, "Pillow not installed, PNG left as is")
        return
    img = Image.open(path).convert("RGB")
    img.quantize(colors=POPUP_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(
        path, optimize=True
    )


def capture_popup(pw, kwargs):
    profile = tempfile.mkdtemp(prefix="gsdm-profile-")
    ext = str(EXTENSION)
    try:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            channel="chromium",  # new headless mode, which can load extensions
            headless=True,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"],
            viewport={"width": 400, "height": 360},
            device_scale_factor=2,
            locale="en-US",
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001
        report("FAIL", "popup screenshots", f"could not start Chromium with the extension: {exc}")
        return
    try:
        if not ctx.service_workers:
            ctx.wait_for_event("serviceworker", timeout=10_000)
        shots = [
            ("popup-downloads.png", "light", None),
            ("popup-this-page.png", "dark", "#tab-page"),
        ]
        for name, scheme, click in shots:
            page = ctx.new_page()
            page.emulate_media(color_scheme=scheme)
            page.goto(f"chrome-extension://{EXTENSION_ID}/popup.html")
            page.wait_for_selector(".brand-name:not(:empty)")
            if click:
                page.click(click)
            else:
                page.click("#tab-downloads")
            page.wait_for_timeout(200)
            dest = SITE / "assets" / name
            page.screenshot(path=str(dest))
            quantise(dest)
            report("PASS", f"popup screenshot {name}", f"{dest.stat().st_size // 1024} KB")
            page.close()
    finally:
        ctx.close()
        shutil.rmtree(profile, ignore_errors=True)


# ---------------------------------------------------------------------------
# 2. Page renders
# ---------------------------------------------------------------------------

def render_pages(pw, kwargs, base_url):
    OUT.mkdir(parents=True, exist_ok=True)
    browser = pw.chromium.launch(**kwargs)
    try:
        for width in WIDTHS:
            for scheme in ("light", "dark"):
                ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme)
                page = ctx.new_page()
                for name in PAGES:
                    page.goto(f"{base_url}/{name}")
                    page.wait_for_load_state("load")
                    stem = name.removesuffix(".html")
                    page.screenshot(path=str(OUT / f"{stem}-{width}-{scheme}.png"), full_page=True)
                    if scheme == "light":
                        overflow = page.evaluate(
                            "document.documentElement.scrollWidth - document.documentElement.clientWidth"
                        )
                        if overflow > 0:
                            report("FAIL", f"no horizontal scroll {name} @{width}", f"{overflow}px too wide")
                        else:
                            report("PASS", f"no horizontal scroll {name} @{width}")
                ctx.close()
    finally:
        browser.close()
    report("PASS", "page renders", f"saved to {OUT.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# 3. Links
# ---------------------------------------------------------------------------

class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []  # (attr value, tag)
        self.ids = set()
        self.by_id = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
            self.by_id[attrs["id"]] = attrs
        for key in ("href", "src"):
            if attrs.get(key):
                self.links.append((attrs[key], tag))


def parse(name):
    parser = LinkParser()
    parser.feed((SITE / name).read_text(encoding="utf-8"))
    return parser


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def check_links(base_url, download_href):
    """download_href: the set of release ZIP links, which check_download covers."""
    parsed = {name: parse(name) for name in PAGES}
    external = set()
    bad = []
    checked = 0
    for name, parser in parsed.items():
        for value, _tag in parser.links:
            url = urllib.parse.urlsplit(value)
            if url.scheme in ("http", "https", "mailto"):
                external.add(value)
                continue
            if value in download_href:
                continue  # release ZIPs are checked separately in check_download
            target = url.path or name
            if url.fragment:
                if target not in parsed:
                    bad.append(f"{name}: {value} (fragment on unknown page)")
                elif url.fragment not in parsed[target].ids:
                    bad.append(f"{name}: {value} (no id '{url.fragment}' in {target})")
            if url.path:
                checked += 1
                try:
                    with urllib.request.urlopen(f"{base_url}/{url.path}") as resp:
                        if resp.status != 200:
                            bad.append(f"{name}: {value} (HTTP {resp.status})")
                except urllib.error.HTTPError as exc:
                    bad.append(f"{name}: {value} (HTTP {exc.code})")
    if bad:
        report("FAIL", "internal links", "; ".join(bad))
    else:
        report("PASS", "internal links", f"{checked} local URLs return 200, all #fragments exist")
    report("INFO", "external links (not fetched)", ", ".join(sorted(external)))


# ---------------------------------------------------------------------------
# 4. Download link
# ---------------------------------------------------------------------------

def check_download(strict):
    """Check every release ZIP link (data-release="<platform>-zip"). Returns their hrefs."""
    index = parse("index.html")
    html_text = (SITE / "index.html").read_text(encoding="utf-8")
    version_match = re.search(r'id="release-version"[^>]*>([^<]+)<', html_text)
    version = version_match.group(1).strip() if version_match else ""
    link = index.by_id.get("download-link", {})
    if link.get("data-release") != "windows-zip":
        report("FAIL", "download link", '#download-link has no data-release="windows-zip"')
    hrefs = set()
    for platform, href in re.findall(
            r'<a\b[^>]*\bdata-release="([\w-]+)-zip"[^>]*\bhref="([^"]*)"', html_text):
        hrefs.add(href)
        check = f"download link ({platform})"
        expected = f"downloads/getsmart-dm-v{version}-{platform}.zip"
        if href != expected:
            report("FAIL", check, f"href is '{href}', expected '{expected}' (from #release-version)")
            continue
        zip_path = SITE / href
        if zip_path.is_file():
            report("PASS", check, f"{href} exists ({zip_path.stat().st_size / 1_048_576:.1f} MB)")
        elif strict:
            report("FAIL", check, f"{href} does not exist")
        else:
            report("EXPECTED-MISSING", check,
                   f"{href} not built yet; scripts/release.py puts it in site/downloads/")
    if not hrefs:
        report("FAIL", "download link", 'no data-release="<platform>-zip" links found')
    return hrefs


# ---------------------------------------------------------------------------
# 5. HTML validation
# ---------------------------------------------------------------------------

def validate_html():
    exe = shutil.which("html5validator")
    if not exe:
        report("SKIP", "HTML validation", "html5validator not installed (pip install html5validator, needs Java)")
        return
    proc = subprocess.run(
        [exe, "--root", str(SITE), "--match", "*.html", "--show-warnings"],
        capture_output=True,
        text=True,
    )
    # html5validator counts every stderr line as an error, including Java's
    # "Picked up JAVA_TOOL_OPTIONS" notice, so drop that line before judging.
    lines = [
        line
        for line in (proc.stdout + proc.stderr).splitlines()
        if line.strip() and not line.startswith("Picked up JAVA_TOOL_OPTIONS")
    ]
    output = "\n".join(lines)
    if proc.returncode == 0 or not lines:
        report("PASS", "HTML validation", output or "no errors or warnings")
    else:
        report("FAIL", "HTML validation", output)


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--no-popup", action="store_true", help="do not retake the popup screenshots")
    ap.add_argument("--strict", action="store_true", help="fail if the release ZIP is missing")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    kwargs = launch_kwargs()
    server, base_url = serve()
    try:
        with sync_playwright() as pw:
            if not args.no_popup:
                capture_popup(pw, kwargs)
            render_pages(pw, kwargs, base_url)
        download_href = check_download(args.strict)
        check_links(base_url, download_href)
        validate_html()
    finally:
        server.shutdown()

    failed = [r for r in results if r[0] == "FAIL"]
    print()
    print(f"{len(results)} checks: {len(failed)} failed, "
          f"{sum(r[0] == 'EXPECTED-MISSING' for r in results)} expected-missing, "
          f"{sum(r[0] == 'SKIP' for r in results)} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    start = time.time()
    code = main()
    print(f"done in {time.time() - start:.1f}s")
    sys.exit(code)
