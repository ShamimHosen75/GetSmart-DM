# GetSmart DM companion (Windows)

The companion is a small helper program that the GetSmart DM extension starts when you download a video from a social site. It runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the video and [ffmpeg](https://ffmpeg.org/) to join the video and sound into one MP4.

Videos are saved to **`Downloads\GetSmart DM\Video`**.

You do **not** need to install Python or anything else yourself. `install.bat` downloads everything it needs into this folder.

Works with **Chrome, Edge and Brave** on **Windows 10 (version 1803 or newer) and Windows 11**, 64-bit. Firefox is not supported yet.

## Install

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

## Update yt-dlp

Sites change often. When videos stop downloading, double-click **`update.bat`**: it downloads the newest `yt-dlp.exe`.

## Uninstall

Double-click **`uninstall.bat`**. It removes the three registry entries so the browsers can no longer start the companion. Then delete this folder yourself. Your downloaded videos are never touched.

## Manual setup (if a download in install.bat fails)

1. Download these yourself and put them in this folder:
   - Python embeddable package: <https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip>. Extract it into a folder named `python` here, so that `python\python.exe` exists.
   - yt-dlp: <https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe>. Save it as `yt-dlp.exe` here.
   - ffmpeg: <https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip>. Open the ZIP, go to its `bin` folder, and copy `ffmpeg.exe` and `ffprobe.exe` here.
2. Run `install.bat` again. It skips the downloads and only does the registration and checks.

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

If ffmpeg is missing, the companion falls back to a single file that already has video and sound (often lower quality), and audio is kept in its original format. The extension tells you when that happens. Run `install.bat` to fix it.

## Troubleshooting

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

## Log file

The companion writes **`host.log`** in this folder (next to `host.py`). It records each download's full command, its result and any errors. It is kept small: at most about 1 MB, plus two older copies (`host.log.1`, `host.log.2`). Attach it when you report a problem.

To check the companion without a browser, open a Command Prompt in this folder and run:

```
python\python.exe host.py --check
```

It prints the companion, Python, yt-dlp and ffmpeg versions and the download folder.

## For developers

- `host.py`: the native-messaging host (`com.getsmartdm.host`). Python 3 standard library only. Protocol: `shared/protocol.md`.
- Test without a browser: `python scripts/test_host.py` (needs yt-dlp on PATH or next to `host.py`).
- Files created by `install.bat` (`python\`, `*.exe`, `run_host.bat`, `com.getsmartdm.host.json`, `host.log`) are not committed.
