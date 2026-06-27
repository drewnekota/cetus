<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

# Cetus

**English** · [简体中文](./README.zh-CN.md)

A desktop agent for macOS, built on DeepSeek V4.1. It watches your screen, remembers what matters, and can act on your behalf — cheap enough to keep running all day.

---

## Why Cetus

Most AI assistants treat every conversation as a blank slate. They can reason well, but they don't know what you're working on, and they can't do much beyond chat.

A useful agent needs three things: **context** (what it knows about your situation), **intelligence** (how well it reasons), and **abilities** (what it can actually do). For a while, intelligence was the hard part. It's not anymore — modern models are good, and DeepSeek V4.1 made them cheap. That changes what's worth building.

When tokens cost an order of magnitude less, things that didn't make sense before become practical:

- Running continuous screen capture and OCR for recall
- Spinning up N parallel attempts on the same task and keeping the best
- Scheduling agents that work while you're away
- Letting one agent orchestrate sub-agents for a single request

Cetus spends those savings on the parts most agents skimp on: giving the agent richer context about your situation and more ways to actually do things.

### Memory and Dreaming

The three factors describe a single moment. What makes an agent useful over time is whether it accumulates anything.

![Cetus — the agent loop](docs/agent-loop.png)

- **Memory** is context the agent writes back to itself — so the next session picks up where the last one left off instead of starting from scratch.
- **Dreaming** runs while you're idle: Cetus reflects on recent conversations and consolidates them into durable notes, turning raw history into preferences that persist. On by default.

## What's in the app

| | Cetus today |
| --- | --- |
| **Context** | Rewind-style screen capture with on-device Apple Vision OCR (off by default) · **meeting memory** — on-device call transcription into searchable notes · a **contextful launcher** that attaches your screenshot, active app, browser URL, and selection · third-party data through pi connectors |
| **Intelligence** | DeepSeek **V4.1 Flash** ⚡ / **V4.1 Pro** ✨ · the pi harness · **Ultra Code** mode (the agent authors a workflow and orchestrates sub-agents) · **parallel solutions** (best-of-N fan-out with side-by-side review) |
| **Abilities** | pi tools & skills · 30+ providers and any OpenAI-compatible endpoint · scheduled **automations** that start background conversations · on-device **voice dictation** · a global double-⌘ **launcher** |
| **Memory** | Durable notes you and the agent both edit (identity, preferences, projects), injected each turn · **Dreaming**: offline consolidation while idle (on by default) |

## A tour of Cetus

### Chat

A single composer: pick a **workspace** (working directory), a **preset** (Daily ⚡ / High / Max / UltraCode ✨), optionally attach files or a screenshot, and send. Replies stream live with collapsible **thinking** blocks and **tool-use** cards showing args, results, and any errors.

![Cetus chat — What should we work on?](docs/screenshot-chat.png)

### Kanban

Every conversation is a card tracked across **In progress · Needs review · Done**, filtered by workspace or across all of them. Background runs (automations, parallel solutions) surface here, so work that spans multiple sessions doesn't get buried in a chat list.

![Cetus Kanban board](docs/screenshot-kanban.png)

### Automations

Saved prompts that fire on a schedule (`at` / `every` / `cron` / `daily`). Each run starts a fresh background conversation — e.g. a weekday-09:00 news digest that searches the last 24 hours and renders an HTML summary while you're away.

![Cetus Automations](docs/screenshot-automations.png)

### Quick launcher

A global **double-⌘** panel: ask Cetus anything without leaving the app you're in. It reads what's in front of you and attaches it as removable context chips: a screenshot of your screen, the active app, the current browser URL, and any selected text. Keep what's useful, drop the rest, then start a new run or continue the last one.

![Cetus quick launcher](docs/screenshot-launcher.png)

### Voice input

Hold a hotkey from any app and talk — Cetus pops a floating equalizer HUD, transcribes on-device with Seed-ASR, and drops the cleaned-up text wherever your cursor is. The same stack as the in-app mic, but it follows you across the desktop.

![Cetus voice HUD — the floating equalizer that listens while you talk](docs/voice-hud.jpeg)

> 📸 Yes, that's a phone photo of a screen. The HUD is a borderless always-on-top overlay that dodged every screenshot tool I threw at it, so I pointed my camera at the monitor instead. 😄

### Meeting memory

Turn on **meeting memory** and Cetus quietly transcribes your calls into searchable notes — on-device, text only, no audio stored.

- **Auto-detect** — when another app grabs your mic (Zoom, Teams, FaceTime, Feishu…), Cetus starts a session and stops when the call ends. Nothing to press.
- **Manual** — global hotkey (default **⌘⇧M**) for in-person meetings that auto-detect can't pick up.
- **Both sides** — your mic is you; system audio is everyone else, captured separately so the transcript knows who said what (macOS 14.2+; falls back to mic-only below that).

Transcription is 100% on-device via Apple's Speech framework — streaming, punctuated, segmented on natural pauses. While a session is live, a small floating pill (red dot + elapsed timer + stop button) sits at the top of your screen without stealing focus. When the call ends, one DeepSeek V4.1 Pro pass distills a title and clean markdown **minutes** — key points, decisions, action items.

