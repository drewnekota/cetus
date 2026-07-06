#!/usr/bin/env bash
# Package a signed .app into a drag-to-install .dmg: the volume contains the
# app plus an /Applications symlink, laid out side-by-side in an icon-view
# Finder window so users know to drag the app across.
#
# Usage: scripts/package-dmg.sh <path/to/Cetus.app> <path/to/output.dmg>
set -euo pipefail

APP="${1:?usage: package-dmg.sh <app> <dmg>}"
DMG="${2:?usage: package-dmg.sh <app> <dmg>}"
VOLNAME="Cetus"
APP_NAME="$(basename "$APP")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ditto "$APP" "$STAGE/src/$APP_NAME"
ln -s /Applications "$STAGE/src/Applications"

# Build read-write first so we can mount it and let Finder write the .DS_Store
# that records icon positions, then compress to the final read-only UDZO.
RW_DMG="$STAGE/rw.dmg"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE/src" -ov -format UDRW \
  -fs HFS+ "$RW_DMG" >/dev/null

# Mount under /Volumes so Finder registers it as a disk. If a volume named
# "Cetus" is already mounted (e.g. the user has a Cetus dmg open), macOS picks
# "Cetus 1" — so parse the real mount point instead of assuming the name.
MOUNT_DIR="$(hdiutil attach "$RW_DMG" -noverify -noautoopen \
  | grep -o '/Volumes/.*' | head -1)"
[ -d "$MOUNT_DIR" ] || { echo "failed to mount $RW_DMG" >&2; exit 1; }
MOUNTED_NAME="$(basename "$MOUNT_DIR")"

# Finder layout is best-effort: if AppleScript is unavailable (rare on CI) the
# dmg still works, just without the pretty arrangement.
if ! /usr/bin/osascript <<EOF >/dev/null 2>&1
tell application "Finder"
  tell disk "$MOUNTED_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 860, 520}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 128
    set position of item "$APP_NAME" of container window to {180, 170}
    set position of item "Applications" of container window to {480, 170}
    close
  end tell
end tell
EOF
then
  echo "warning: Finder layout failed; dmg will use default icon arrangement" >&2
fi
sync

hdiutil detach "$MOUNT_DIR" >/dev/null || { sleep 2; hdiutil detach "$MOUNT_DIR" -force >/dev/null; }

rm -f "$DMG"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
echo "✓ $DMG"
