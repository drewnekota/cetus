#!/bin/zsh
# Build, sign, notarize and (with --publish) ship a Swift release.
#
#   ./release.sh              build + sign + notarize into dist/<version>/
#   ./release.sh --publish    ...then upload to the `swift` release on drewnekota/cetus
#
# Version: bump VERSION first; it must be newer than the published appcast.
# Notes:   optional RELEASE_NOTES (text) or RELEASE_NOTES_FILE.
# Needs:   the Developer ID cert in the login keychain, a notarytool keychain
#          profile ($CETUS_NOTARY_PROFILE, default "cetus-notary"), the Sparkle
#          EdDSA key in the keychain (generate_keys), and `gh` logged in as drewnekota.
set -euo pipefail
cd "$(dirname "$0")"

PUBLISH=0
[[ "${1:-}" == "--publish" ]] && PUBLISH=1

[[ -f release.env ]] && source release.env
VERSION=$(tr -d '[:space:]' < VERSION)
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: QIU JIN (65N4VF5643)}"
NOTARY_PROFILE="${CETUS_NOTARY_PROFILE:-cetus-notary}"
REPO=drewnekota/cetus
TAG=swift
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
SPARKLE_BIN=.build/artifacts/sparkle/Sparkle/bin
APP_NAME="Cetus Swift.app"
DIST="dist/$VERSION"

step() { print -P "%F{cyan}==>%f $*"; }

# --- 0. preflight -------------------------------------------------------------
[[ "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || { echo "VERSION must be x.y.z (got $VERSION)"; exit 1; }
security find-identity -v -p codesigning | grep -q "$IDENTITY" || { echo "missing signing identity: $IDENTITY"; exit 1; }
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
  echo "notarytool profile '$NOTARY_PROFILE' not found. Create it once with:"
  echo "  xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id ${APPLE_ID:-<apple id>} --team-id 65N4VF5643"
  exit 1
}
PUBLISHED=$(curl -fsSL "$BASE_URL/appcast.xml" 2>/dev/null | sed -n 's/.*<sparkle:shortVersionString>\(.*\)<\/sparkle:shortVersionString>.*/\1/p' | head -1 || true)
if [[ -n "$PUBLISHED" ]]; then
  NEWEST=$(printf '%s\n%s\n' "$PUBLISHED" "$VERSION" | sort -V | tail -1)
  [[ "$NEWEST" == "$VERSION" && "$PUBLISHED" != "$VERSION" ]] || { echo "VERSION $VERSION is not newer than published $PUBLISHED"; exit 1; }
fi
if (( PUBLISH )); then
  GH_TOKEN=$(gh auth token --user drewnekota 2>/dev/null) || { echo "gh is not logged in as drewnekota"; exit 1; }
  export GH_TOKEN
fi

# --- 1. build -------------------------------------------------------------------
step "Building cetus-agentd"
cargo build --release --manifest-path "$HOME/Developer/gpuix-fork/apps/cetus/agentd/Cargo.toml"
step "Building Cetus $VERSION"
CETUS_RELEASE=1 ./bundle.sh >/dev/null
/bin/rm -rf "$DIST"
mkdir -p "$DIST"
APP="$DIST/$APP_NAME"
ditto build/Cetus.app "$APP"

# --- 2. sign, inside out ------------------------------------------------------
step "Signing"
sign() { codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@"; }
FW="$APP/Contents/Frameworks/Sparkle.framework"
sign "$FW/Versions/B/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$FW/Versions/B/XPCServices/Downloader.xpc"
sign "$FW/Versions/B/Autoupdate"
sign "$FW/Versions/B/Updater.app"
sign "$FW"
sign "$APP/Contents/Resources/cetus-agentd"
sign --entitlements Cetus.entitlements "$APP"
codesign --verify --deep --strict "$APP"

# --- 3. notarize ----------------------------------------------------------------
step "Notarizing the app"
ditto -c -k --keepParent "$APP" "$DIST/notarize.zip"
xcrun notarytool submit "$DIST/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
/bin/rm -f "$DIST/notarize.zip"
spctl --assess --type execute -vv "$APP"

# --- 4. artifacts -------------------------------------------------------------
step "Packaging"
ZIP="$DIST/Cetus-Swift-$VERSION.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
DMG="$DIST/Cetus-Swift-$VERSION.dmg"
STAGE=$(mktemp -d)
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Cetus Swift" -srcfolder "$STAGE" -ov -format ULFO "$DMG" >/dev/null
/bin/rm -rf "$STAGE"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
step "Notarizing the DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

# --- 5. appcast -----------------------------------------------------------------
step "Writing appcast"
SIG=$("$SPARKLE_BIN/sign_update" "$ZIP")   # sparkle:edSignature="…" length="…"
NOTES="${RELEASE_NOTES:-}"
[[ -n "${RELEASE_NOTES_FILE:-}" ]] && NOTES=$(cat "$RELEASE_NOTES_FILE")
[[ -z "$NOTES" ]] && NOTES="Cetus $VERSION"
NOTES_XML=$(print -r -- "$NOTES" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
cat > "$DIST/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Cetus (Swift)</title>
    <item>
      <title>$VERSION</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<pre>$NOTES_XML</pre>]]></description>
      <enclosure url="$BASE_URL/Cetus-Swift-$VERSION.zip" type="application/octet-stream" $SIG/>
    </item>
  </channel>
</rss>
XML
cp "$DMG" "$DIST/Cetus-Swift.dmg"   # stable name for the install link

echo
echo "Artifacts in $DIST:"
ls -lh "$DIST" | tail -n +2
if (( ! PUBLISH )); then
  echo "Dry run: not published. Re-run with --publish to upload."
  exit 0
fi

# --- 6. publish -----------------------------------------------------------------
step "Publishing to $REPO@$TAG"
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "Cetus (Swift)" --prerelease --latest=false \
    --notes "Native Swift build of Cetus. Install: download Cetus-Swift.dmg and drag Cetus Swift into Applications. It updates itself from this release's appcast.xml."
fi
# Upload the archive before the appcast so the feed never points at a missing file.
gh release upload "$TAG" --repo "$REPO" --clobber "$ZIP" "$DMG" "$DIST/Cetus-Swift.dmg"
gh release upload "$TAG" --repo "$REPO" --clobber "$DIST/appcast.xml"
echo "Published $VERSION: $BASE_URL/Cetus-Swift.dmg"
