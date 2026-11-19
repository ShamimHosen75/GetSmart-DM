# SIDM for Android: manual QA checklist

Run on a real phone (Android 8 or newer) with the release APK from the website or the `sidm-android-apks` artifact. Tick each box; note the phone model and Android version at the top of your report.

Phone: ______________________  Android: ____  SIDM version: ______

## Install and first start

- [ ] Open the website on the phone, tap **Download for Android**. The APK downloads (about 50 MB).
- [ ] Tap the file. Android asks to allow installs from the browser; after allowing it, **Install** works. If Play Protect warns, **More details > Install anyway** works.
- [ ] SIDM opens on the welcome screen. Switching **English / বাংলা** changes the text right away.
- [ ] **Allow notifications** shows Android's permission prompt (Android 13+). On Android 8 or 9 it asks for storage instead.
- [ ] The notice screen says the user is responsible and DRM is never downloaded. **I understand** opens Home.
- [ ] Closing and reopening SIDM goes straight to Home (no welcome again).

## Video from social sites (Share to SIDM)

For each site, use a public post with a video. Share it to SIDM from the site's own app (or paste the link). Expected: the quality picker shows the title and qualities, the highest first and selected; **Download** adds it to Downloads; it finishes; it plays from the notification, from **Open**, and in the Gallery under Download/SIDM.

- [ ] Facebook (video post or reel)
- [ ] Instagram (reel)
- [ ] TikTok
- [ ] X (Twitter)
- [ ] YouTube (normal video and a Short). YouTube is on by default.
- [ ] LinkedIn
- [ ] Reddit
- [ ] Vimeo or Dailymotion
- [ ] **Audio only (MP3)** on any of the above saves a playable .mp3.
- [ ] A lower quality (for example 360p) saves a smaller file than the highest quality.
- [ ] A private or friends-only post you can see: SIDM says to sign in; **Browser** opens it; after signing in there and tapping **Download**, it works.
- [ ] A Netflix or Spotify link: refused with the DRM message, nothing is downloaded.

## Files

- [ ] Paste a direct link to a big file (for example a 100 MB+ test file): SIDM asks "Download this file?" with its name and size.
- [ ] Progress shows size, speed and time left; the notification shows the same.
- [ ] **Pause** stops it; **Resume** continues from where it stopped (not from 0).
- [ ] Turn on airplane mode during a download: it shows "Waiting for the internet" and continues by itself when the internet is back.
- [ ] Settings > **Connections per file** 1 vs 8: 8 is not slower, and the file is identical (open it).
- [ ] Settings > **Speed limit** 512 KB/s: speed stays near 512 KB/s.
- [ ] **Download on Wi-Fi only** on, on mobile data: downloads wait ("Waiting for Wi-Fi") and start on Wi-Fi.
- [ ] Several downloads at once follow **Downloads at the same time**.
- [ ] Lock the phone for 5 minutes during a long download: it keeps going.
- [ ] Swipe SIDM away from recent apps during a download, open it again: the download is paused or queued and resumes.

## Browser

- [ ] The start page lists sites; tapping one opens it.
- [ ] Play a video on a site, tap **Download**: either the quality picker opens, or a list of found media plus "Video on this page".
- [ ] A page's own download link (for example a PDF or ZIP link) is caught: "SIDM is downloading …" and it appears in Downloads.
- [ ] Back goes back in the page history.
- [ ] Switching to another tab and back keeps the page open.
- [ ] On netflix.com the Download button is grey and says SIDM does not download from DRM sites.

## Downloads list

- [ ] Filters (All, Video, Music, Documents, Other) show the right rows.
- [ ] **Open**, **Share**, **Copy link** work; **Remove from list** keeps the file; **Delete file** asks first and removes it from the phone.
- [ ] **Clear finished** removes finished rows only.
- [ ] A failed download shows a plain reason and **Retry** works.

## Settings and updates

- [ ] Theme Light / Dark / Follow system all look right (Home, Downloads, Settings, sheets).
- [ ] Every screen reads correctly in Bangla (no English left except site names and file names).
- [ ] Turning **YouTube** off, then a YouTube link: "YouTube downloads are off". Turning it on shows the warning dialog first.
- [ ] Video engine shows a yt-dlp version; **Update now** says up to date or updates.
- [ ] **Sign out of all sites** signs you out in the SIDM browser.
- [ ] About shows the version; **Check for updates** says the website is not online yet (until the domain is set) or checks it.
- [ ] Once a newer version is on the website: Home shows "SIDM x.y.z is available"; **Download update** downloads it and Android asks to update; the downloads list is kept.
