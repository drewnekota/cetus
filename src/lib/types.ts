// Shared types between Rust backend and React frontend.
// pi event JSON is forwarded verbatim; we narrow it per event type below.

// DeepSeek-only: cetus ships a single model (V4 Pro); the per-conversation knob
// is how hard it thinks. `DsModel` stays as a one-member union so the model id
// remains a typed value across the Rust/TS boundary. Persisted per conversation.
export type DsModel = "pro";
export type ReasoningLevel = "non_think" | "think_high" | "think_max";

export interface ModelChoice {
  model: DsModel;
  reasoning: ReasoningLevel;
}

// ---- Quick launcher -------------------------------------------------------

/** A launcher trigger. `off` leaves that function unbound. */
export type QuickGesture =
  | "off"
  | "both_cmd"
  | "both_opt"
  | "double_cmd"
  | "double_opt";
export type QuickSessionMode = "new" | "last";

export interface QuickSettings {
  /** Master switch for the global gesture. */
  enabled: boolean;
  /** Gesture that opens the launcher *without* a screenshot. */
  gesturePlain: QuickGesture;
  /** Gesture that opens the launcher *with* a screenshot attached. */
  gestureShot: QuickGesture;
  /** Gesture that captures the current UI and directly drafts reply options
   *  with a vision model. */
  gestureReply: QuickGesture;
  /** Configurable global hotkey (Tauri accelerator, e.g. "Cmd+Shift+K") that
   *  brings cetus to the front, switching desktops if it's on another. Empty
   *  string = no hotkey. */
  summonHotkey: string;
  sessionMode: QuickSessionMode;
  /** Master switch for global hold-to-talk dictation. */
  voiceEnabled: boolean;
  /** Push-to-talk modifier held while speaking. */
  voiceGesture: VoiceGesture;
  /** Opt-in double-tap of the voice trigger for hands-free mode. Off by
   *  default so double right-Option belongs to quick reply only. */
  voiceHandsfreeShortcut: boolean;
  /** How a global transcript is inserted into the focused app. */
  voiceInsertMode: VoiceInsertMode;
  /** Clean the transcript (thought-to-text) before inserting (global only). */
  voiceCleanup: boolean;
  /** Override for the Ark cleanup model id; empty = built-in default. */
  voiceCleanupModel: string;
  /** Recognition engine: Doubao streaming cloud (zh/en) vs Apple on-device. */
  voiceAsrEngine: VoiceAsrEngine;
  /** Bias Doubao recognition toward the user's vocabulary + what they're
   *  writing (hotwords + context). Doubao engine only. */
  voiceContextBiasing: boolean;
  /** User hotword list, one term per line — boosted during recognition. */
  voiceHotwords: string;
  /** ID of a server-side hotword table (热词词表) for the long-tail dictionary. */
  voiceBoostingTableId: string;
  /** Play a soft bubble pop when the dictation capsule appears. */
  voiceStartSound: boolean;
  /** Register cetus as a login item so it starts (in the tray) at login. */
  launchOnStartup: boolean;
  /** Silently check for and install app updates in the background at launch
   *  (applied on next launch). On by default; takes effect next launch. */
  autoUpdate: boolean;
}

export const DEFAULT_QUICK_SETTINGS: QuickSettings = {
  enabled: true,
  gesturePlain: "both_cmd",
  gestureShot: "off",
  gestureReply: "double_opt",
  summonHotkey: "",
  sessionMode: "new",
  voiceEnabled: false,
  voiceGesture: "right_option",
  voiceHandsfreeShortcut: false,
  voiceInsertMode: "type",
  voiceCleanup: true,
  voiceCleanupModel: "",
  voiceAsrEngine: "doubao",
  voiceContextBiasing: true,
  voiceHotwords: "",
  voiceBoostingTableId: "",
  voiceStartSound: true,
  launchOnStartup: false,
  autoUpdate: true,
};

/** Metadata for an available app update (from the release manifest). */
export interface UpdateMeta {
  /** Version offered by the manifest. */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes, if any. */
  notes?: string | null;
}

/** Progress emitted while the native updater downloads an app update. */
export interface UpdateDownloadProgress {
  downloaded: number;
  total?: number | null;
  finished: boolean;
}

