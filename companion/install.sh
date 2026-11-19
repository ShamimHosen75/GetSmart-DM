#!/usr/bin/env bash
# SIDM companion installer for macOS and Linux. No sudo needed.
#
# Downloads yt-dlp and ffmpeg into this folder, writes run_host.sh and the
# native-messaging manifest, and registers it for Chrome, Chromium, Edge and
# Brave (current user only).
#
# Run it from a terminal:   bash install.sh
#
# Written for the bash 3.2 that ships with macOS: no associative arrays,
# no ${var,,}, no mapfile.

set -eu

EXT_ID="ejkhmcfjnohjikdgfgkhjficmiaoghma"
HOST_NAME="com.sidm.host"
GH="https://github.com/yt-dlp"

HERE="$(cd "$(dirname "$0")" && pwd -P)"
MANIFEST="$HERE/$HOST_NAME.json"
LAUNCHER="$HERE/run_host.sh"
WORK=""

say()  { printf '%s\n' "$*"; }
fail() {
  printf '\nERROR: %s\n' "$*" >&2
  printf '\nInstall did NOT finish. See the message above.\n' >&2
  exit 1
}
cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

say ""
say "SIDM companion installer"
say "Folder: $HERE"
say ""

# ---------------------------------------------------------------- 1. checks

if [ "$(id -u)" = "0" ]; then
  fail "Do not run this with sudo or as root. Run it as your normal user: bash install.sh"
fi
[ -f "$HERE/host.py" ] || fail "host.py is missing. Extract the whole companion ZIP, then run install.sh again."

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) fail "Unsupported system: $OS. This installer is for macOS and Linux (use install.bat on Windows)." ;;
esac
say "System: $PLATFORM ($ARCH)"

if command -v curl >/dev/null 2>&1; then
  DL="curl"
elif command -v wget >/dev/null 2>&1; then
  DL="wget"
else
  fail "Neither curl nor wget was found. Install one of them, then run install.sh again."
fi

download() { # $1 = URL, $2 = target file
  if [ "$DL" = "curl" ]; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 --progress-bar -o "$2" "$1"
  else
    wget -O "$2" "$1"
  fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gsdm-install.XXXXXX")"

# ---------------------------------------------------------------- 2. Python 3

linux_python_hint() {
  ids=""
  if [ -r /etc/os-release ]; then
    ids="$(. /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
  fi
  case " $ids " in
    *" debian "*|*" ubuntu "*) say "  sudo apt install python3" ;;
    *" fedora "*|*" rhel "*|*" centos "*) say "  sudo dnf install python3" ;;
    *" arch "*) say "  sudo pacman -S python" ;;
    *" opensuse"*|*" suse "*) say "  sudo zypper install python3" ;;
    *" alpine "*) say "  sudo apk add python3" ;;
    *) say "  Install the package called python3 (on Arch it is called python) with your package manager." ;;
  esac
}

PYTHON=""
for cand in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  p="$(command -v "$cand" 2>/dev/null || true)"
  [ -n "$p" ] || continue
  # On macOS /usr/bin/python3 is a stub until the Command Line Tools are installed:
  # running it fails (and may pop up an install dialog), so test that it really works.
  if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    PYTHON="$p"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  say ""
  say "Python 3.8 or newer is needed and was not found."
  if [ "$PLATFORM" = "macos" ]; then
    say "Install Apple's Command Line Tools (includes python3):"
    say "  xcode-select --install"
    say "or install Python from https://www.python.org/downloads/macos/"
  else
    say "Install it with:"
    linux_python_hint
  fi
  fail "python3 is missing. Install it, then run install.sh again."
fi
say "[ok] Python: $PYTHON ($("$PYTHON" -c 'import sys; print(sys.version.split()[0])'))"

# ---------------------------------------------------------------- 3. yt-dlp

if [ "$PLATFORM" = "macos" ]; then
  YTDLP_ASSET="yt-dlp_macos"
else
  case "$ARCH" in
    x86_64|amd64) YTDLP_ASSET="yt-dlp_linux" ;;
    aarch64|arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
    armv7l|armv7*) YTDLP_ASSET="yt-dlp_linux_armv7l" ;;
    *) YTDLP_ASSET="yt-dlp" ;; # the zipapp: runs on any system python3
  esac
fi
YTDLP_URL="$GH/yt-dlp/releases/latest/download/$YTDLP_ASSET"

if [ -x "$HERE/yt-dlp" ]; then
  say "[skip] yt-dlp is already present. To update it later run: ./yt-dlp -U"
else
  say "[1/2] Downloading yt-dlp ($YTDLP_ASSET)..."
  download "$YTDLP_URL" "$WORK/yt-dlp" || fail "Download failed: $YTDLP_URL
Check your internet connection and try again."
  chmod +x "$WORK/yt-dlp"
  mv -f "$WORK/yt-dlp" "$HERE/yt-dlp" || fail "Could not copy yt-dlp into $HERE"
fi

# ---------------------------------------------------------------- 4. ffmpeg + ffprobe

