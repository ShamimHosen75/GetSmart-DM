# Changelog

All notable changes to GetSmart DM. Newest version first. Each version has three parts: **Extension**, **Companion** and **Website**.

Add a new section with `python scripts/bump.py patch|minor|major`, then fill in the bullets before running `scripts/release.py`. See `RELEASE.md`.

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
