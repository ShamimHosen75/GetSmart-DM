# Companion QA checklist

Manual checks on a real Windows 10/11 PC with Chrome (and spot checks in Edge and Brave). Run them before every release. Automated tests cover the same flows against a local test server: `python scripts/test_host.py` and `python scripts/test_companion.py`.

Setup: load `extension/` unpacked (ID `ejkhmcfjnohjikdgfgkhjficmiaoghma`), extract the companion to `%LOCALAPPDATA%\GetSmart DM\companion` and run `install.bat`. Keep `host.log` open in a text editor that reloads.

## Install

- [ ] `install.bat` on a clean folder downloads Python, yt-dlp and ffmpeg, prints the three versions and the `--check` output, then `Done`. No admin prompt.
- [ ] Run `install.bat` again: only `[skip]` lines for the downloads, still ends with `Done`.
- [ ] Unplug the network and run `install.bat` in a fresh folder: it names the failed download, says "Install did NOT finish" and `echo %errorlevel%` after it shows `1`.
- [ ] Folder path with a space and Bangla letters (e.g. `C:\Users\<you>\GetSmart DM\কম্প্যানিয়ন`): install works and the companion connects.
- [ ] `regedit`: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.getsmartdm.host`, the same under `Microsoft\Edge` and `BraveSoftware\Brave-Browser`, each pointing at `com.getsmartdm.host.json`.
- [ ] Restart Chrome, open the popup on a Facebook video: "This page" shows the companion as connected with the yt-dlp version. Same in Edge and Brave.
- [ ] No console window flashes while the companion runs or downloads.

## Real sites

For each: open the post in the browser, use the popup's "This page" card, quality Best. The file must land in `Downloads\GetSmart DM\Video`, play with sound in the Windows player, and `host.log` must show the start command and `rc=0`.

- [ ] Public Facebook video (a Page's video or a public reel).
- [ ] X (Twitter) post with a video.
- [ ] Instagram reel from a public account.
- [ ] TikTok video.
- [ ] Vimeo video.
- [ ] Quality 720 on one of the above: the file is at most 720p (check in the file's Properties > Details).
- [ ] Quality Audio: an `.mp3` is saved and plays.
- [ ] A title with Bangla or emoji: the file name is readable, not `????`.
- [ ] Private Facebook or Instagram post (or one from a private account): the card shows "This video is private or needs you to log in…", no file is left behind.
- [ ] A deleted post or a broken link: "Video not found (404)…" or "not supported", never a raw Python error.
- [ ] YouTube is on by default: a YouTube video downloads, and the first one shows the one-time notice. With the setting turned off, the card says YouTube is off and nothing reaches `host.log`.
- [ ] A Netflix or Spotify page: refused as DRM; nothing is attempted.

## Cancel and failures

- [ ] Start a long video, press Cancel mid-download: the job shows Canceled within a few seconds, Task Manager shows no `yt-dlp.exe` or `ffmpeg.exe` left running, and no `.part`, `.ytdl` or `.fNNN.*` files remain in the folder.
- [ ] Cancel while ffmpeg is merging (right after the progress reaches 100%): same result, no `.temp.mp4` left.
- [ ] Companion closed while a job runs: in Task Manager, end the `python.exe` under the companion folder mid-download. `yt-dlp.exe` and `ffmpeg.exe` disappear with it within a second, the job turns into an error ("companion stopped"), and the next download reconnects and works.
- [ ] Close the browser mid-download: `host.log` shows "browser disconnected", the download is canceled and `yt-dlp.exe` exits.
- [ ] Rename `ffmpeg.exe` away and download with Best: a single-file download succeeds and the card shows the "ffmpeg was not found…" note. Rename it back.
- [ ] Rename `yt-dlp.exe` away: download shows "yt-dlp is missing. Run install.bat…". Rename it back.
- [ ] A file you already have in the Video folder with another name is never deleted or overwritten by a canceled or failed job.

## update.bat

- [ ] Prints the current yt-dlp version, downloads, prints the new version and `Done`.
- [ ] Offline: says the download failed, keeps the old `yt-dlp.exe` working, exit code `1`.

## uninstall.bat

- [ ] Removes the three registry keys (each line says "removed"); running it again says "not registered" for each.
- [ ] After uninstall, the popup shows the companion as not installed, and no files were deleted (the companion folder and the Video folder are unchanged).
- [ ] `install.bat` again restores everything.

## host.log

- [ ] Every job has a "start" line with the full yt-dlp command and an "end" line with the return code and the last output.
- [ ] Errors are logged with the friendly message.
- [ ] The log stays at most about 1 MB plus `host.log.1` and `host.log.2`.
