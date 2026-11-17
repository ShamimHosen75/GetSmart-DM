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

## M3 Folder sorting + queue

- [ ] Download a PDF, an MP4, a ZIP and an EXE from any site: they land in `Downloads/GetSmart DM/Documents`, `/Video`, `/Archives`, `/Programs`. A file with an unknown extension goes to `/Other` (or by its MIME type).
- [ ] Settings > folder sorting off (M8, or `chrome.storage.sync.set({sortIntoFolders:false})` in the service worker console): new downloads go straight to `Downloads/` again.
- [ ] A second download with the same name gets ` (1)` added; nothing is overwritten.
- [ ] Set max simultaneous to 2 and add 4 large links in the "+" panel (M4): 2 run, 2 show "Waiting in queue". Pausing one starts the next. Cancelling a waiting row removes it.
- [ ] Close and reopen the browser with items waiting: they start again.
- [ ] Names we choose are made safe for Windows: `a:b?.pdf` saves as `a_b_.pdf`, `CON.txt` as `_CON.txt`, a 300-character name is cut to 150 with the extension kept, and a Bangla name (`বাংলা গান.mp3`) is kept as is.
- [ ] Notifications (on by default): a finished download shows "Download complete"; clicking it opens the folder. A failed one shows "Download failed" with the reason. Cancelling shows nothing.

## M4 Add links + context menus

- [ ] Popup "+" opens the add panel. Paste 3 lines: two https links and `ftp://x`. "Add" queues the two and says "Added 2 to the queue · 1 skipped (not http/https)". Duplicate lines are added once. Ctrl+Enter adds, Esc closes.
- [ ] Add with an empty box: "Paste at least one http:// or https:// link." and nothing is queued.
- [ ] Right-click a link > "Download link with GetSmart DM": it goes through the queue and into the sorted folder.
- [ ] Right-click an image, and a `<video>`/`<audio>` element with a real `src` > "Download this file with GetSmart DM".
- [ ] Right-click an image whose address is `blob:` or `data:` (for example a canvas export) > a notification explains it cannot be saved, nothing is queued.
- [ ] Right-click the page background > "Grab all links on this page" opens the link grabber (M5) in a tab next to it.
- [ ] Switch the language to Bangla: the menu entries switch to Bangla.

## M5 Link grabber

- [ ] On a page with many links (a file index or a download site), right-click > "Grab all links on this page": a tab opens next to it with a table (checkbox, name, type, address) and chips with counts per category.
- [ ] Links inside iframes are included. The same URL appears once. `mailto:`, `javascript:` and `#` links are not listed.
- [ ] Typing in the filter narrows by name, address or link text; chips narrow by category; the header checkbox selects every row shown (and only those).
- [ ] "Download selected" queues the selected rows (watch the popup: max simultaneous is respected) and clears the ticks.
- [ ] Close the source tab, then press "Scan again": "The tab is gone".
- [ ] On `chrome://settings` and on the Chrome Web Store, "Grab all links" shows "Chrome does not allow this page".
- [ ] On a page with no links: "No links found".

## M6 Media detection ("This page")

- [ ] Open a page that plays a plain MP4 or MP3 (for example a file on a test server or a site that uses `<video src="...mp4">`): the toolbar icon shows a green number on that tab, and "This page" lists the file with size and type. "Download" queues it with the shown name.
- [ ] HLS/DASH players (`.m3u8`, `.mpd`, `.ts`, `.m4s`) are not listed; only whole files are.
- [ ] Files smaller than the minimum size (default 200 KB) are not listed.
- [ ] A response with `Content-Disposition: attachment; filename*=UTF-8''...` is listed under that (decoded) name. Without a usable name, the tab title plus an extension from the MIME type is used.
- [ ] At most 25 entries per tab; navigating the tab to a new page clears the list and the green badge. Other tabs keep their own lists.
- [ ] On YouTube nothing is detected and "This page" says detection is always off there.
- [ ] On Netflix, Prime Video, Disney+, Spotify and similar, nothing is detected and "This page" says GetSmart DM does not download from DRM services.
- [ ] Add a site to "Disabled sites" in Settings (M8): nothing is detected there and "This page" says so.
- [ ] With no media, the tab shows "Nothing found on this page", and the global badge (number of running downloads) shows instead of the green one.

## M7 Companion bridge (video sites)

Needs the companion installed (`companion/install.bat` on Windows).