/** Bare base64 screen capture (no `data:` prefix), as pi-ai ImageContent. */
export interface QuickScreenshot {
  data: string;
  mimeType: string;
}

/** An attachment collected by the quick launcher. Images use the model's image
 * channel; other files are persisted once the main window picks a conversation. */
export type QuickAttachment =
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "file"; data: string; mimeType: string; name: string; sizeBytes: number };

/** Ambient context captured the moment the launcher is summoned — what the user
 *  was looking at before the panel took focus. Every field is best-effort and may
 *  be empty. Mirrors Rust's `AmbientContext`. */
export interface QuickContext {
  app: string;
  bundleId: string;
  url: string;
  title: string;
  selection: string;
}

/** Payload Rust pushes to the quick window when the launcher fires. */
export interface QuickOpenPayload {
  screenshot: QuickScreenshot | null;
  screenshotDefault: boolean;
  /** Whether macOS Screen Recording permission is granted. Lets the panel show
   *  the grant-permission hint only when truly denied — not as a flash before
   *  the first capture lands. */
  screenshotPermission: boolean;
  /** Ambient context captured pre-focus; null when no screenshot rode along.
   *  The browser URL is filled in later via a `quick-open-url` event. */
  context: QuickContext | null;
  sessionMode: QuickSessionMode;
  /** Token for this open; echoed by `quick-open-url` so a late URL from an
   *  earlier open is ignored. */
  openId: number;
}

/** Deferred browser URL for the current open, fetched after the panel presents
 *  so its AppleScript latency stays off the first-paint path. */
export interface QuickOpenUrlPayload {
  url: string;
  title: string;
  openId: number;
}

/** Initial loading event for the direct visual quick-reply surface. */
export interface QuickReplyOpenPayload {
  openId: number;
  app: string;
  screenshotPermission: boolean;
}

export interface QuickReplyOutput {
  candidates: string[];
  context: string;
  provider: string;
}

/** One-shot completion for the matching quick-reply open. */
export interface QuickReplyResultPayload {
  openId: number;
  output: QuickReplyOutput | null;
  error: string | null;
}

/** Coding-agent runtime for a conversation. "pi" is the built-in Cetus
 *  harness; claude-code / codex are headless CLI backends orchestrated
 *  per-turn (spawned in a git worktree, streamed through the same chat UI). */
export type BackendId = "pi" | "claude-code" | "codex";

/** Whether a backend supports sending a message while a turn is running.
 *  `pi` steers over its RPC, claude-code over the turn's stdin, and codex
 *  mirrors the Codex app behavior by interrupting the current `codex exec`
 *  turn and immediately resuming the thread with the new message. */
export function backendSupportsSteer(backend: BackendId): boolean {
  return backend === "pi" || backend === "claude-code" || backend === "codex";
}

/** Where a CLI-backend conversation's isolated changes live (git repo
 *  workspaces only). `exists` is false until the first turn creates it. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  exists: boolean;
}

/** One question of a claude-code AskUserQuestion tool call. */
export interface CliAskQuestion {
  question: string;
  /** Short chip label (≤12 chars). */
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** A blocking CLI-host request surfaced in the chat. Claude Code sends its
 *  stream-json control_request shape; Codex app-server sends reverse JSON-RPC
 *  requests such as request_user_input and MCP elicitations. Both are answered
 *  via api.cliControlRespond. */
export interface CliControlRequest {
  type: "cli_control_request";
  requestId: string | number;
  source?: "claude-code" | "codex";
  requestKind?: "request_user_input" | "mcp_elicitation";
  toolName: string;
  input: Record<string, unknown> & { questions?: CliAskQuestion[] };
  toolUseId: string | number | null;
  suggestions?: unknown;
}

/** One live background task owned by a conversation's CLI session (a Monitor,
 *  async Agent/Workflow, or background Bash). These outlive model turns — a
 *  Monitor can wake the agent long after the reply settled — so the bridge
 *  streams the full live set as `cli_background_tasks` snapshots and the chat
 *  pane renders them as a standing strip. */
export interface CliBackgroundTask {
  taskId: string;
  /** Subagent type or task kind: "Monitor", "Bash", "Explore", "Workflow", … */
  kind: string;
  description: string;
  /** Latest task_progress line, if any. */
  statusText?: string;
}

/** One native slash command reported by a CLI backend's initialize handshake
 *  (claude-code: built-ins like /usage /compact /context plus every skill).
 *  Surfaced as a `cli_commands` event when the session process boots; the
 *  composer merges them into the slash menu and passes the picked token to
 *  the CLI verbatim. */
export interface CliSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  /** Runtime-native entry type. Claude reports both built-ins and skills in
   *  one catalog; Codex's skills/list entries are always skills. */
  kind?: "command" | "skill";
}

