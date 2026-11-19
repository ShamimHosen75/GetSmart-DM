# SIDM

**Download Smarter. Faster. Better.**

A free download manager for Chrome, Edge and Brave on Windows (macOS and Linux too, with their own companion installer), distributed as a ZIP from our own website.

| Folder | What it is |
|---|---|
| `extension/` | Browser extension (Manifest V3, plain JS modules) |
| `companion/` | Optional companion app (Python native-messaging host running yt-dlp + ffmpeg), for YouTube and multi-connection downloads; `install.bat` for Windows, `install.sh` for macOS and Linux |
| `site/` | Static download website |
| `scripts/` | Packaging and release scripts |
| `shared/` | Extension and companion contract (`protocol.md`) |

Development rules live in [`CLAUDE.md`](CLAUDE.md).

## Extension ID

The extension has a fixed ID, **`ejkhmcfjnohjikdgfgkhjficmiaoghma`**, set by the public key in `extension/manifest.json`. See [`extension/README.md`](extension/README.md).
