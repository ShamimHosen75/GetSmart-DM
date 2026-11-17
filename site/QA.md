# Website QA checklist

## Automated

- [ ] `python scripts/test_site.py` ends with `0 failed`. Before a release: `python scripts/test_site.py --strict` (ZIP must exist).
- [ ] Look through the renders in `test-results/site/` (each page at 1280 px and 390 px, light and dark).

## Manual

- [ ] Open `site/index.html` in Chrome, Edge and Brave. No console errors, no requests to other domains (DevTools Network tab).
- [ ] Nav stays at the top when scrolling; Features / Install / FAQ jump to their sections; the Download button jumps to the hero.
- [ ] Tab key: "Skip to content" appears first; every link and FAQ question shows a visible focus ring.
- [ ] **Download for Windows** points at `downloads/sidm-v<version>-windows.zip`; version, size and SHA-256 under it match the real file.
- [ ] Both screenshots load and match the current popup.
- [ ] Switch Windows to dark mode (or DevTools > Rendering > prefers-color-scheme): every page switches, text stays readable.
- [ ] Narrow the window to 390 px: single column, nav links hidden, Download button still visible, no sideways scroll.
- [ ] FAQ items open and close with mouse, Enter and Space.
- [ ] Footer links Privacy and Terms work; yt-dlp and ffmpeg links open their sites.
- [ ] Privacy and Terms pages: nav links go back to the right sections of the home page.
- [ ] Lighthouse (DevTools) on each page: Accessibility 95 or more.
- [ ] Contact email placeholder replaced before launch.
- [ ] After deploying to Vercel: `/privacy` and `/terms` work without `.html`.
