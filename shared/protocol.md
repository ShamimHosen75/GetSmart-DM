# SIDM native-messaging protocol, v1

This file is the **only** definition of the protocol between the extension and the companion. Change this spec first, then the code on both sides.

## Transport

- Chrome/Edge/Brave native messaging, host name **`com.sidm.host`**.
- Each message is framed as a **4-byte little-endian unsigned length** followed by that many bytes of **UTF-8 JSON** (one JSON object per message).
- Browser limits apply: host to browser messages max 1 MB, browser to host max 64 MiB.

## Common fields

Every message is a JSON object with:

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Message type (below) |
| `v` | integer | Protocol version. Currently **1** |

A receiver that gets a `v` it does not support must not act on the message. The companion answers with a `progress` message of `state: "error"` when the message carried an `id`; otherwise it logs and ignores it.

Unknown extra fields are ignored, so fields can be added without bumping `v`. Removing or changing the meaning of a field requires a new version.

## Extension to companion

### `hello`
Sent first after connecting.
```json
{ "type": "hello", "v": 1 }
```

### `add_video`
Start a download.
```json
{ "type": "add_video", "v": 1, "id": "a1b2c3", "url": "https://example.com/watch/123", "quality": "720", "dir": "C:\\Users\\me\\Downloads" }
```
| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique download id chosen by the extension; echoed in every `progress` |
| `url` | yes | Page or media URL |
| `quality` | yes | One of `best`, `1080`, `720`, `480`, `360`, `audio` |
| `dir` | no | Target folder: an absolute path to a folder that exists (usually one the user just chose with `pick_folder`). If absent, the companion uses its default folder (reported in `hello`). A `dir` that is not an existing absolute folder is refused with `state: "error"` |
| `youtube` | no | `true` only when the user has turned on the off-by-default YouTube setting. If absent or `false`, the companion refuses YouTube URLs with a `progress` of `state: "error"` |

The companion also refuses known DRM services (Netflix, Prime Video, Disney+, Hulu, Max, Spotify and similar) with `state: "error"`, and never tries to work around DRM.

### `video_info`
Ask what a video page offers, so the extension can show the size of each quality before the user picks one. Needs the `"video_info"` feature.
```json
{ "type": "video_info", "v": 1, "id": "q1w2e3", "url": "https://www.youtube.com/watch?v=abc", "youtube": true }
```
| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Request id chosen by the extension; echoed in the reply |
| `url` | yes | Page URL, as for `add_video` |
| `youtube` | no | Same rule as `add_video`: YouTube URLs are refused without it |

The companion answers with one `video_info` message (below). It may take a few seconds (it asks the site).

### `pick_folder`
Show the system's choose-a-folder dialog on the user's screen. Needs the `"pick_folder"` feature.
```json
{ "type": "pick_folder", "v": 1, "id": "p9o8i7", "title": "Choose where to save the video", "start": "C:\\Users\\me\\Videos" }
```
| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Request id chosen by the extension; echoed in the reply |
| `title` | no | Text shown in the dialog |
| `start` | no | Folder the dialog opens in, if it exists |

The companion answers with one `folder` message when the user closes the dialog. Folders chosen this way are remembered by the companion (at most 20), so `open_file` may open files in them.

### `cancel`
Cancel a running download.
```json
{ "type": "cancel", "v": 1, "id": "a1b2c3" }
```

### `add_file` (multi-connection file download)
Download one file over several HTTP connections at once. Also used to **resume** a paused or interrupted file: send `add_file` again with the same `id`, `url`, `folder` and `filename`, and the companion continues from its partial file.
```json
{ "type": "add_file", "v": 1, "id": "f1e2d3", "url": "https://example.com/big.zip", "filename": "big.zip", "folder": "SIDM/Archives", "connections": 8, "headers": { "Referer": "https://example.com/", "User-Agent": "Mozilla/5.0 ..." } }
```
| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique download id chosen by the extension; echoed in every `progress` |
| `url` | yes | `http` or `https` URL of the file |
| `filename` | no | File name to save as. The companion makes it safe for the file system. If absent, the name comes from `Content-Disposition` or the URL |
| `folder` | no | Folder **relative to the user's Downloads folder** (for example `SIDM/Archives`). Must not contain `..`. If absent, the Downloads folder itself |
| `connections` | no | Number of parallel connections, 1 to 16. Default 8 |
| `headers` | no | Extra request headers. Only `Referer`, `User-Agent` and `Accept-Language` are used |
| `speed_limit` | no | Bytes per second for this file, `0` or absent = no limit |

The companion first asks the server for one byte (`Range: bytes=0-0`). If the server does not answer `206` with a total size, or asks for a login (`401`/`403`), the companion does not download and answers `progress` with `state: "error"` and an `error_code`, so the extension can let the browser download the file instead.

While downloading, the file is written to `<name>.gsdmpart` next to the final file, with its state in `<name>.gsdmpart.json`. When all bytes are in, it is renamed to the final name (with ` (1)`, ` (2)`... added if that name exists).

### `pause_file`
Stop the connections of a running file download and keep the partial file, so `add_file` with the same `id` can resume it.
```json
{ "type": "pause_file", "v": 1, "id": "f1e2d3" }
```

### `cancel` (files)
`cancel` also stops a file download, running or paused, and removes its own `.gsdmpart` and `.gsdmpart.json` files. To cancel a paused file the companion does not know any more (it was restarted), the extension sends `add_file` fields along with `cancel`: `{ "type": "cancel", "id": ..., "url": ..., "filename": ..., "folder": ... }`.

