#!/usr/bin/env bash
# Code-sign (and optionally notarize) a cetus macOS bundle.
#
# WHY THIS EXISTS, NOT just Tauri's built-in signer: the app bundles a
# bun-compiled `pi` executable plus several native `.node` modules under
# Contents/Resources/pi-install/. Tauri signs the .app shell and its main
# binary, but does NOT sign arbitrary Mach-O files living under resources/.
# Apple's notary service rejects any bundle containing an unsigned or
# non-hardened-runtime executable, so we sign every nested Mach-O ourselves,
# inside-out (deepest first), giving the JIT'ing `pi` sidecar its own looser
# entitlements. Then we seal the .app last.
#
# Usage:
#   APPLE_SIGNING_IDENTITY="..." scripts/macos-sign.sh <Cetus.app | Cetus.dmg> [--harden] [--notarize]
#
#   (no flags)   plain stable signature — for LOCAL dev (Apple Development
#                identity). Enough to keep TCC grants across rebuilds.
#   --harden     hardened runtime + entitlements + secure timestamp — required
#                before notarization. Use with a "Developer ID Application" id.
#   --notarize   implies --harden; submits to Apple's notary service and staples
#                the ticket. Needs APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID
#                (app-specific password) in the environment.
#   --staple-only  no signing: just staple a ticket Apple has already issued for
#                this bundle. The notary service notarizes everything inside a
#                submitted container, so once the .dmg carrying this .app is
#                accepted, the .app's own ticket exists and stapler fetches it
#                by cdhash — one Apple round-trip instead of two.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ENTITLEMENTS="$SCRIPT_DIR/../src-tauri/entitlements.plist"
PI_ENTITLEMENTS="$SCRIPT_DIR/../src-tauri/entitlements-pi.plist"

TARGET="${1:-}"
HARDEN=0
NOTARIZE=0
STAPLE_ONLY=0
for arg in "${@:2}"; do
  case "$arg" in
    --harden)      HARDEN=1 ;;
    --notarize)    HARDEN=1; NOTARIZE=1 ;;
    --staple-only) STAPLE_ONLY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[ -n "$TARGET" ] && [ -e "$TARGET" ] || { echo "usage: macos-sign.sh <app|dmg> [--harden] [--notarize] [--staple-only]" >&2; exit 2; }

if [ "$STAPLE_ONLY" = 1 ]; then
  # No re-signing here: the bundle must keep the exact cdhash Apple notarized.
  echo "→ Stapling Apple's existing ticket to $TARGET"
  stapled=0
  for attempt in 1 2 3 4 5; do
    if xcrun stapler staple "$TARGET"; then
      stapled=1
      break
    fi
    # The ticket is published a moment after the enclosing submission is
    # accepted, so an early staple can miss it. Wait and ask again.
    echo "  ticket not available yet (attempt $attempt); retrying in 10s"
    sleep 10
  done
  [ "$stapled" = 1 ] || { echo "no notarization ticket for $TARGET" >&2; exit 1; }
  case "$TARGET" in
    *.app|*.app/)
      echo "→ Verifying Gatekeeper acceptance"
      spctl --assess --type execute --verbose=4 "$TARGET" || true
      ;;
  esac
  echo "✓ Stapled: $TARGET"
  exit 0
fi

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (see: security find-identity -v -p codesigning)}"

# Common codesign flags. Hardened runtime + a secure timestamp are mandatory for
# notarization; we skip them for plain local signing to stay fast and offline.
COMMON=(--force --sign "$APPLE_SIGNING_IDENTITY")
if [ "$HARDEN" = 1 ]; then
  COMMON+=(--options runtime --timestamp)
fi

sign_one() { # <file> [entitlements]
  local f="$1" ent="${2:-}"
  if [ "$HARDEN" = 1 ] && [ -n "$ent" ]; then
    codesign "${COMMON[@]}" --entitlements "$ent" "$f"
  else
    codesign "${COMMON[@]}" "$f"
  fi
}

notarize() { # <file: .zip or .dmg> <staple-target>
  local submit="$1" staple_target="$2"
  : "${APPLE_ID:?--notarize needs APPLE_ID}"
  : "${APPLE_PASSWORD:?--notarize needs APPLE_PASSWORD (app-specific password)}"
  : "${APPLE_TEAM_ID:?--notarize needs APPLE_TEAM_ID}"
  echo "→ Submitting to Apple notary service (this can take a few minutes)…"
  xcrun notarytool submit "$submit" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait
  echo "→ Stapling ticket to $staple_target"
  xcrun stapler staple "$staple_target"
}

case "$TARGET" in
  *.dmg)
    sign_one "$TARGET"
    [ "$NOTARIZE" = 1 ] && notarize "$TARGET" "$TARGET"
    ;;
  *.app|*.app/)
    APP="${TARGET%/}"
    MAIN_BIN_DIR="$APP/Contents/MacOS"
    # Every Mach-O under the bundle, deepest path first, EXCLUDING the main
    # binary in Contents/MacOS/ (sealed when we sign the .app itself below).
    while IFS= read -r f; do
      case "$f" in "$MAIN_BIN_DIR"/*) continue ;; esac
      if file -b "$f" | grep -q "Mach-O"; then
        printf '%s\t%s\n' "$(awk -F/ '{print NF}' <<<"$f")" "$f"
      fi
    done < <(find "$APP" -type f) | sort -rn | cut -f2- | while IFS= read -r f; do
      case "$f" in
        */pi-install/pi) echo "  sign (pi sidecar): ${f#$APP/}"; sign_one "$f" "$PI_ENTITLEMENTS" ;;
        *)               echo "  sign: ${f#$APP/}";              sign_one "$f" ;;
      esac
    done
    # Seal the bundle last (this signs Contents/MacOS/<main> with app entitlements).
    echo "→ Sealing $APP"
    sign_one "$APP" "$APP_ENTITLEMENTS"
    codesign --verify --deep --strict --verbose=2 "$APP"
    if [ "$NOTARIZE" = 1 ]; then
      ZIP="${APP%.app}.notarize.zip"
      /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
      notarize "$ZIP" "$APP"
      rm -f "$ZIP"
      echo "→ Verifying Gatekeeper acceptance"
      spctl --assess --type execute --verbose=4 "$APP" || true
    fi
    ;;
  *) echo "target must be a .app or .dmg: $TARGET" >&2; exit 2 ;;
esac

echo "✓ Signed: $TARGET"
