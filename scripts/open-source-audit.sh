#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

section() {
  printf '\n== %s ==\n' "$1"
}

check_no_matches() {
  local name="$1"
  local pattern="$2"
  shift 2
  local tmp
  tmp="$(mktemp)"
  if rg -n "$pattern" "$@" >"$tmp"; then
    echo "FAIL: $name"
    cat "$tmp"
    fail=1
  else
    echo "ok: $name"
  fi
  rm -f "$tmp"
}

section "bridge package boundary"
check_no_matches \
  "Rust bridge source has no app/Tauri/model coupling" \
  'AppEvent|app_event|use tauri|TauriEventSink|TauriTaskSpawner|AppHandle|Emitter|tauri::async_runtime|crate::plugins|handle\.state|crate::automation|crate::store|ModelChoice|DsModel|ReasoningLevel|DeepSeek|drewnekota|/Users/' \
  src-tauri/cetus-bridge/src

check_no_matches \
  "TypeScript bridge protocol has no app/Tauri/private coupling" \
  'AppEvent|app_event|TauriEventSink|TauriTaskSpawner|DeepSeek|drewnekota|/Users/' \
  packages/cetus-bridge-protocol/src

section "generated artifacts"
for path in \
  packages/cetus-bridge-protocol/dist \
  src-tauri/cetus-bridge/target \
  src-tauri/cetus-bridge/Cargo.lock
do
  if [[ -e "$path" ]]; then
    echo "FAIL: generated artifact present: $path"
    fail=1
  else
    echo "ok: $path absent"
  fi
done

section "full repo sensitive strings"
tmp="$(mktemp)"
rg -n \
  'gho_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|APPLE_PASSWORD=|TAURI_SIGNING_PRIVATE_KEY=|/Users/jinqiu|drewnekota' \
  README.md README.zh-CN.md docs evals packages src src-tauri scripts \
  --glob '!src-tauri/target/**' \
  --glob '!src-tauri/pi-install/**' \
  --glob '!evals/**/results/**' \
  --glob '!evals/**/workspaces/**' \
  --glob '!scripts/release.env' \
  --glob '!scripts/signing.env' \
  --glob '!packages/**/dist/**' \
  >"$tmp" || true

# Allowed documented examples:
# - release.env.example contains placeholder APPLE_PASSWORD for users.
# - open-source-readiness.md and this script contain the literal scan patterns.
if grep -Ev '^(scripts/release\.env\.example:|docs/open-source-readiness\.md:|scripts/open-source-audit\.sh:)' "$tmp" >"$tmp.filtered"; then
  echo "FAIL: sensitive/private-looking strings found"
  cat "$tmp.filtered"
  fail=1
else
  echo "ok: no unexpected sensitive/private-looking strings"
fi
rm -f "$tmp" "$tmp.filtered"

section "tracked eval artifacts"
tmp="$(mktemp)"
git ls-files 'evals/**/results/**' 'evals/**/workspaces/**' >"$tmp"
if [[ -s "$tmp" ]]; then
  echo "FAIL: generated eval outputs are tracked"
  cat "$tmp"
  fail=1
else
  echo "ok: no generated eval outputs tracked"
fi
rm -f "$tmp"

section "docs asset embedded strings"
tmp="$(mktemp)"
git ls-files docs \
  | grep -E '\.(png|jpe?g|svg|excalidraw)$' \
  | xargs rg -a -n 'gho_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|APPLE_PASSWORD=|TAURI_SIGNING_PRIVATE_KEY=|/Users/jinqiu|drewnekota' \
  >"$tmp" || true
if [[ -s "$tmp" ]]; then
  echo "FAIL: sensitive/private-looking strings found in docs assets"
  cat "$tmp"
  fail=1
else
  echo "ok: docs assets have no embedded sensitive/private-looking strings"
fi
rm -f "$tmp"

section "result"
if [[ "$fail" -ne 0 ]]; then
  echo "open-source audit failed"
  exit 1
fi

echo "open-source audit passed"
