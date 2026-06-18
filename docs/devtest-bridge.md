# Cetus devtest bridge (M1–M4)

A **dev-only** bridge that lets an automated test harness — including an
**external** agent such as Claude Code — drive the running Cetus app from outside
the process.

> **SECURITY / SCOPE**
> - Compiled **only** under the `devtest` Cargo feature (`#[cfg(feature = "devtest")]`).
>   It is never present in a release/default build.
> - The external entry point (M4) is a **Unix-domain socket** on the local
>   filesystem. There is **no TCP port** and nothing listens on the network.
> - Even in a `devtest` build the socket is **opt-in**: the server only starts
>   when `CETUS_DEVTEST=1` (or `CETUS_DEVTEST_SOCK`) is set in the environment.
> - Do not ship, enable, or rely on this in production.

---

## 1. Launching Cetus with the bridge enabled

Three gates must be satisfied at once:

| Gate | What | Read by |
|------|------|---------|
| `NEXT_PUBLIC_CETUS_DEVTEST=1` | enables the frontend `TestHook` listener | Next.js client bundle (`test-hook.tsx`) |
| `--features devtest` | compiles in the Rust commands + UDS server | the Tauri CLI → cargo |
| `CETUS_DEVTEST=1` (or `CETUS_DEVTEST_SOCK`) | actually opens the UDS socket at runtime | the Rust side (`start_uds_server`) |

The Tauri dev runner starts the Next.js dev server as a child process
(`beforeDevCommand = "pnpm dev"` → `next dev -p 17381`), so env vars you set on
the `tauri dev` command are inherited by Next — that is how `NEXT_PUBLIC_*`
reaches the frontend.

```sh
NEXT_PUBLIC_CETUS_DEVTEST=1 \
CETUS_DEVTEST=1 \
pnpm tauri dev --features devtest
```

Notes on flag passing:
- `--features devtest` is consumed by the **Tauri CLI** (`tauri dev`/`tauri build`
  accept `-f, --features [<FEATURES>...]`) and forwarded to `cargo`. This is the
  correct place for the cargo feature — do **not** use `-- --features devtest`
  (that would forward to the built app binary, not the compiler).
- `NEXT_PUBLIC_CETUS_DEVTEST=1` is read at Next serve/build time; because it is a
  `NEXT_PUBLIC_` var it is inlined into the client bundle and visible to
  `TestHook`. It must be present on the `tauri dev` invocation so the spawned
  `pnpm dev` inherits it.
- `CETUS_DEVTEST=1` is read by the Rust side at runtime and is what actually opens
  the UDS server. Without it (or `CETUS_DEVTEST_SOCK`), a `devtest` build still
  exposes the IPC commands but does **not** open a socket.

To pin the socket to a known path (recommended for scripting):

```sh
NEXT_PUBLIC_CETUS_DEVTEST=1 \
CETUS_DEVTEST=1 \
CETUS_DEVTEST_SOCK=/tmp/cetus-devtest.sock \
pnpm tauri dev --features devtest
```

---

## 2. Socket path

Resolved by `devtest::start_uds_server`:

1. `$CETUS_DEVTEST_SOCK` if set and non-empty, otherwise
2. `<app_data_dir>/cetus-devtest.sock`

On macOS `app_data_dir` is typically
`~/Library/Application Support/<bundle-identifier>/`. Because the bundle id can
vary between dev/release configs, the simplest robust setup is to set
`CETUS_DEVTEST_SOCK` explicitly (e.g. `/tmp/cetus-devtest.sock`) on both the app
and the CLI. A stale socket file is unlinked before bind.

---

## 3. CLI (`scripts/cetus-devtest.mjs`)

Zero-dependency Node client. It connects to the socket (`$CETUS_DEVTEST_SOCK` or
the default path, or `--sock`), sends one newline-delimited JSON request built
from argv, prints the one-line JSON response, and exits.