/** Claude's unified rate-limit heartbeat (`rate_limit_event`), forwarded by
 *  the bridge as a `cli_rate_limit` event after each API call. Account-level
 *  (not per conversation), so the store keeps one snapshot per runtime and
 *  the runtime picker renders it as a quota line. */
export interface CliRateLimitInfo {
  /** "allowed" | "allowed_warning" | "rejected" */
  status: string;
  /** 0..1 fraction of the window used; the CLI includes it only near/over
   *  the warning threshold. */
  utilization?: number;
  /** Epoch seconds when the window resets. */
  resetsAt?: number;
  /** "five_hour" | "seven_day" | "overage" … */
  rateLimitType?: string;
  isUsingOverage?: boolean;
}

/** Latest model-context occupancy reported by a CLI session. Unlike account
 * quota this is conversation-scoped and represents the most recent model
 * request, not cumulative tokens spent across the thread. */
export interface CliContextUsage {
  usedTokens: number;
  contextWindow: number;
  /** Raw vendor protocol bytes observed since this runtime connection began.
   *  This catches media-heavy transcripts that token-based compact thresholds
   *  do not see. */
  transcriptBytes?: number;
}

/** Persisted CLI-agent (claude-code / codex) switches. */
export interface CliAgentSettings {
  /** Skip the CLIs' permission prompts (headless turns can't answer them). */
  bypassApprovals: boolean;
  /** Run each conversation in its own git worktree/branch instead of the
   *  workspace's working tree. Off by default. */
  isolateInWorktree: boolean;
}

/** What a CLI backend actually runs when no override is set, resolved from
 *  the vendor's config on disk (claude settings.json / codex config.toml), so
 *  the tuning menu can echo "Default (Opus)" instead of a bare "Default".
 *  `models` is the CLI's own live catalog; null → use the static fallback
 *  catalog. */
export interface CliDefaults {
  model: string | null;
  effort: string | null;
  models: { id: string; label: string }[] | null;
}

/** Payload the quick panel forwards to the main window on submit. */
export interface QuickLaunchPayload {
  text: string;
  image: QuickScreenshot | null;
  /** Files manually pasted or picked in the launcher. */
  attachments: QuickAttachment[];
  sessionMode: QuickSessionMode;
  /** Repo the launched task should run in; null → backend default workspace. */
  workspaceDir: string | null;
  /** Model + reasoning chosen in the launcher's model picker. */
  model: DsModel;
  reasoning: ReasoningLevel;
  /** Ultra Code (workflow orchestration) state chosen in the launcher. */
  ultra: boolean;
  /** Ambient context the user kept on the panel; null when none/all removed. */
  context: QuickContext | null;
  /** Coding-agent runtime chosen in the launcher (Cetus / Claude Code /
   *  Codex). Applied to newly-created conversations only. */
  backend: BackendId;
  /** CLI backends' model override ("" = the CLI's own default). */
  cliModel: string;
  /** CLI backends' reasoning-effort override ("" = the CLI's default). */
  cliEffort: string;
}

export const DEFAULT_MODEL_CHOICE: ModelChoice = {
  model: "pro",
  reasoning: "think_high",
};

// ---- Voice dictation ------------------------------------------------------

/** Which surface started a dictation, echoed back on every voice event so a
 *  surface can ignore a session it didn't start. */
export type VoiceTarget = "composer" | "quick" | "global";

/** macOS Microphone + Speech Recognition authorization, from the Swift helper.
 *  Each is "authorized" | "denied" | "restricted" | "undetermined" | "unknown"
 *  | "unsupported". */
export interface VoicePermissions {
  mic: string;
  speech: string;
}

