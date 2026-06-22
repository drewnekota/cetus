<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

# Cetus

**English** · [简体中文](./README.zh-CN.md)

**An affordable desktop agent, made possible by DeepSeek V4.1.**

Cetus watches your screen, remembers what matters, and acts on your behalf — one assistant that actually knows your situation and can do the thing, made cheap enough to keep running all day.

---

## The thesis

An agent's value is the product of three things:

```
agent  =  context  ×  intelligence  ×  abilities
          (perceive)   (reason)        (act)
```

It's a _product_, not a sum: all three are indispensable, the weakest factor caps the whole thing, and you win by lifting the most-neglected one — not by pushing the factor that's already strong even further.

Today the industry pours most of its money into the middle term — and intelligence genuinely matters. But because it's a product, once intelligence is strong enough, what users feel next isn't the next increment of raw reasoning — it's whether the agent _knows their situation_ and _can do the thing_. Context and abilities are exactly where most agents are starving. So Cetus makes a deliberate bet:

> **All three are indispensable. Intelligence is now both strong and cheap — so the leverage is in the factors the field under-invests in: richer context, more abilities, and a loop that keeps running.**

This is what DeepSeek V4.1 unlocks. When tokens are an order of magnitude cheaper, things that were economically impossible with frontier models become routine:

- **continuously** capturing and OCR-ing your screen for recall,
- **fanning out** N parallel attempts at a task and keeping the best,
- **scheduling** agents that wake up and work while you're away,
- letting an agent **orchestrate sub-agents** for a single request.

We're not trading intelligence away — V4.1 keeps it strong. We're spending what it saves on the two factors that have been starved. That rebalancing is the whole product.

### Context × Intelligence × Abilities — and the loop that makes it compound

The three factors describe a single moment. What makes an agent _yours_ is how it compounds across time — and that's a fourth thing the formula hides:

![Cetus — the agent loop](docs/agent-loop.png)

- **Memory** is context the agent writes back to itself — it turns one-shot tasks into accumulated understanding instead of starting from zero every session.
- **Dreaming** _(roadmap)_ is intelligence applied to memory while idle: compressing raw experience into durable preferences and minting new skills. It's how a generic agent grinds itself into one that _gets you_.

The per-moment factors are being commoditized for everyone. The compounding loop is what's personal — and what's defensible.

### Where this is going: multimodal, because life is

Today Cetus reasons over text — screen OCR, transcripts, typed prompts. That's a waypoint, not the destination. As models keep improving, a single multimodal model that's both smart enough and cheap enough to run all day is coming — and the reason to bet on it is almost embarrassingly simple: **life itself is multimodal.** A person's day is video, sound, speech, and gesture — not a stream of tokens.

So a real life assistant has to meet life on its own terms: take multimodal input and produce multimodal output — _natively_. By multimodal we mean genuinely _understanding_ video and speech and _responding_ in kind — not the workarounds we lean on today (sampling frames out of a video, flattening speech to text). Those are bridges for an era when multimodal intelligence is still scarce and expensive. When it isn't, the bridges come down, and the agent simply perceives and acts in the same modalities you already live in.

## What this maps to in the app

| Axis                      | In Cetus today                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context — perceive**    | Rewind-style screen capture with on-device Apple Vision OCR (off by default; screen content is sensitive) · **meeting memory** — Granola-style on-device transcription of your calls into searchable notes · a **contextful launcher** that attaches your screenshot, active app, browser URL and selection · third-party data through pi connectors |
| **Intelligence — reason** | DeepSeek **V4.1 Flash** ⚡ / **V4.1 Pro** ✨ · the pi harness · **Ultra Code** mode (the agent authors a workflow and orchestrates sub-agents) · **parallel solutions** (best-of-N fan-out with side-by-side review)                                                                                                                                 |
| **Abilities — act**       | pi tools & skills · 30+ providers and any OpenAI-compatible endpoint · scheduled **automations** that mint background conversations · on-device **voice dictation** · a global double-⌘ **launcher** for act-from-anywhere on the desktop                                                                                                            |
| **The loop — compound**   | **Memory**: durable notes (identity, preferences, projects) both you and the agent edit, injected fresh each turn · **Dreaming**: offline consolidation — _roadmap_                                                                                                                                                                                  |

## A tour of Cetus

### Chat — one box, do anything

A single composer drives everything: pick a **workspace** (the working directory), pick a **preset** (Daily ⚡ / High / Max / UltraCode ✨), attach files or a screenshot, and go. Replies stream live with collapsible **thinking** blocks and **tool-use** cards (args, results, error highlighting, partial output).

![Cetus chat — What should we work on?](docs/screenshot-chat.png)

### Kanban — long-running work has a home

Every conversation is a card, tracked across **In progress · Needs review · Done** — filtered to one workspace or all of them. Background runs (automations, parallel solutions) surface here so work that outlives a single sitting doesn't get lost in a chat list.

![Cetus Kanban board](docs/screenshot-kanban.png)

### Automations — prompts that run on a schedule

Saved prompts that fire on a schedule (`at` / `every` / `cron` / `daily`). Each run starts a **fresh background conversation** — e.g. a weekday-09:00 _Daily news digest_ that searches the last 24 hours and renders an HTML summary while you're away.

![Cetus Automations](docs/screenshot-automations.png)

