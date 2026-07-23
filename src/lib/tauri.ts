"use client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentSettings,
  AppEvent,
  AutoArchiveSettings,
  Automation,
  AutomationInput,
  BashResult,
  Conversation,
  DiscoverySettings,
  McpImportEntry,
  DreamSettings,
  ExtensionUIResponseBody,
  McpConnector,
  McpConnectorInput,
  McpTestResult,
  MemoryEntry,
  MemoryPatch,
  MemoryState,
  TranscriptState,
  ModelChoice,
  PiEvent,
  PiMessage,
  PluginEntry,
  SkillEntry,
  SkillReviewSettings,
  SkillState,
  DiscoveredSkill,
  SlashCommand,
  SlashCommandInput,
  UltraSettings,
  QuickLaunchPayload,
  QuickScreenshot,
  QuickSettings,
  ReviewState,
  UpdateDownloadProgress,
  UpdateMeta,
  VoiceInsertMode,
  VoicePermissions,
  WorkspaceFileEntry,
  WorkspaceDirectoryListing,
  WorkspaceTextPreview,
  WorktreeInfo,
  CliAgentSettings,
  CliDefaults,
  DevtestDomOp,
  DevtestDomArgs,
} from "./types";

// --- Screen-context collection (Rewind-like) types -------------------------

export interface CaptureSettings {
  enabled: boolean;
  intervalSeconds: number;
  excludedApps: string[];
  retentionDays: number;
  ocrEnabled: boolean;
}

export interface CaptureStats {
  enabled: boolean;
  count: number;
}

export interface Screenshot {
  id: string;
  ts: number;
  appName: string | null;
  windowTitle: string | null;
  filePath: string;
  /** Small JPEG variant for grid/palette previews; null for pre-thumbnail
   *  frames (render filePath as the fallback). */
  thumbPath: string | null;
  phash: number | null;
  bytes: number;
  ocrText: string | null;
}

// --- Ambient text context (Littlebird-like AX collector) types --------------

export interface AmbientSettings {
  enabled: boolean;
  intervalSeconds: number;
  excludedApps: string[];
  retentionDays: number;
}

export interface AmbientStats {
  enabled: boolean;
  count: number;
}

export interface AmbientEntry {
  id: string;
  ts: number;
  appName: string | null;
  bundleId: string | null;
  windowTitle: string | null;
  url: string | null;
  pageTitle: string | null;
  text: string;
  textHash: number | null;
}

// --- Meeting memory (ambient audio transcription) types --------------------

export interface MeetingSettings {
  enabled: boolean;
  autoDetect: boolean;
  systemAudio: boolean;
  summarize: boolean;
  /** auto = SeedASR when configured, otherwise Apple on-device. */
  asrEngine: "auto" | "local";
  retentionDays: number;
  /** Global accelerator that starts/stops a manual session ("" = none). */
  toggleHotkey: string;
}

export interface MeetingStatus {
  recording: boolean;
  startedTs: number | null;
  auto: boolean;
  appHint: string | null;
  segments: number;
  engine: "cloud" | "local" | "idle";
  meetingId: string | null;
}

export interface Meeting {
  id: string;
  startedTs: number;
  endedTs: number | null;
  title: string | null;
  summary: string | null;
  appName: string | null;
  segmentCount: number;
}

export interface MeetingSegment {
  ts: number;
  source: string;
  text: string;
}

export interface RemoteSettings {
  enabled: boolean;
  port: number;
  accessUrl: string;
  pairingUrl: string;
  pairingQrSvg: string;
  tailscaleReady: boolean;
  tailscaleMessage: string;
}

// --- Commands --------------------------------------------------------------

