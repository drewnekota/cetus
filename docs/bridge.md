# Cetus Bridge

Cetus Bridge is the host/extension layer that lets a Tauri desktop app expose
native and app-owned capabilities to an agent runtime without hard-wiring those
capabilities into the model loop.

The current implementation is still in-repo, but the boundary is now explicit:

- Rust protocol and router: `src-tauri/cetus-bridge/src/bridge.rs`
- Pi RPC process wrapper and event demux: `src-tauri/cetus-bridge/src/pi_rpc.rs`
- Shared TypeScript extension protocol: `packages/cetus-bridge-protocol/src/index.ts`
- First-party extensions: `src-tauri/cetus-extensions/*.ts`

## What It Does

The bridge has four jobs:

1. Spawn and supervise a long-lived `pi --mode rpc` process per conversation.
2. Load TypeScript extensions into that agent process in deterministic order.
3. Forward normal agent events to the Tauri frontend as `app-event`.
4. Intercept known hidden extension RPCs and route them to native host handlers.

The key trick is the host tunnel. Pi extensions already have `ctx.ui.input`, so
Cetus uses specific sentinel titles as an internal RPC transport:

```text
extension tool
  -> ctx.ui.input("__cetus_skill__", JSON.stringify(payload))
  -> Rust bridge classifier
  -> native handler
  -> extension_ui_response
  -> tool result text for the model
```

Only sentinel titles listed in `src-tauri/cetus-bridge/src/bridge.rs` are intercepted. Any
other extension UI request keeps flowing to the frontend dialog host, which keeps
native side effects behind an explicit allowlist.

`src-tauri/cetus-bridge/src/bridge.rs` also owns `RuntimeConfig`, the product-neutral config
that `PiRpc::spawn` now receives. It carries:

- `append_system_prompt`: the already-composed prompt addendum for this app/mode.
- `extensions.directory_name`: the extension folder to scan under the runtime.
- `extensions.required_extensions`: filenames that must be present for the host
  surface to work as advertised.
- `plugin_extensions`: app-computed plugin extension paths, plugin-owned core
  overrides, and enabled-plugin summaries.

That means the subprocess wrapper no longer decides the extension directory or
required extension set itself, and it no longer reads the Cetus plugin store.
Cetus computes those choices before spawning the runtime and passes them in.
`PiRpc::spawn` receives an `EventSink` and `TaskSpawner`; Cetus passes
`TauriEventSink` and `TauriTaskSpawner` from `src-tauri/src/tauri_bridge.rs`.
The subprocess runtime no longer imports Tauri directly and emits
`bridge::RuntimeEvent` instead of Cetus frontend events. `src-tauri/src/app_event.rs`
maps those runtime events into the app's serialized `app-event` payloads, so other
hosts can supply their own event mapping without changing the bridge core.
Likewise, Cetus model choices are translated in `src-tauri/src/model_bridge.rs`;
`PiRpc` only sends protocol-level provider/model/thinking-level strings.

## Open-Source Core

These pieces now live in the local `src-tauri/cetus-bridge` crate and are good
candidates for a separately published `cetus-bridge` crate/package:

- JSONL subprocess RPC client with request/response correlation.
- Stall-based streaming timeout driven by child stdout activity.
- Deterministic extension discovery and load ordering.
- Host tunnel protocol constants and JSON payload helpers.
- Event demux from runtime events into host/frontend events.
- Extension-side helpers for host calls and tool result formatting.
- Minimal examples for skill, automation, and browser/control style tunnels.

## Product-Specific Pieces

These should stay as app integrations or examples, not the bridge core:

- Cetus identity/system prompt and product guide in `src-tauri/src/prompts.rs`.
- DeepSeek model choice wiring.
- Automation, skill, memory, dreaming, review, and board semantics.
- Browser-use and computer-use implementation details.
- MCP connector settings UI and stored connector model.
- App signing, updater, release, and private service credentials.

The core should define how a host call is transported and routed; the app decides
what `__cetus_skill__` or `__cetus_automation__` actually does.

## Current Protocol

Rust owns the authoritative sentinel list in `src-tauri/cetus-bridge/src/bridge.rs`.
TypeScript extensions import matching constants through
`src-tauri/cetus-extensions/bridge/protocol.ts`, which re-exports the package
source from `packages/cetus-bridge-protocol/src/index.ts`.

Current host tunnels:

- `__cetus_ultra_agent__`: spawn one sub-agent for Ultra workflows.
- `__cetus_agent_step__`: emit a live browser/computer action step to the UI.
- `__cetus_cua_request__`: call the native macOS accessibility helper.
- `__cetus_browser_request__`: open/focus the embedded browser surface.
- `__cetus_automation__`: create/list/update scheduled automations.
- `__cetus_skill__`: create/list/update/delete user skills.

Payloads are JSON strings carried in the `placeholder` field of `ctx.ui.input`.
Replies are JSON strings delivered through pi's `extension_ui_response`.

## Security Boundary

The bridge treats extension output as untrusted unless a narrow host tunnel says
otherwise:

- Unknown `extension_ui_request` messages are rendered by the frontend dialog
  host, not executed natively.
- Native side effects require a known sentinel title and a host handler.
- Extension tool calls should return structured errors instead of throwing, so
  the agent can recover without corrupting the conversation.
- External connector and web/OCR content must remain data, never instructions.

Before the whole repo is public, audit every first-party extension for:

- Secrets or service-specific credentials.
- Private endpoints, org names, or personal paths.
- Over-broad filesystem/network/native side effects.
- Product prompts that reveal unreleased strategy rather than behavior.

## Minimal Host Tunnel

Extension side:

```ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callHost, HOST_TUNNELS, toolResult, type HostTunnelContext } from "./bridge/protocol";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_skills",
    description: "List user skills through the native host.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, exCtx) {
      const reply = await callHost(exCtx as HostTunnelContext, HOST_TUNNELS.skill, {
        op: "list",
      });
      return toolResult(reply);
    },
  });
}
```

Host side:

```rust
if let Some(kind) = crate::bridge::host_tunnel_kind(&value) {
    let params = crate::bridge::tunnel_params(&value);
    match kind {
        crate::bridge::HostTunnelKind::Skill => {
            // Route to the app-owned skill handler, then reply with
            // `extension_ui_response` using the original request id.
        }
        _ => {
            // Other host tunnels stay explicitly handled or ignored.
        }
    }
}
```

The protocol is deliberately small: a known title selects the native handler,
`placeholder` carries JSON params, and `extension_ui_response.value` carries the
JSON reply. Everything else remains normal extension UI.

## Extraction Plan

1. Keep `src-tauri/cetus-bridge/src/bridge.rs` product-light and move more
   protocol-only code there as it stabilizes.
2. Treat `src-tauri/cetus-bridge` as the staging crate for a public
   `cetus-bridge` release; app-specific adapters stay in `src-tauri/src`.
3. Move any remaining app assumptions out of `PiRpc` before publishing the crate,
   keeping configuration hooks for env, runtime paths, and extension directories.
4. Treat `packages/cetus-bridge-protocol` as the staging package for a public
   `@cetus/bridge-protocol` release.
5. Extend `src-tauri/cetus-bridge/examples/minimal_host.rs` into a minimal Tauri
   demo app that registers one host tunnel and one extension tool.
6. Document the extension contract independently of Cetus product features.

This keeps the full Cetus repo open-source-ready while making bridge the obvious
technical asset instead of a hidden implementation detail.

See `docs/open-source-readiness.md` for the release checklist and verification
commands.
