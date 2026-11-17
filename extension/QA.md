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
