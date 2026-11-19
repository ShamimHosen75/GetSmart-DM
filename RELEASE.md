# Releasing SIDM

A release is one version number shared by the extension and the companion, one ZIP per platform on the website, and one git tag `v<version>`.

Currently built: the main download, **the extension alone** (`sidm-v<version>-extension.zip`, all systems), and the optional companion for **Windows** (`sidm-v<version>-companion-windows.zip`) and **macOS/Linux** (`sidm-v<version>-companion-macos-linux.zip`).

## Checklist

Copy this list into the release PR or issue and tick it off.

### 1. Prepare

- [ ] `main` is up to date and every PR for this release is merged.
- [ ] Bump the version: `python scripts/bump.py patch` (or `minor`, `major`, or an exact `0.1.0`). This updates `extension/manifest.json`, `companion/host.py` `VERSION`, the version on `site/index.html`, and adds an empty section to `CHANGELOG.md` with today's date.
- [ ] Fill in the new `CHANGELOG.md` section under **Extension**, **Companion** and **Website**. Write "No changes." under a heading that has none.

### 2. Test

- [ ] Run every test script that exists:
  ```
  python scripts/test_release.py
  python scripts/test_host.py
  python scripts/test_extension.py
  python scripts/test_companion.py
  python scripts/test_site.py
  ```
- [ ] The **test** GitHub Actions workflow is green on the release branch.
- [ ] Go through the manual checklists in `extension/QA.md`, `companion/QA.md` and `site/QA.md` (those that exist).

### 3. Build

- [ ] NSIS 3 is installed (`makensis`; Linux: `sudo apt-get install nsis`): release.py builds the Windows setup program `SIDM-Setup.exe` with it, puts it inside the extension ZIP and next to it as `sidm-v<version>-companion-setup.exe`. Without NSIS, pass `--no-setup` (then the ZIP has no setup program).
- [ ] `python scripts/release.py`. It refuses to run if the extension and companion versions differ. It prints the ZIP's size and SHA-256, writes `site/version.json`, updates the size, SHA-256 and download link on `site/index.html`, and removes older ZIPs from `site/downloads/` (pass `--keep` to keep them).
- [ ] `python scripts/test_site.py --strict` passes (the download link points at a ZIP that exists).
- [ ] Check the ZIP listings: one top folder `sidm/` with `START-HERE.txt` and `extension/` (extension ZIP) or `companion/` (companion ZIPs), and no `.pem`, `host.log`, `python/` or `.exe` files.

### 4. Test the ZIP on a clean Windows account

Use a Windows user account that has never had SIDM (a new local account, or Windows Sandbox).

- [ ] Download the extension ZIP from the local site (or copy it over) and check its SHA-256 matches: `certutil -hashfile sidm-v<version>-extension.zip SHA256`.
- [ ] Extract it and follow only `START-HERE.txt`.
- [ ] Fresh Chrome profile: load `sidm\extension` unpacked; the extension ID shown on `chrome://extensions` is `ejkhmcfjnohjikdgfgkhjficmiaoghma`.
- [ ] Without the companion: a normal file download works, and a video download from Facebook, X or LinkedIn works (`extension/QA.md` M15).
- [ ] Optional companion: extract `sidm-v<version>-companion-windows.zip` next to it and run `companion\install.bat` from scratch. It ends with `Done`.
- [ ] Restart Chrome. The popup shows the companion as connected and a YouTube download works.
- [ ] Repeat the extension check in Edge and Brave if they are installed.
- [ ] `uninstall.bat` removes the registration; downloaded files are left alone.

### 4b. Test the macOS/Linux companion ZIP

On a Mac and on a Linux desktop (a fresh user account if possible):

- [ ] Check the SHA-256: `shasum -a 256 sidm-v<version>-companion-macos-linux.zip` (macOS) or `sha256sum ...` (Linux).
- [ ] Load `sidm/extension` from the extension ZIP unpacked; the ID is `ejkhmcfjnohjikdgfgkhjficmiaoghma`.
- [ ] Extract the companion ZIP next to it and follow its `START-HERE.txt`. `ls -l sidm/companion` shows `install.sh` as executable.
- [ ] `bash install.sh` as your normal user ends with `Done`. Restart the browser: companion connected, a video download works.
- [ ] `bash uninstall.sh` removes the manifests; downloaded files are left alone.

### 5. Commit and tag

- [ ] Commit the version bump, `CHANGELOG.md`, `site/index.html`, `site/version.json` and the new ZIPs in `site/downloads/` (release ZIPs are allowed by `.gitignore`):
  ```
  git add -A
  git commit -m "chore: release v<version>"
  ```
- [ ] Merge to `main`, then tag the merge commit and push the tag:
  ```
  git checkout main && git pull
  git tag -a v<version> -m "SIDM <version>"
  git push origin v<version>
  ```
- [ ] Optional: create a GitHub release from the tag, paste the `CHANGELOG.md` section, and attach the ZIP.

### 6. Deploy the website

- [ ] Deploy `site/` to the website host.
- [ ] On the live site: the version, size and SHA-256 are right, the download link works, and the downloaded file's SHA-256 matches.
- [ ] `https://<site>/version.json` returns `{"version": "<version>"}`. Extensions already installed show "Update available" in the popup footer within a day.

### 7. Announce

- [ ] Post the release with the `CHANGELOG.md` section and the download link.

## How users get updates

- **Extension**: once a day at most, the popup fetches `<SITE_URL>/version.json` and shows a small "Update available" link in its footer when the site has a newer version. The link opens the website. `SITE_URL` (`https://sidm.online`) is set in `extension/update-check.js`; while it is empty no check is made.
- **Companion**: `companion\update.bat` downloads the newest `yt-dlp.exe`. A new companion `host.py` arrives with the new ZIP.

## Adding a platform

`scripts/release.py` has a `PLATFORMS` table. A new platform (for example macOS/Linux) adds one entry with the companion files it ships and its `START-HERE.txt` lines, and marks its link, size and SHA-256 on `site/index.html` with `data-release="<platform>-zip"`, `"<platform>-size"` and `"<platform>-sha256"`.
