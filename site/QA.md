# Website QA checklist

## Automated

- [ ] `python scripts/test_site.py` ends with `0 failed`. Before a release: `python scripts/test_site.py --strict` (ZIP must exist).
- [ ] Look through the renders in `test-results/site/` (each page at 1280 px and 390 px, light and dark).

## Manual

- [ ] Open `site/index.html` in Chrome, Edge and Brave. No console errors, no requests to other domains (DevTools Network tab).
- [ ] The floating nav bar stays at the top when scrolling; Extension / Windows / Android / FAQ jump to their sections; the Download button jumps to the hero.
- [ ] Below 900 px the links move into the menu button (no JavaScript): it opens and closes with tap, Enter and Space, and each link jumps to its section.
- [ ] Footer: the two buttons, all columns and "Back to top" work on every page.
- [ ] Tab key: "Skip to content" appears first; every link and FAQ question shows a visible focus ring.
- [ ] **Download SIDM** points at `downloads/sidm-v<version>-extension.zip`; version, size and SHA-256 under it match the real file.
- [ ] The install section has 2 steps and no install.bat step; the optional companion links point at `sidm-v<version>-companion-windows.zip` and (FAQ) `sidm-v<version>-companion-macos-linux.zip`.
- [ ] Both screenshots load and match the current popup.
- [ ] Switch Windows to dark mode (or DevTools > Rendering > prefers-color-scheme): every page switches, text stays readable.
- [ ] Narrow the window to 390 px: single column, nav links hidden, Download button still visible, no sideways scroll.
- [ ] FAQ items open and close with mouse, Enter and Space.
- [ ] Footer links Privacy and Terms work; yt-dlp and ffmpeg links open their sites.
- [ ] Privacy and Terms pages: nav links go back to the right sections of the home page.
- [ ] Home hero: the demo window loops (play, Download, quality menu, Saved); the "Works with" strip scrolls; numbers count up once.
- [ ] How to use: Extension / Windows / Android tabs switch with click and with the arrow keys. Each demo plays like a recording (a pointer moves to the button, clicks, the next step follows, then it starts over), also with the mouse over it. Clicking a step or a glowing "Try it" spot jumps there and pauses the tour; **Pause demo / Play demo** stops and restarts it.
- [ ] Turn on "Reduce motion" (Windows: Settings > Accessibility > Visual effects > Animation effects off): background effects stop and everything is visible; the How to use tour still steps through (fades only, the pointer jumps instead of gliding) and Pause demo stops it.
- [ ] On a phone: the hero, the demo and the tabs fit without sideways scrolling and scroll smoothly.
- [ ] Guides: every guide page opens from the home Guides section, the nav and the footer; breadcrumbs, "More guides" cards and the Download buttons work.
- [ ] Each guide keeps the "Download only what you have the right to" note and makes no DRM claims.
- [ ] Before launch: after deploying, `/sitemap.xml` and `/robots.txt` load on the live site; submit the sitemap in Google Search Console.
- [ ] Lighthouse (DevTools) on each page: Accessibility 95 or more.
- [ ] Contact email placeholder replaced before launch.
- [ ] After deploying to Vercel: `/privacy` and `/terms` work without `.html`.

## MP4 to MP3 and online downloader (`online-downloader.html`)

While `<meta name="sidm-api">` is empty, the page shows only MP4 to MP3 and the paste-a-link checks below wait until the SIDM Online service runs.

Automated: `python scripts/test_online.py` (local test videos, the real service, Chromium).

- [ ] "MP4 to MP3" is in the nav (highlighted on its own page), the phone menu and the footer on every page.
- [ ] Paste button: reads the clipboard (Chrome asks once) and starts; in Firefox it asks you to press Ctrl+V.
- [ ] Real links on the live site, each giving the right title, thumbnail and choices and a file that plays: YouTube (one-time notice first), YouTube Short, TikTok, Facebook reel, Instagram reel, X post, Vimeo, Reddit, Dailymotion, a direct `.mp4` link.
- [ ] Share text with a link inside (for example from the TikTok app) works.
- [ ] MP3 choice gives an MP3 that plays; 1080p gives a 1080p MP4 with sound.
- [ ] Netflix, Spotify or Disney+ links are refused with the DRM message; a private video shows the login message.
- [ ] Two downloads at once work; a third asks you to wait.
- [ ] With the service stopped, the page says it is not reachable and, for a direct file link, offers to open the file.
- [ ] MP4 to MP3: choose and drop a file (MP4 from a phone, MOV, WebM); 128/192/320 kbps all play; a file without sound shows a clear message; nothing is uploaded (DevTools Network).
- [ ] Light and dark, 1280 px and 390 px: no sideways scroll, result card and buttons readable.
