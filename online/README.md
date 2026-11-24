# SIDM Online

The small service behind the website's [online downloader](../site/online-downloader.html).
The page sends it a pasted link; it asks [yt-dlp](https://github.com/yt-dlp/yt-dlp) what the link
offers, downloads the format the visitor picks (joining video and sound or making an MP3 with
ffmpeg) and hands the file back. Files are deleted 30 minutes after they are ready.

The website itself stays static on Cloudflare Pages. Only the link downloads need this service;
the page's MP4 to MP3 converter runs in the browser and needs nothing.

| File | What it is |
|---|---|
| `server.py` | The service. Python standard library only; runs `yt-dlp` and `ffmpeg` |
| `Dockerfile`, `entrypoint.sh` | Image with Python, ffmpeg, Deno (yt-dlp needs it for YouTube) and yt-dlp, updated on every start and once a day |
| `docker-compose.yml`, `Caddyfile` | One-command deploy with automatic HTTPS at `api.sidm.online` |

## Free hosting on Render (about 10 minutes)

`render.yaml` at the repository root sets everything up on [Render](https://render.com)'s free plan:

1. Open https://render.com/deploy?repo=https://github.com/ShamimHosen75/GetSmart-DM and sign in
   with GitHub (no card needed for the free plan).
2. Press **Deploy Blueprint**. Render builds the Docker image in `online/` (about 5 minutes).
3. Open the service's address, for example `https://sidm-online.onrender.com/api/health`; it shows
   `{"ok": true, ...}`.
4. Put that address (without `/api/health`) in `<meta name="sidm-api">` in
   `site/online-downloader.html`. The Video link tab appears once it is deployed.

Free plan limits: it sleeps after 15 minutes with no visitors and takes up to a minute to wake
(the page wakes it when it opens and tells the visitor), 512 MB of memory (two downloads at once,
files up to 1 GB, videos up to 2 hours) and a monthly traffic allowance. Move to a paid plan or the
VPS below when it gets busy. Optional: add `api.sidm.online` as a custom domain in Render and a
CNAME record in Cloudflare DNS, then use that address in the meta tag instead.

## Deploy on your own server (about 15 minutes)

It needs a machine that runs Docker all the time. A small VPS is enough to start
(2 vCPU, 2 to 4 GB RAM, 40 GB disk; for example Hetzner CX22, DigitalOcean, Vultr or Linode,
about US$4 to 6 a month). Downloads go through the server, so pick a plan with generous traffic.

1. Create the server (Ubuntu 24.04) and install Docker: `curl -fsSL https://get.docker.com | sh`
2. In Cloudflare DNS for sidm.online add an **A** record `api` pointing at the server's IP,
   proxy status **DNS only** (grey cloud).
3. On the server: `git clone https://github.com/ShamimHosen75/GetSmart-DM && cd GetSmart-DM/online && docker compose up -d --build`
4. Check `https://api.sidm.online/api/health` shows `{"ok": true, ...}`. The page already points
   there (`<meta name="sidm-api">` in `site/online-downloader.html`).

Platforms that run a Dockerfile (Render, Railway, Fly.io, Google Cloud Run) work too: deploy this
folder, set the settings below, and point `api.sidm.online` (or change the page's `sidm-api`
meta tag) at the address they give you.

## Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `SIDM_ORIGINS` | `https://sidm.online,https://www.sidm.online,https://*.sidm.pages.dev` | Pages allowed to use the service (CORS) |
| `SIDM_MAX_DURATION` | `10800` | Longest video, in seconds |
| `SIDM_MAX_FILESIZE` | `2147483648` | Biggest file, in bytes |
| `SIDM_MAX_JOBS` | `4` | Downloads running at once (others wait) |
| `SIDM_MAX_JOBS_PER_IP` | `2` | Downloads running at once per visitor |
| `SIDM_INFO_PER_IP` / `SIDM_RATE_WINDOW` | `40` / `600` | Link checks per visitor per window (seconds) |
| `SIDM_KEEP_FILES` | `1800` | Seconds a finished file is kept |
| `SIDM_TRUST_PROXY` | `1` | Read the visitor IP from `CF-Connecting-IP` / `X-Forwarded-For` |
| `SIDM_AUTO_UPDATE` | `1` in Docker | Update yt-dlp once a day |
| `SIDM_ALLOW_PRIVATE` | off | Tests only: allow links to localhost |

## Good to know

- **YouTube** often asks data-centre servers to "confirm you're not a bot". When that happens the
  page says so and points to the extension, which downloads from the visitor's own PC. Residential
  or less-used hosting IPs are blocked less.
- **DRM** sites (Netflix, Prime Video, Disney+, Spotify and others) are refused. Links to private
  network addresses (localhost, LAN, cloud metadata) are refused so the service can't be used to
  reach the server's own network.
- **Logs** go to standard output (`docker compose logs sidm-online`): job starts and failures,
  which include the link. Nothing is written to disk except the temporary files.

## Test

`python scripts/test_online.py` runs the unit checks and a full browser test against local test
videos (needs yt-dlp, ffmpeg and Playwright).

## API

| Request | Answer |
|---|---|
| `GET /api/health` | `{"ok": true, "version", "ytdlp", "ffmpeg"}` |
| `POST /api/info` `{"url"}` | `{"info", "title", "thumbnail", "duration", "uploader", "site", "youtube", "options": [{"id", "kind", "label", "note", "ext", "size"}]}` |
| `POST /api/jobs` `{"info", "option"}` | `202 {"job", "state", ...}` |
| `GET /api/jobs/<job>` | `{"state": "queued" / "downloading" / "converting" / "done" / "error", "percent", "bytes", "total", "speed", "eta", "size", "error"}` |
| `GET /api/jobs/<job>/file` | The file, as an attachment |
| `DELETE /api/jobs/<job>` | Cancels a running job |

Errors are `{"error": "<message for the visitor>"}` with a 4xx/5xx status.