# Copy ffmpeg and ffprobe found anywhere under $1 into this folder.
take_ffmpeg_from() {
  src_ff="$(find "$1" -type f -name ffmpeg -perm -u+x 2>/dev/null | head -n 1)"
  src_fp="$(find "$1" -type f -name ffprobe -perm -u+x 2>/dev/null | head -n 1)"
  [ -n "$src_ff" ] && [ -n "$src_fp" ] || return 1
  cp -f "$src_ff" "$HERE/ffmpeg" && cp -f "$src_fp" "$HERE/ffprobe" || return 1
  chmod +x "$HERE/ffmpeg" "$HERE/ffprobe"
}

# Download a .tar.xz build from $1 and take ffmpeg + ffprobe out of it.
ffmpeg_from_tarxz() {
  rm -rf "$WORK/ff" && mkdir -p "$WORK/ff"
  download "$1" "$WORK/ff.tar.xz" || return 1
  tar -xJf "$WORK/ff.tar.xz" -C "$WORK/ff" || return 1
  take_ffmpeg_from "$WORK/ff"
}

ffmpeg_linux() {
  case "$ARCH" in
    x86_64|amd64)  jv="amd64"; yt="linux64" ;;
    aarch64|arm64) jv="arm64"; yt="linuxarm64" ;;
    i?86)          jv="i686";  yt="" ;;
    armv7l|armv7*) jv="armhf"; yt="" ;;
    *) return 1 ;;
  esac
  url="${GSDM_FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$jv-static.tar.xz}"
  say "[2/2] Downloading ffmpeg static build, about 40 MB..."
  if ffmpeg_from_tarxz "$url"; then return 0; fi
  [ -n "$yt" ] || return 1
  say "      johnvansickle.com did not work, trying the yt-dlp ffmpeg build on GitHub..."
  ffmpeg_from_tarxz "$GH/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-$yt-gpl.tar.xz"
}

ffmpeg_macos() {
  if command -v brew >/dev/null 2>&1; then
    say "[2/2] Homebrew found, using its ffmpeg..."
    prefix="$(brew --prefix)"
    if [ ! -x "$prefix/bin/ffmpeg" ] || [ ! -x "$prefix/bin/ffprobe" ]; then
      say "      brew install ffmpeg (this can take a few minutes)..."
      brew install ffmpeg || return 1
    fi
    # Symlinks, so 'brew upgrade' keeps them current. Browsers start the companion
    # with a short PATH that does not include Homebrew, so it looks here first.
    ln -sf "$prefix/bin/ffmpeg" "$HERE/ffmpeg" && ln -sf "$prefix/bin/ffprobe" "$HERE/ffprobe"
    return
  fi
  if [ "$ARCH" = "arm64" ] && ! /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
    say ""
    say "Note: the evermeet.cx ffmpeg build is for Intel Macs. On Apple Silicon it needs Rosetta."
    say "Install Rosetta with:  softwareupdate --install-rosetta --agree-to-license"
    say "or install Homebrew (https://brew.sh) and run install.sh again to use its ffmpeg."
  fi
  say "[2/2] Downloading ffmpeg and ffprobe from evermeet.cx..."
  rm -rf "$WORK/ff" && mkdir -p "$WORK/ff"
  download "https://evermeet.cx/ffmpeg/getrelease/zip" "$WORK/ffmpeg.zip" || return 1
  download "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" "$WORK/ffprobe.zip" || return 1
  unzip -o -q "$WORK/ffmpeg.zip" -d "$WORK/ff" || return 1
  unzip -o -q "$WORK/ffprobe.zip" -d "$WORK/ff" || return 1
  chmod +x "$WORK/ff/ffmpeg" "$WORK/ff/ffprobe" 2>/dev/null || true
  take_ffmpeg_from "$WORK/ff"
}

if [ -x "$HERE/ffmpeg" ] && [ -x "$HERE/ffprobe" ]; then
  say "[skip] ffmpeg and ffprobe are already present."
elif [ "$PLATFORM" = "macos" ]; then
  ffmpeg_macos || fail "Could not get ffmpeg. Check your internet connection, or install Homebrew and run: brew install ffmpeg"
else
  ffmpeg_linux || fail "Could not get ffmpeg for $ARCH. Install it with your package manager (package name: ffmpeg), then run install.sh again."
fi

# ---------------------------------------------------------------- 4b. Deno (optional)
# yt-dlp needs a JavaScript runtime for full YouTube support. A failure only warns.
deno_asset() {
  case "$PLATFORM:$ARCH" in
    macos:arm64) echo "deno-aarch64-apple-darwin.zip" ;;
    macos:*) echo "deno-x86_64-apple-darwin.zip" ;;
    *:x86_64|*:amd64) echo "deno-x86_64-unknown-linux-gnu.zip" ;;
    *:aarch64|*:arm64) echo "deno-aarch64-unknown-linux-gnu.zip" ;;
    *) echo "" ;;
  esac
}
if [ -x "$HERE/deno" ]; then
  say "[skip] deno is already present."