Those notes become context the agent can reach: ask "what did we decide about the launch date?" and Cetus searches your meeting history (`search_meeting_history`) — all local, nothing uploaded. Off by default; the master switch means Cetus never listens until you opt in. macOS only for now.

![Cetus meeting memory — Settings → Meetings](docs/screenshot-meetings.png)

### Screen context

With screen context on, Cetus periodically captures frames, dedupes them with a perceptual hash, and OCRs on-device with Apple Vision so the agent can recall what you were working on — and you can search by OCR text or app. Images and text stay on your Mac; nothing is uploaded. Off by default; controls include capture interval, retention period, and an excluded-apps list that pauses capture when sensitive apps (1Password, Messages…) are frontmost.

![Cetus screen context settings](docs/screenshot-screen-history.png)

### Settings

Each capability is opt-in. **Computer & Browser control** lets the agent drive your browser and Mac apps through numbered element lists (not raw pixels), with a confirmation step before anything consequential (sending, deleting, purchasing, submitting, authenticating) and a Stop button always in reach.

![Cetus settings — Computer & Browser control](docs/screenshot-settings.png)

## Also in the box

- **Persistent memory** you and the agent both edit, injected each turn (identity, preferences, projects)
- **Parallel solutions**: fan one prompt into N candidate runs, then keep one and archive the rest
- **Ultra Code** mode: the agent spawns its own sub-agents for a single request
- **Voice dictation** (on-device, macOS) — in-app and as a global push-to-talk
- **Meeting memory** (on-device, macOS) — auto-detect, system-audio capture, DeepSeek-distilled minutes the agent can search
- New / switch / rename / archive / delete conversations (SQLite-backed metadata)
- Abort in-flight runs · one pi RPC subprocess shared across conversations via `switch_session`
- pi binary bundled as a Tauri sidecar — no PATH dependency for end users
- **Any model under the hood**: pi supports 30+ providers (Anthropic, OpenAI, Google, Bedrock, Ollama, LM Studio, OpenRouter, …) and any OpenAI-compatible endpoint; the current UI is DeepSeek-only, swap models with one line in `model-picker.tsx`

## Requirements

- **Node** ≥ 20, **pnpm**, **bun** (for building the pi sidecar binary)
- **Rust** stable (`rustc`, `cargo`)
- **Tauri** prerequisites: <https://v2.tauri.app/start/prerequisites/>
- A **`DEEPSEEK_API_KEY`** (or your provider of choice; pi auto-picks up `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)

## First-time setup

```bash
pnpm install
# Build pi as a single-file binary into src-tauri/binaries/pi-<target>.
# Takes ~30s. Run once per dev machine; binaries are gitignored.
./scripts/build-pi-sidecar.sh
```

## Run in dev

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm tauri dev
```

Tauri launches the Next.js dev server (port 3000) and a window pointing at it. The pi sidecar is spawned automatically from the bundled binary.

### Dev backdoor: `PI_BIN`

If you're iterating on pi itself, point at any pi build to bypass the sidecar:

```bash
export PI_BIN=/absolute/path/to/your/pi
pnpm tauri dev
```

This skips `tauri-plugin-shell` entirely and uses raw `tokio::process::Command`.

## Build

```bash
./scripts/build-pi-sidecar.sh   # if you haven't already
pnpm tauri build
```

Outputs `.app` / `.dmg` on macOS. A real multi-size icon set is required for `tauri build` (lives under `src-tauri/icons/`, regenerate with `pnpm tauri icon <path-to-1024px.png>`).

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
│  │ - ModelPicker (DeepSeek)│  event   │                                      │ │
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
- **Extension UI**: when a pi extension calls `ctx.ui.select()` etc., pi sends `extension_ui_request` over the event stream. The frontend `DialogHost` renders a dialog and replies via the `extension_ui_respond` Tauri command.
- **Bridge**: Cetus also intercepts known extension host tunnels and routes them to native handlers. See [docs/bridge.md](docs/bridge.md) for the protocol, security boundary, and open-source extraction plan.

## Reusable bridge packages

The host/extension bridge is factored into two standalone, provider-neutral packages you can depend on without pulling in the rest of the app:

- **[`cetus-bridge`](src-tauri/cetus-bridge)** (Rust crate) — the product-light host runtime: JSONL subprocess RPC around `pi --mode rpc`, deterministic extension loading, host-tunnel classification, and injectable `EventSink` / `TaskSpawner` traits. Tauri, app storage, and model-provider choices stay out of the crate — they live in app-side adapters (`tauri_bridge.rs`, `app_event.rs`, `model_bridge.rs`). `examples/minimal_host.rs` shows the smallest integration.
- **[`@cetus/bridge-protocol`](packages/cetus-bridge-protocol)** (TypeScript) — the extension-side protocol: the shared `HOST_TUNNELS` sentinels, `callHost()`, `toolResult()`, and host-tunnel types.

Both are MIT-licensed and carry no Cetus- or DeepSeek-specific code, so other agent hosts can reuse the same bridge. See [docs/bridge.md](docs/bridge.md) for the protocol and security boundary.

## License

MIT (matches pi).
