# SIDM Online: the service behind sidm.online/online-downloader.
# Build: docker build -t sidm-online online/
# Run:   docker run -d -p 8080:8080 --restart unless-stopped sidm-online
FROM python:3.12-slim

# ffmpeg joins video and sound and makes MP3s. Deno is the JavaScript runtime
# yt-dlp needs for YouTube.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno

RUN pip install --no-cache-dir -U "yt-dlp[default]"

RUN useradd --create-home sidm
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh && chown sidm /app
USER sidm

ENV PORT=8080 \
    SIDM_AUTO_UPDATE=1 \
    PIP_USER=1 \
    PATH="/home/sidm/.local/bin:${PATH}"
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=10s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=8)"
ENTRYPOINT ["./entrypoint.sh"]