### `set_speed_limit`
Limit the total speed of all file downloads, or of one file.
```json
{ "type": "set_speed_limit", "v": 1, "limit": 524288 }
{ "type": "set_speed_limit", "v": 1, "id": "f1e2d3", "limit": 0 }
```
| Field | Required | Meaning |
|---|---|---|
| `limit` | yes | Bytes per second, `0` = no limit |
| `id` | no | If present, the limit applies to that file only; otherwise to all file downloads together |

Video downloads (`add_video`) are not limited.

### `open_file`
Open a finished file, or show it in its folder.
```json
{ "type": "open_file", "v": 1, "path": "C:\\Users\\me\\Downloads\\SIDM\\Archives\\big.zip", "reveal": true }
```
Only paths that exist inside the user's Downloads folder, or inside a folder the user chose with `pick_folder`, are opened. `reveal: true` opens the folder with the file selected where the system allows it.

### `ping`
Liveness check.
```json
{ "type": "ping", "v": 1 }
```

## Companion to extension

### `hello`
Reply to `hello`.
```json
{ "type": "hello", "v": 1, "version": "0.1.0", "ytdlp": "2026.11.01", "ffmpeg": "7.1", "dir": "C:\\Users\\me\\Downloads" }
```
| Field | Meaning |
|---|---|
| `version` | Companion version |
| `ytdlp` | yt-dlp version, or `null` if not found |
| `ffmpeg` | ffmpeg version, or `null` if not found |
| `dir` | Default download folder: `<user Downloads folder>\SIDM\Video` |
| `downloads` | The user's Downloads folder (the root that `add_file` `folder` is relative to) |
| `features` | List of optional features this companion supports. `"files"` = `add_file`, `pause_file`, `set_speed_limit` and `open_file`; `"video_info"` = `video_info`; `"pick_folder"` = `pick_folder`. An older companion sends no `features` (or fewer); the extension then does without them |

Optional `js_runtime` (true/false): whether a JavaScript runtime (Deno) sits next to the companion. yt-dlp needs one for full YouTube support; the installers download it.

The companion answers `hello` within a second: it keeps the yt-dlp and ffmpeg versions it found in its own `versions.json` and only asks the tools again when their files change.

### `progress`
Sent repeatedly while a download runs, and once with a final state.
```json
{ "type": "progress", "v": 1, "id": "a1b2c3", "state": "running", "downloaded": 1048576, "total": 52428800, "speed": 2097152, "eta": 24, "filename": "video.mp4" }
```
| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Download id from `add_video` |
| `state` | yes | `running`, `done`, `error` or `canceled` |
| `downloaded` | no | Bytes downloaded so far |
| `total` | no | Total bytes, if known |
| `speed` | no | Bytes per second |
| `eta` | no | Seconds remaining |
| `filename` | no | Output file name (full path once `done`) |
| `error` | no | Human-readable message, present when `state` is `error` |
| `note` | no | Human-readable notice that is not an error, e.g. ffmpeg is missing so a lower-quality single-file format was used |

File downloads (`add_file`) use the same message with these differences and extra fields:

| Field | Meaning |
|---|---|
| `state` | Also `paused` (after `pause_file`; not final) |
| `filename` | Full path of the final file (also while running, so the extension can show where it goes) |
| `segments` | While running: one `[start, end, done]` per part of the file, in bytes (`end` inclusive, `done` = bytes of that part already written). At most 32 entries |
| `connections` | Number of connections downloading right now |
| `resumable` | `true` when the server supports ranges (always `true` once a file download runs) |
| `error_code` | With `state: "error"`: `no_range` (server cannot send parts), `auth` (`401`/`403`), `http` (other HTTP error), `network`, `disk`, `bad_request`. The extension falls back to the browser for `no_range` and `auth` |

`done`, `error` and `canceled` are final: no more `progress` follows for that `id`.

### `video_info` (reply)
```json
{ "type": "video_info", "v": 1, "id": "q1w2e3", "title": "My video", "duration": 212, "max_height": 1080,
  "sizes": { "best": 98500000, "1080": 98500000, "720": 41200000, "480": 22000000, "360": 14100000, "audio": 3400000 } }
```
| Field | Meaning |
|---|---|
| `id` | Request id |
| `sizes` | Estimated bytes for each quality of `add_video` (what that quality would download: best video up to that height plus the best audio). A quality with no estimate is left out. Estimates come from the site and can be off by a few percent |
| `max_height` | Height of the best video stream, or absent if unknown. Qualities above it download the same file as `best` |
| `title`, `duration` | From the site, if known |
| `error` | Present instead of `sizes` when the companion could not read the page (human-readable) |

### `folder`
Reply to `pick_folder`.
```json
{ "type": "folder", "v": 1, "id": "p9o8i7", "path": "D:\\Videos" }
{ "type": "folder", "v": 1, "id": "p9o8i7", "path": null }
{ "type": "folder", "v": 1, "id": "p9o8i7", "path": null, "error": "no_dialog" }
```
`path` is the chosen folder, or `null` when the user canceled. `error: "no_dialog"` means this system has no folder dialog the companion can show (for example Linux without zenity or kdialog); the extension then saves to the default folder.

### `pong`
Reply to `ping`.
```json
{ "type": "pong", "v": 1 }
```
