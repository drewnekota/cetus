#!/usr/bin/env bash
# Build pi as a single-file binary and assemble its full runtime tree under
# src-tauri/pi-install/.
#
# Why a tree, not just a binary: pi's Bun-compiled executable resolves several
# resources (package.json, theme/*.json, assets/*) relative to its binary's
# parent directory at runtime, not from Bun's embedded virtual FS. Shipping
# only the binary breaks startup (see pi issue notes in TROUBLESHOOTING). The
# install tree mirrors the npm tarball so every relative-path read resolves.
#
# Output: src-tauri/pi-install/
#   pi                        — the bun-compiled executable
#   package.json, dist/, ...  — full npm tarball contents
#   node_modules/             — runtime deps from `bun install`
#   theme/, assets/           — symlinks to dist/modes/interactive/{theme,assets}
#                                so pi's `<bindir>/theme/...` reads work

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$REPO_ROOT/src-tauri/pi-install"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  CLIP_PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) CLIP_PLATFORM="darwin-x64" ;;
  Linux-x86_64)  CLIP_PLATFORM="linux-x64" ;;
  Linux-aarch64) CLIP_PLATFORM="linux-arm64" ;;
  *)
    echo "Unsupported host platform: $(uname -s) $(uname -m)" >&2
    exit 1 ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (https://bun.sh)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ Downloading @earendil-works/pi-coding-agent tarball..."
TARBALL_URL="$(npm view @earendil-works/pi-coding-agent dist.tarball)"
curl -fsSL "$TARBALL_URL" -o "$WORK/pi.tgz"

echo "→ Extracting..."
tar -xzf "$WORK/pi.tgz" -C "$WORK"
cd "$WORK/package"

echo "→ Installing runtime deps with bun..."
bun install --silent

# MCP client used by cetus-extensions/mcp-bridge.ts to connect user-configured
# MCP servers ("Connectors") and expose their tools to the agent. Installed into
# this tree's node_modules so pi's jiti extension loader can resolve `import
# "mcporter"` from <bindir>/cetus-extensions/. Pinned; runs under pi's bun runtime.
MCPORTER_VERSION="0.11.3"
echo "→ Adding mcporter@$MCPORTER_VERSION (MCP bridge dependency)..."
bun add "mcporter@$MCPORTER_VERSION" --silent

echo "→ Compiling single-file binary..."
bun build --compile ./dist/bun/cli.js --outfile pi

echo "→ Assembling install tree at $DEST_DIR"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
# Copy the whole package tree (excluding any platform-specific cruft we'll
# re-add explicitly). We exclude .npmignore-ish junk; the tarball is already
# minimal so a full copy is fine.
cp -R . "$DEST_DIR/"
# Pi's compiled binary reads `<bindir>/theme/*` and `<bindir>/assets/*` at
# startup, but in the tarball those live under dist/modes/interactive/. Copy
# them up — symlinks don't survive Tauri's resource bundler (it dereferences,
# then the bundled copy has no top-level theme/ dir).
cp -R dist/modes/interactive/theme  "$DEST_DIR/theme"
cp -R dist/modes/interactive/assets "$DEST_DIR/assets"
chmod 0755 "$DEST_DIR/pi"

# Overlay cetus's own pi extensions (vision-bridge, etc.). These live under
# version control at src-tauri/cetus-extensions/ and must be re-deployed here on
# every sidecar build because this whole tree is wiped (rm -rf above) and is
# itself gitignored. pi loads `<bindir>/<EXT_DIR>/*.ts` at spawn time
# (see src-tauri/src/pi_rpc.rs), and the host re-syncs this dir into the app's
# writable install tree on launch (src-tauri/src/lib.rs::sync_cetus_extensions).
# EXT_DIR_NAME MUST match pi_rpc::CETUS_EXTENSIONS_DIR — if you rename it, change
# it in pi_rpc.rs (loader), lib.rs (sync), AND here, or the loader reads an empty
# path and the agent launches with zero of its own tools.
EXT_DIR_NAME="cetus-extensions"
CETUS_EXT_SRC="$REPO_ROOT/src-tauri/$EXT_DIR_NAME"
if [ -d "$CETUS_EXT_SRC" ]; then
  cp -R "$CETUS_EXT_SRC" "$DEST_DIR/$EXT_DIR_NAME"
  echo "→ $EXT_DIR_NAME overlaid ($(ls "$CETUS_EXT_SRC" | wc -l | tr -d ' ') file(s))"
fi

PLUGIN_DIR_NAME="cetus-plugins"
CETUS_PLUGIN_SRC="$REPO_ROOT/src-tauri/$PLUGIN_DIR_NAME"
if [ -d "$CETUS_PLUGIN_SRC" ]; then
  cp -R "$CETUS_PLUGIN_SRC" "$DEST_DIR/$PLUGIN_DIR_NAME"
  echo "→ $PLUGIN_DIR_NAME overlaid ($(find "$CETUS_PLUGIN_SRC" -name plugin.json | wc -l | tr -d ' ') plugin(s))"
fi

# Harden pi-ai's request-side message conversion. Every provider routes its
# history through transformMessages() (transform-messages.js) before converting
# to wire format, and each converter assumes message `content` is an array
# (for...of / .filter / .some / .flatMap). A message can still arrive with
# content == null (e.g. a tool result whose content was never populated): one
# such message throws mid-agent-loop, the host surfaces it as "pi rejected
# prompt: undefined is not an object (evaluating 'content')", and because the
# bad message stays in history EVERY later prompt re-crashes — the conversation
# is bricked. The poison is usually a tool result whose content was never
# populated (content == null) OR a half-streamed assistant turn left with an
# EMPTY content array ([]) when a run crashed mid-stream — both choke the
# per-provider converters. Inject one tolerant guard at this shared chokepoint
# (nullish OR empty-array content → a "(no content)" placeholder block; strings
# are left untouched as they're already handled per role). Idempotent: keyed off
# the `cetus-guard` marker so re-runs and upstream changes are safe.
PI_AI_TRANSFORM="$DEST_DIR/node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js"
GUARD='    messages = messages.map((m) => (m \&\& (m.content == null || (Array.isArray(m.content) \&\& m.content.length === 0))) ? { ...m, content: [{ type: "text", text: "(no content)" }] } : m); \/* cetus-guard *\/'
if [ -f "$PI_AI_TRANSFORM" ] && ! grep -q "cetus-guard" "$PI_AI_TRANSFORM"; then
  perl -0777 -pi -e "s/(export function transformMessages\\(messages, model, normalizeToolCallId\\) \\{\\n)/\$1${GUARD}\\n/" "$PI_AI_TRANSFORM"
  grep -q "cetus-guard" "$PI_AI_TRANSFORM" \
    && echo "→ pi-ai content guard applied: transform-messages.js" \
    || echo "⚠ pi-ai content guard FAILED to apply (transformMessages signature changed?)" >&2
fi

# Native clipboard module (pi loads it at runtime for some operations).
CLIP_SRC="$WORK/package/node_modules/@mariozechner/clipboard-$CLIP_PLATFORM"
if [ -d "$CLIP_SRC" ]; then
  CLIP_DST="$DEST_DIR/node_modules/@mariozechner/clipboard-$CLIP_PLATFORM"
  if [ ! -d "$CLIP_DST" ]; then
    mkdir -p "$(dirname "$CLIP_DST")"
    cp -R "$CLIP_SRC" "$CLIP_DST"
  fi
  echo "→ Clipboard module present ($CLIP_PLATFORM)"
fi

# Slim the install tree. pi ships as a bun-compiled binary with its JS bundled
# in; this tree exists only so pi's runtime relative-path reads (package.json,
# theme/, assets/) and jiti's runtime `.ts` extension loading — which resolves
# real deps (pi-ai, mcporter, …) from node_modules — keep working. None of that
# reads source maps, TypeScript declarations, or package docs/changelogs, so
# drop them. Keep package.json, .js, .ts, .json, native binaries, and LICENSE
# files (redistribution compliance). This is the safe tier (~100 MB); it does
# NOT touch the build-time deps (typescript, rolldown, esbuild) — those may be
# reachable via dynamic import at runtime and need a smoke test before removal.
echo "→ Slimming install tree (strip source maps, type defs, docs)..."
BEFORE_SZ="$(du -sh "$DEST_DIR" | awk '{print $1}')"
find "$DEST_DIR" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
rm -rf "$DEST_DIR/docs" "$DEST_DIR/examples" "$DEST_DIR/CHANGELOG.md"

# Drop deps that the shipped runtime never resolves. pi is bun-compiled with its
# JS (incl. pi-ai's providers, which call provider HTTP APIs via raw fetch)
# bundled into the `pi` binary, and jiti transpiles `.ts` extensions with its own
# transformer — so neither the build/compile toolchain nor the per-provider SDK
# packages are loaded from this node_modules at runtime. Verified by smoke test
# (./pi --provider deepseek/anthropic --print → reaches the real API; -e *.ts →
# jiti loads it) with all of these removed. cetus is DeepSeek-only; the OpenAI
# SDK stays because DeepSeek rides pi-ai's openai-completions path. NOTE: this
# also disables pi's standalone `install`/`update` extension-build commands and
# trims non-DeepSeek model adapters — fine for the bundled app, revisit if either
# assumption changes.
echo "→ Pruning build toolchain + unused provider SDKs (DeepSeek-only)..."
for dep in typescript @rolldown @esbuild rollup vite \
           @anthropic-ai @google @mistralai @aws-sdk @smithy; do
  rm -rf "$DEST_DIR/node_modules/$dep"
done

# Pruning the toolchain orphans the .bin shims that pointed into it (e.g.
# node_modules/.bin/tsserver -> ../typescript/bin/tsserver). Tauri's resource
# bundler dereferences every symlink under the bundled tree and ABORTS the build
# on a dangling one ("resource path pi-install/... doesn't exist"). Sweep broken
# links so the slimmed tree stays bundleable. (`! -exec test -e {}` matches a
# symlink whose target no longer resolves.)
DANGLING="$(find "$DEST_DIR" -type l ! -exec test -e {} \; -print -delete)"
if [ -n "$DANGLING" ]; then
  echo "→ removed dangling symlinks after prune:"
  echo "$DANGLING" | sed 's/^/    /'
fi
echo "  install tree: $BEFORE_SZ → $(du -sh "$DEST_DIR" | awk '{print $1}')"

echo "✓ Done. $DEST_DIR ($(du -sh "$DEST_DIR" | awk '{print $1}'))"
