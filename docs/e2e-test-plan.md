# Cetus E2E Test Plan

会议听写的真实音频专项流程见 [meeting-e2e.md](meeting-e2e.md)。

End-to-end test plan for the Cetus desktop agent (Tauri + Next.js + pi sidecar).

> **Scope note:** README mentions _Parallel solutions_ (并行候选). That path has been
> removed — **Ultra Code is the only orchestration path**. Do not test parallel candidates.

---

## 0. Test layers

E2E here is not one dimension. Organize cases (and prompts) along these four layers:

| Layer             | What it covers                                                | Needs real model / OS perms | Scriptable           |
| ----------------- | ------------------------------------------------------------- | --------------------------- | -------------------- |
| **L0 Shell**      | multi-window routing, tray, sidecar spawn, pi binary landing  | no                          | easy                 |
| **L1 UI**         | clicks / dialogs / hotkeys / list CRUD, no prompt sent        | no                          | easy                 |
| **L2 Agent loop** | send prompt → stream → tool cards → artifacts                 | DeepSeek key                | semi (assert stream) |
| **L3 System**     | voice, screen OCR, CUA, quick launcher, scheduled automations | macOS perms / keys          | mostly manual        |

Run the **P0 smoke subset** first; only run the full matrix once smoke is green.

---

## 1. Environment prerequisites

Many cases fail _falsely_ if these aren't set. Check before a run.

- **Keys**
  - [ ] `DEEPSEEK_API_KEY` — required (core loop, titling, dreaming, voice cleanup)
  - [ ] Groq / OpenRouter — optional (Whisper cloud ASR fallback)
  - [ ] Tavily — optional (LLM-tuned web search; falls back to DDG scraping)
  - [ ] Gemini — optional (vision transcription)
- **macOS permissions**
  - [ ] Accessibility (gestures, text injection, CUA)
  - [ ] Microphone (voice)
  - [ ] Speech Recognition (voice)
  - [ ] Screen Recording (capture + quick-panel screenshot)
- **Build / data**
  - [ ] `./scripts/build-pi-sidecar.sh` has run; pi binary at `<app_data>/pi-install/pi`
  - [ ] A throwaway workspace `~/cetus-e2e` for filesystem cases (easy teardown)

---

## 2. Test case template

For L2/L3 a case ≈ one prompt + a set of assertions. Use this shape:

```yaml
id: AGENT-TOOL-001
area: agent-loop / tool-use
preconditions: [DeepSeek key set, workspace=~/cetus-e2e]
model: flash + high
prompt: |
  Create hello.txt with content "Cetus e2e" in the current dir, then read it back.
expect:
  - a write-file tool card (args contain hello.txt)
  - a read-file tool card whose result contains "Cetus e2e"
  - final assistant message confirms done
  - hello.txt actually exists on disk
teardown: rm hello.txt
```

Assert on **two tracks**: ① UI-observable (tool card / artifact / HUD appears)
② side effects (file, `memory.json`, SQLite, `mcp.json` landed). Mark unmet-prereq
cases `skip` and **log it** — avoid a false all-green.

---

## 3. Feature checklist (by priority)

### P0 — Core agent loop

- [ ] New conversation → send prompt → streamed reply (pi lazy-spawns)
- [ ] Abort mid-stream (square button / Esc)
- [ ] Model switch: Flash / Pro × reasoning None/High/Max, applies immediately
- [ ] Tool card render: args, results, error highlight, partial output
- [ ] Thinking block collapse / expand
- [ ] Artifact: first artifact auto-opens right panel, copy, HTML/SVG preview
- [ ] Attachments: image (paste/drag/picker, 8MB), file (25MB), oversize error
- [ ] Workspace switch (kills pi, respawns with new cwd)
- [ ] Lifecycle: rename / archive / delete / messages hydrate on switch
- [ ] Auto-title: mechanical title on first msg → AI title upgrades in background

### P0 — Multi-window & hotkeys

- [ ] Window routing: main / quick / voice all render correctly
- [ ] Hotkeys: ⌘K, ⌘N, ⌘,, ⌘1/2/3, Esc (modal-blocking guard)
- [ ] Tray: Open / Settings / Quit; closing window only hides; ⌘Q quits

### P1 — Board / Automations

- [ ] Board 3 columns: In progress / Needs review / Done; streaming forces In progress
- [ ] Card detail dialog: embedded chat, Approve, Request changes, Open in main
- [ ] Create task dialog (⌘N on board): fire-and-forget, "Create more"
- [ ] Automations: 4 schedule modes (Interval/Daily/Once/Cron) create/edit
- [ ] Automations: enable/disable, Run now (does NOT advance schedule), last-run link
- [ ] Schedule validation errors (bad cron, interval < 1 min)
- [ ] **Scheduler real fire**: set a 1-min interval, wait for a real fire → conversation with clock badge appears

### P1 — Command Palette / Sidebar