/** Payload on the `voice-partial` / `voice-final` / `voice-ready` /
 *  `voice-error` / `voice-level` events Rust emits while a dictation runs. */
export interface VoiceEventPayload {
  target: VoiceTarget;
  text?: string;
  message?: string;
  /** Live mic amplitude 0…1 (on `voice-level`), for the waveform indicator. */
  level?: number;
}

/** A spelling learned from the user's post-dictation edit. */
export interface VoiceDictionaryEventPayload extends VoiceEventPayload {
  terms: string[];
}

/** How global dictation inserts the transcript into the focused app. */
export type VoiceInsertMode = "type" | "paste";

/** Speech-recognition engine for voice dictation. "apple" = on-device
 *  SFSpeechRecognizer (instant, weaker zh/en); "doubao" = Volcano Engine
 *  (Doubao) real-time streaming cloud — fastest (~90ms), live partials, great
 *  zh/en, works in mainland China; needs a Doubao X-Api-Key. */
export type VoiceAsrEngine = "apple" | "doubao";

/** Global push-to-talk trigger (held down while speaking). */
export type VoiceGesture = "right_cmd" | "right_option" | "fn" | "caps_lock";

// ---- Dictation history (voice context) ------------------------------------

/** One saved dictation transcript. Mirrors the Rust `TranscriptEntry`
 *  (src-tauri/src/transcripts.rs). */
export interface TranscriptEntry {
  id: string;
  text: string;
  /** Which surface produced it: "composer" | "quick" | "global". */
  target: string;
  createdAt: number;
}

/** The dictation-history store: a master switch + the saved transcripts. When
 *  `enabled` is false, cetus neither records new dictations nor lets the agent
 *  recall them (via the `recall_dictation` tool). Off by default (privacy). */
export interface TranscriptState {
  enabled: boolean;
  entries: TranscriptEntry[];
}

// ---- Ultra Code (autonomous workflow orchestration) -----------------------

/** Master switch for Ultra Code. When on, conversations get the workflow-
 *  authoring system prompt and the agent orchestrates substantial tasks by
 *  writing a JS workflow (run via `ultra-runtime.ts` in pi's Bun runtime). */
export interface UltraSettings {
  enabled: boolean;
}

export const DEFAULT_ULTRA_SETTINGS: UltraSettings = {
  enabled: false,
};

// ---- DEV-ONLY eval bridge (devtest Cargo feature) -------------------------

/** DOM op the dev TestHook performs on a `test_dom` round-trip. Mirrors the
 *  ops handled in src/components/devtest/test-hook.tsx. */
export type DevtestDomOp =
  | "find"
  | "click"
  | "type"
  | "getText"
  | "eval"
  | "dump";

export interface DevtestDomArgs {
  selector?: string;
  text?: string;
  js?: string;
}

// ---- Computer & Browser control (agent control) ---------------------------

/** Independent switches for the browser-use / computer-use capability. When a
 *  surface is on, conversations get its control prompt and its `browser_*` /
 *  `computer_*` tools register (gated via env). Mirrors the Rust
 *  `AgentSettings` (src-tauri/src/agent.rs). */
export interface AgentSettings {
  browser: boolean;
  computer: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  browser: false,
  computer: false,
};

// ---- Plugins ---------------------------------------------------------------

/** One discovered Cetus plugin. A plugin may contribute prompt guidance, skills,
 *  MCP servers, pi extensions, or trusted native capabilities. Mirrors the Rust
 *  `PluginEntry` (src-tauri/src/plugins.rs). */
export interface PluginEntry {
  id: string;
  displayName: string;
  version: string;
  description: string;
  builtIn: boolean;
  enabled: boolean;
  configurable: boolean;
  available: boolean;
  unavailableReason?: string | null;
  path: string;
  extensions: string[];
  mcpServers: string[];
  apps: string[];
  nativeCapabilities: string[];
  interfaceCapabilities: string[];
  agentControlSurface?: string | null;
  riskLevel?: string | null;
  error?: string | null;
}

// ---- Dreaming (quiet-time memory consolidation) ---------------------------

/** Settings for "dreaming": when you're not chatting with cetus, it reflects on
 *  recent conversations and consolidates durable insights into agent memory.
 *  Mirrors the Rust `DreamSettings` (src-tauri/src/dream.rs). */
