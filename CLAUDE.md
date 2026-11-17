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

**Step 3: `site/`.** Current step = 3.

Status: **site built** (index, privacy, terms, styles, popup screenshots, `vercel.json`, `scripts/test_site.py`, `scripts/deploy_site.md`), waiting for "continue". The download ZIP and the real version/size/SHA-256 come from the Step 4 release script (`data-release` attributes in `site/index.html`). Popup screenshots show the M1 popup and are placeholders; re-run `python scripts/test_site.py` to refresh them.

Step 2 (`companion/`) status: M1 (host.py + test_host.py) and M2 (install.bat, update.bat, uninstall.bat, README) done; waiting for the owner's install.bat output and "continue" before M3.

Step 1 (`extension/`) status: M1 skeleton done; M2 to M9 (including the M7 companion bridge) not built yet.

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

## Way of working

- Work in **milestones**. After each milestone: stop, summarise what changed and how to test it, and **wait for the owner to say "continue"** before starting the next.
- Build only what the current step asks for.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