- [ ] ⌘K search conversations (title + content, tokenized AND)
- [ ] ⌘K switch model / switch view / screen-history results
- [ ] Sidebar: workspace grouping, archive/restore, empty state hint

### P1 — Settings (all 12 sections)

- [ ] API Keys: add/edit/delete + mask/reveal (changing a key kills all pis)
- [ ] Memory: CRUD + global toggle + per-entry toggle
- [ ] Skills: import / create / edit / enable-disable
- [ ] Connectors (MCP): add stdio/http, **Test connection real handshake**, toggle exports `mcp.json`
- [ ] Notifications: test notification + permission request
- [ ] Appearance: font roles, theme Light/Dark/System, zoom
- [ ] Dreaming: toggle + idle minutes
- [ ] Launcher / Voice / Screen / Agent-control / Archived-chats sections render & persist

### P2 — System capabilities (macOS, perms, mostly manual)

- [ ] Quick launcher: double-⌘ / both-⌘ trigger, screenshot toggle, session new/last, workspace sticky, submit → main window
- [ ] Voice dictation: global push-to-talk + composer mic, HUD waveform, Apple on-device, Whisper fallback, type vs paste insert, optional DeepSeek cleanup
- [ ] Screen capture + OCR: background frames, perceptual-hash dedup, FTS5 search, excluded apps, retention prune, history lightbox
- [ ] CUA (computer/browser control): observe/act/screenshot loop, agent-control card live screenshots, **Stop interrupts**, AX permission
- [ ] Ultra Code: enable → model authors workflow → `agent()` sub-spawn → parallel → sub-agents appear as temp conversations → synthesis
- [ ] Memory loop + Dreaming: agent writes via `manage_memory` → idle triggers dream merge → next turn injects

### P2 — Permissions & degradation

- [ ] Missing-permission states: mic / speech / screen-recording / accessibility grant buttons reappear
- [ ] Degradation: no Tavily → DDG; no Groq → Apple ASR; swiftc unavailable → OCR degrades to capture-only

---

## 4. Prompt buckets (for L2/L3)

A "test case" for the agent ≈ a prompt + assertions. Representative prompts per bucket:

### Bucket A — Pure chat / rendering (no tools)

- "Explain JSONL in one paragraph with a code-block example" → markdown / code-block render
- "Reason step by step through 17 × 23" + ThinkMax → thinking block appears & collapses

### Bucket B — Tool calls (with real side effects)

- File read/write (case AGENT-TOOL-001 above)
- "List files in the current directory" → tool card + result
- "Search the weather today" (Tavily / DDG fallback) → web tool
- Force an error: "Read /nonexistent/x.txt" → error-highlighted tool card

### Bucket C — Artifacts

- "Generate a simple SVG smiley artifact" → right panel auto-opens + preview + copy
- "Write a single-file HTML counter" → HTML artifact

### Bucket D — Ultra Code orchestration (toggle Ultra ON first)

- "Summarize every .md file in this project in one line each" (fan out sub-agents) → sub-conversations appear + synthesis
- A decomposable task that exercises real `agent()` / `parallel()` fan-out

### Bucket E — CUA computer control (Agent control ON + AX perm)

- "Open a browser and search for Cetus github" → observe→act loop + control-card screenshots
- Hit **Stop** mid-control → interruption verified

### Bucket F — Memory / Dreaming

- "Remember I prefer pnpm over npm" → `manage_memory` write + appears in Settings
- New conversation: "Which package manager do I like?" → memory injected
- Idle > idle-minutes → dream produces agent-sourced memory

### Bucket G — Multimodal / perception

- Quick launcher with screenshot checked + "What's on this screen?" → screenshot rides prompt + vision card
- Voice push-to-talk one sentence → transcript injected into composer

### Bucket H — Automations

- Create a "say the current time every minute" interval automation → wait for real fire → board shows badged conversation

---

## 5. Run organization

- **Layout:** `tests/e2e/<area>/<id>.yaml` (area = L0..L3 or buckets A..H)
- **Order:** smoke subset (P0 #1–4 + multi-window + ⌘K) first; full matrix after green
- **Dual assertions:** UI-observable + verifiable side effect (file / `memory.json` / SQLite / `mcp.json`)
- **Env matrix:** tag each case with required keys/perms; skip + log unmet ones (no false green)
- **Throwaway workspace:** run filesystem cases in `~/cetus-e2e` for clean teardown

---

## 6. Smoke subset (≈15 min manual pass)

Minimum set proving the app is alive:

1. Launch app → main window renders, sidebar + composer visible
2. New chat → "say hi" → streamed reply arrives
3. Abort a longer stream mid-flight
4. Switch model Flash→Pro, send again
5. One tool call (file write in `~/cetus-e2e`) → tool card + file on disk
6. One artifact ("SVG smiley") → right panel opens
7. ⌘K → search a conversation → opens it
8. ⌘1/2/3 → Chat / Board / Automations switch
9. Settings → add a Memory entry → persists after reopen
10. Tray → Quit
