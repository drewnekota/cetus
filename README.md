<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

<h1 align="center">Cetus</h1>

<p align="center"><a href="https://cetus.run">Official website · cetus.run</a></p>

<p align="center"><strong>One desktop client for every agent you run.</strong></p>

<p align="center">Claude Code, Codex, DeepSeek Harness, OpenCode, Grok Build, Kimi CLI, or the built-in runtime — in one Mac app, with one place to approve, answer, and review what they do.</p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest/download/Cetus.dmg"><img alt="Download Cetus for macOS" src="https://img.shields.io/badge/Download-Cetus-111111?style=for-the-badge&logo=apple" /></a>
  <a href="https://github.com/drewnekota/cetus/releases/download/swift/Cetus-Swift.dmg"><img alt="Download Cetus Swift (Beta) for macOS" src="https://img.shields.io/badge/Download-Cetus_Swift_(Beta)-F05138?style=for-the-badge&logo=swift&logoColor=white" /></a>
</p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest"><img alt="Latest release" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdrewnekota%2Fcetus%2Fmain%2Fsrc-tauri%2Ftauri.conf.json&query=%24.version&prefix=v&label=release&color=blue" /></a>
  <a href="https://github.com/drewnekota/cetus/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/drewnekota/cetus/total" /></a>
  <a href="https://github.com/drewnekota/cetus/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/drewnekota/cetus/ci.yml" /></a>
  <a href="https://github.com/drewnekota/cetus/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/drewnekota/cetus" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/drewnekota/cetus" /></a>
</p>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

![Cetus runtime picker — Claude Code, Codex, DeepSeek Harness, OpenCode, Grok Build, and Kimi CLI in one macOS app](docs/screenshot-runtime-picker.png)

## Why Cetus

Coding agents are no longer the slow part. Claude Code, Codex, and DeepSeek Harness can work for an hour on their own. What slows things down is **the human in the loop**: an agent stops to ask for permission, asks a clarifying question, or finishes and waits for review — and nobody notices, because it is sitting in one of a dozen terminal tabs.

Most people who use agents seriously run more than one: Codex for one task, Claude Code for another, a different model for a second opinion. Every runtime has its own terminal, its own approval prompts, and its own way of saying "I'm done". The more agents you run, the more of your day goes to tab-hopping, and the more agent time is lost waiting on you.

So the first thing Cetus does is give all of them one client:

- **Every runtime in one window.** Use the CLI you already have installed and signed in to. Cetus reuses its login, model, and tools, so there is no second account to set up.
- **One place to respond.** Permission prompts, questions, and plans from any runtime show up as cards in the conversation. Steer a running turn or queue the next message without waiting for it to finish.
- **One board for review.** Every conversation is a card in **In progress · Needs review · Done**. Finished work waits for you instead of scrolling away in a terminal.
- **Parallel without collisions.** Per-conversation git worktrees let several agents edit the same repo at once.

![Cetus Kanban board](docs/screenshot-kanban.png)

Once all your agents run in one client, it becomes the natural place for everything else around them. The rest of Cetus grew from there.

![Cetus demo — launch an agent, schedule an automation, and switch runtimes](docs/cetus-demo.gif)

## Get started

Cetus runs on **Apple Silicon** Macs. There are two builds of the same app:

