# scripts/

Packaging, release and test scripts. Python 3 standard library only, except the Playwright tests.

| Script | What it does |
|---|---|
| `release.py` | Builds `site/downloads/sidm-v<version>-<platform>.zip`, prints size and SHA-256, writes `site/version.json`, updates `site/index.html`. `--keep` keeps older ZIPs, `--platform extension` builds one download. |
| `check_site_size.py` | Fails if any file in `site/` is 25 MiB or larger (Cloudflare Pages refuses them). Run by the test workflow and by `release.py`; the Android APKs go in the GitHub Release instead. |
| `bump.py` | `bump.py major\|minor\|patch\|x.y.z`: sets the version in `extension/manifest.json`, `companion/host.py`, `site/index.html`, and adds a dated `CHANGELOG.md` section. |
| `test_release.py` | Tests for `release.py` and `bump.py` (works on a temporary copy). |
| `test_host.py` | Tests `companion/host.py` over native messaging. Needs yt-dlp. |
| `test_site.py` | QA for `site/` (popup screenshots, renders at 1280/390 px, link check, download link, HTML validation). Needs `pip install playwright pillow` and `python -m playwright install chromium`; `html5validator` optional. `--strict` fails if the ZIP the page links to is missing. |
| `deploy_site.md` | How to deploy `site/` to Vercel or GitHub Pages and point a custom domain. |
| `extension_id.py` | Prints the fixed extension ID from the manifest key. |
| `make_icons.py` | Regenerates the extension icons. |

The full release steps are in [`RELEASE.md`](../RELEASE.md). The **test** GitHub Actions workflow (`.github/workflows/test.yml`) runs every test script on each push.

## Website markers used by release.py

`release.py` only changes elements on `site/index.html` that carry a `data-release` attribute, and those elements must hold plain text:

| Attribute | Gets |
|---|---|
| `data-release="version"` | the version, e.g. `0.1.0` (any number of elements) |
| `data-release="extension-zip"` | `href="downloads/sidm-v<version>-extension.zip"` (the main download) |
| `data-release="extension-size"` | the size, e.g. `48 KB` |
| `data-release="extension-sha256"` | the hex SHA-256 |
| `data-release="companion-windows-zip"`, `-size`, `-sha256` | the same for the optional Windows companion ZIP (install section) |
| `data-release="companion-macos-linux-zip"`, `-size`, `-sha256` | the same for the optional macOS/Linux companion ZIP (FAQ) |
