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
- [ ] Guides: every guide page opens from the home Guides section, the nav and the footer; breadcrumbs, "More guides" cards and the Download buttons work.
- [ ] Each guide keeps the "Download only what you have the right to" note and makes no DRM claims.
- [ ] Before launch: after deploying, `/sitemap.xml` and `/robots.txt` load on the live site; submit the sitemap in Google Search Console.
- [ ] Lighthouse (DevTools) on each page: Accessibility 95 or more.
- [ ] Contact email placeholder replaced before launch.
- [ ] After deploying to Vercel: `/privacy` and `/terms` work without `.html`.
