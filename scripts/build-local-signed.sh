#!/usr/bin/env bash
# Local dev: build cetus.app, sign it with your STABLE Apple Development identity,
# and (optionally) install it to /Applications — so macOS keeps your Accessibility
# / Screen Recording grants across rebuilds instead of re-prompting every time.
#
# One-time setup:
#   cp scripts/signing.env.example scripts/signing.env   # gitignored
#   # edit scripts/signing.env → set APPLE_SIGNING_IDENTITY to your identity
#   # (security find-identity -v -p codesigning)
#
# Then just:  scripts/build-local-signed.sh
#
# This uses a PLAIN signature (no hardened runtime / notarization) — for local
# use that's all you need; the point is only that the identity is stable. Release
# builds go through CI (.github/workflows/release.yml) with Developer ID + notarize.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
[ -f scripts/signing.env ] && source scripts/signing.env
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY in scripts/signing.env (see scripts/signing.env.example)}"

# Assemble the pi sidecar tree if it's missing (gitignored, ~144 MB).
[ -d src-tauri/pi-install ] || scripts/build-pi-sidecar.sh

echo "→ Building app bundle (unsigned)…"
# --bundles app: we only want the .app for local install; skip dmg packaging.
# No APPLE_SIGNING_IDENTITY is passed to tauri here on purpose — we sign manually
# below so the nested pi/.node binaries get signed too.
env -u APPLE_SIGNING_IDENTITY pnpm tauri build --bundles app

APP="$(/usr/bin/find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || { echo "no .app produced under target/release/bundle/macos" >&2; exit 1; }

echo "→ Signing $APP with: $APPLE_SIGNING_IDENTITY"
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" scripts/macos-sign.sh "$APP"

if [ "${1:-}" = "--install" ] || [ "${INSTALL:-}" = "1" ]; then
  echo "→ Installing to /Applications (quitting any running copy first)…"
  osascript -e 'tell application "Cetus" to quit' >/dev/null 2>&1 || true
  rm -rf "/Applications/$(basename "$APP")"
  cp -R "$APP" /Applications/
  echo "✓ Installed /Applications/$(basename "$APP")"
else
  echo "✓ Built + signed: $APP"
  echo "  (re-run with --install to copy it into /Applications)"
fi