- [ ] On a video page of facebook.com, fb.watch, x.com, twitter.com, instagram.com, tiktok.com, vimeo.com, dailymotion.com, reddit.com, twitch.tv, vk.com, ok.ru, bilibili.com or streamable.com, "This page" shows the "Video on this page" card: companion status, quality (Best, 1080p, 720p, 480p, 360p, Audio only) and "Download video".
- [ ] Status shows "Companion app 0.x connected" with a green dot. Uninstall the companion and reopen the popup: "not installed" with help text, and the button is disabled.
- [ ] "Download video": a row appears under "Video downloads" with bar, size, speed and time left; when done it says "Saved" and the folder button opens the folder in a tab. A note from the companion (for example ffmpeg missing) shows in italics.
- [ ] Cancel a running video: "Cancelled"; Retry starts it again; Remove clears finished rows.
- [ ] End the companion process (Task Manager) during a download: the row turns "Failed: The companion app stopped"; the next "Download video" reconnects.
- [ ] Right-click on a page of those sites > "Download video from this page with GetSmart DM" starts a job at the default quality. Without the companion, a notification explains how to install it.
- [ ] YouTube: no card controls, only the note that YouTube downloads are off; no context-menu entry. After turning on "Allow YouTube" in Settings (M8), the card and the menu appear on youtube.com.
- [ ] Netflix and other DRM sites: no card, no menu; asking the worker for addVideo there returns the DRM refusal.
- [ ] Leave the browser idle for a minute with no video running: the companion process exits (no zombie host).

## M8 Settings page

- [ ] Every control saves as soon as it changes ("Saved" toast) and is still set after closing and reopening Settings, and on another computer signed in to the same browser profile (storage.sync).
- [ ] Language Automatic / English / বাংলা and Theme Automatic / Light / Dark apply at once to Settings and an open popup.
- [ ] Sort into folders off: new downloads go to plain `Downloads/`.
- [ ] Downloads at the same time: typing 25 saves 10, typing 0 saves 1.
- [ ] Ask where to save on: links added with "+" open the Save As window.
- [ ] Notifications off: no finish/fail notifications (the blob:/data: explanation still shows).
- [ ] Media detection off: "This page" says it is off and nothing is listed; minimum size 1000 KB hides smaller files.
- [ ] Disabled sites: `https://www.Example.com/path` is saved as `example.com`; entries without a dot are dropped; duplicates are removed.
- [ ] Companion line shows connected with the yt-dlp / ffmpeg versions and the save folder, or "not installed" with help text.
- [ ] Default video quality is used by the right-click video menu and preselected in the popup card.
- [ ] Allow YouTube: clicking the switch opens the Terms of Service warning. Cancel leaves it off; "I understand, turn it on" turns it on. Turning it off needs no warning.

## M9 Release checks (0.1.0)

Run `python scripts/test_extension.py` first (all PASS), then by hand:

- [ ] **Service worker asleep:** on `chrome://extensions` > GetSmart DM > "Service worker", wait 5 minutes until it shows "inactive". Then: start a download from a site (it is sorted into a folder), right-click a link > "Download link with GetSmart DM" (it starts), open a page with a video (green badge appears), open the popup (list correct). Each wakes the worker with no error on the card.
- [ ] **Queue after sleep:** with max 1, add 3 links, let the worker sleep, then cancel the running one: the next queued link starts.
- [ ] **Incognito:** turn on "Allow in Incognito" for GetSmart DM. Downloads from an incognito window appear in the popup opened there, are sorted, and media detection works. The popup in a normal window does not list incognito downloads.
- [ ] **Alt-click:** Alt+click on a link (Chrome's own "download link" shortcut) downloads it directly without the queue; it still appears in the list and is sorted into a folder.
- [ ] **chrome:// pages:** on `chrome://settings`, `edge://settings` and the Web Store: the popup opens without errors, "This page" shows "Nothing found", "Grab all links" says Chrome does not allow the page.
- [ ] **Dark mode:** set Windows to dark mode with Theme = Automatic: popup, settings and grabber are dark with readable text, badges and type tiles. Theme = Light overrides it.
- [ ] **Bangla UI:** Language = বাংলা: popup, settings, grabber, context menus and notifications are in Bangla with no English left except file names, sizes and product names; long Bangla labels do not overflow.
- [ ] **Edge and Brave:** Load unpacked works and the ID is the same.
- [ ] Version in Settings > About is 0.1.0.

## M10 Download button on videos

- [ ] On a page with a plain `<video>` (for example a free stock-video site), move the pointer over the video: a "Download" pill appears at its top-right corner and fades after 2.5 s without movement. Small videos (under 200×112) get no button.
- [ ] Click it: the menu lists the files the page played (with size and type) and the video's own file. Choosing one adds it to the queue and shows "Added to GetSmart DM".
- [ ] On a supported video site (Facebook, X, Vimeo...), the menu also offers "Download video" through the companion at the default quality.
- [ ] If nothing is known yet: "Nothing to download yet. Play the video for a few seconds, then try again."
- [ ] No button on YouTube (unless Allow YouTube is on, then only the companion entry), on Netflix/other DRM sites, on disabled sites, or when "Download button on videos" is off in Settings.
- [ ] The page's own styles do not change the button; clicking elsewhere closes the menu; the page keeps working (play/pause clicks still reach the player).
- [ ] Bangla UI: the button and menu are in Bangla.
