# GetSmart DM companion (Windows, macOS, Linux)

The companion is a small helper program that the GetSmart DM extension starts when you download a video from a social site. It runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the video and [ffmpeg](https://ffmpeg.org/) to join the video and sound into one MP4.

Videos are saved to **`Downloads\GetSmart DM\Video`** (on Linux, your desktop's Downloads folder, even if it has another name such as `Téléchargements`).

`host.py` is the same on every system; only the installer differs:

- **Windows**: `install.bat`, `update.bat`, `uninstall.bat`. See [Windows](#windows) below.
- **macOS and Linux**: `install.sh`, `uninstall.sh`. See [macOS and Linux](#macos-and-linux) below.

Firefox is not supported yet.

## Windows

You do **not** need to install Python or anything else yourself. `install.bat` downloads everything it needs into this folder.

Works with **Chrome, Edge and Brave** on **Windows 10 (version 1803 or newer) and Windows 11**, 64-bit.

### Install

1. Extract the companion ZIP to a folder you will keep, for example `%LOCALAPPDATA%\GetSmart DM\companion`. Avoid `Program Files`, because the companion writes its log and tools into its own folder.
2. Double-click **`install.bat`**. No admin rights are needed. It:
   - downloads embedded Python 3.12 from python.org into `python\`
   - downloads `yt-dlp.exe` (latest release from GitHub)
   - downloads ffmpeg (yt-dlp's FFmpeg build, about 200 MB) and keeps only `ffmpeg.exe` and `ffprobe.exe`
   - writes `run_host.bat` and `com.getsmartdm.host.json`
   - registers the companion for Chrome, Edge and Brave for your Windows user only
   - checks that Python, yt-dlp and ffmpeg run, and prints `Done`
3. Restart your browser. In the GetSmart DM popup the companion should show as connected.

Anything already present is skipped, so running `install.bat` again is safe. If you move the folder, run `install.bat` again.

### Update yt-dlp

Sites change often. When videos stop downloading, double-click **`update.bat`**: it downloads the newest `yt-dlp.exe`.

### Uninstall

Double-click **`uninstall.bat`**. It removes the three registry entries so the browsers can no longer start the companion. Then delete this folder yourself. Your downloaded videos are never touched.

### Manual setup (if a download in install.bat fails)

1. Download these yourself and put them in this folder:
   - Python embeddable package: <https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip>. Extract it into a folder named `python` here, so that `python\python.exe` exists.
   - yt-dlp: <https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe>. Save it as `yt-dlp.exe` here.
   - ffmpeg: <https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip>. Open the ZIP, go to its `bin` folder, and copy `ffmpeg.exe` and `ffprobe.exe` here.
2. Run `install.bat` again. It skips the downloads and only does the registration and checks.

## macOS and Linux

Works with **Chrome, Chromium, Edge and Brave** on macOS 11 or newer (Intel and Apple Silicon) and on 64-bit Linux (x86_64 and ARM64). No `sudo` and no admin password needed: everything goes into this folder and your own user settings.

Needs **Python 3.8 or newer**, which the installer finds itself:

- **macOS**: uses `python3` from Apple's Command Line Tools. If it is not installed yet, macOS offers to install it, or run `xcode-select --install`. Python from python.org or Homebrew also works.
- **Linux**: uses the system `python3`. If it is missing, the installer tells you the command for your distribution, for example `sudo apt install python3` (Debian, Ubuntu, Mint), `sudo dnf install python3` (Fedora) or `sudo pacman -S python` (Arch).

### Install

1. Extract the Mac/Linux ZIP to a folder you will keep, for example `~/getsmart-dm`.
2. Open Terminal in the `companion` folder and run:

   ```
   bash install.sh
   ```

   It:
   - downloads yt-dlp from GitHub (`yt-dlp_macos` on macOS, `yt-dlp_linux` on Linux, `yt-dlp_linux_aarch64` on ARM64) and saves it as `yt-dlp`
   - gets ffmpeg and ffprobe:
     - **macOS**: if [Homebrew](https://brew.sh) is installed, uses Homebrew's ffmpeg (installs it with `brew install ffmpeg` if needed) and links it here; otherwise downloads the static build from [evermeet.cx](https://evermeet.cx/ffmpeg/). That build is for Intel Macs and needs Rosetta on Apple Silicon; the installer tells you if Rosetta is missing.
     - **Linux**: downloads the static build from [johnvansickle.com](https://johnvansickle.com/ffmpeg/) (about 40 MB); if that site is down, falls back to yt-dlp's FFmpeg build on GitHub
   - writes `run_host.sh` and `com.getsmartdm.host.json`
   - copies the manifest into each browser's `NativeMessagingHosts` folder (below). Chrome is always registered; Chromium, Edge and Brave only if that browser has been opened at least once. Install a browser later? Run `install.sh` again.
   - checks that yt-dlp, ffmpeg and the companion run, and prints `Done`
3. Restart your browser. In the GetSmart DM popup the companion should show as connected.

Anything already present is skipped, so running `install.sh` again is safe. If you move the folder, run `install.sh` again. Do not run it with `sudo`; it refuses, because it must register the companion for your own user.

| Browser | macOS | Linux |
|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | `~/.config/google-chrome/NativeMessagingHosts/` |
| Chromium | `~/Library/Application Support/Chromium/NativeMessagingHosts/` | `~/.config/chromium/NativeMessagingHosts/` |
| Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` | `~/.config/microsoft-edge/NativeMessagingHosts/` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |

Browsers installed as **Snap or Flatpak** packages on Linux run in a sandbox that cannot start the companion. Use the browser's regular `.deb`/`.rpm` package instead.

### Update yt-dlp

When videos stop downloading, run `./yt-dlp -U` in this folder. On macOS with Homebrew, `brew upgrade ffmpeg` updates ffmpeg too.

### Uninstall

Run `bash uninstall.sh`. It removes `com.getsmartdm.host.json` from the browser folders above so the browsers can no longer start the companion. Then delete this folder yourself. Your downloaded videos are never touched.

### Manual setup (if a download in install.sh fails)

1. Put these in this folder yourself:
   - yt-dlp from <https://github.com/yt-dlp/yt-dlp/releases/latest>: the `yt-dlp_macos` or `yt-dlp_linux` file, renamed to `yt-dlp`.
   - `ffmpeg` and `ffprobe`: on Linux from <https://johnvansickle.com/ffmpeg/> or your package manager (`sudo apt install ffmpeg`, then `ln -s /usr/bin/ffmpeg /usr/bin/ffprobe .`); on macOS from <https://evermeet.cx/ffmpeg/> or `brew install ffmpeg`.
2. Run `chmod +x yt-dlp ffmpeg ffprobe`, then `bash install.sh` again. It skips the downloads and only writes the manifest and runs the checks.

## Supported sites

Anything yt-dlp supports, including Facebook, X (Twitter), Instagram, TikTok, Vimeo, Dailymotion, Reddit and many more. The full list is in yt-dlp's [supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). Only public videos can be downloaded. Private posts and anything that needs you to log in show "needs login".

**Not supported, on purpose:** DRM-protected services such as Netflix, Prime Video, Disney+, Hulu, Max and Spotify. The companion refuses them and never tries to get around DRM.

## YouTube

YouTube downloading is **off by default**. YouTube's Terms of Service do not allow downloading videos without permission. You can turn it on in the extension's Settings, after reading the warning there; you are responsible for following YouTube's terms. While it is off, the companion refuses YouTube links even if one is sent to it.

## Quality

| Choice | What you get |
|---|---|
| Best | Best video + best audio, joined into MP4 |
| 1080 / 720 / 480 / 360 | Best video up to that height + best audio, joined into MP4 |
| Audio | Audio only, converted to MP3 |

If ffmpeg is missing, the companion falls back to a single file that already has video and sound (often lower quality), and audio is kept in its original format. The extension tells you when that happens. Run `install.bat` (Windows) or `install.sh` (macOS, Linux) to fix it.

## Troubleshooting

### Windows

| Problem | What to do |
|---|---|
| Popup says the companion is not connected | Run `install.bat` again, then fully close and restart the browser. Check that `com.getsmartdm.host.json` exists in this folder. |
| `install.bat` says curl or tar was not found | Your Windows is older than Windows 10 1803. Update Windows. |
| A download fails in `install.bat` | Check your internet connection and run it again. Antivirus or a company proxy can block downloads: use Manual setup. |
| "Download failed ... CRYPT_E_NO_REVOCATION_CHECK" or other certificate errors | Your network blocks certificate checks. Use Manual setup with a browser. |
| "Video not found (404)" | The post was deleted or the link is wrong. Open the link in the browser to check. |
| "This video is private or needs you to log in" | Only public videos are supported. |
| "This site or link is not supported" | Try the link of the post itself, not of a profile or feed. Run `update.bat`. |
| Downloads that used to work now fail | Run `update.bat` to get the newest yt-dlp. |
| "ffmpeg is missing" | Run `install.bat` again; it downloads ffmpeg if `ffmpeg.exe` or `ffprobe.exe` is missing. |
| Antivirus deletes `yt-dlp.exe` | This is a false alarm on some antivirus products. Allow the file, then run `update.bat`. |
| You moved the companion folder | Run `install.bat` again so the browser knows the new location. |

### macOS and Linux

| Problem | What to do |
|---|---|
| Popup says the companion is not connected | Run `bash install.sh` again, then quit the browser completely (on a Mac: Cmd+Q) and open it again. Check that the browser's `NativeMessagingHosts` folder (table above) has `com.getsmartdm.host.json`. |
| "python3 is missing" | Install it as the installer says (macOS: `xcode-select --install`; Linux: your distribution's `python3` package), then run `install.sh` again. |
| "Permission denied" when running `./install.sh` | Run it as `bash install.sh`, or `chmod +x install.sh` first. |
| `install.sh` refuses to run with sudo | Run it as your normal user. It never needs sudo. |
| macOS: ffmpeg "Bad CPU type in executable" | The evermeet.cx build needs Rosetta on Apple Silicon: `softwareupdate --install-rosetta --agree-to-license`, or install Homebrew, delete `ffmpeg` and `ffprobe` here and run `install.sh` again. |
| Linux: Snap or Flatpak browser never connects | Use the browser's regular package; sandboxed browsers cannot start native helpers. |
| Downloads that used to work now fail | Run `./yt-dlp -U` in this folder. |
| You moved the companion folder | Run `install.sh` again so the browser knows the new location. |

## Log file

The companion writes **`host.log`** in this folder (next to `host.py`). It records each download's full command, its result and any errors. It is kept small: at most about 1 MB, plus two older copies (`host.log.1`, `host.log.2`). Attach it when you report a problem.

To check the companion without a browser, open a Command Prompt (Windows) or Terminal (macOS, Linux) in this folder and run:

```
python\python.exe host.py --check     (Windows)
./run_host.sh --check                (macOS, Linux)
```

It prints the companion, Python, yt-dlp and ffmpeg versions and the download folder.

## For developers

- `host.py`: the native-messaging host (`com.getsmartdm.host`). Python 3 standard library only. Protocol: `shared/protocol.md`.
- Test without a browser: `python scripts/test_host.py` (needs yt-dlp on PATH or next to `host.py`).
- Files created by the installers (`python\`, `*.exe`, `yt-dlp`, `ffmpeg`, `ffprobe`, `run_host.bat`, `run_host.sh`, `com.getsmartdm.host.json`, `host.log`) are not committed.
- On macOS and Linux the browser starts `run_host.sh`, which runs `host.py` with the absolute path of the `python3` that `install.sh` found and puts this folder (plus Homebrew's `bin`) first on `PATH`, because browsers started from the Dock or a launcher get a short `PATH`.
- `install.sh` is written for the bash 3.2 that ships with macOS. Check it with `shellcheck companion/*.sh`.
