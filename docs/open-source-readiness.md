# Open-Source Readiness

This checklist tracks what must be true before publishing the full Cetus repo
and the bridge packages.

## Current Bridge Boundary

- Rust bridge core lives in `src-tauri/cetus-bridge`.
- TypeScript bridge protocol lives in `packages/cetus-bridge-protocol`.
- Cetus app adapters live outside those packages:
  - `src-tauri/src/tauri_bridge.rs`
  - `src-tauri/src/app_event.rs`
  - `src-tauri/src/model_bridge.rs`
  - `src-tauri/src/prompts.rs`
- Existing app code imports the Rust bridge through the root re-export in
  `src-tauri/src/lib.rs`.
- Existing extensions import the TypeScript protocol through
  `src-tauri/cetus-extensions/bridge/protocol.ts`, a re-export shim.

## Ready Gates

- [x] Root repository has an MIT `LICENSE`.
- [x] `cetus-bridge` declares the same MIT license.
- [x] `@cetus/bridge-protocol` declares the same MIT license.
- [x] `cetus-bridge` builds as a standalone path crate.
- [x] `cetus-bridge` has a minimal host example:
  `src-tauri/cetus-bridge/examples/minimal_host.rs`.
- [x] `@cetus/bridge-protocol` builds as an isolated TypeScript package.
- [x] Bridge core has no direct Tauri, app event, app store, plugin registry, or
  Cetus model-choice dependency.
- [x] Build artifacts are ignored for bridge packages:
  `src-tauri/cetus-bridge/{target,Cargo.lock}` and
  `packages/cetus-bridge-protocol/dist`.
- [x] Bridge packages are provider-neutral: no DeepSeek-specific code or comments
  remain in `src-tauri/cetus-bridge` or `packages/cetus-bridge-protocol`.
- [x] Known scan false positives are limited to documented examples:
  `scripts/release.env.example` contains placeholder `APPLE_PASSWORD`, and this
  document contains the literal scan patterns.
- [x] `scripts/open-source-audit.sh` provides a repeatable local gate for bridge
  boundary checks, generated-artifact checks, and sensitive/private string scans.
- [x] `research/` has no tracked files; local research clones stay ignored.
- [x] `evals/` tracked files are fixtures/cases/scripts; generated
  `results/` and `workspaces/` outputs are ignored and checked by audit.
- [x] Tracked docs asset inventory exists in `docs/asset-release-review.md`.
- [x] Audit script scans docs asset bytes for embedded private-looking strings.

## Still Required Before Public Release

- [ ] Full-repo private reference audit, not just bridge package audit.
- [ ] Full-repo secret scan with a dedicated scanner before public release.
- [x] Decide whether `research/` and eval docs ship publicly or stay ignored:
  `research/` stays local/ignored; eval fixtures and benchmark scripts ship.
- [ ] Manually verify every bundled image/screenshot in `docs/` is visually
  publishable; see `docs/asset-release-review.md`.
- [ ] Add release/package instructions for `cetus-bridge` and
  `@cetus/bridge-protocol`.
- [ ] Expand the headless bridge example into a minimal Tauri host demo if the
  public story needs a UI example.
- [ ] Review first-party extensions for over-broad native side effects and
  product-specific assumptions.

## Verification Commands

Run from `src-tauri/`:

```sh
CARGO_TARGET_DIR=target cargo test --manifest-path cetus-bridge/Cargo.toml --examples
CARGO_TARGET_DIR=target cargo test --manifest-path cetus-bridge/Cargo.toml
cargo test --lib
cargo check
```

Run from the repo root:

```sh
pnpm build
pnpm exec tsc -p packages/cetus-bridge-protocol/tsconfig.json
NODE_PATH="$PWD/src-tauri/pi-install/node_modules" bun build \
  src-tauri/cetus-extensions/automation-tools.ts \
  src-tauri/cetus-extensions/skill-tools.ts \
  src-tauri/cetus-extensions/ultra-runtime.ts \
  --outdir /tmp/cetus-extension-check
```

Bridge-package boundary scan:

```sh
rg -n 'AppEvent|app_event|use tauri|TauriEventSink|TauriTaskSpawner|AppHandle|Emitter|tauri::async_runtime|crate::plugins|handle\.state|crate::automation|crate::store|ModelChoice|DsModel|ReasoningLevel|/Users/|gho_|sk-[A-Za-z0-9]|APPLE_PASSWORD|TAURI_SIGNING_PRIVATE_KEY' \
  src-tauri/cetus-bridge packages/cetus-bridge-protocol
```

Full-repo scan should exclude generated artifacts and the local pi install tree:

```sh
rg -n 'gho_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|APPLE_PASSWORD=|TAURI_SIGNING_PRIVATE_KEY=|/Users/|drewnekota' \
  README.md docs evals packages src src-tauri scripts \
  --glob '!src-tauri/target/**' \
  --glob '!src-tauri/pi-install/**' \
  --glob '!evals/**/results/**' \
  --glob '!evals/**/workspaces/**' \
  --glob '!scripts/release.env' \
  --glob '!packages/**/dist/**'
```

Or run the scripted gate:

```sh
scripts/open-source-audit.sh
```
