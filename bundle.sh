#!/bin/zsh
# Build Cetus.app (release config) with cetus-agentd and Sparkle bundled.
# Dev builds are ad-hoc signed and carry no update feed; release.sh sets
# CETUS_RELEASE=1 to add the Sparkle feed and signs/notarizes on its own.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(tr -d '[:space:]' < VERSION)
swift build -c release
AGENTD="${CETUS_AGENTD:-$HOME/Developer/gpuix-fork/apps/cetus/agentd/target/release/cetus-agentd}"
APP=build/Cetus.app
/bin/rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp .build/release/Cetus "$APP/Contents/MacOS/Cetus"
ditto .build/release/Sparkle.framework "$APP/Contents/Frameworks/Sparkle.framework"
cp -R .build/release/Cetus_Cetus.bundle "$APP/Contents/Resources/"
cp "$AGENTD" "$APP/Contents/Resources/cetus-agentd"
ICONSET=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s Sources/Cetus/Resources/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) Sources/Cetus/Resources/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
FEED=""
if [[ "${CETUS_RELEASE:-}" == 1 ]]; then
  FEED="
  <key>SUFeedURL</key><string>https://github.com/drewnekota/cetus/releases/download/swift/appcast.xml</string>
  <key>SUPublicEDKey</key><string>/EWL9yZRRygz0ICF7hXLvNPWO6UllsyaLehvBwi9vDk=</string>
  <key>SUEnableInstallerLauncherService</key><false/>"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Cetus</string>
  <key>CFBundleDisplayName</key><string>Cetus</string>
  <key>CFBundleIdentifier</key><string>dev.cetus.swift</string>
  <key>CFBundleExecutable</key><string>Cetus</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>$FEED
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSMicrophoneUsageDescription</key><string>cetus uses your microphone to transcribe speech to text for voice input.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>cetus transcribes your speech on-device so you can dictate instead of type.</string>
  <key>NSAppleEventsUsageDescription</key><string>cetus reads the front browser tab and app so screen context and quick capture know what you're looking at.</string>
  <key>NSAudioCaptureUsageDescription</key><string>cetus transcribes the other meeting participants from your system audio. No audio is stored.</string>
</dict></plist>
PLIST
if [[ "${CETUS_RELEASE:-}" != 1 ]]; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
fi
echo "$APP"
