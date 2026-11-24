#!/bin/sh
# Sites change often, so start every container with the newest yt-dlp.
# server.py checks for a new one once a day after that (SIDM_AUTO_UPDATE=1).
python -m pip install --user -U -q "yt-dlp[default]" || echo "yt-dlp update failed, using the built-in one"
exec python server.py
