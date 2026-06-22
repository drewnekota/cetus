# @cetus/bridge-protocol

TypeScript helpers for Cetus-compatible extension host tunnels.

The package exports:

- `HOST_TUNNELS`: the shared sentinel title list
- `callHost()`: send a JSON payload through `ctx.ui.input`
- `toolResult()`: format a host reply as a pi tool result
- host tunnel TypeScript types

Cetus extensions import this through
`src-tauri/cetus-extensions/bridge/protocol.ts`, a shim kept under the extension
directory so the host scanner only loads top-level extension entrypoints.

## Verify

From the repo root:

```sh
pnpm exec tsc -p packages/cetus-bridge-protocol/tsconfig.json
```
