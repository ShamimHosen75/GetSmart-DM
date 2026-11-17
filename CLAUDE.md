# CLAUDE.md: GetSmart DM

Permanent rules for anyone (human or AI) working in this repo. Read this first, every session.

## Project overview

**GetSmart DM** ("Download Smarter. Faster. Better.") is a free download manager for **Chrome, Edge and Brave on Windows**, with a companion installer for **macOS and Linux** too (Step 5).

- Distributed from our own website as a ZIP. It is **not** published on the Chrome Web Store, because it downloads videos from social sites.
- It is an original product. **Never copy the name, logo, UI, text or code of Internet Download Manager or any other product.**

## Folder map

| Folder | Contents |
|---|---|
| `extension/` | Chrome extension, Manifest V3, plain JavaScript ES modules, no build step |
| `companion/` | Companion app: Python native-messaging host that runs yt-dlp + ffmpeg. One `host.py` for all systems; `*.bat` installers for Windows, `*.sh` for macOS/Linux |
| `site/` | Static download website (HTML/CSS, no framework) |
| `scripts/` | Packaging and release scripts |
| `shared/` | Contracts shared by extension and companion; `shared/protocol.md` is the protocol spec |

Each folder has its own `README.md`, and each folder that ships features has a `QA.md`.

## Build order

Step 0 (done): repo skeleton (this file, folders, `.gitignore`, `shared/protocol.md`).

1. `extension/`
2. `companion/`
3. `site/`
4. `scripts/`
5. Companion for macOS and Linux (`companion/install.sh`, `uninstall.sh`, macOS/Linux release ZIP)

Later: Android app.

## Current step

**Step 5: companion for macOS and Linux.** Current step = 5.

Step 5 adds `companion/install.sh` and `uninstall.sh` (bash 3.2 compatible, no sudo, system `python3`, yt-dlp + ffmpeg into the companion folder, manifest copied to Chrome/Chromium/Edge/Brave `NativeMessagingHosts` folders), the `macos-linux` entry in `scripts/release.py` `PLATFORMS`, the companion README section and the website FAQ answer. `host.py` stays one file for all systems: Windows-only code is behind `IS_WIN`; on Linux it reads the XDG Downloads folder.

Status: **Step 5 done**, waiting for the owner's "continue". Tested for real on Linux x86_64 (install, Chromium native messaging, a download, uninstall). macOS has not been run yet.

Step 4 (`scripts/`) builds the release tooling: `scripts/release.py` (Windows ZIP, size + SHA-256, `site/version.json`, `site/index.html` via `data-release` markers), `scripts/bump.py`, `CHANGELOG.md`, `RELEASE.md` (checklist and `v<version>` tags), the popup "Update available" footer link (`extension/update-check.js`) and the `test` GitHub Actions workflow.

Step 4 status: **release tooling done**, waiting for the owner's "continue". Open: the website domain for `SITE_URL` in `extension/update-check.js`.

Earlier steps are not finished yet:
- Step 1 (`extension/`): M1 to M9 done, version 0.1.0 (`scripts/test_extension.py` passes). Next: M10+ download-manager features the owner asked for (video overlay button, per-download progress panel, multi-connection downloads through the companion, full manager page, speed limiter, scheduler, on-completion options).
- Step 2 (`companion/`): M1 (`host.py` + `scripts/test_host.py`), M2 (bat files + README), M3 (`scripts/test_companion.py`, end to end with the extension's M7 bridge) and M4 (`companion/QA.md`, version 0.1.0, CHANGELOG) done. Open: the owner's real `install.bat` run on Windows and the `companion/QA.md` real-site pass. Companion milestones: M1 host.py, M2 install/update/uninstall.bat + README, M3 end-to-end test, M4 QA.md + 0.1.0 + CHANGELOG.
- Step 3 (`site/`): built (index, privacy, terms, `scripts/test_site.py`, `scripts/deploy_site.md`), waiting for "continue". Popup screenshots show the M1 popup and are placeholders.

Update this section at the end of every milestone.

## Extension rules

- Manifest V3, ES modules (`"type": "module"` for the service worker), **no bundler, no build step, no external libraries**. Everything is hand-written.
- Must work on **Chrome 116+, Edge and Brave**. Do not use APIs newer than Chrome 116 without a feature check and fallback.
- Original design: **light and dark theme** (follows system by default, overridable in Settings).
- Fixed extension ID: the public key sits in `manifest.json` `"key"`, so the ID is always **`ejkhmcfjnohjikdgfgkhjficmiaoghma`** (the companion whitelists it). The private key `extension-key.pem` is gitignored and must **never** be committed. `python scripts/extension_id.py` prints the ID.
- Strings: **English and Bangla** in a built-in dictionary module (`extension/i18n.js`). Do **not** use `chrome.i18n` / `_locales`, because the user must be able to switch language in Settings at runtime. Every user-visible string goes through the dictionary; no hard-coded UI text.

## Companion rules

- **Python 3 standard library only.** It runs on an embedded Python (Windows) or the system `python3` 3.8+ (macOS, Linux) with no pip, so no third-party imports.
- `install.sh` / `uninstall.sh` must run on the **bash 3.2** that ships with macOS and must **never need sudo**.
- Logs to `host.log` in the same folder as the companion script/executable.
- **Never deletes user files.** It may only clean up its own temporary/partial files it created for a download that was canceled or failed.
- yt-dlp and ffmpeg are external binaries it calls; they are downloaded tools and are not committed (see `.gitignore`).

## Protocol rules

- The extension and companion protocol is defined **only** in `shared/protocol.md`. Code must match the spec; change the spec first, then the code.
- Every message has `"type"` and `"v"` (protocol version, **currently 1**).
- Native messaging host name: `com.getsmartdm.host`.

## Content rules (non-negotiable)

- **YouTube** is supported through the companion (yt-dlp) and is **on by default** (owner's decision, 2026-11-17). The first YouTube download shows a one-time notice that the user is responsible for having the right to download and for the site's terms. The setting can be turned off; turning it back on shows the warning dialog.
- **Never attempt DRM-protected content** (Netflix, Prime Video, Disney+, Spotify, or any other DRM source). Detect and refuse; do not try to work around DRM.

## QA rules

- Every feature ships with a **manual QA checklist** in that folder's `QA.md`.
- Where possible, every feature also gets an **automated Playwright test**.

## Release rules

- The extension and companion always share one version (`x.y.z`). Change it only with `python scripts/bump.py`; `scripts/release.py` refuses to build if they differ.
- Every version gets a `CHANGELOG.md` section with **Extension / Companion / Website** sub-headings.
- Follow `RELEASE.md` for every release. Tags are `v<version>` on `main`.

## Way of working

- Work in **milestones**. After each milestone: stop, summarise what changed and how to test it, and **wait for the owner to say "continue"** before starting the next.
- Build only what the current step asks for.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
