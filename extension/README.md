# extension/

SIDM browser extension for Chrome 116+, Edge and Brave. Manifest V3, plain JavaScript ES modules, no build step and no external libraries. See the root `CLAUDE.md` for the rules.

Status: version 0.2.0 plus M15. Step 1 milestones M1 to M15 are done. M15: videos are downloaded by the extension itself, no companion app needed (see "Videos without the companion" below).

## Videos without the companion (M15)

The extension saves most site videos on its own:

1. `media.js` sees each response a tab gets. `stream-jobs.js` keeps the streams: HLS playlists (`.m3u8`), DASH manifests (`.mpd`), and pieces of MP4 files that players fetch bit by bit (Facebook-style `bytestart=`/`byteend=` addresses, or `206` partial responses to `fetch`).
2. When the video button or the popup asks, the offscreen page (`offscreen.html`, `offscreen.js`) reads them and offers choices such as 720p, 480p or audio only.
3. On a click it fetches every piece, 6 at a time. It joins separate video and audio into one MP4 (`mp4.js`, fragmented or plain MP4) and hands the worker a `blob:` URL. The worker saves it with `chrome.downloads` into `SIDM/Video`.

Limits:

- Encrypted streams (HLS `EXT-X-KEY`, DASH `ContentProtection`, `encv`/`enca`/`pssh` in MP4) and live streams are refused.
- MPEG-TS HLS is saved as `.ts`, which plays in VLC and most players, because joining TS into MP4 is not done.
- YouTube's streams are signed and scrambled, so YouTube needs the optional companion.
- The whole video is held in memory until it is saved, so very long videos need free RAM.

The companion app (`companion/`) is optional. It adds YouTube, multi-connection file downloads and a speed limit for those files.

## Install (Load unpacked)

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right in Chrome, left sidebar in Edge).
3. Click **Load unpacked** and pick this `extension/` folder (the one that holds `manifest.json`).
4. Pin SIDM from the puzzle-piece menu so the icon is always visible.

After pulling new code, press the reload arrow on the SIDM card.

## Extension ID

The ID is fixed: **`ejkhmcfjnohjikdgfgkhjficmiaoghma`**.

Chrome computes the ID from the public key in `manifest.json` `"key"`, so every Load unpacked install, on every computer, gets the same ID. The companion app whitelists this ID in its native-messaging manifest (`allowed_origins`).

`python scripts/extension_id.py` prints the ID from `manifest.json`.

### The private key (`extension-key.pem`)

The matching private key is `extension-key.pem` in the repo root. It is gitignored and must never be committed.

- Load unpacked does **not** need the private key. The `"key"` field alone fixes the ID.
- The private key is only needed to pack a signed `.crx` with the same ID (`chrome://extensions` > Pack extension > Private key file).
- If it is lost, generate a new pair. This **changes the ID**, so the companion whitelist must change too:

```sh
openssl genrsa -out extension-key.pem 2048
python scripts/extension_id.py --pem extension-key.pem --print-key
# paste the printed "key" into manifest.json "key", and update the ID in CLAUDE.md, this README and the companion
```

## Permissions