export const api = {
  webviewHeartbeat: (sequence: number) =>
    invoke<number>("webview_heartbeat", { sequence }),
  wakeMainWebview: () => invoke<void>("wake_main_webview"),
  listConversations: (includeArchived = false) =>
    invoke<Conversation[]>("list_conversations", { includeArchived }),
  newConversation: (workspaceDir?: string, model?: ModelChoice) =>
    invoke<Conversation>("new_conversation", {
      workspaceDir: workspaceDir ?? null,
      model: model ?? null,
    }),
  forkConversation: (id: string, messageId?: string | null, messageIndex?: number | null) =>
    invoke<{ conversation: Conversation; messages: PiMessage[] }>("fork_conversation", {
      id,
      messageId: messageId ?? null,
      messageIndex: messageIndex ?? null,
    }),
  switchConversation: (id: string) =>
    invoke<{ conversation: Conversation; messages: PiMessage[] }>("switch_conversation", { id }),
  setActiveConversation: (id: string | null) =>
    invoke<void>("set_active_conversation", { id }),
  archiveConversation: (id: string, archive: boolean) =>
    invoke<Conversation>("archive_conversation", { id, archive }),
  /** Set the human-in-the-loop review state; returns the updated row. */
  setReviewState: (id: string, state: ReviewState) =>
    invoke<Conversation>("set_review_state", { id, stateValue: state }),
  /** Read a single conversation row (for the backend picker's current value). */
  getConversation: (id: string) =>
    invoke<Conversation | null>("get_conversation", { id }),
  /** Switch the coding-agent backend for a conversation:
   *  "pi" | "claude-code" | "codex". The next send_prompt routes accordingly. */
  setConversationBackend: (id: string, backend: string) =>
    invoke<void>("set_conversation_backend", { id, backend }),
  /** Set a CLI-backend conversation's model + reasoning-effort overrides
   *  (claude --model/--effort / codex -m + model_reasoning_effort); "" restores
   *  the CLI's own defaults. Applies from the next turn. */
  setConversationCliModel: (id: string, model: string, effort: string) =>
    invoke<void>("set_conversation_cli_model", { id, model, effort }),
  getRemoteSettings: () => invoke<RemoteSettings>("get_remote_settings"),
  setRemoteEnabled: (enabled: boolean) =>
    invoke<RemoteSettings>("set_remote_enabled", { enabled }),
  rotateRemoteAccess: () => invoke<RemoteSettings>("rotate_remote_access"),
  /** Worktree path + branch of a CLI-backend conversation (null for pi
   *  conversations and non-git workspaces). */
  conversationWorktree: (id: string) =>
    invoke<WorktreeInfo | null>("conversation_worktree", { id }),
  /** Branch checked out in a local workspace; null for non-git/remote dirs. */
  workspaceGitBranch: (workspaceDir: string) =>
    invoke<string | null>("workspace_git_branch", { workspaceDir }),
  /** The CLI's own configured defaults (model / effort / codex model catalog),
   *  read from the vendor config on disk — lets the tuning menu echo what
   *  "Default" resolves to. */
  getCliDefaults: (backend: string) =>
    invoke<CliDefaults>("get_cli_defaults", { backend }),
  getCliAgentSettings: () => invoke<CliAgentSettings>("get_cli_agent_settings"),
  setCliAgentSettings: (settings: CliAgentSettings) =>
    invoke<void>("set_cli_agent_settings", { settings }),
  /** Answer a blocking CLI-host request. Claude responses use the stream-json
   *  permission shape; Codex responses are reverse JSON-RPC results. */
  cliControlRespond: (
    id: string,
    requestId: string | number,
    response: unknown,
    source?: "claude-code" | "codex",
    installPluginId?: string,
  ) => invoke<void>("cli_control_respond", {
    id,
    requestId,
    response,
    source: source ?? null,
    installPluginId: installPluginId ?? null,
  }),
  deleteConversation: (id: string) => invoke<void>("delete_conversation", { id }),
  renameConversation: (id: string, title: string) =>
    invoke<Conversation>("rename_conversation", { id, title }),
  sendPrompt: (
    id: string,
    message: string,
    images?: { type: "image"; data: string; mimeType: string }[],
  ) =>
    invoke<void>("send_prompt", {
      id,
      message,
      images: images && images.length ? images : null,
    }),
  compactConversation: (id: string) => invoke<void>("compact_conversation", { id }),
  abort: (id: string) => invoke<void>("abort", { id }),
  /** Run a one-shot shell command locally (the composer's `!` bash mode) in
   *  `cwd` (defaults to the workspace). Bypasses the agent; the result is
   *  rendered inline in the chat. Rejects only on spawn failure — a non-zero
   *  exit is a normal result in `exitCode`. */
  runBash: (command: string, cwd?: string | null) =>
    invoke<BashResult>("run_bash", { command, cwd: cwd ?? null }),
  terminalStart: (
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
  ) => invoke<void>("terminal_start", { sessionId, cwd, cols, rows }),
  terminalWrite: (sessionId: string, dataBase64: string) =>
    invoke<void>("terminal_write", { sessionId, dataBase64 }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalStop: (sessionId: string) =>
    invoke<void>("terminal_stop", { sessionId }),
  /** Roll back the last (failed/empty) turn and return the user text to resend
   *  plus the truncated history. See commands::retry_last_turn. */
  retryLastTurn: (id: string) =>
    invoke<{ text: string; messages: PiMessage[] }>("retry_last_turn", { id }),
  /** Persist a non-image attachment to disk; returns its absolute path so the
   *  prompt can reference it for the read_document tool. */
  saveAttachment: (id: string, name: string, data: string) =>
    invoke<string>("save_attachment", { id, name, data }),
  /** Absolute paths of any files on the clipboard (a Finder file copy). Empty on
   *  a non-file clipboard or off macOS. Used to reference a too-large paste by
   *  its real path instead of inlining its bytes. */
  readClipboardFilePaths: () =>
    invoke<string[]>("read_clipboard_file_paths"),
  piPing: () => invoke<boolean>("pi_ping"),
  defaultWorkspace: () => invoke<string>("default_workspace"),
  pickWorkspaceDir: () => invoke<string | null>("pick_workspace_dir"),
  listWorkspaceFiles: (workspaceDir?: string | null) =>
    invoke<WorkspaceFileEntry[]>("list_workspace_files", { workspaceDir: workspaceDir ?? null }),
  listWorkspaceDirectory: (workspaceDir: string, directoryPath?: string | null) =>
    invoke<WorkspaceDirectoryListing>("list_workspace_directory", {
      workspaceDir,
      directoryPath: directoryPath ?? null,
    }),
  searchWorkspaceFiles: (workspaceDir: string, query: string) =>
    invoke<WorkspaceDirectoryListing>("search_workspace_files", { workspaceDir, query }),
  createWorkspaceEntry: (workspaceDir: string, parentPath: string, name: string, isDir: boolean) =>
    invoke<string>("create_workspace_entry", { workspaceDir, parentPath, name, isDir }),
  renameWorkspaceEntry: (workspaceDir: string, path: string, newName: string) =>
    invoke<string>("rename_workspace_entry", { workspaceDir, path, newName }),
  trashWorkspaceEntry: (workspaceDir: string, path: string) =>
    invoke<void>("trash_workspace_entry", { workspaceDir, path }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  readWorkspaceTextFile: (workspaceDir: string, path: string) =>
    invoke<WorkspaceTextPreview>("read_workspace_text_file", { workspaceDir, path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  /** Open an http(s)/mailto link in the user's default browser. */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** Open an http(s) URL in Cetus's own top-level browser webview window. */
  openBrowserWindow: (url: string) =>
    invoke<void>("open_browser_window", { url }),
  openBrowserPanel: (
    url: string,
    bounds: { x: number; y: number; width: number; height: number },
    labels?: { annotate: string; placeholder: string; cancel: string; send: string },
  ) => invoke<void>("open_browser_panel", { url, bounds, labels: labels ?? null }),
  setBrowserPanelBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    invoke<void>("set_browser_panel_bounds", { bounds }),
  setBrowserPanelAnnotationMode: (enabled: boolean) =>
    invoke<void>("set_browser_panel_annotation_mode", { enabled }),
  closeBrowserPanel: () => invoke<void>("close_browser_panel"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  // Sync the native window vibrancy to the app theme ("system" | "light" |
  // "dark"); app-wide on macOS. Best-effort — callers fire-and-forget.
  setThemeAppearance: (preference: string) =>
    invoke<void>("set_theme_appearance", { preference }),
  setWorkspace: (id: string, workspaceDir: string) =>
    invoke<Conversation>("set_workspace", { id, workspaceDir }),
  getModelChoice: (id: string) => invoke<ModelChoice>("get_model_choice", { id }),
  setModelChoice: (id: string, choice: ModelChoice) =>
    invoke<Conversation>("set_model_choice", { id, choice }),
  extensionUiRespond: (
    conversationId: string,
    id: string,
    payload: ExtensionUIResponseBody,
  ) => invoke<void>("extension_ui_respond", { conversationId, id, payload }),
  listApiKeys: () => invoke<string[]>("list_api_keys"),
  getCliRuntimeStatus: () =>
    invoke<{ claudeCode: boolean; codex: boolean }>("get_cli_runtime_status"),
  listApiKeysMasked: () => invoke<Record<string, string>>("list_api_keys_masked"),
  revealApiKey: (provider: string) =>
    invoke<string | null>("reveal_api_key", { provider }),
  setApiKey: (provider: string, key: string) =>
    invoke<void>("set_api_key", { provider, key }),
  deleteApiKey: (provider: string) =>
    invoke<void>("delete_api_key", { provider }),
  /** Custom DeepSeek base URL ("" = stock api.deepseek.com). */
  getDeepseekBaseUrl: () => invoke<string>("get_deepseek_base_url"),
  setDeepseekBaseUrl: (url: string) =>
    invoke<void>("set_deepseek_base_url_cmd", { url }),

  // Automations ------------------------------------------------------------
  listAutomations: () => invoke<Automation[]>("list_automations"),
  createAutomation: (input: AutomationInput) =>
    invoke<Automation>("create_automation", { input }),
  updateAutomation: (id: string, input: AutomationInput) =>
    invoke<Automation>("update_automation", { id, input }),
  deleteAutomation: (id: string) => invoke<void>("delete_automation", { id }),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    invoke<Automation>("set_automation_enabled", { id, enabled }),
  runAutomationNow: (id: string) =>
    invoke<Conversation>("run_automation_now", { id }),

  // Persistent agent memory -------------------------------------------------
  /** The full memory store: master switch + entries (newest decisions and all). */
  listMemories: () => invoke<MemoryState>("list_memories"),
  /** Add a user-authored memory; returns the created entry. */
  createMemory: (content: string, category?: string | null) =>
    invoke<MemoryEntry>("create_memory", {
      content,
      category: category ?? null,
    }),
  /** Patch an entry. Omitted fields stay as-is; `category: null`/"" clears it. */
  updateMemory: (id: string, patch: MemoryPatch) =>
    invoke<MemoryEntry>("update_memory", {
      id,
      // null → "leave unchanged" on the Rust side; "" → clear the category.
      content: patch.content ?? null,
      category: patch.category === undefined ? null : (patch.category ?? ""),
      enabled: patch.enabled === undefined ? null : patch.enabled,
    }),
  deleteMemory: (id: string) => invoke<void>("delete_memory", { id }),
  /** Flip the master switch for memory injection. */
  setMemoryEnabled: (enabled: boolean) =>
    invoke<void>("set_memory_enabled", { enabled }),
  /** Delete every entry (the master switch is left untouched). */
  clearMemories: () => invoke<void>("clear_memories"),

  // Dictation history (voice context) --------------------------------------
  /** The dictation-history store: master switch + saved transcripts. */
  listTranscripts: () => invoke<TranscriptState>("list_transcripts"),
  /** Toggle whether dictations are recorded + agent-recallable. */
  setTranscriptsEnabled: (enabled: boolean) =>
    invoke<void>("set_transcripts_enabled", { enabled }),
  /** Delete all saved transcripts (the master switch is left untouched). */
  clearTranscripts: () => invoke<void>("clear_transcripts"),

  // Ultra Code (autonomous workflow orchestration) ------------------------
  getUltraSettings: () => invoke<UltraSettings>("get_ultra_settings"),
  setUltraSettings: (settings: UltraSettings) =>
    invoke<void>("set_ultra_settings", { settings }),

  // Mirror the resolved UI locale into the backend so it can anchor the
  // conversation system prompt to a concrete reply language. Fire-and-forget.
  setUiLocale: (locale: string) => invoke<void>("set_ui_locale", { locale }),

  // Computer & Browser control (agent control) ----------------------------
  getAgentSettings: () => invoke<AgentSettings>("get_agent_settings"),
  setAgentSettings: (settings: AgentSettings) =>
    invoke<void>("set_agent_settings", { settings }),
  agentStop: (convId: string) => invoke<void>("agent_stop", { convId }),
  listPlugins: () => invoke<PluginEntry[]>("list_plugins"),
  setPluginEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_plugin_enabled", { id, enabled }),
  importPlugin: (path: string) => invoke<PluginEntry>("import_plugin", { path }),
  revealPlugin: (id: string) => invoke<void>("reveal_plugin", { id }),
  deletePlugin: (id: string) => invoke<void>("delete_plugin", { id }),

  // Dreaming (idle-time memory consolidation) -----------------------------
  getDreamSettings: () => invoke<DreamSettings>("get_dream_settings"),
  setDreamSettings: (settings: DreamSettings) =>
    invoke<void>("set_dream_settings", { settings }),

  // Auto-archive (idle-time conversation archiving) -----------------------
  getAutoArchiveSettings: () =>
    invoke<AutoArchiveSettings>("get_auto_archive_settings"),
  setAutoArchiveSettings: (settings: AutoArchiveSettings) =>
    invoke<void>("set_auto_archive_settings", { settings }),

  // Skill review (idle-time self-improvement: propose skills from experience) -
  getSkillReviewSettings: () =>
    invoke<SkillReviewSettings>("get_skill_review_settings"),
  setSkillReviewSettings: (settings: SkillReviewSettings) =>
    invoke<void>("set_skill_review_settings", { settings }),

  // Skills (Agent Skills standard) ----------------------------------------
  /** The whole skills store: master switch + installed entries. */
  listSkills: () => invoke<SkillState>("list_skills"),
  /** Flip the master switch for skill loading. */
  setSkillsEnabled: (enabled: boolean) =>
    invoke<void>("set_skills_enabled", { enabled }),
  /** Install a skill from a folder containing a SKILL.md; returns the entry. */
  importSkill: (path: string) => invoke<SkillEntry>("import_skill", { path }),
  /** Create a skill from a name + description + markdown body. */
  createSkill: (name: string, description: string, body: string) =>
    invoke<SkillEntry>("create_skill", { name, description, body }),
  setSkillEnabled: (id: string, enabled: boolean) =>
    invoke<SkillEntry>("set_skill_enabled", { id, enabled }),
  deleteSkill: (id: string) => invoke<void>("delete_skill", { id }),
  /** Open the skill's folder in the OS file browser. */
  revealSkill: (id: string) => invoke<void>("reveal_skill", { id }),
  /** Skills auto-loaded from the global `~/.agents/skills` dir (read-only). */
  listDiscoveredSkills: () =>
    invoke<DiscoveredSkill[]>("list_discovered_skills"),
  /** Read a discovered skill's full SKILL.md for in-app rendering. */
  readDiscoveredSkill: (id: string) =>
    invoke<string>("read_discovered_skill", { id }),
  /** Open a discovered skill's folder in the OS file browser. */
  revealDiscoveredSkill: (id: string) =>
    invoke<void>("reveal_discovered_skill", { id }),

  // Slash commands (local prompt snippets) --------------------------------
  /** All user-defined slash commands, sorted by name. */
  listSlashCommands: () => invoke<SlashCommand[]>("list_slash_commands"),
  /** Create (no id) or update (with id) a slash command; returns the saved one. */
  upsertSlashCommand: (input: SlashCommandInput) =>
    invoke<SlashCommand>("upsert_slash_command", { input }),
  deleteSlashCommand: (id: string) =>
    invoke<void>("delete_slash_command", { id }),

  // MCP servers ------------------------------------------------------------
  listConnectors: () => invoke<McpConnector[]>("list_connectors"),
  addConnector: (input: McpConnectorInput) =>
    invoke<McpConnector>("add_connector", { input }),
  updateConnector: (id: string, input: McpConnectorInput) =>
    invoke<McpConnector>("update_connector", { id, input }),
  setConnectorEnabled: (id: string, enabled: boolean) =>
    invoke<McpConnector>("set_connector_enabled", { id, enabled }),
  removeConnector: (id: string) => invoke<void>("remove_connector", { id }),
  /** Run a real MCP initialize + tools/list handshake against the config. */
  testConnector: (input: McpConnectorInput) =>
    invoke<McpTestResult>("test_connector", { input }),
  /** Run the OAuth flow for an HTTP MCP server via mcporter (opens a browser). */
  authorizeConnector: (input: McpConnectorInput) =>
    invoke<string>("authorize_connector", { input }),
  getDiscoverySettings: () =>
    invoke<DiscoverySettings>("get_discovery_settings"),
  setDiscoverySettings: (settings: DiscoverySettings) =>
    invoke<void>("set_discovery_settings", { settings }),
  /** Preview the MCP servers an import source would pull in (no connect). */
  previewMcpImport: (source: string) =>
    invoke<McpImportEntry[]>("preview_mcp_import", { source }),

  // Quick launcher ---------------------------------------------------------
  getQuickSettings: () => invoke<QuickSettings>("get_quick_settings"),
  setQuickSettings: (settings: QuickSettings) =>
    invoke<void>("set_quick_settings", { settings }),

  // Self-update -----------------------------------------------------------
  /** Manually check for an update. Resolves to its metadata, or null if the
   *  app is up to date (always null in dev builds). */
  checkForUpdate: () => invoke<UpdateMeta | null>("check_for_update"),
  /** Download + install the available update (applied on next launch). */
  installUpdate: () => invoke<void>("install_update"),
  /** Remember a version dismissed from the passive toast (no re-prompt until a
   *  newer one ships). */
  ignoreUpdateVersion: (version: string) =>
    invoke<void>("ignore_update_version", { version }),
  /** Version of an already-downloaded update waiting for relaunch, if any. */
  pendingUpdateVersion: () => invoke<string | null>("pending_update_version"),
  /** Relaunch the app to apply an already-downloaded update. */
  relaunchApp: () => invoke<void>("relaunch_app"),
  /** Hide panel, capture screen, restore panel. For the in-panel toggle. */
  quickRecaptureScreenshot: () =>
    invoke<QuickScreenshot | null>("quick_recapture_screenshot"),
  quickDismiss: () => invoke<void>("quick_dismiss"),
  /** Accept a direct visual reply and type it back into the previously focused app. */
  quickReplyInsert: (text: string) =>
    invoke<void>("quick_reply_insert", { text }),
  // Native notification: clicking it routes back as a `notification-activate`
  // event carrying `conversationId` (see notify.rs).
  postNotification: (p: {
    title: string;
    body: string;
    conversationId?: string | null;
  }) => invoke<void>("post_notification", p),
  quickSubmit: (payload: QuickLaunchPayload) =>
    invoke<void>("quick_submit", { payload }),
  accessibilityTrusted: () => invoke<boolean>("accessibility_trusted"),
  requestAccessibility: () => invoke<boolean>("request_accessibility"),
  openAccessibilitySettings: () =>
    invoke<void>("open_accessibility_settings"),
  screenRecordingTrusted: () => invoke<boolean>("screen_recording_trusted"),
  requestScreenRecording: () => invoke<boolean>("request_screen_recording"),
  openScreenRecordingSettings: () =>
    invoke<void>("open_screen_recording_settings"),

  // Voice dictation --------------------------------------------------------
  voicePermissions: () => invoke<VoicePermissions>("voice_permissions"),
  requestVoicePermissions: () =>
    invoke<VoicePermissions>("request_voice_permissions"),
  openMicrophoneSettings: () => invoke<void>("open_microphone_settings"),
  /** Type text into the currently-focused app (global dictation). */
  insertText: (text: string, mode?: VoiceInsertMode) =>
    invoke<void>("insert_text", { text, mode: mode ?? null }),

  // Screen context (Rewind-like collection) --------------------------------
  getCaptureSettings: () => invoke<CaptureSettings>("get_capture_settings"),
  setCaptureSettings: (settings: CaptureSettings) =>
    invoke<void>("set_capture_settings", { settings }),
  captureStats: () => invoke<CaptureStats>("capture_stats"),
  recentScreenshots: (limit?: number, beforeTs?: number) =>
    invoke<Screenshot[]>("recent_screenshots", {
      limit: limit ?? null,
      beforeTs: beforeTs ?? null,
    }),
  searchScreenshots: (
    query: string,
    sinceTs?: number,
    limit?: number,
    beforeTs?: number,
  ) =>
    invoke<Screenshot[]>("search_screenshots", {
      query,
      sinceTs: sinceTs ?? null,
      limit: limit ?? null,
      beforeTs: beforeTs ?? null,
    }),

  // Ambient text context (Littlebird-like AX collector) ---------------------
  getAmbientSettings: () => invoke<AmbientSettings>("get_ambient_settings"),
  setAmbientSettings: (settings: AmbientSettings) =>
    invoke<void>("set_ambient_settings", { settings }),
  ambientStats: () => invoke<AmbientStats>("ambient_stats"),
  recentAmbientContext: (limit?: number, beforeTs?: number) =>
    invoke<AmbientEntry[]>("recent_ambient_context", {
      limit: limit ?? null,
      beforeTs: beforeTs ?? null,
    }),
  searchAmbientContext: (
    query: string,
    sinceTs?: number,
    limit?: number,
    beforeTs?: number,
  ) =>
    invoke<AmbientEntry[]>("search_ambient_context", {
      query,
      sinceTs: sinceTs ?? null,
      limit: limit ?? null,
      beforeTs: beforeTs ?? null,
    }),
  clearAmbientHistory: () => invoke<void>("clear_ambient_history"),
  /** Inner text of the `<context source="cetus-ambient">` fence, or null when
   *  the collector is off / the rolling window is empty. */
  ambientRecentSummary: () => invoke<string | null>("ambient_recent_summary"),

  // Meeting memory (ambient audio transcription) ----------------------------
  getMeetingSettings: () => invoke<MeetingSettings>("get_meeting_settings"),
  setMeetingSettings: (settings: MeetingSettings) =>
    invoke<void>("set_meeting_settings", { settings }),
  meetingStatus: () => invoke<MeetingStatus>("meeting_status"),
  meetingStart: () => invoke<void>("meeting_start"),
  meetingStop: () => invoke<boolean>("meeting_stop"),
  listMeetings: (limit?: number) =>
    invoke<Meeting[]>("list_meetings", { limit: limit ?? null }),
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  meetingTranscript: (id: string) =>
    invoke<MeetingSegment[]>("meeting_transcript", { id }),

  // DEV-ONLY eval bridge (only registered when the `devtest` Cargo feature is on).
  testEval: (js: string, label?: string) =>
    invoke<void>("test_eval", { js, label: label ?? null }),
  testScreenshot: () => invoke<QuickScreenshot>("test_screenshot"),
  testAx: (request: unknown) => invoke<unknown>("test_ax", { request }),
  testDom: (op: DevtestDomOp, args?: DevtestDomArgs) =>
    invoke<unknown>("test_dom", {
      op,
      selector: args?.selector ?? null,
      text: args?.text ?? null,
      js: args?.js ?? null,
    }),
};

// --- Events ---------------------------------------------------------------

export async function onAppEvent(handler: (e: AppEvent) => void): Promise<UnlistenFn> {
  return listen<AppEvent>("app-event", (e) => handler(e.payload));
}

/** Fired (main window only) when a background check finds an update and
 *  auto-update is off — drives the passive "update available" toast. */
export async function onUpdateAvailable(
  handler: (u: UpdateMeta) => void,
): Promise<UnlistenFn> {
  return listen<UpdateMeta>("update-available", (e) => handler(e.payload));
}

/** Fired once an update has finished downloading + installing (silently at
 *  startup, or via a manual install) — drives the sidebar's "Restart to
 *  update" button. The swap is already on disk; only a relaunch remains. */
export async function onUpdateReady(
  handler: (u: UpdateMeta) => void,
): Promise<UnlistenFn> {
  return listen<UpdateMeta>("update-ready", (e) => handler(e.payload));
}

/** Fired while a native app update is downloading. */
export async function onUpdateDownloadProgress(
  handler: (p: UpdateDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<UpdateDownloadProgress>("update-download-progress", (e) =>
    handler(e.payload),
  );
}

export async function onPiEvent(handler: (e: PiEvent) => void): Promise<UnlistenFn> {
  return onAppEvent((evt) => {
    if (evt.type === "pi_event" && evt.event.type !== "extension_ui_request") {
      handler(evt.event as PiEvent);
    }
  });
}
