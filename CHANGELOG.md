# Changelog

All notable changes to SIDM. Newest version first. Each version has **Extension**, **Companion** and **Website** parts, plus **Android** from 0.5.0 on.

Add a new section with `python scripts/bump.py patch|minor|major`, then fill in the bullets before running `scripts/release.py`. See `RELEASE.md`.

## [0.5.1] - 2026-11-19

Fixes from the first real Windows test of 0.5.0: no sizes, no folder dialog and no download, with nothing shown.

Later (2026-11-23): the Android APKs moved from the website to the GitHub Release v0.5.1, because the website host (Cloudflare Pages) refuses files of 25 MiB or more. The site's Android buttons and the old `/downloads/` APK addresses point there.

### Extension

- The video menu shows which desktop program answered ("With the SIDM desktop program 0.5.1"). When the program is older than the extension (no sizes, no folder dialog), the menu says so and offers "Install the new SIDM desktop program".
- After a quality is clicked, the menu follows the download: "Downloading… 12%", "Saved", or the error from the program, instead of only "Added to SIDM".
- When the sizes cannot be read, the menu shows why ("Sizes not available: ...").
- "Copy debug info" now includes the program version, its features, yt-dlp and ffmpeg versions, the connection error and the last video downloads' errors.

### Companion

- Installs Deno next to yt-dlp (Windows, macOS, Linux): yt-dlp needs a JavaScript runtime for YouTube. The program puts its own folder first on yt-dlp's PATH so it is found. `hello` reports `js_runtime`.
- Running SIDM Setup again always fetches the newest yt-dlp (it used to keep the old one), and a yt-dlp that is in use no longer stops the install.
- Clear messages for YouTube's "confirm you're not a bot" and for missing formats (yt-dlp too old or no Deno), instead of "private or needs log in".

### Website

- Version 0.5.1.


## [0.5.0] - 2026-11-19

SIDM for Android, installed from the website. YouTube with SIDM for Windows: file sizes in the menu, a folder dialog for each download, and no more install offers once it is installed.

### Extension

- Install once: when the desktop program has answered once, SIDM remembers it and never offers the installer again (menu or Settings), unless the browser reports it is no longer registered (uninstalled). After a restart it waits up to 8 seconds for the program to start instead of 1.5, and says "starting, try again" rather than "install".
- The desktop program starts with the browser, and when a video site opens, so the first click is quick.
- The quality menu (video button and popup) shows the size of each quality, for example "≈ 98 MB", and hides qualities the video does not have.
- Choose where to save: clicking a quality opens Windows' "Select folder" window; the video downloads straight into the folder you pick (the last one is suggested next time). Closing the window cancels. Settings: "Ask where to save each video" (on by default; off = Downloads\SIDM\Video).
- The popup's "Update available" check now reads https://sidm.online/version.json.

### Companion

- `video_info`: sizes per quality from yt-dlp (`-J`), estimated the way the download picks formats.
- `pick_folder`: the system folder dialog (Windows Explorer-style dialog via PowerShell, on top of the browser; macOS `choose folder`; Linux zenity or kdialog). Chosen folders are remembered in `folders.json`, so "Open folder" works there too.
- `add_video` `dir` must be an existing absolute folder.
- `hello` answers within a second: tool versions are kept in `versions.json` until yt-dlp or ffmpeg change (asking yt-dlp.exe took seconds, which made the extension think the program was missing).
- Protocol additions in `shared/protocol.md` (still v1; new optional features `video_info`, `pick_folder`).
- The uninstaller also removes `versions.json` and `folders.json`.

### Website

- New "SIDM for Android" section: download links for the APK (most phones) and the 32-bit APK (older phones), with size, SHA-256 and three install steps. Markers `android-*` and `android-32bit-*`.
- A note for iPhone users: SIDM for iPhone is not available yet.
- The FAQ section's background no longer clashes with the new section.

### Android

