#!/usr/bin/env bash
# Archives a Release build and uploads it to App Store Connect for TestFlight.
# Bump CURRENT_PROJECT_VERSION in project.yml first: every upload needs a new build number.
# Uses ASC API key A39LNF998Z (team 65N4VF5643); override with ASC_KEY_ID / ASC_ISSUER_ID.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_ID="${ASC_KEY_ID:-A39LNF998Z}"
ISSUER="${ASC_ISSUER_ID:-209fcb99-7561-40e7-a2e9-98eec2e03ba4}"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER")
OUT="$ROOT/build/testflight"
mkdir -p "$OUT"

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${DESTINATION:-upload}</string>
  <key>teamID</key><string>65N4VF5643</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

(cd "$ROOT" && xcodegen generate --quiet)
rm -rf "$OUT/Cetus.xcarchive"
xcodebuild -project "$ROOT/CetusMobile.xcodeproj" -scheme Cetus -configuration Release -destination "generic/platform=iOS" \
  -archivePath "$OUT/Cetus.xcarchive" "${AUTH[@]}" -quiet archive
[ "${SKIP_EXPORT:-}" = 1 ] && exit 0
xcodebuild -exportArchive -archivePath "$OUT/Cetus.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" "${AUTH[@]}"