export interface DreamSettings {
  /** Master switch. When on, cetus consolidates memory while you're not using it. */
  enabled: boolean;
  /** Minutes with no cetus chat activity (a "quiet period") before a dream may
   *  start. Named `idleMinutes` for back-compat; it's a cetus-quiet window, not
   *  system idle. */
  idleMinutes: number;
}

/** Default ON — dreaming runs out of the box (no-op until a DeepSeek key and
 *  some sessions exist). */
export const DEFAULT_DREAM_SETTINGS: DreamSettings = {
  enabled: true,
  idleMinutes: 15,
};

// ---- Auto-archive ----------------------------------------------------------

/** Unit for the auto-archive idle threshold. */
export type AutoArchiveUnit = "hours" | "days";

/** Settings for auto-archiving idle conversations. When enabled, cetus archives
 *  any conversation left untouched longer than `value` `unit`s. Mirrors the Rust
 *  `AutoArchiveSettings` (src-tauri/src/auto_archive.rs). */
export interface AutoArchiveSettings {
  /** Master switch. Default OFF — opt-in. */
  enabled: boolean;
  /** Idle threshold amount, in `unit`s. */
  value: number;
  /** Unit for `value`. */
  unit: AutoArchiveUnit;
}

/** Default OFF — auto-archive only runs once the user turns it on. */
export const DEFAULT_AUTO_ARCHIVE_SETTINGS: AutoArchiveSettings = {
  enabled: false,
  value: 30,
  unit: "days",
};

// ---- Skills (Agent Skills standard) ---------------------------------------

/** One installed skill. The markdown (a SKILL.md with name/description
 *  frontmatter) lives on disk under `<app_data>/skills/<id>/`; enabled skills
 *  are materialised into pi's agent dir so the model can invoke them. Mirrors
 *  the Rust `SkillEntry` (src-tauri/src/skills.rs). */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** "import" (copied from a folder), "created" (written from the editor), or
   *  "agent" (proposed by the background skill-review pass — lands disabled for
   *  the user to review and turn on). */
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** Settings for skill review: when idle, cetus reviews recent conversations and
 *  proposes reusable skills (as disabled suggestions for you to approve).
 *  Mirrors the Rust `SkillReviewSettings` (src-tauri/src/skill_review.rs). */
export interface SkillReviewSettings {
  /** Master switch. When on, cetus proposes skills while you're not using it.
   *  Proposals never activate without your approval. */
  enabled: boolean;
  /** Minutes of no cetus chat activity before a review may start. */
  idleMinutes: number;
}

/** Default ON — proposals are non-destructive (they land disabled). No-op until
 *  a DeepSeek key and some sessions exist. */
export const DEFAULT_SKILL_REVIEW_SETTINGS: SkillReviewSettings = {
  enabled: true,
  idleMinutes: 20,
};

/** The whole skills store: a master switch plus the installed entries. */
export interface SkillState {
  version: number;
  /** Master switch — when off, no skill is loaded even if entries exist. */
  enabled: boolean;
  entries: SkillEntry[];
}

/** A skill auto-discovered from a user or repo `.agents/skills` dir. pi loads
 *  these automatically; cetus shows them read-only.
 *  Mirrors the Rust `DiscoveredSkill` (src-tauri/src/skills.rs). */
export interface DiscoveredSkill {
  /** Stable id used by read/reveal commands. */
  id: string;
  name: string;
  description: string;
  /** `user` for the configured skills folder, `repo` for workspace `.agents/skills`. */
  scope: "user" | "repo";
  /** Absolute directory whose child folder contains this skill. */
  root: string;
  /** Absolute path to the skill's `SKILL.md`. */
  path: string;
}

// ---- Slash commands -------------------------------------------------------

/** A user-defined slash command — a reusable prompt snippet triggered by typing
 *  `/<name>` in the composer. Picking one expands `/<name>` to `prompt`; it never
 *  reaches the agent as a command. Mirrors the Rust `SlashCommand`
 *  (src-tauri/src/slash_commands.rs). */
