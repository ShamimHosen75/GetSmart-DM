#!/usr/bin/env bash
# SIDM companion: remove the native-messaging registration for Chrome,
# Chromium, Edge and Brave (current user) on macOS and Linux.
# Deletes only the com.sidm.host.json manifests this installer copied.
# Your downloaded videos are never touched.

set -eu

HOST_NAME="com.sidm.host"
# Name used before the rename to SIDM; removed too if an older install left it.
OLD_HOST_NAME="com.getsmartdm.host"

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

echo "Removing SIDM companion registration (current user)..."
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
  old="$dir/NativeMessagingHosts/$OLD_HOST_NAME.json"
  if [ -f "$old" ] || [ -L "$old" ]; then rm -f "$old" && echo "  removed old: $old"; fi
done
IFS="$OLDIFS"

echo ""
echo "Done. The browsers can no longer start the companion."
echo "You can now delete this folder yourself. Your videos in Downloads/SIDM are kept."
exit $status