| Permission | Why SIDM needs it |
|---|---|
| `downloads` | List, start, pause, resume, cancel and retry downloads, and choose the folder and file name (`onDeterminingFilename`). |
| `downloads.open` | Open a finished file from the popup ("Open file"). |
| `contextMenus` | Right-click entries: download a link, download an image/video/audio file, grab all links on a page, download the video on a page. |
| `storage` | Settings (`storage.sync`), the download queue (`storage.local`), and media found per tab and companion jobs (`storage.session`). |
| `webRequest` | Read response headers (Content-Type, Content-Length, Content-Disposition) to detect video and audio files the page plays. Read-only, nothing is blocked or changed. |
| `webNavigation` | Clear the media list of a tab when it navigates to a new page. |
| `scripting` | Collect the links, images and media on a page for the link grabber, only when you ask for it. |
| `notifications` | Tell you when a download finishes or fails, and why a `blob:`/`data:` link cannot be saved. |
| `alarms` | Scheduler: start and stop the queue at the times you set. |
| `offscreen` | A hidden page that downloads video pieces and joins them into one file (M15). |
| `nativeMessaging` | Talk to the optional SIDM companion app (`com.sidm.host`), used for YouTube and multi-connection downloads when it is installed. |
| `host_permissions: <all_urls>` | Needed by `webRequest` and `scripting` to work on any site you visit. SIDM never sends page data anywhere. |

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest with the fixed `"key"` |
| `background.js` | Service worker (ES module): wires the modules below, badge, message router |
| `queue.js` | Queue in `storage.local`, folder sorting and chosen names (`onDeterminingFilename`), notifications |
| `menus.js` | Context menus |
| `media.js` | Media detection (`webRequest.onHeadersReceived`), per-tab lists in `storage.session` |
| `native-bridge.js` | Companion connection (`com.sidm.host`) and video jobs |
| `sites.js` | Video sites, YouTube hosts, DRM hosts, host helpers |
| `common.js` | Settings defaults and storage, theme, categories, safe file names, formatting |
| `i18n.js` | Built-in English + Bangla dictionary and `t()` |
| `popup.html` / `popup.js` | Toolbar popup |
| `downloads-view.js` | Popup "Downloads" tab |
| `add-links.js` | Popup "+" panel |
| `page-view.js` / `video-card.js` | Popup "This page" tab: detected media and the video card |
| `grabber.html` / `grabber.js` | Link grabber page (`grabber.html?tab=<id>`) |
| `options.html` / `options.js` | Settings page |
| `overlay.js` | Content script: the Download button over videos (closed shadow root) |
| `progress.html` / `progress.js` | Progress window for one download (`progress.html?id=<id>`) |
| `manager.html` / `manager.js` | Download manager page: category tree, sortable table, toolbar |
| `file-jobs.js` | Multi-connection file downloads through the companion (`add_file`), jobs in `storage.local` `fileJobs` |
| `scheduler.js` | Scheduler alarms and "when the queue is done" |
| `stream-jobs.js` | Videos downloaded in the browser (M15): streams per tab, jobs in `storage.local` `streamJobs`, saving |
| `offscreen.html` / `offscreen.js` | Hidden page: reads playlists and manifests, downloads pieces, joins them |
| `mp4.js` | Reads MP4 headers and joins a video and an audio MP4 into one |
| `stream-parse.js` | HLS and DASH parsers |
| `download-info.js` | State, name, size and error text of a download, shared by the lists |
| `speed.js` | Transfer rate from byte samples, and time left |
| `update-check.js` | "Update available" footer link |
| `ui.css` | Shared styles, light and dark theme |
| `icons/` | 16, 32, 48, 128 px icons, generated by `scripts/make_icons.py` |

## Worker messages

Extension pages talk to the service worker with `chrome.runtime.sendMessage({ type, ... })`:

| `type` | Fields | Reply |
|---|---|---|
| `enqueue` | `items: [{ url, filename? }]` | `{ added, rejected }` |
| `removeQueued` | `qid` | `{ ok }` |
| `setQueuePaused` | `paused` | `{ ok }` (stops or starts taking items from the queue) |
| `pauseFile` / `resumeFile` / `cancelFile` / `eraseFile` | `id` | `{ ok }` or `{ error }` (companion file downloads) |
| `openFile` | `id, reveal` | `{ ok }` or `{ error }` (open a finished companion file, or show it in its folder) |
| `setFileSpeedLimit` | `id, limit` (bytes/s, 0 = none) | `{ ok }` |
| `streamOptions` | `tabId` | `{ options: [{ id, label, hasAudio, size, kind, audioOnly }], refused }` (`refused`: `encrypted`, `live` or empty) |
| `addStream` | `optionId, tabId, title, pageUrl?` | `{ id }` or `{ error }` |
| `pauseStream` / `resumeStream` / `retryStream` / `cancelStream` / `eraseStream` | `id` | `{ ok }` or `{ error }` |
| `getVideoState` | `url` | `{ site, drm, companion, jobs, defaultQuality }` |
| `addVideo` | `url, quality, title?` | `{ id }` or `{ error }` |
| `cancelVideo` / `retryVideo` / `removeVideo` / `openVideoFolder` | `id` | `{ ok }` or `{ error }` |

## Testing

```sh
pip install playwright
python -m playwright install chromium
python scripts/test_extension.py          # headless, prints PASS/FAIL per check
```

Manual checklist: [`QA.md`](QA.md).

## Regenerating the icons

```sh
pip install pillow
python scripts/make_icons.py
```
