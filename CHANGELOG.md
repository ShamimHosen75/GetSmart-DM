# Changelog

All notable changes to GetSmart DM. Newest version first. Each version has three parts: **Extension**, **Companion** and **Website**.

Add a new section with `python scripts/bump.py patch|minor|major`, then fill in the bullets before running `scripts/release.py`. See `RELEASE.md`.

## [0.1.0] - 2026-11-17

First release.

### Extension

- Downloads tab: every browser download, newest first, with progress, speed, time left and state; pause, resume, cancel, retry, open, show in folder, copy link, remove; search, category filter (Video, Music, Documents, Programs, Archives, Images, Other) and "Clear finished". The toolbar badge counts running downloads.
- Saves into `Downloads/GetSmart DM/<Category>/` (can be turned off). Downloads GetSmart DM starts wait in a queue (1 to 10 at a time, 3 by default); file names are made safe for Windows; Bangla names are kept.
- Notifications when a download finishes or fails.
- "+" panel to add links (one per line) and right-click menus: download a link, download an image/video/audio file, grab all links on a page. `blob:` and `data:` addresses are refused with an explanation.
- Link grabber page: every link, image and media file on a page (iframes included), with category chips, a filter and "Download selected".
- "This page" tab: video and audio files the page plays (whole files only, not HLS/DASH pieces), with a green badge count. Never on YouTube, DRM services or sites you turn it off for.
- Video sites (Facebook, X, Instagram, TikTok, Vimeo, Dailymotion, Reddit, Twitch, VK, OK, Bilibili, Streamable): "Download video" with quality choice through the companion app, with progress, cancel, retry and open folder. YouTube only after turning it on in Settings and reading the Terms of Service warning.
- Settings page: language, theme, folder sorting, downloads at the same time, ask where to save, notifications, media detection, minimum size, disabled sites, default video quality, YouTube, companion status.
- Automated test `scripts/test_extension.py`; manual checklist `extension/QA.md`.

### Companion

- (filled in by the companion step)

### Website

- (filled in by the website step)

## [0.0.1] - 2026-11-17

Development snapshot, not released to users.

### Extension

- Manifest V3 skeleton with a fixed extension ID, popup with Downloads and This page tabs, Settings page with language (English, Bangla) and theme (automatic, light, dark).
- Popup footer shows "Update available" when the website has a newer version (checked at most once a day).

### Companion

- Windows native-messaging host (`host.py`): hello, add_video with progress, cancel, ping; YouTube refused unless enabled.
- `install.bat`, `update.bat` and `uninstall.bat` for the current Windows user, no admin rights needed.
- macOS and Linux: `install.sh` and `uninstall.sh` (no sudo, system Python 3, yt-dlp and ffmpeg into the companion folder, registered for Chrome, Chromium, Edge and Brave). On Linux videos go to the desktop's Downloads folder even when it has a translated name.

### Website

- FAQ: Mac and Linux answer with the macOS/Linux download.
- Release tooling: `scripts/release.py` builds the Windows and macOS/Linux ZIPs and updates the download page and `version.json`; `scripts/bump.py` bumps the version everywhere.