| Build | Download | Requires |
| --- | --- | --- |
| **Cetus** — the original app, built with Tauri | [Cetus.dmg](https://github.com/drewnekota/cetus/releases/latest/download/Cetus.dmg) | macOS 13+ |
| **Cetus Swift** (Beta) — a native SwiftUI build, still missing some polish | [Cetus-Swift.dmg](https://github.com/drewnekota/cetus/releases/download/swift/Cetus-Swift.dmg) | macOS 15+ |

Both update themselves. Then:

1. Open the DMG and move Cetus to Applications.
2. Use the built-in runtime, or pick an installed and signed-in `claude`, `codex`, or `dsh` (DeepSeek Harness) CLI.
3. Choose a workspace and give the agent its first task.

> **Early release:** Cetus is under active development. Please [open an issue](https://github.com/drewnekota/cetus/issues) if something breaks or a workflow is missing.

## What grew from there

### Quick Launcher — your agent, one hotkey away

Hold **both ⌘ keys** to summon your agent over any app. Cetus brings along the current screenshot, frontmost app, browser URL, and selected text as removable context chips, so you can ask in place instead of explaining what you are looking at.

![Cetus quick launcher demo](docs/quick-launcher.gif)

### Automations — let it work while you are away

Turn any prompt into a one-off or recurring job (`at` / `every` / `cron` / `daily`). Each run keeps its runtime and model settings, works in a fresh background conversation, and lands on the board for review.

![Cetus Automations demo](docs/automation.gif)

### Screen context — let it remember what you were doing

With screen context on, Cetus captures frames, dedupes them, and OCRs them on-device with Apple Vision. Your agent can recall what was on screen or search the history by text and app. Everything stays on your Mac; capture is opt-in, with retention controls and an excluded-apps list.

![Cetus screen context settings](docs/screenshot-screen-history.png)

### Dictation from any app

Hold a hotkey anywhere and talk. Cetus shows a small equalizer HUD, transcribes with Seed-ASR, and types the cleaned-up text wherever your cursor is.

![Cetus voice dictation HUD](docs/voice-hud.jpeg)

### Meetings as searchable context

Turn on **meeting memory** and Cetus transcribes your calls on-device into searchable notes — text only, no audio stored. It starts when another app takes the mic (Zoom, Teams, FaceTime, Feishu…) or on a hotkey (default **⌘⇧M**), and records your mic and system audio separately so the transcript knows who said what. Ask "what did we decide about the launch date?" and the agent searches your meeting history locally. Off by default.

![Cetus meeting memory — Settings → Meetings](docs/screenshot-meetings.png)

### And more

- **Persistent memory** that you and the agent both edit, carried into future conversations
- **Parallel solutions**: fan one prompt into N candidate runs, keep one, archive the rest
- **Cetus Remote**, an optional Tailscale-backed phone companion for following runs and handling approvals
- **Computer and browser control**, with a confirmation step before anything consequential and a Stop button always in reach
- **30+ model providers** for the built-in runtime, including Anthropic, OpenAI, Google, Bedrock, Ollama, LM Studio, and OpenRouter

Every capability that touches your screen, mic, or apps is opt-in.

## Community

⭐️ Star the repo to get notified about new releases. To share feedback, scan the QR code with WeChat to join the group chat.

<p align="center"><img src="docs/cetus-community-wechat.jpg" width="280" alt="WeChat QR code for the Cetus community group" /></p>

## Development

### Requirements

- **Node** ≥ 20, **pnpm**, **bun** (for building the pi sidecar binary)
- **Rust** stable (`rustc`, `cargo`)
- **Tauri** prerequisites: <https://v2.tauri.app/start/prerequisites/>
- A **`DEEPSEEK_API_KEY`** (or your provider of choice; pi auto-picks up `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
- **Optional**: the **Claude Code** (`claude`), **Codex** (`codex`), and/or **DeepSeek Harness** (`dsh`, 0.1.2 or newer — Cetus drives it through its ACP profile) CLIs installed and logged in, if you want them as conversation runtimes — Cetus reuses their existing login, no extra setup

### First-time setup

```bash
pnpm install
# Build pi as a single-file binary into src-tauri/binaries/pi-<target>.
# Takes ~30s. Run once per dev machine; binaries are gitignored.
./scripts/build-pi-sidecar.sh
```

### Run in dev

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm tauri dev
```

Tauri launches the Next.js dev server (port 17381) and a window pointing at it. The pi sidecar is spawned automatically from the bundled binary.

#### Dev backdoor: `PI_BIN`

If you're iterating on pi itself, point at any pi build to bypass the sidecar:

```bash
export PI_BIN=/absolute/path/to/your/pi
pnpm tauri dev
```

This skips `tauri-plugin-shell` entirely and uses raw `tokio::process::Command`.

### Build

```bash
./scripts/build-pi-sidecar.sh   # if you haven't already
pnpm tauri build
```

Outputs `.app` / `.dmg` on macOS. A real multi-size icon set is required for `tauri build` (lives under `src-tauri/icons/`, regenerate with `pnpm tauri icon <path-to-1024px.png>`).

### Cetus Swift (Beta)

The native build lives in [`swift/`](swift) as a SwiftPM package (macOS 15+). `swift build` compiles it; `swift/bundle.sh` assembles `swift/build/Cetus.app` and expects a `cetus-agentd` binary at `$CETUS_AGENTD`.

## Architecture

```
┌──────────────────────────────── Tauri window ──────────────────────────────────┐
│                                                                                │
│  Next.js (static export)              Rust (Tokio + tauri-plugin-shell)        │
│  ┌─────────────────────────┐          ┌──────────────────────────────────────┐ │
│  │ React UI                │  invoke  │  Tauri commands                      │ │
│  │ - ConversationList      │ ───────► │  (list, new, switch, send,           │ │
│  │ - Chat (text/thinking/  │          │   archive, set_model,                │ │
│  │   tool cards), Composer │ ◄─────── │   extension_ui_respond, …)           │ │
│  │ - ModelPicker           │  event   │                                      │ │
│  │ - DialogHost (ext UI)   │          │  PiRpc: sidecar(plugin-shell) OR     │ │
│  │ - chatReducer (deltas → │          │    PI_BIN(tokio::process)            │ │
│  │   RenderedMessage[])    │          │  Store: SQLite metadata              │ │
│  └─────────────────────────┘          └─────────────────┬────────────────────┘ │
│                                                         │ stdin/stdout         │
│                                                         ▼ (LF-framed JSON)     │
│                                       ┌──────────────────────────────────────┐ │
│                                       │  pi --mode rpc subprocess            │ │
│                                       │  (bundled binary, any-model engine)  │ │
│                                       └──────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Conversations** are pi `.jsonl` session files under `<app-data>/sessions/`. We index them (id, title, session_file, model, timestamps, archived_at) in SQLite at `<app-data>/cetus.db`.
- **Switching**: `switch_session` + `get_messages` replays history. One pi process for the app lifetime.
- **Streaming**: pi emits `agent_start`, `message_update` with `assistantMessageEvent` deltas, and `tool_execution_*` events. The frontend `chatReducer` folds these into stable `RenderedMessage[]` indexed by `contentIndex`, with a `toolCallId → block` side-table to route execution updates.
- **Framing**: strict-LF JSONL. `tauri-plugin-shell` delivers stdout in arbitrary byte chunks, so the reader maintains its own accumulator and emits one line per `\n`, stripping optional `\r`. Generic line readers that split on Unicode separators (Node `readline`) are non-compliant.
- **Sidecar packaging**: `src-tauri/binaries/pi-<target>` ships inside `.app/Contents/Resources/`. `PI_BIN` env var is the dev backdoor for iterating on pi.
- **CLI runtimes**: conversations on **Claude Code** / **Codex** / **DeepSeek Harness** bypass the pi RPC entirely — `cetus-bridge::cli_agent` keeps a conversation-scoped Claude streaming session, Codex app-server thread, or ACP stdio session (DeepSeek Harness, OpenCode, Grok, Kimi) alive, and a unit-tested `EventTranslator` maps their events into the same PiEvent stream `chatReducer` already consumes. Context and background terminals persist across turns via the vendor session/thread; optional per-conversation git worktrees isolate edits.
- **Extension UI**: when a pi extension calls `ctx.ui.select()` etc., pi sends `extension_ui_request` over the event stream. The frontend `DialogHost` renders a dialog and replies via the `extension_ui_respond` Tauri command.
- **Bridge**: Cetus also intercepts known extension host tunnels and routes them to native handlers.

## Reusable bridge packages

The host/extension bridge is factored into two standalone, provider-neutral packages you can depend on without pulling in the rest of the app:

- **[`cetus-bridge`](src-tauri/cetus-bridge)** (Rust crate) — the product-light host runtime: JSONL subprocess RPC around `pi --mode rpc`, deterministic extension loading, host-tunnel classification, and injectable `EventSink` / `TaskSpawner` traits. Tauri, app storage, and model-provider choices stay out of the crate — they live in app-side adapters (`tauri_bridge.rs`, `app_event.rs`, `model_bridge.rs`). `examples/minimal_host.rs` shows the smallest integration.
- **[`@cetus/bridge-protocol`](packages/cetus-bridge-protocol)** (TypeScript) — the extension-side protocol: the shared `HOST_TUNNELS` sentinels, `callHost()`, `toolResult()`, and host-tunnel types.

Both are MIT-licensed and carry no Cetus- or DeepSeek-specific code, so other agent hosts can reuse the same bridge.

<details>
<summary>Friendly links</summary>

- [LINUX DO](https://linux.do) — A community of idealists.

</details>

## License

MIT (matches pi).