export interface SlashCommand {
  id: string;
  /** The bare trigger, no leading `/`. */
  name: string;
  description: string;
  /** Text inserted into the composer when the command is picked. */
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

/** The fields the editor sends to upsert a command. `id` present → edit; absent
 *  → create. Mirrors the Rust `SlashCommandInput`. */
export interface SlashCommandInput {
  id?: string;
  name: string;
  description: string;
  prompt: string;
}

// ---- MCP servers -----------------------------------------------------------

/** Transport for an MCP server: a local `stdio` command or a remote
 *  `http` (Streamable-HTTP / SSE) endpoint. */
export type McpTransport = "stdio" | "http";

/** One configured MCP server. Fields for the other transport are left empty.
 *  Mirrors the Rust `McpConnector` (src-tauri/src/mcp.rs). */
export interface McpConnector {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: the executable + its args + extra env vars. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** http: the endpoint URL + any extra request headers. */
  url: string;
  headers: Record<string, string>;
  /** http auth mode: "" (static headers) or "oauth" (mcporter runs the flow). */
  auth: string;
  oauthClientId: string;
  oauthScope: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Create/update payload for an MCP server (server fills in ids + timestamps). */
export interface McpConnectorInput {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  auth: string;
  oauthClientId: string;
  oauthScope: string;
  enabled: boolean;
}

/** mcporter `imports` sources cetus can pull discovered MCP servers from. */
export type McpImportSource =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "codex"
  | "opencode";

/** Opt-in loading of skills + MCP managed outside cetus. Mirrors Rust
 *  `DiscoverySettings` (src-tauri/src/discovery.rs). */
export interface DiscoverySettings {
  /** Load SKILL.md folders from `skillsFolder` plus standard runtime roots. */
  skillsLoadDiscovered: boolean;
  /** Additional folder scanned for discovered skills (default ~/.agents/skills). */
  skillsFolder: string;
  /** Editor configs to import MCP servers from. */
  mcpImports: McpImportSource[];
}

/** One MCP server an import source would pull in. Mirrors Rust `McpImportEntry`. */
export interface McpImportEntry {
  name: string;
  detail: string;
}

/** One tool a connected server exposes. Mirrors Rust `McpToolInfo`. */
export interface McpToolInfo {
  name: string;
  description: string | null;
}

/** Result of a `test_connector` handshake (initialize + tools/list). */
export interface McpTestResult {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: McpToolInfo[];
  error: string | null;
}

// ---- Persistent agent memory ----------------------------------------------

export type MemorySource = "user" | "agent";

/** One durable note injected into the agent's context every turn. Mirrors the
 *  Rust `MemoryEntry` (src-tauri/src/memory.rs) and the memory.ts extension. */
export interface MemoryEntry {
  id: string;
  content: string;
  /** Optional free-text grouping label, or null. */
  category: string | null;
  /** Who authored it — the user (settings page) or the agent (manage_memory). */
  source: MemorySource;
  /** When false the entry is kept but not injected into context. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The whole memory store: a master switch plus the entries. */
export interface MemoryState {
  version: number;
  /** Master switch — when off, no memory is injected even if entries exist. */
  enabled: boolean;
  entries: MemoryEntry[];
}

/** Partial edit for `updateMemory`. Omit a field to leave it unchanged; pass
 *  `category: null` (or "") to clear the category. */
export interface MemoryPatch {
  content?: string;
  category?: string | null;
  enabled?: boolean;
}

/** Human-in-the-loop review lifecycle for a conversation. "pending" parks the
 *  card in the board's "Needs review" column (set by the request_review tool);
 *  the board's actions move it to "approved" or back to "none". */
export type ReviewState = "none" | "pending" | "approved" | "changes_requested";

export interface Conversation {
  id: string;
  title: string;
  sessionFile: string;
  /** Absolute path used as pi's cwd for this conversation. */
  workspaceDir: string;
  /** Coding-agent backend: "pi" (default) | "claude-code" | "codex". */
  backend?: string;
  /** Model override for CLI backends (claude --model / codex -m); empty →
   *  the CLI's own default. Unused for pi. */
  cliModel?: string;
  /** Reasoning-effort override for CLI backends; empty → the CLI's default. */
  cliEffort?: string;
  model: ModelChoice;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Set when an automation firing minted this conversation (the automation's
   *  id); null for user-started chats. Lets the UI badge automation runs. */
  sourceAutomationId: string | null;
  /** Set when this conversation is one candidate of a parallel-solutions task —
   *  shared by all siblings so the board can cluster them into one review card.
   *  null for ordinary conversations. */
  parallelGroupId: string | null;
  /** 0-based position within the parallel group (maps to a SOLUTION_VARIANT).
   *  null for ordinary conversations. */
  solutionIndex: number | null;
  /** Human-in-the-loop review state. "pending" → the board's "Needs review"
   *  column; defaults to "none". */
  reviewState: ReviewState;
}

// pi message types we actually render. AgentMessage in pi can carry many roles;
// we keep this loose and rely on `role` + `content` shape.
export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  // pi-ai's content-level tool call has type="toolCall" and field "arguments"
  // (not "tool_use" / "input"). Matters for inflating historical messages.
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string };

export interface PiMessage {
  id?: string;
  // pi-ai roles include "toolResult" (one message per tool execution) — not
  // a generic "tool" role with nested tool_result content blocks.
  // "custom" carries extension-emitted breadcrumbs (e.g. vision_describe) and
  // never goes to the model — it's purely UI.
  role: "user" | "assistant" | "system" | "toolResult" | "custom";
  content: PiContentBlock[] | string;
  // toolResult messages carry these at the top level instead of in content
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  // custom messages: extension-defined discriminator (e.g. "vision_describe").
  customType?: string;
  display?: boolean;
  // pi-specific extras pass through
  [k: string]: unknown;
}

// Streaming event types we care about (subset of pi RPC events).
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: unknown[] }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_end"; message: PiMessage }
  | {
      type: "message_update";
      message: PiMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: { content: PiContentBlock[]; details?: unknown };
    }
  | {
      type: "tool_execution_delta";
      toolCallId: string;
      delta: string;
      totalBytes: number;
      truncated: boolean;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: { content: PiContentBlock[]; details?: unknown };
      isError: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; aborted: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  // toolcall_start carries no id/name — those arrive on toolcall_end.
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "aborted" | "error"; message?: string };

// Automations: a saved prompt that fires on a schedule. Mirrors the Rust
// `Automation` / `AutomationSchedule` in src-tauri/src/automation.rs.
export type AutomationSchedule =
  // One-shot at an absolute epoch-ms instant.
  | { kind: "once"; atMs: number }
  // Fixed interval, re-anchored to "now" after each run.
  | { kind: "interval"; everyMinutes: number }
  // Local wall-clock "HH:MM" on the given weekdays (0=Sun..6=Sat; empty = daily).
  | { kind: "daily"; time: string; weekdays: number[] }
  // Standard 5-field cron expression, evaluated in local time.
  | { kind: "cron"; expr: string };

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  workspaceDir: string;
  model: ModelChoice;
  schedule: AutomationSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastConversationId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  /** Coding-agent runtime fired runs use: "pi" (default) | "claude-code" |
   *  "codex". */
  backend?: BackendId;
  /** Model override for CLI backends; empty → the CLI's own default. */
  cliModel?: string;
  /** Reasoning-effort override for CLI backends; empty → the CLI's default. */
  cliEffort?: string;
}

