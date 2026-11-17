# CLAUDE.md: GetSmart DM

Permanent rules for anyone (human or AI) working in this repo. Read this first, every session.

## Project overview

**GetSmart DM** ("Download Smarter. Faster. Better.") is a free download manager for **Chrome, Edge and Brave on Windows**.

- Distributed from our own website as a ZIP. It is **not** published on the Chrome Web Store, because it downloads videos from social sites.
- It is an original product. **Never copy the name, logo, UI, text or code of Internet Download Manager or any other product.**

## Folder map

| Folder | Contents |
|---|---|
| `extension/` | Chrome extension, Manifest V3, plain JavaScript ES modules, no build step |
| `companion/` | Windows companion app: Python native-messaging host that runs yt-dlp + ffmpeg |
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

Later: companion for macOS/Linux, Android app.

## Current step

**Step 4: `scripts/`.** Current step = 4.

Step 4 builds the release tooling: `scripts/release.py` (Windows ZIP, size + SHA-256, `site/version.json`, `site/index.html` via `data-release` markers), `scripts/bump.py`, `CHANGELOG.md`, `RELEASE.md` (checklist and `v<version>` tags), the popup "Update available" footer link (`extension/update-check.js`) and the `test` GitHub Actions workflow.

Status: **release tooling done**, waiting for the owner's "continue". Open: the website domain for `SITE_URL` in `extension/update-check.js`.

Earlier steps are not finished yet:
- Step 1 (`extension/`): M1 skeleton done; M2 to M9 (including the M7 companion bridge and `scripts/test_extension.py`) not built yet.
- Step 2 (`companion/`): M1 (`host.py` + `scripts/test_host.py`) and M2 (bat files + README) done; M3 (`scripts/test_companion.py`, needs the extension's M7 bridge) and M4 (`QA.md`, 0.1.0, CHANGELOG entries) not done. Companion milestones: M1 host.py, M2 install/update/uninstall.bat + README, M3 end-to-end test, M4 QA.md + 0.1.0 + CHANGELOG.
- Step 3 (`site/`): built (index, privacy, terms, `scripts/test_site.py`, `scripts/deploy_site.md`), waiting for "continue". Popup screenshots show the M1 popup and are placeholders.

Update this section at the end of every milestone.

## Extension rules

- Manifest V3, ES modules (`"type": "module"` for the service worker), **no bundler, no build step, no external libraries**. Everything is hand-written.
- Must work on **Chrome 116+, Edge and Brave**. Do not use APIs newer than Chrome 116 without a feature check and fallback.
- Original design: **light and dark theme** (follows system by default, overridable in Settings).
- Fixed extension ID: the public key sits in `manifest.json` `"key"`, so the ID is always **`ejkhmcfjnohjikdgfgkhjficmiaoghma`** (the companion whitelists it). The private key `extension-key.pem` is gitignored and must **never** be committed. `python scripts/extension_id.py` prints the ID.
- Strings: **English and Bangla** in a built-in dictionary module (`extension/i18n.js`). Do **not** use `chrome.i18n` / `_locales`, because the user must be able to switch language in Settings at runtime. Every user-visible string goes through the dictionary; no hard-coded UI text.

## Companion rules

- **Python 3 standard library only.** It runs on an embedded Python with no pip, so no third-party imports.
- Logs to `host.log` in the same folder as the companion script/executable.
- **Never deletes user files.** It may only clean up its own temporary/partial files it created for a download that was canceled or failed.
- yt-dlp and ffmpeg are external binaries it calls; they are downloaded tools and are not committed (see `.gitignore`).

## Protocol rules

- The extension and companion protocol is defined **only** in `shared/protocol.md`. Code must match the spec; change the spec first, then the code.
- Every message has `"type"` and `"v"` (protocol version, **currently 1**).
- Native messaging host name: `com.getsmartdm.host`.

## Content rules (non-negotiable)

- **YouTube downloading is never a default.** It exists only behind an **off-by-default setting** that shows a Terms-of-Service warning before it can be enabled.
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
