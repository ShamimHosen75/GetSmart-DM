# Changelog

All notable changes to SIDM. Newest version first. Each version has three parts: **Extension**, **Companion** and **Website**.

Add a new section with `python scripts/bump.py patch|minor|major`, then fill in the bullets before running `scripts/release.py`. See `RELEASE.md`.

## [0.2.0] - 2026-11-17

Renamed from GetSmart DM to **SIDM - Smart Internet Download Manager**. The extension ID is unchanged.

### Extension

- Name, English and Bangla strings and menus say SIDM; downloads are now saved in `Downloads/SIDM/<Category>/`.
- Video button on the page: appears over videos on any site (shadow DOM, iframes, players that load later, and as soon as a video starts playing). With the companion connected it offers Best, 1080p, 720p, 480p, 360p or audio only; without it, it says the companion is missing and opens the install help.
- More video sites through the companion: LinkedIn, Pinterest, Tumblr, Threads, Bluesky, Snapchat, 9GAG, Imgur, Kick, Rumble, Odysee, SoundCloud, Mixcloud, Bandcamp, TED, Loom and others. Any other page that plays a video is offered to the companion too ("try this page").
- YouTube is on by default through the companion, with a one-time notice on the first YouTube download. DRM services are still refused.
- Progress window for each download: size, speed, time left, resume support, pause/resume/cancel, a speed limit tab and "when finished" options. Opens for downloads SIDM starts, for all downloads, or never (Settings).
- Multi-connection downloads: files of 1 MB or more on servers that allow it are downloaded by the companion over up to 16 connections, with a parts view, pause/resume and a speed limit (global or per file). Falls back to a normal browser download when the server does not allow it or the file needs a login.
- Download manager page: category tree, sortable table with multi-select, start/stop queue, stop all, delete (with "also delete the file" for browser downloads) and a status bar.
- Scheduler: start the queue at a time on chosen days and optionally stop it again. When the queue is done: do nothing, show a notification or close the browser.
- New permission: `alarms` (for the scheduler).

### Companion

- Native host renamed to `com.sidm.host`; run `install.bat` / `install.sh` again after updating. The uninstallers also remove the old `com.getsmartdm.host` registration.
- Multi-connection file downloads (`add_file`, `pause_file`, `set_speed_limit`, `open_file` in protocol v1): Range probe, resumable `.gsdmpart` files, work stealing between connections, token-bucket speed limit, paused when the browser closes.
- Videos are saved in `Downloads/SIDM/Video`.

### Website

- Name and texts say SIDM; download links point at `sidm-v<version>-<platform>.zip`.
- YouTube FAQ and terms: YouTube is supported and on by default; the user is responsible for having the right to download.

## [0.1.0] - 2026-11-17

First release.

### Extension

- Downloads tab: every browser download, newest first, with progress, speed, time left and state; pause, resume, cancel, retry, open, show in folder, copy link, remove; search, category filter (Video, Music, Documents, Programs, Archives, Images, Other) and "Clear finished". The toolbar badge counts running downloads.
- Saves into `Downloads/SIDM/<Category>/` (can be turned off). Downloads SIDM starts wait in a queue (1 to 10 at a time, 3 by default); file names are made safe for Windows; Bangla names are kept.
- Notifications when a download finishes or fails.
- "+" panel to add links (one per line) and right-click menus: download a link, download an image/video/audio file, grab all links on a page. `blob:` and `data:` addresses are refused with an explanation.
- Link grabber page: every link, image and media file on a page (iframes included), with category chips, a filter and "Download selected".
- "This page" tab: video and audio files the page plays (whole files only, not HLS/DASH pieces), with a green badge count. Never on YouTube, DRM services or sites you turn it off for.
- Video sites (Facebook, X, Instagram, TikTok, Vimeo, Dailymotion, Reddit, Twitch, VK, OK, Bilibili, Streamable): "Download video" with quality choice through the companion app, with progress, cancel, retry and open folder. YouTube only after turning it on in Settings and reading the Terms of Service warning.
- Settings page: language, theme, folder sorting, downloads at the same time, ask where to save, notifications, media detection, minimum size, disabled sites, default video quality, YouTube, companion status.
- Automated test `scripts/test_extension.py`; manual checklist `extension/QA.md`.

### Companion

- First version of the Windows companion (`host.py` 0.1.0): downloads videos from Facebook, X, Instagram, TikTok, Vimeo and other sites yt-dlp supports, joins video and sound into one MP4 with ffmpeg, and saves to `Downloads\SIDM\Video`.
- Qualities Best, 1080, 720, 480, 360 and Audio (MP3). Without ffmpeg it falls back to a single file and tells you why.
- Plain-language errors for DRM, private or login-only posts, unsupported links, 404, missing ffmpeg and network problems. Every job is logged to `host.log`.
- Cancel stops the download and removes only that download's partial files.
- YouTube is refused unless it is turned on in Settings; DRM services (Netflix, Spotify and others) are always refused.
- `install.bat` sets everything up without admin rights or a separate Python install; `update.bat` gets the newest yt-dlp; `uninstall.bat` removes the browser registration.
- Tests: `scripts/test_host.py` (host over native-messaging framing) and `scripts/test_companion.py` (extension + companion end to end in Chromium). Manual checklist: `companion/QA.md`.

### Website

- No changes.

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