/** Create/update payload. Server derives run-state + next-run. */
export interface AutomationInput {
  name: string;
  prompt: string;
  workspaceDir: string | null;
  model: ModelChoice;
  schedule: AutomationSchedule;
  enabled: boolean;
  /** "pi" | "claude-code" | "codex" (defaults to "pi" server-side). */
  backend: BackendId;
  /** Model override for CLI backends; "" → the CLI's own default. */
  cliModel: string;
  /** Reasoning-effort override for CLI backends; "" → the CLI's default. */
  cliEffort: string;
}

// Backend lifecycle events (emitted by our Rust code, not pi).
// `pi_event.event` is forwarded verbatim — could be a PiEvent above or an
// ExtensionUIRequest (below); discriminate by `type`.
export type AppEvent =
  | { type: "pi_ready"; conversationId?: string }
  | { type: "pi_exited"; conversationId?: string; code: number | null }
  | { type: "pi_error"; conversationId?: string; message: string }
  | { type: "pi_event"; conversationId?: string; event: PiEvent | ExtensionUIRequest }
  // Emitted when a conversation row changes out-of-band (async auto-titling).
  | { type: "conversation_updated"; conversation: Conversation }
  // An automation's state advanced (next-run computed, toggled, run recorded).
  | { type: "automation_updated"; automation: Automation }
  // An automation was deleted out-of-band (e.g. via the control socket).
  | { type: "automation_deleted"; id: string }
  // An automation fired and minted a conversation.
  | { type: "automation_fired"; automation: Automation; conversation: Conversation }
  // Agent memory changed out-of-band — the dreaming pass consolidated recent
  // sessions into new/refined notes. The Memory settings page reloads on this.
  | { type: "memory_updated" }
  // Agent skills changed out-of-band — the skill-review pass proposed new skills
  // from recent sessions. The Skills settings page reloads on this.
  | { type: "skills_updated" }
  // MCP servers changed out-of-band — the manage_mcp tool updated the MCP store.
  | { type: "mcp_updated" }
  // A live computer/browser-use step: the agent took an action on the user's
  // behalf. Drives the in-chat "Controlling …" panel (AgentControlCard).
  | {
      type: "agent_step";
      conversationId: string;
      surface: "browser" | "computer";
      action: string;
      highlightedIndex?: number;
      screenshotJpeg?: string;
    }
  // Meeting memory lifecycle: a capture session started ("started") or its
  // transcript landed ("saved", with the generated title when a summary ran).
  // The frontend turns these into localized notifications.
  | {
      type: "meeting_event";
      kind: "started" | "saved";
      meetingId: string;
      app: string | null;
      title: string | null;
    };

