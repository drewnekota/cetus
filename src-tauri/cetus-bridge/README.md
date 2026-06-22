# cetus-bridge

Rust host/runtime bridge for Cetus-compatible agent hosts.

This crate owns the product-light pieces:

- JSONL subprocess RPC around `pi --mode rpc`
- deterministic extension loading
- host tunnel sentinel classification
- `RuntimeConfig` and `RuntimeEvent`
- injectable `EventSink` and `TaskSpawner` traits

Cetus app-specific adapters live outside this crate:

- `src-tauri/src/tauri_bridge.rs` maps task spawning and event emission to Tauri.
- `src-tauri/src/app_event.rs` maps `RuntimeEvent` into Cetus frontend events.
- `src-tauri/src/model_bridge.rs` maps Cetus model choices into provider/model ids.
- `src-tauri/src/prompts.rs` provides Cetus product prompts and runtime config.

## Verify

From `src-tauri/`:

```sh
CARGO_TARGET_DIR=target cargo test --manifest-path cetus-bridge/Cargo.toml
CARGO_TARGET_DIR=target cargo test --manifest-path cetus-bridge/Cargo.toml --examples
```

The crate should stay free of Tauri, app storage, app events, and model-provider
product types.

## Minimal Host

`examples/minimal_host.rs` shows the smallest host-side integration:

- implement `EventSink` to receive `RuntimeEvent`
- implement `TaskSpawner` to run bridge background tasks
- build a `RuntimeConfig`
- call `PiRpc::spawn`

Compile it:

```sh
CARGO_TARGET_DIR=target cargo test --manifest-path cetus-bridge/Cargo.toml --examples
```

Run it with a pi binary:

```sh
CARGO_TARGET_DIR=target cargo run --manifest-path cetus-bridge/Cargo.toml --example minimal_host -- /path/to/pi
```
