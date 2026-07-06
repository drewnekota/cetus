#!/usr/bin/env bash
# Build a RELEASE-style cetus bundle locally — the same artifact CI produces —
# so you can test it before tagging a release. Signs with your Developer ID +
# hardened runtime, packages a .dmg, and (with --notarize) submits to Apple.
#
# One-time setup:
#   cp scripts/release.env.example scripts/release.env   # gitignored
#   # edit scripts/release.env → set APPLE_SIGNING_IDENTITY (Developer ID) and,
#   # for --notarize, APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID.
#
# Usage:
#   scripts/build-release.sh                 # Dev ID + hardened runtime + dmg (fast, no Apple round-trip)
#   scripts/build-release.sh --notarize      # + Apple notarization + staple (minutes; needs creds)
#   scripts/build-release.sh --install       # also copy the .app into /Applications
#
# WITHOUT --notarize you still get a real hardened-runtime build — enough to
# confirm the app launches and the JIT'ing pi sidecar + native .node modules
# load under hardened runtime (the #1 thing that breaks on notarized builds).
# WITH --notarize you additionally prove Gatekeeper accepts the download.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
[ -f scripts/release.env ] && source scripts/release.env
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY in scripts/release.env (your \"Developer ID Application: …\" id)}"

NOTARIZE=0 INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --notarize) NOTARIZE=1 ;;
    --install)  INSTALL=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
SIGN_FLAGS=(--harden); [ "$NOTARIZE" = 1 ] && SIGN_FLAGS=(--notarize)

[ -d src-tauri/pi-install ] || scripts/build-pi-sidecar.sh

echo "→ Building app bundle (unsigned; we sign nested binaries ourselves)…"
env -u APPLE_SIGNING_IDENTITY pnpm tauri build --bundles app

APP="$(/usr/bin/find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || { echo "no .app produced" >&2; exit 1; }

echo "→ Signing the app (${SIGN_FLAGS[*]})…"
scripts/macos-sign.sh "$APP" "${SIGN_FLAGS[@]}"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
DMG="src-tauri/target/release/bundle/Cetus_${VERSION}_aarch64.dmg"
echo "→ Packaging $DMG"
scripts/package-dmg.sh "$APP" "$DMG"
echo "→ Signing the dmg (${SIGN_FLAGS[*]})…"
scripts/macos-sign.sh "$DMG" "${SIGN_FLAGS[@]}"

if [ "$INSTALL" = 1 ]; then
  echo "→ Installing to /Applications…"
  osascript -e 'tell application "Cetus" to quit' >/dev/null 2>&1 || true
  rm -rf "/Applications/$(basename "$APP")"
  cp -R "$APP" /Applications/
fi

echo
echo "✓ Release bundle ready:"
echo "    app: $APP"
echo "    dmg: $DMG"
[ "$NOTARIZE" = 0 ] && echo "  (hardened-runtime only — re-run with --notarize for the Gatekeeper-clean download)"
echo
echo "Quick local checks:"
echo "    spctl --assess --type execute -vv \"$APP\"        # Gatekeeper verdict"
echo "    codesign --verify --deep --strict -v \"$APP\"     # structural verify"