### Quick launcher — contextful, act from anywhere

A global **double-⌘** frosted panel: _Ask Cetus anything_ without leaving the app you're in — and it shows up already knowing your situation. Cetus reads what's in front of you and attaches it as **removable context chips**: a **screenshot** of what you're looking at, the **active app**, the current **browser URL**, and any **selected text**. Keep the chips that matter, drop the rest, then start a **New** run or continue the **Last** one — workspace + preset picked inline, ↵ to start, esc to dismiss.

![Cetus quick launcher](docs/screenshot-launcher.png)

### Voice input — a global, Wispr-Flow-style push-to-talk

Hold the hotkey from _any_ app and just talk — Cetus pops a floating equalizer HUD that reacts to your voice, transcribes on-device, and drops the cleaned-up text wherever your cursor is. It's the same Seed-ASR + cleanup stack as the in-app mic, but it follows you everywhere on the desktop instead of living inside a single text box.

![Cetus voice HUD — the floating equalizer that listens while you talk](docs/voice-hud.jpeg)

> 📸 Yes, that's a _phone photo of a screen_. The HUD is a borderless, always-on-top overlay that politely dodges every screenshot tool I threw at it — so I did what any reasonable person would do and pointed my camera at the monitor. Authenticity over pixels. 😄

### Meeting memory — Granola-style notes for every call

Turn on **meeting memory** and Cetus quietly transcribes your meetings into searchable notes — on-device, text-only, no audio ever stored. It runs three ways:

- **Auto-detect** — when another app grabs your mic (Zoom, Teams, FaceTime, Feishu…), Cetus starts a session on its own and stops when the call ends. Nothing to remember to press.
- **Manual** — a global hotkey (default **⌘⇧M**) starts/stops a session by hand, for the in-person meetings nothing can auto-detect.
- **Both sides of the conversation** — _your_ mic is you; **system audio** is everyone else, captured separately so the transcript knows who said what (macOS 14.2+; gracefully falls back to mic-only below that).

Transcription is **100% on-device** via Apple's Speech framework — streaming, punctuated, segmented on natural pauses. While a session is live, a small floating pill (red dot + elapsed timer + stop button) sits at the top of your screen without stealing focus. When the meeting ends, a single **DeepSeek V4.1 Pro** pass distills a title and clean markdown **minutes** — key points, decisions, and action items.

Best of all, those notes become **context the agent can reach**: ask _"what did we decide about the launch date?"_ or _"pull the action items from this morning's standup"_ and Cetus searches your meeting history (`search_meeting_history`) — all from a local log, nothing leaves the machine. Off by default; the master switch means Cetus never listens, including auto-detect, until you opt in. macOS-only for now.

![Cetus meeting memory — Settings → Meetings](docs/screenshot-meetings.png)

### Screen context — Rewind-style recall, on your terms

With screen context on, Cetus periodically captures frames, dedupes them with a perceptual hash, and OCRs them **on-device with Apple Vision** so the agent can recall what you were working on — then search the history by OCR text or app. Images and text stay on your Mac; nothing is uploaded. It's **off by default** (screen content is sensitive), and the controls keep you in charge: capture interval, how long to keep history, on-device OCR, and an **excluded-apps** list that pauses capture while a sensitive app (1Password, Messages…) is frontmost.

![Cetus screen context settings](docs/screenshot-screen-history.png)

### Settings — capabilities & permissions, one switch at a time

Each ability is opt-in. **Computer & Browser control** lets the agent drive your browser and Mac apps through _numbered element lists, never raw pixels_, and it confirms anything consequential (sending, deleting, purchasing, submitting, authenticating) with a Stop button always in reach. Alongside it: API Keys, Memory, Dreaming, Skills, Connectors, Voice, and Screen context.

![Cetus settings — Computer & Browser control](docs/screenshot-settings.png)

## Also in the box

- **Persistent memory** the user and agent both edit, injected fresh each turn (identity, preferences, projects)
- **Parallel solutions**: fan one prompt into N candidate runs, then keep one and archive the rest
- **Ultra Code** mode: host-orchestrated workflow engine where the agent spawns its own sub-agents
- **Voice dictation** (on-device, macOS), in-app and as a global push-to-talk
- **Meeting memory** (on-device, macOS): Granola-style transcription with auto-detect, system-audio capture, and DeepSeek-distilled minutes the agent can search
- New / switch / rename / archive / delete conversations (SQLite-backed metadata)
- Abort in-flight runs · one pi RPC subprocess shared across conversations via `switch_session`
- pi binary bundled as a Tauri sidecar — no PATH dependency for end users
- **Any-model under the hood**: pi natively supports 30+ providers (Anthropic, OpenAI, Google, Bedrock, Ollama, LM Studio, OpenRouter, …) and any OpenAI-compatible endpoint. The current UI is DeepSeek-only; swap models with one line in `model-picker.tsx`.

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

Outputs `.app` / `.dmg` on macOS. A real multi-size icon set is required for `tauri build` (the full set lives under `src-tauri/icons/`, regenerate it with `pnpm tauri icon <path-to-1024px.png>`).

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
- **Bridge**: Cetus also intercepts known extension host tunnels and routes them
  to native handlers. See [docs/bridge.md](docs/bridge.md) for the protocol,
  security boundary, and open-source extraction plan.

## License

MIT (matches pi).
