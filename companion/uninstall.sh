#!/usr/bin/env bash
# GetSmart DM companion: remove the native-messaging registration for Chrome,
# Chromium, Edge and Brave (current user) on macOS and Linux.
# Deletes only the com.getsmartdm.host.json manifests this installer copied.
# Your downloaded videos are never touched.

set -eu

HOST_NAME="com.getsmartdm.host"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    DIRS="$BASE/Google/Chrome
$BASE/Chromium
$BASE/Microsoft Edge
$BASE/BraveSoftware/Brave-Browser" ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    DIRS="$BASE/google-chrome
$BASE/chromium
$BASE/microsoft-edge
$BASE/BraveSoftware/Brave-Browser" ;;
  *) echo "This uninstaller is for macOS and Linux (use uninstall.bat on Windows)." >&2; exit 1 ;;
esac

echo "Removing GetSmart DM companion registration (current user)..."
status=0
OLDIFS="$IFS"
IFS='
'
for dir in $DIRS; do
  f="$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$f" ] || [ -L "$f" ]; then
    if rm -f "$f"; then
      echo "  removed: $f"
    else
      echo "  ERROR: could not remove $f" >&2
      status=1
    fi
  else
    echo "  not registered: $dir"
  fi
done
IFS="$OLDIFS"

echo ""
echo "Done. The browsers can no longer start the companion."
echo "You can now delete this folder yourself. Your videos in Downloads/GetSmart DM are kept."
exit $status
