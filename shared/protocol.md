# GetSmart DM native-messaging protocol, v1

This file is the **only** definition of the protocol between the extension and the companion. Change this spec first, then the code on both sides.

## Transport

- Chrome/Edge/Brave native messaging, host name **`com.getsmartdm.host`**.
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
| `dir` | no | Target folder. If absent, the companion uses its default folder (reported in `hello`) |
| `youtube` | no | `true` only when the user has turned on the off-by-default YouTube setting. If absent or `false`, the companion refuses YouTube URLs with a `progress` of `state: "error"` |

The companion also refuses known DRM services (Netflix, Prime Video, Disney+, Hulu, Max, Spotify and similar) with `state: "error"`, and never tries to work around DRM.

### `cancel`
Cancel a running download.
```json
{ "type": "cancel", "v": 1, "id": "a1b2c3" }
```

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
| `dir` | Default download folder: `<user Downloads folder>\GetSmart DM\Video` |

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

`done`, `error` and `canceled` are final: no more `progress` follows for that `id`.

### `pong`
Reply to `ping`.
```json
{ "type": "pong", "v": 1 }
```