elif command -v deno >/dev/null 2>&1; then
  say "[ok] deno found on PATH: $(command -v deno)"
else
  DENO_ASSET="$(deno_asset)"
  if [ -n "$DENO_ASSET" ] && command -v unzip >/dev/null 2>&1; then
    say "Downloading Deno for YouTube, about 40 MB..."
    rm -rf "$WORK/deno" && mkdir -p "$WORK/deno"
    if download "${GSDM_DENO_URL:-https://github.com/denoland/deno/releases/latest/download/$DENO_ASSET}" "$WORK/deno.zip" \
        && unzip -o -q "$WORK/deno.zip" -d "$WORK/deno" && mv -f "$WORK/deno/deno" "$HERE/deno"; then
      chmod +x "$HERE/deno"
    else
      say "WARNING: Deno could not be installed. Some YouTube videos may not download. Run install.sh again later."
    fi
  else
    say "WARNING: no Deno build for $PLATFORM/$ARCH (or unzip is missing). Some YouTube videos may not download."
  fi
fi

if [ "$PLATFORM" = "macos" ]; then
  # Files fetched by a browser carry a quarantine flag that blocks them from running.
  xattr -d com.apple.quarantine "$HERE/deno" "$HERE/yt-dlp" "$HERE/ffmpeg" "$HERE/ffprobe" "$HERE/host.py" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 5. launcher + manifest

# The browser runs the launcher directly, so it needs the absolute path of Python.
# Single-quote the path for sh (an embedded ' becomes '\'').
q_python="'$(printf '%s' "$PYTHON" | sed "s/'/'\\\\''/g")'"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
# Generated by install.sh. The browser starts this to run the SIDM companion.
# If you move this folder, run install.sh again.
DIR="\$(cd "\$(dirname "\$0")" && pwd -P)"
PATH="\$DIR:/opt/homebrew/bin:/usr/local/bin:\$PATH"
export PATH
exec $q_python "\$DIR/host.py" "\$@"
EOF
chmod +x "$LAUNCHER" "$HERE/host.py"

# Python writes the JSON so any folder name (spaces, quotes, non-English letters) stays valid.
"$PYTHON" - "$MANIFEST" "$HOST_NAME" "$LAUNCHER" "$EXT_ID" <<'EOF' || fail "Could not write $MANIFEST"
import json, sys
out, name, path, ext = sys.argv[1:5]
with open(out, "w", encoding="utf-8") as f:
    json.dump({"name": name, "description": "SIDM companion", "path": path,
               "type": "stdio", "allowed_origins": ["chrome-extension://%s/" % ext]}, f, indent=2)
    f.write("\n")
EOF

if [ "$PLATFORM" = "macos" ]; then
  BASE="$HOME/Library/Application Support"
  BROWSERS="Chrome|$BASE/Google/Chrome
Chromium|$BASE/Chromium
Edge|$BASE/Microsoft Edge
Brave|$BASE/BraveSoftware/Brave-Browser"
else
  BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSERS="Chrome|$BASE/google-chrome
Chromium|$BASE/chromium
Edge|$BASE/microsoft-edge
Brave|$BASE/BraveSoftware/Brave-Browser"
fi

say ""
say "Registering for Chrome, Chromium, Edge and Brave (current user)..."
registered=0
OLDIFS="$IFS"
IFS='
'
for line in $BROWSERS; do
  IFS="$OLDIFS"
  label="${line%%|*}"
  dir="${line#*|}"
  # Register Chrome always; the others only when that browser has been run once
  # (its settings folder exists), so we do not create folders for browsers you do not have.
  if [ "$label" != "Chrome" ] && [ ! -d "$dir" ]; then
    say "  skipped $label (not installed; run install.sh again after installing it)"
    continue
  fi
  mkdir -p "$dir/NativeMessagingHosts" || fail "Could not create $dir/NativeMessagingHosts"
  cp -f "$MANIFEST" "$dir/NativeMessagingHosts/$HOST_NAME.json" || fail "Could not copy the manifest to $dir/NativeMessagingHosts"
  say "  $label: $dir/NativeMessagingHosts/$HOST_NAME.json"
  registered=$((registered + 1))
done
IFS="$OLDIFS"

# ---------------------------------------------------------------- 6. verify

say ""
say "Checking the tools..."
"$HERE/yt-dlp" --version >/dev/null 2>&1 || fail "yt-dlp does not run. Delete the yt-dlp file in this folder and run install.sh again."
say "yt-dlp $("$HERE/yt-dlp" --version)"
"$HERE/ffmpeg" -version >/dev/null 2>&1 || fail "ffmpeg does not run. Delete ffmpeg and ffprobe in this folder and run install.sh again."
"$HERE/ffmpeg" -version | head -n 1
say ""
say "Companion self-check:"
"$LAUNCHER" --check || fail "host.py --check failed. See host.log in this folder."

say ""
say "Done. Restart Chrome, Chromium, Edge or Brave, then open SIDM: the companion should show as connected."
say "Keep this folder where it is. If you move it, run install.sh again."