```sh
node scripts/cetus-devtest.mjs ping
node scripts/cetus-devtest.mjs screenshot > /tmp/shot.json
node scripts/cetus-devtest.mjs eval --label main --js "document.title"   # fire-and-forget
node scripts/cetus-devtest.mjs find  --selector '[data-testid="agent-control-card"]'
node scripts/cetus-devtest.mjs click --selector '[data-testid="nav-agent-control"]'
node scripts/cetus-devtest.mjs type  --selector 'input#prompt' --text "hello"
node scripts/cetus-devtest.mjs getText --selector 'h1'
node scripts/cetus-devtest.mjs dump
node scripts/cetus-devtest.mjs dom --op eval --js "document.querySelector('h1')?.textContent"
node scripts/cetus-devtest.mjs ax  --request '{"action":"tree"}'
```

Options (any op): `--sock <path>`, `--id <value>`, `--selector <css>`,
`--text <string>`, `--js <string>`, `--label <string>`, `--op <name>` (for the
literal `dom` op), `--request <json>` (for `ax`), `--timeout <ms>` (default 15000).

Exit codes: `0` ok, `1` response `ok:false`, `2` bad usage, `3` connect/socket
error (prints `Cetus devtest socket not found — is Cetus running with
--features devtest and CETUS_DEVTEST=1?`), `4` timeout, `5` closed early.

If you set `CETUS_DEVTEST_SOCK` when launching Cetus, set the **same** value for
the CLI so both agree on the path.

---

## 4. Protocol

Newline-delimited JSON, one response per request, over the UDS:

- Request: `{ "id": <any>, "op": <string>, ...op-specific fields }`
- Response: `{ "id": <same>, "ok": true, "result": <value> }` on success or
  `{ "id": <same>, "ok": false, "error": <string> }` on failure.

### Op set

| op           | extra fields           | routes to (shared with command)             | result |
|--------------|------------------------|---------------------------------------------|--------|
| `ping`       | —                      | —                                           | `{}` |
| `eval`       | `label?`, `js`         | webview `eval` (fire-and-forget) / `test_eval` | `null` |
| `screenshot` | —                      | `quick::capture_screenshot` / `test_screenshot` | `{data, mimeType}` (base64 jpeg) |
| `ax`         | `request` (CuaRequest JSON) | `cua.request_blocking` (spawn_blocking) / `test_ax` | helper value |
| `dom`        | `op`, `selector?`, `text?`, `js?` | DOM round-trip (`devtest-command` → oneshot, ~5s) / `test_dom` | op value |
| `find`       | `selector`             | DOM round-trip (op=`find`)                  | match info |
| `click`      | `selector`             | DOM round-trip (op=`click`)                 | click result |
| `type`       | `selector`, `text`     | DOM round-trip (op=`type`)                  | type result |
| `getText`    | `selector`             | DOM round-trip (op=`getText`)               | text content |
| `dump`       | —                      | DOM round-trip (op=`dump`)                  | DOM snapshot |

`find`/`click`/`type`/`getText`/`dump` are convenience aliases for `dom` with
the corresponding op name; they share the same `devtest-command` round-trip the
`test_dom` IPC command uses, so the frontend `TestHook` must be active (requires
`NEXT_PUBLIC_CETUS_DEVTEST=1`). DOM ops time out after ~5s if the TestHook does
not reply. The UDS handler routes each op to the **same** `op_*` async fn the
matching `test_*` Tauri command calls — one implementation per op.

---

## 5. Architecture summary

- `src-tauri/src/devtest.rs` — Tauri commands (`test_eval`, `test_screenshot`,
  `test_ax`, `test_dom`, `test_dom_result`), the DOM round-trip registry, the
  shared `op_*` fns, and `start_uds_server` + the connection/dispatch loop (M4).
- `src/components/devtest/test-hook.tsx` — frontend listener for
  `devtest-command`; replies via the `test_dom_result` invoke. Active only when
  `NEXT_PUBLIC_CETUS_DEVTEST === "1"`.
- `src-tauri/src/lib.rs` — `mod devtest` is `#[cfg(feature = "devtest")]`; the
  setup closure calls `devtest::start_uds_server(...)` (also
  `#[cfg(feature = "devtest")]`), which early-returns unless
  `CETUS_DEVTEST` / `CETUS_DEVTEST_SOCK` is set.
- `scripts/cetus-devtest.mjs` — the external zero-dep Node CLI described above.
