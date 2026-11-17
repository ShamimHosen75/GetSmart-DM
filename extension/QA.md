# Extension QA checklist

Manual checks, grouped by milestone. Tick each before calling a milestone done.

## M1 Skeleton

- [ ] `chrome://extensions` > Load unpacked > `extension/` loads with no error or warning on the card.
- [ ] The card shows ID `ejkhmcfjnohjikdgfgkhjficmiaoghma`. Remove and load again: the ID stays the same.
- [ ] "Service worker" link on the card opens DevTools with no errors in the console.
- [ ] The toolbar icon is a purple rounded square with a white down-arrow and mint line, sharp at 100% and 150% scaling.
- [ ] Popup opens, shows "Downloads" and "This page" tabs; switching works; reopening remembers the last tab.
- [ ] The sliders button in the popup opens the settings page in a new tab.
- [ ] Settings: Language = বাংলা switches the settings page and the popup to Bangla right away; Automatic follows the browser language.
- [ ] Settings: Theme = Dark / Light / Automatic switches immediately; Automatic follows Windows dark mode.
- [ ] Settings: About shows the version and the extension ID.
- [ ] Same checks in Edge and Brave.

## Update available (release tooling, Step 4)

Needs `SITE_URL` set in `extension/update-check.js` and a `version.json` reachable there.

- [ ] With `version.json` showing a **higher** version than the manifest, the popup footer shows "Update available" (Bangla: "আপডেট পাওয়া যাচ্ছে"); clicking it opens the website in a new tab.
- [ ] With the **same or lower** version, or the site offline, no footer link and no console error.
- [ ] Open the popup several times: DevTools Network shows at most one `version.json` request per 24 hours.
- [ ] With `SITE_URL` empty, no request is made at all.

## M2 Download list

- [ ] Start a few downloads from any site: the "Downloads" tab lists every Chrome download, newest first, including ones started before the popup opened.
- [ ] A running download shows name, progress bar, "x of y", speed and time left. The speed settles within a few seconds and does not jump around.
- [ ] A server without a size (no Content-Length) shows a moving bar and the bytes received.
- [ ] Toolbar badge = number of running downloads; pausing one lowers it, finishing all clears it.
- [ ] Pause / Resume / Cancel work from the row. Cancelled rows are struck through.
- [ ] Retry on a failed or cancelled download: resumes if Chrome can, otherwise starts the same URL again and the old row goes away.
- [ ] Completed rows: Open file opens it, Show in folder opens Explorer with the file selected. If the file was deleted on disk, the row says "File deleted".
- [ ] Copy link puts the URL on the clipboard and shows "Link copied".
- [ ] Remove from list removes the row but keeps the file on disk.
- [ ] Search matches the file name and the URL. Each category chip (Video, Music, Documents, Programs, Archives, Images, Other) shows only that type; "All" shows everything; no match shows "No downloads match".
- [ ] "Clear finished" removes every row that is not running or paused, and hides itself when there is nothing to clear.
- [ ] While a download runs, open DevTools on the popup (right-click > Inspect), Elements panel: rows flash only in the changed fields; the list is not rebuilt.
- [ ] Switch Settings to বাংলা and Dark while the popup is open: chips, states and buttons switch at once.
