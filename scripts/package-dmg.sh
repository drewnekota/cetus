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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKGROUND="$SCRIPT_DIR/assets/dmg-background.png"

[ -f "$BACKGROUND" ] || {
  echo "missing dmg background: $BACKGROUND" >&2
  exit 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ditto "$APP" "$STAGE/src/$APP_NAME"
ln -s /Applications "$STAGE/src/Applications"
mkdir -p "$STAGE/src/.background"
cp "$BACKGROUND" "$STAGE/src/.background/background.png"

# Build read-write first so we can mount it and let Finder write the .DS_Store
# that records icon positions, then compress to the final read-only UDZO.
RW_DMG="$STAGE/rw.dmg"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE/src" -ov -format UDRW \
  -fs HFS+ "$RW_DMG" >/dev/null

# Mount under /Volumes so Finder registers it as a disk. If a volume named
# "Cetus" is already mounted (e.g. the user has a Cetus dmg open), macOS picks
# "Cetus 1" — so parse the real mount point instead of assuming the name.
ATTACH_OUT="$(hdiutil attach "$RW_DMG" -noverify -noautoopen)"
# `set -o pipefail` is on, so nothing downstream of a pipe may exit early: an
# `awk ... exit` or `head -1` closes the pipe, the writer dies of SIGPIPE, and
# the pipeline reports failure even though the match succeeded. Every awk here
# reads its input to the end and latches the first hit instead.
MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUT" \
  | awk -F'\t' '$0 ~ /\/Volumes\// && !f { print $NF; f = 1 }')"
[ -d "$MOUNT_DIR" ] || { echo "failed to mount $RW_DMG" >&2; exit 1; }
MOUNTED_NAME="$(basename "$MOUNT_DIR")"
# Detach by device node rather than mount path: a detach that unmounts the
# volume but fails to eject the disk leaves the path gone, and a retry keyed on
# the path then dies with ENOENT instead of finishing the eject.
DEV_SLICE="$(printf '%s\n' "$ATTACH_OUT" \
  | awk '$0 ~ /\/Volumes\// && !f { print $1; f = 1 }')"
DEV_NODE="$(printf '%s' "$DEV_SLICE" | sed -E 's#s[0-9]+$##')"

# Finder layout is best-effort: if AppleScript is unavailable (rare on CI) the
# dmg still works, just without the pretty arrangement.
if ! /usr/bin/osascript <<EOF >/dev/null 2>&1
tell application "Finder"
  tell disk "$MOUNTED_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set the bounds of container window to {200, 120, 920, 560}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 144
    set text size of viewOptions to 14
    set background picture of viewOptions to file ".background:background.png"
    set position of item "$APP_NAME" of container window to {185, 230}
    set position of item "Applications" of container window to {535, 230}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF
then
  echo "warning: Finder layout failed; dmg will use default icon arrangement" >&2
fi
sync

# Spotlight and fseventsd keep indexing the freshly written volume after Finder
# lets go of it, so a first detach often loses to "Resource busy" (this failed
# the v0.3.93 release). Retry against the device node, escalating to -force, and
# stop as soon as the disk is no longer attached.
detached=0
for attempt in 1 2 3 4 5; do
  # Here-string, not `hdiutil info | grep -q`: with pipefail, grep -q exiting on
  # the first match kills hdiutil with SIGPIPE and the pipeline reports failure,
  # which reads as "already detached" exactly when the disk is still attached.
  if ! grep -q "^${DEV_NODE}[[:space:]]" <<<"$(hdiutil info)"; then
    detached=1
    break
  fi
  if [ "$attempt" -eq 1 ]; then
    hdiutil detach "$DEV_NODE" >/dev/null 2>&1 || true
  else
    hdiutil detach "$DEV_NODE" -force >/dev/null 2>&1 || true
  fi
  sleep 2
done
[ "$detached" = 1 ] || { echo "failed to detach $DEV_NODE ($MOUNT_DIR)" >&2; exit 1; }

rm -f "$DMG"
# ULFO (LZFSE) rather than UDZO at zlib-level=9: on a bundle this size the deflate
# pass was the single slowest thing in the release job, and LZFSE compresses a
# ~300 MB app tree in a fraction of the time at a comparable size. It needs
# macOS 10.11+ to mount; the app itself requires 13.0.
hdiutil convert "$RW_DMG" -format ULFO -o "$DMG" >/dev/null
echo "✓ $DMG"