// Extension UI sub-protocol (pi RPC docs: "Extension UI Protocol").
// pi sends these on stdout to ask the client for user interaction.
// Dialog methods expect a matching `extension_ui_response`; fire-and-forget
// methods do not.
export type ExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** Per-method response body (no `type`, no `id` — those are added by Rust). */
export type ExtensionUIResponseBody =
  | { value: string } // select / input / editor
  | { confirmed: boolean } // confirm
  | { cancelled: true }; // any dialog dismissal

// Internal render state ----------------------------------------------------

export type RenderedBlock =
  | { kind: "text"; text: string; streaming?: boolean }
  | { kind: "thinking"; text: string; streaming?: boolean }
  // Local-only block for image previews on user messages. Persisted nowhere;
  // pi never sees this kind — actual image bytes are forwarded to the agent
  // via send_prompt's `images` argument (pi-ai ImageContent).
  | { kind: "image"; dataUrl: string; name?: string }
  // Local-only chip for a non-image attachment (docx/xlsx/pdf/…). The bytes are
  // written to disk (save_attachment) and the agent reads them via read_document;
  // this block only renders the filename in the bubble.
  | { kind: "file"; name: string; path: string; mimeType: string; sizeBytes: number }
  // Extension breadcrumb (custom message). Currently produced by vision-bridge
  // to surface "Gemini described N images" inline in the conversation.
  | { kind: "custom"; customType: string; text: string; details?: unknown }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      args: unknown;
      // null until result arrives. `details` carries structured tool output
      // (e.g. send_artifact's path/mime) — distinct from `content` which is
      // the model-visible text.
      result: { content: PiContentBlock[]; details?: unknown; isError: boolean } | null;
      streaming?: boolean;
    };

/** Result of a local `!` bash-mode command (run_bash). Mirrors the Rust
 *  BashResult; rendered inline by BashCard. */
export interface BashResult {
  stdout: string;
  stderr: string;
  /** Process exit code; -1 when killed by signal or the timeout. */
  exitCode: number;
  timedOut: boolean;
  /** Directory the command actually ran in. */
  cwd: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  isDir: boolean;
  isIgnored: boolean;
  gitStatus: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" | "ignored" | null;
  isSymlink: boolean;
  symlinkTarget: string | null;
  sizeBytes: number | null;
  modifiedMs: number | null;
}

export interface WorkspaceDirectoryListing {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  isRemote: boolean;
}

export interface WorkspaceTextPreview {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export interface RenderedMessage {
  // Stable client-side id; for user messages we synthesize one.
  key: string;
  role: "user" | "assistant" | "tool" | "system" | "custom";
  blocks: RenderedBlock[];
  createdAt: number;
}