- First version. Android 8 and later, installed from the website (not the Play Store).
- Paste a link or use Share to SIDM from any app (YouTube, Facebook, Instagram, TikTok, X, Reddit, LinkedIn, Vimeo and the other sites yt-dlp supports). Pick a quality, highest first, or audio only (M4A or MP3).
- Files download with up to 8 connections at once, pause and resume, keep going in the background with a notification, and wait for Wi-Fi or the network to come back.
- Built-in SIDM browser: sign in to a site, play the video, tap the download button. Files a page offers are caught too.
- Settings: English and Bangla, light and dark theme, Wi-Fi only, connections, parallel downloads, speed limit, YouTube on or off (with the notice when turned back on).
- The video engine (yt-dlp) updates itself every day; the app checks the website for new versions and installs them.
- DRM services (Netflix, Prime Video, Disney+, Spotify and others) are refused.
- Saved in `Downloads/SIDM`.
- Checks https://sidm.online for new app versions.

## [0.4.0] - 2026-11-18

LinkedIn fixed, the highest quality first, and SIDM for Windows: a setup program like any PC download manager's.

### Extension

- LinkedIn fixed: its player loads one MP4 that holds both video and sound, in parts. Those files were dropped; now they are offered and saved whole (also when the MP4 header is at the end of the file).
- Videos are found in the page's own data too, not only in what the player fetched: the site's API replies (LinkedIn, X, Instagram, Facebook, TikTok, Vimeo and others list every quality there), `<video>` sources and `data-sources`, og:video and JSON-LD. This often works before the video plays, and gives the original resolution even when the player shows a lower one.
- The video under the pointer is matched to its data by its thumbnail or its length, so a feed with many videos offers the right one. Other videos on the page are listed separately when nothing matches.
- The highest quality is first and marked "Highest quality"; files keep their source format (MP4, WebM).
- "Copy debug info" in the video menu: what SIDM saw on the page, without addresses' query strings, to send with a report.
- Settings: "Install SIDM for Windows" saves the setup program (shipped inside the extension ZIP) to Downloads. The page turns green by itself once it is installed. The YouTube note in the video menu points there.
- Wording: the companion is now "the SIDM desktop program".

### Companion

- New Windows setup program, `SIDM-Setup.exe` (NSIS, built on Linux by `scripts/build_setup.py`): no admin rights, installs into `%LOCALAPPDATA%\Programs\SIDM`, runs `install.bat /quiet` with no console window, adds Start menu entries ("Update SIDM tools", "Uninstall SIDM") and an entry in Windows Installed apps. The uninstaller removes the browser registration and only SIDM's own files.
- `install.bat /quiet`: no pauses or progress bars, for the setup program.

### Website

- The install section offers SIDM Setup (`sidm-v<version>-companion-setup.exe`, markers `companion-setup-*`) for YouTube; the companion ZIP stays as an alternative.

## [0.3.0] - 2026-11-18

No install needed: the extension ZIP is all most people need. The companion app is now optional.

### Extension

- Videos are downloaded by the extension itself, without the companion. It uses the streams the page plays: HLS playlists, DASH manifests and the MP4 pieces that players such as Facebook's fetch bit by bit. The video button and the popup offer the qualities found (for example 720p, 360p, audio only). Pieces are fetched 6 at a time, and separate video and audio are joined into one MP4 in the browser. The file is saved in `Downloads/SIDM/Video`.
- In-browser video downloads show in the popup, the manager and the progress window, with pause, resume, cancel and retry.
- Encrypted (DRM) and live streams are refused. MPEG-TS streams are saved as `.ts`.
- YouTube still needs the companion: its streams are signed and scrambled. The menu says so instead of asking every site for an install.
- Companion wording is "optional" everywhere; nothing in the normal flow asks for it.
- New permission: `offscreen` (a hidden page that joins the video pieces).

### Companion

- No changes to the program. It ships as a separate optional ZIP (`sidm-v<version>-companion-windows.zip`, `...-companion-macos-linux.zip`).

### Website

- The main download is `sidm-v<version>-extension.zip` (the extension alone, every system). Install is 2 steps; the companion is an optional extra for YouTube.
- FAQ and privacy page updated: the extension alone installs nothing else.

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
