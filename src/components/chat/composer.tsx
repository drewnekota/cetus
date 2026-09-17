"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import { artifactsFromDetails, formatBytes } from "@/lib/artifact";
import {
  useRuntimeCatalog,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
import { useChatStore, useCliCommands } from "@/lib/chat-store";
import { type SlashItem } from "@/components/chat/slash-menu";
import { type EditableSlashCommand } from "@/components/chat/slash-command-dialog";
import { type MentionTab } from "@/components/chat/mention-menu";
import {
  FUNCTION_MENTIONS,
  buildMentionRefs,
  extractMentionRefs,
  mentionDraftKey,
  mentionToken,
  mentionsInText,
  parseRefs,
  recallRefs,
  rememberRef,
  serializeRefs,
  textWithoutMentions,
  uniqueLabel,
  type MentionItem,
  type MentionRef,
  type MentionResolution,
} from "@/lib/mentions";
import { splitLeadingQuote } from "@/lib/user-quote";
import { useTranslation } from "@/lib/i18n";
import { flavorHeroPlaceholder } from "@/lib/chat-flavor";
import { api } from "@/lib/tauri";
import { composeWithAmbient } from "@/lib/quick-context";
import { prepareImageAttachment } from "@/lib/image-attachment";
import { readDroppedFiles } from "@/lib/dropped-files";
import { FILE_DRAG_EVENT, FILE_DROP_EVENT } from "@/components/file-drop-host";
import {
  readDraft,
  readDraftAttachments,
  readPersistedDraftAttachments,
  writeDraft,
  writeDraftAttachments,
} from "@/lib/draft-store";
import type {
  Automation,
  BackendId,
  CliSlashCommand,
  Conversation,
  ModelChoice,
  WorkspaceFileEntry,
} from "@/lib/types";
import { toast } from "sonner";
import {
  quoteKey,
  RUNTIME_CATALOG_REFRESH_MS,
  escapeRegExp,
  CLAUDE_CLI_COMMANDS,
  CODEX_CLI_COMMANDS,
  describeSchedule,
  detectSlashToken,
  detectMentionToken,
  cleanQuoteText,
  FOCUS_TRIGGER_CHARS,
  MAX_FILE_BYTES,
  fileToBase64,
  formatQuoteMarkdown,
} from "./composer-utils";
import { renderComposer } from "./composer-view";

/** A composer attachment. Images ride pi's `images` channel (→ native model input);
 *  every other file is written to disk and read by the agent via local file-reading. */
export type ComposerAttachment = ImageAttachment | FileAttachment;

/** Runtime choice captured with a composed message. Selecting a runtime only
 * updates this intent; the conversation is switched when the message is
 * actually delivered. */
export interface ComposerRuntimeSelection {
  backend: BackendId;
  cliModel: string;
  cliEffort: string;
}

/** A message parked in the follow-up queue while the agent is mid-run. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  runtime?: ComposerRuntimeSelection;
}

/** Imperative-looking, token-keyed request to replace the current draft. Used
 *  when a queued message is removed from the queue and returned to the shared
 *  composer for full text + attachment editing. */
export interface ComposerDraftRequest {
  id: number;
  text: string;
  attachments: ComposerAttachment[];
}

export interface QuoteRequest {
  id: number;
  text: string;
}

export interface ImageAttachment {
  type: "image";
  /** Bare base64 (no `data:` prefix). */
  data: string;
  mimeType: string;
  /** Original filename when available; "(pasted)" for clipboard images. */
  name: string;
  /** Local-only preview URL for thumbnails (revoked on remove). */
  previewUrl: string;
}

export interface FileAttachment {
  type: "file";
  /** Bare base64 (no `data:` prefix). */
  data: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
}

interface Props {
  disabled?: boolean;
  streaming?: boolean;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  /** Active conversation id — drives the backend picker (pi/claude-code/codex).
   *  Null on the hero composer before a conversation exists (picker hides). */
  conversationId?: string | null;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (
    text: string,
    attachments: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => void;
  /** Called instead of onSend when the agent is mid-run: the message is parked
   *  in a follow-up queue (shown above the composer) and delivered when the run
   *  ends, unless the user promotes it to a steer. Omit to fall back to onSend
   *  (immediate steer) while streaming. */
  onQueue?: (
    text: string,
    attachments: ComposerAttachment[],
    runtime?: ComposerRuntimeSelection,
  ) => void;
  /** Send the first queued follow-up when Enter is pressed with an otherwise
   *  empty composer. Omit when there is no queued message to send. */
  onSendFirstQueued?: () => void;
  /** Send a shell command to the Terminal surface (the `!` mode). Receives the
   *  command with the leading `!` already stripped. Omit to disable this mode
   *  (the `!` is then just a normal character). */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Visual variant: hero (large, centered with headline) vs docked (bottom). */
  variant?: "hero" | "docked";
  placeholder?: string;
  /** Bumping this number forces the textarea to refocus (e.g. when the user
   *  clicks "New chat" while already on the hero — the component doesn't
   *  remount so a stable `autoFocus` prop alone wouldn't re-trigger focus). */
  focusToken?: number;
  /** Persist the unsent text under this key so it survives a view switch (the
   *  composer unmounts) or a conversation switch (the key changes in place).
   *  Omit for ephemeral composers (dialogs) that shouldn't retain a draft. */
  draftKey?: string;
  /** Replace the current draft and focus the textarea when this token changes. */
  draftRequest?: ComposerDraftRequest | null;
  /** Selected text from the current conversation to append as a Markdown quote. */
  quoteRequest?: QuoteRequest | null;
  /** Backend choice held before a conversation exists (the hero composer):
   *  the parent applies it to the conversation minted on first send. Omit to
   *  hide the backend picker on conversation-less composers (dialogs). */
  pendingBackend?: BackendId;
  onPendingBackendChange?: (backend: BackendId) => void;
  /** Pending-mode CLI model/effort (hero composer), applied on first send. */
  pendingCliModel?: string;
  pendingCliEffort?: string;
  onPendingTuningChange?: (model: string, effort: string) => void;
  /** Keyboard runtime-switch request (token-keyed), applied by the
   *  BackendPicker exactly once per token. */
  backendSwitch?: ({ token: number } & RuntimeSwitchTarget) | null;
  /** Request cycling to a specific runtime (Tab in the composer). Routes back
   *  through the parent's token machinery so BackendPicker applies it. */
  onRequestBackendSwitch?: (target: RuntimeSwitchTarget) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

export function Composer({
  disabled,
  streaming,
  modelChoice,
  onModelChange,
  conversationId,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onQueue,
  onSendFirstQueued,
  onBash,
  onAbort,
  variant = "docked",
  placeholder,
  focusToken,
  draftKey,
  draftRequest,
  quoteRequest,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  backendSwitch,
  onRequestBackendSwitch,
}: Props) {
  const { t, locale } = useTranslation("chat");
  // A random hero placeholder, re-rolled per new chat (focusToken bumps) so the
  // empty composer reads a little differently each time. Only used by the hero
  // variant; docked/bash/streaming keep their functional hints.
  const heroPlaceholder = useMemo(
    () => flavorHeroPlaceholder(locale),
    [locale, focusToken],
  );
  const [text, setText] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  // Quoted selection ("Add to chat") held apart from the typed text, ChatGPT
  // style: shown as a dismissable bar above the textarea and only merged into
  // the outgoing message (as a Markdown blockquote) at send time. Persisted
  // under a derived draft key so it survives view/conversation switches.
  const [quote, setQuote] = useState(() =>
    draftKey ? readDraft(quoteKey(draftKey)) : "",
  );
  const updateQuote = useCallback(
    (v: string) => {
      setQuote(v);
      if (draftKey) writeDraft(quoteKey(draftKey), v);
    },
    [draftKey],
  );
  const restoreAttachments = useCallback(
    (key?: string): ComposerAttachment[] =>
      key
        ? readDraftAttachments(key).map((attachment) =>
            attachment.type === "image"
              ? {
                  ...attachment,
                  previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
                }
              : attachment,
          )
        : [],
    [],
  );

  // Write-through setter: every edit persists the draft under the current key so
  // it's already saved when the composer unmounts (view switch) or its key
  // changes (conversation switch). No-op persistence when no draftKey is wired.
  const updateText = useCallback(
    (v: string) => {
      setText(v);
      if (draftKey) writeDraft(draftKey, v);
    },
    [draftKey],
  );

  // The conversation/view switched while this composer stayed mounted (e.g. the
  // docked composer in ChatPane as the active chat changes). The outgoing draft
  // was already persisted on each keystroke, so just load the incoming one.
  const draftKeyRef = useRef(draftKey);
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    draftKeyRef.current = draftKey;
    setPreviewImage(null);
    setText(draftKey ? readDraft(draftKey) : "");
    setQuote(draftKey ? readDraft(quoteKey(draftKey)) : "");
    setAttachments(restoreAttachments(draftKey));
    setMentionRefs(
      draftKey ? parseRefs(readDraft(mentionDraftKey(draftKey))) : [],
    );
  }, [draftKey, restoreAttachments]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() =>
    restoreAttachments(draftKey),
  );
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(
    null,
  );

  // Attachment bytes live in IndexedDB across a renderer recovery. Hydrate
  // them asynchronously, but never overwrite a newer in-memory user edit.
  useEffect(() => {
    if (!draftKey) return;
    const key = draftKey;
    let cancelled = false;
    void readPersistedDraftAttachments(key).then((stored) => {
      if (cancelled || draftKeyRef.current !== key || !stored.length) return;
      setAttachments((current) => {
        if (current.length) return current;
        return stored.map((attachment) =>
          attachment.type === "image"
            ? {
                ...attachment,
                previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
              }
            : attachment,
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  const updateAttachments = useCallback(
    (update: (previous: ComposerAttachment[]) => ComposerAttachment[]) => {
      setAttachments((previous) => {
        const next = update(previous);
        if (draftKey) writeDraftAttachments(draftKey, next);
        return next;
      });
    },
    [draftKey],
  );
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Mirrors the BackendPicker's value so pi-only affordances (the DeepSeek
  // model picker) hide when a CLI backend serves this conversation — the CLIs
  // run their own default models, so the picker would be a no-op there.
  const [backend, setBackend] = useState<BackendId>("pi");
  const { entries: runtimeEntries, enabledBackendIds } = useRuntimeCatalog();
  // Existing-conversation runtime is loaded asynchronously. Until it arrives,
  // omit runtime intent from a very fast send so the persisted backend remains
  // authoritative instead of accidentally treating the initial `pi` state as
  // a requested switch.
  const [runtimeReady, setRuntimeReady] = useState(!conversationId);
  const [cliTuning, setCliTuning] = useState({ model: "", effort: "" });
  const onRuntimeTuningChange = useCallback((model: string, effort: string) => {
    setCliTuning({ model, effort });
  }, []);
  useEffect(() => setRuntimeReady(!conversationId), [conversationId]);
  // Ambient rolling context (Littlebird-like collector). The chip only shows
  // when the collector is enabled in Settings; the per-composer toggle decides
  // whether each send leads with a `<context source="cetus-ambient">` fence.
  const [ambientAvailable, setAmbientAvailable] = useState(false);
  const [ambientOn, setAmbientOn] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("cetus.ambient-inject") === "1",
  );
  useEffect(() => {
    let live = true;
    const check = () =>
      api
        .ambientStats()
        .then((st) => live && setAmbientAvailable(st.enabled))
        .catch(() => {});
    check();
    // Re-check when the window regains focus so flipping the collector on in
    // Settings shows the chip without a reload.
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, []);
  const toggleAmbient = () => {
    setAmbientOn((v) => {
      window.localStorage.setItem("cetus.ambient-inject", v ? "0" : "1");
      return !v;
    });
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastQuoteIdRef = useRef<number | null>(null);
  const lastDraftRequestIdRef = useRef<number | null>(null);

  // A leading `!` flips the composer into Terminal mode: submit opens/focuses
  // the Terminal surface and runs the command there instead of sending a chat
  // message. Gated on a wired onBash handler — otherwise `!` is just text.
  const bashMode = !!onBash && text.startsWith("!");
  const bashCommand = bashMode ? text.slice(1).trim() : "";

  // ---- Slash menu (commands + skills) -------------------------------------
  // Native commands the conversation's CLI session reported on boot.
  const nativeCommands = useCliCommands(conversationId);
  // Catalog probed straight from the runtime, for composers with no live
  // session behind them (new chat, or a conversation whose CLI hasn't booted).
  // Keyed by the runtime it was probed for, so switching runtimes in the
  // composer can't leave the previous one's commands on the menu.
  const [probed, setProbed] = useState<{
    backend: BackendId;
    commands: CliSlashCommand[];
  }>({
    backend: "pi",
    commands: [],
  });
  const catalogProbeRef = useRef<{
    key: string;
    request: Promise<CliSlashCommand[]>;
  } | null>(null);
  const catalogCheckedAtRef = useRef(new Map<string, number>());
  const [slashCommands, setSlashCommands] = useState<SlashItem[]>([]);
  const [slashSkills, setSlashSkills] = useState<SlashItem[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashStart, setSlashStart] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  const [cliTuningOpen, setCliTuningOpen] = useState(false);
  const contextUsage = useChatStore((s) =>
    conversationId ? s.cliContextUsage[conversationId] : undefined,
  );
  const codexRateLimit = useChatStore((s) => s.cliRateLimits.codex);
  // Set when the user dismisses with Esc; cleared on the next edit so the menu
  // stays closed for the current token but a later `/` reopens it.
  const slashSuppress = useRef(false);
  // Slash-command editor, opened from the menu: the Commands heading creates
  // (the typed token seeds the name, so `/summar` + click lands in a half-filled
  // form), a row's pencil edits that command.
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [newCommandSeed, setNewCommandSeed] = useState("");
  const [editingCommand, setEditingCommand] =
    useState<EditableSlashCommand | null>(null);

  // ---- @-mention menu (goal, …) -------------------------------------------
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionActive, setMentionActive] = useState(0);
  const mentionSuppress = useRef(false);
  const [mentionTab, setMentionTab] = useState<MentionTab>("all");
  // What each `@label` in the draft points at. Persisted next to the draft text
  // so the pills survive a view switch / reload; pruned as tokens are edited out.
  const [mentionRefs, setMentionRefs] = useState<MentionRef[]>(() =>
    draftKey ? parseRefs(readDraft(mentionDraftKey(draftKey))) : [],
  );
  const updateMentionRefs = useCallback(
    (next: MentionRef[] | ((prev: MentionRef[]) => MentionRef[])) => {
      setMentionRefs((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        if (draftKey)
          writeDraft(mentionDraftKey(draftKey), serializeRefs(value));
        return value;
      });
    },
    [draftKey],
  );
  // A token edited out of the text (or the text cleared on send) drops its ref.
  useEffect(() => {
    if (mentionRefs.length === 0) return;
    const live = mentionsInText(text, mentionRefs);
    if (live.length !== mentionRefs.length) updateMentionRefs(live);
  }, [text, mentionRefs, updateMentionRefs]);
  const mentionLabels = useMemo(
    () => mentionRefs.map((r) => r.label),
    [mentionRefs],
  );
  const highlightRef = useRef<HTMLDivElement>(null);
  // Menu data sources, loaded when the menu opens (cheap SQL / a snapshot of the
  // resident message list) — never subscribed to, so streaming tokens don't
  // re-render the composer.
  const [mentionAutomations, setMentionAutomations] = useState<Automation[]>(
    [],
  );
  const [mentionConversations, setMentionConversations] = useState<
    Conversation[]
  >([]);
  const [mentionArtifacts, setMentionArtifacts] = useState<MentionItem[]>([]);
  const [mentionFiles, setMentionFiles] = useState<WorkspaceFileEntry[]>([]);
  const [mentionFilesLoading, setMentionFilesLoading] = useState(false);
  const withFocusHint = useCallback(
    (base: string) => {
      const trimmed = base.trimEnd();
      const separator = /[.!?。！？…]$/.test(trimmed) ? " " : ". ";
      return `${trimmed}${separator}${t("composer.focusShortcutHint")}`;
    },
    [t],
  );

  // Pull commands + skills when the menu opens (so settings edits show up
  // without a remount). Skills = enabled library skills + globally discovered
  // ones, matching what the agent actually loads.
  useEffect(() => {
    if (!slashOpen) return;
    let alive = true;
    (async () => {
      try {
        const [commands, skillState, discovered, discovery, cachedNative] =
          await Promise.all([
            api.listSlashCommands(),
            api.listSkills(),
            api.listDiscoveredSkills(),
            api.getDiscoverySettings(),
            conversationId
              ? api.getCliCommands(conversationId)
              : Promise.resolve([]),
          ]);
        if (!alive) return;
        // cli_commands is also streamed live, but the Rust-side snapshot
        // survives renderer/HMR reloads and closes the startup-listener race.
        if (
          conversationId &&
          cachedNative.length > 0 &&
          (useChatStore.getState().cliCommands[conversationId]?.length ?? 0) ===
            0
        ) {
          useChatStore.getState().setCliCommands(conversationId, cachedNative);
        }
        setSlashCommands(
          commands.map((c) => ({
            kind: "command",
            id: c.id,
            name: c.name,
            description: c.description,
            prompt: c.prompt,
            // Locally stored → the menu offers an inline edit affordance.
            commandId: c.id,
          })),
        );
        const libs = skillState.enabled
          ? skillState.entries.filter((e) => e.enabled)
          : [];
        const seen = new Set<string>();
        const skills: SlashItem[] = [];
        const loadedDiscovered = discovery.skillsLoadDiscovered
          ? discovered
          : [];
        for (const s of [...libs, ...loadedDiscovered]) {
          const key = s.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          skills.push({
            kind: "skill",
            id: s.id,
            name: s.name,
            description: s.description,
          });
        }
        setSlashSkills(skills);
      } catch {
        // Slash menu is a convenience — a load failure just leaves it empty.
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId, slashOpen]);

  const probeRuntimeCatalog = useCallback(
    (refreshIfStale: boolean) => {
      if (backend !== "claude-code" && backend !== "codex") return;
      const cwd = workspaceDir ?? defaultWorkspace;
      const key = `${backend}\n${cwd}`;
      const inFlight = catalogProbeRef.current;
      if (inFlight?.key === key) return;

      const checkedAt = catalogCheckedAtRef.current.get(key) ?? 0;
      const forceRefresh =
        refreshIfStale && Date.now() - checkedAt >= RUNTIME_CATALOG_REFRESH_MS;
      const request = api.probeCliCommands(
        backend,
        cwd || undefined,
        forceRefresh,
      );
      catalogProbeRef.current = { key, request };
      void request
        .then((commands) => {
          catalogCheckedAtRef.current.set(key, Date.now());
          // A slower probe for a previously selected runtime must not replace
          // the current runtime's catalog.
          if (catalogProbeRef.current?.request === request) {
            setProbed({ backend, commands });
          }
        })
        .catch(() => {
          // Runtime discovery is best-effort; retain the last good catalog.
        })
        .finally(() => {
          if (catalogProbeRef.current?.request === request) {
            catalogProbeRef.current = null;
          }
        });
    },
    [backend, workspaceDir, defaultWorkspace],
  );

  // Prewarm as soon as the composer knows which runtime + workspace a new
  // conversation will use. In the common path this finishes before `/` opens.
  useEffect(() => {
    if (nativeCommands.length > 0) return;
    probeRuntimeCatalog(false);
  }, [nativeCommands.length, probeRuntimeCatalog]);

  // Revalidate stale catalogs when the menu opens. The current catalog remains
  // visible while a changed result is fetched in the background.
  useEffect(() => {
    if (!slashOpen || nativeCommands.length > 0) return;
    probeRuntimeCatalog(true);
  }, [slashOpen, nativeCommands.length, probeRuntimeCatalog]);

  const slashItems = useMemo(() => {
    const q = slashQuery.toLowerCase();
    // Rank rather than just filter: a query like "usage" must surface
    // `/usage-credits` above `/context` ("Show current context usage") and a
    // figma skill whose blurb happens to contain "Usage —". Lower is better;
    // 0 = no match. Ties keep the caller's (catalog) order.
    const rank = (it: SlashItem): number => {
      if (!q) return 1;
      const name = it.name.toLowerCase();
      if (name === q) return 1;
      if (name.startsWith(q)) return 2;
      // Namespaced names (`figma:figma-use`) and hyphenated words: a segment
      // start beats an arbitrary substring.
      const segIdx = name.search(new RegExp(`(^|[-_:/.])${escapeRegExp(q)}`));
      if (segIdx >= 0) return 3;
      if (name.includes(q)) return 4;
      if (it.description.toLowerCase().includes(q)) return 5;
      return 0;
    };
    const match = (it: SlashItem) => rank(it) > 0;
    const byRank = (list: SlashItem[]): SlashItem[] =>
      list
        .map((it, i) => ({ it, i, r: rank(it) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.it);
    // The menu labels one heading per run of a kind, and a runtime catalog
    // arrives alphabetically interleaved (a skill can be row 0). Partition here
    // so the panel always reads Commands → Skills, ranked within each.
    const byKind = (list: SlashItem[]): SlashItem[] => [
      ...byRank(list.filter((it) => it.kind === "command")),
      ...byRank(list.filter((it) => it.kind === "skill")),
    ];
    // CLI runtimes own their skill catalogs. Claude reports built-ins + skills
    // in its initialize ack; Codex reports skills via app-server skills/list.
    // Do not merge Cetus/pi's managed/discovered skills into either runtime:
    // seeing a skill in the menu must mean the selected runtime can invoke it.
    // Live session catalog when there is one, probed catalog otherwise.
    const catalog =
      nativeCommands.length > 0
        ? nativeCommands
        : probed.backend === backend
          ? probed.commands
          : [];
    const native: SlashItem[] = catalog.map((c) => {
      const description = c.argumentHint
        ? `${c.description} — ${c.argumentHint}`
        : c.description;
      return c.kind === "skill"
        ? {
            kind: "skill" as const,
            id: `cli:${c.name}`,
            name: c.name,
            description,
          }
        : {
            kind: "command" as const,
            id: `cli:${c.name}`,
            name: c.name,
            description,
            prompt: `/${c.name} `,
          };
    });
    if (backend === "claude-code") {
      const runtimeItems = native.length > 0 ? native : CLAUDE_CLI_COMMANDS;
      return byKind([
        ...runtimeItems.filter(match),
        ...slashCommands.filter(match),
      ]);
    }
    if (backend === "codex") {
      return byKind([
        ...CODEX_CLI_COMMANDS.filter(match),
        ...native.filter(match),
        ...slashCommands.filter(match),
      ]);
    }
    if (backend !== "pi") {
      return byKind([...native.filter(match), ...slashCommands.filter(match)]);
    }
    return byKind([
      ...slashCommands.filter(match),
      ...slashSkills.filter(match),
    ]);
  }, [slashCommands, slashSkills, slashQuery, backend, nativeCommands, probed]);

  const slashVisible = slashOpen && slashItems.length > 0;
  const slashIdx = Math.min(slashActive, slashItems.length - 1);

  function closeSlash() {
    setSlashOpen(false);
  }

  useEffect(() => {
    if (!mentionOpen) return;
    let alive = true;
    api
      .listAutomations()
      .then((rows) => alive && setMentionAutomations(rows))
      .catch(() => {});
    api
      .listConversations(true)
      .then((rows) => alive && setMentionConversations(rows))
      .catch(() => {});
    // Artifacts the agent delivered in this conversation, newest first.
    const messages = conversationId
      ? (useChatStore.getState().chats[conversationId]?.messages ?? [])
      : [];
    const seen = new Set<string>();
    const artifacts: MentionItem[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const b of messages[i].blocks) {
        if (b.kind !== "tool_use" || !b.result) continue;
        for (const a of artifactsFromDetails(b.result.details)) {
          if (seen.has(a.path)) continue;
          seen.add(a.path);
          artifacts.push({
            kind: "artifact",
            label: a.name,
            id: a.path,
            path: a.path,
            title: a.name,
            subtitle: a.caption ?? a.path,
            meta: `${a.mimeType}, ${formatBytes(a.sizeBytes)}`,
          });
        }
      }
    }
    setMentionArtifacts(artifacts);
    return () => {
      alive = false;
    };
  }, [mentionOpen, conversationId]);

  // Files: root listing (folders first) for an empty query, else a debounced
  // workspace search that includes folders. Only when the tab can show them.
  const filesWanted =
    mentionOpen && (mentionTab === "all" || mentionTab === "file");
  useEffect(() => {
    if (!filesWanted) return;
    const ws = workspaceDir || defaultWorkspace;
    if (!ws) return;
    let alive = true;
    const q = mentionQuery.trim();
    setMentionFilesLoading(true);
    const run = () =>
      (q
        ? api.searchWorkspaceFiles(ws, q, true)
        : api.listWorkspaceDirectory(ws)
      )
        .then((listing) => {
          if (!alive) return;
          setMentionFiles(listing.entries);
        })
        .catch(() => alive && setMentionFiles([]))
        .finally(() => alive && setMentionFilesLoading(false));
    const timer = window.setTimeout(run, q ? 120 : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [filesWanted, mentionQuery, workspaceDir, defaultWorkspace]);

  const mentionItems = useMemo<MentionItem[]>(() => {
    const q = mentionQuery.trim().toLowerCase();
    const hit = (...fields: (string | undefined | null)[]) =>
      !q || fields.some((f) => f?.toLowerCase().includes(q));
    const all = mentionTab === "all";
    const want = (k: MentionItem["kind"]) => all || mentionTab === k;
    const cap = (rows: MentionItem[], n: number) =>
      all ? rows.slice(0, n) : rows;
    const out: MentionItem[] = [];
    if (want("function")) {
      out.push(...FUNCTION_MENTIONS.filter((f) => hit(f.label, f.subtitle)));
    }
    if (want("automation")) {
      const rows = mentionAutomations
        .filter((a) => hit(a.name, a.prompt))
        .map<MentionItem>((a) => ({
          kind: "automation",
          label: a.name,
          id: a.id,
          title: a.name,
          subtitle: a.prompt.replace(/\s+/g, " "),
          meta: `${describeSchedule(a)}${a.enabled ? "" : ", disabled"}`,
        }));
      out.push(...cap(rows, 3));
    }
    if (want("artifact")) {
      out.push(
        ...cap(
          mentionArtifacts.filter((a) => hit(a.title, a.subtitle)),
          3,
        ),
      );
    }
    if (want("file")) {
      const rows = mentionFiles
        .filter((f) => hit(f.relativePath, f.name))
        .map<MentionItem>((f) => ({
          kind: "file",
          label: f.isDir
            ? `${f.relativePath.replace(/\/$/, "")}/`
            : f.relativePath,
          id: f.path,
          path: f.path,
          isDir: f.isDir,
          title: f.name,
          subtitle: f.relativePath,
        }));
      out.push(...cap(rows, 5));
    }
    if (want("conversation")) {
      const rows = mentionConversations
        .filter((c) => c.id !== conversationId && hit(c.title))
        .sort((a, b) => {
          const aa = a.archivedAt ? 1 : 0;
          const ba = b.archivedAt ? 1 : 0;
          return aa - ba || b.updatedAt - a.updatedAt;
        })
        .map<MentionItem>((c) => ({
          kind: "conversation",
          label: c.title,
          id: c.id,
          title: c.title,
          subtitle: c.workspaceDir.split("/").pop() || c.workspaceDir,
          archived: !!c.archivedAt,
          meta: `runtime ${c.backend || "pi"}, last updated ${new Date(c.updatedAt).toISOString()}`,
        }));
      out.push(...cap(rows, 4));
    }
    return out;
  }, [
    mentionQuery,
    mentionTab,
    mentionAutomations,
    mentionArtifacts,
    mentionFiles,
    mentionConversations,
    conversationId,
  ]);

  const mentionVisible = mentionOpen;
  const mentionIdx = Math.max(
    0,
    Math.min(mentionActive, mentionItems.length - 1),
  );

  function closeMention() {
    setMentionOpen(false);
  }

  /** Recompute the open token from the live textarea state. No-ops when the
   *  token is unchanged so arrow-nav doesn't reset the highlighted row. */
  function syncSlash() {
    if (slashSuppress.current) return;
    // In bash mode a `/` is a path separator, not a slash-command trigger.
    if (bashMode) {
      if (slashOpen) setSlashOpen(false);
      return;
    }
    const el = taRef.current;
    if (!el) return;
    const detected = detectSlashToken(el.value, el.selectionStart ?? 0);
    if (!detected) {
      if (slashOpen) setSlashOpen(false);
      return;
    }
    if (
      slashOpen &&
      detected.start === slashStart &&
      detected.query === slashQuery
    )
      return;
    setSlashStart(detected.start);
    setSlashQuery(detected.query);
    setSlashActive(0);
    setSlashOpen(true);
  }

  /** Insert text at the current caret (replacing any selection), then restore
   *  the caret after the inserted run. Used by paste when we've hijacked the
   *  event to strip out image files but still want the accompanying text. */
  function insertTextAtCaret(insert: string) {
    const el = taRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(end);
    const pos = start + insert.length;
    updateText(next);
    slashSuppress.current = false;
    mentionSuppress.current = false;
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(pos, pos);
      syncSlash();
      syncMention();
    });
  }

  /** Replace the `/<token>` with the picked item: a command expands to its
   * prompt; a skill inserts the selected runtime's explicit-invocation token. */
  function applySlash(item: SlashItem) {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    // Codex's native explicit-skill syntax is `$skill-name`; the slash menu is
    // only the discovery UI. Claude and pi expose skills as `/skill-name`.
    const insert =
      item.kind === "command"
        ? item.prompt
        : backend === "codex"
          ? `$${item.name} `
          : `/${item.name} `;
    const next = text.slice(0, slashStart) + insert + text.slice(caret);
    const pos = slashStart + insert.length;
    updateText(next);
    closeSlash();
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(pos, pos);
    });
  }

  /** Mirror of {@link syncSlash} for the `@`-mention token. */
  function syncMention() {
    if (mentionSuppress.current) return;
    // In bash mode `@` is just a shell character (paths, git refs), not a trigger.
    if (bashMode) {
      if (mentionOpen) setMentionOpen(false);
      return;
    }
    const el = taRef.current;
    if (!el) return;
    const detected = detectMentionToken(el.value, el.selectionStart ?? 0);
    if (!detected) {
      if (mentionOpen) setMentionOpen(false);
      return;
    }
    if (
      mentionOpen &&
      detected.start === mentionStart &&
      detected.query === mentionQuery
    )
      return;
    setMentionStart(detected.start);
    setMentionQuery(detected.query);
    setMentionActive(0);
    setMentionOpen(true);
  }

  /** Replace the `@<token>` with the picked item's `@label ` token and record
   *  what the label points at. The token is resolved for the model at send
   *  time (see {@link buildMentionRefs}); in the textarea it stays `@label`. */
  function applyMention(item: MentionItem | undefined) {
    if (!item) return;
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const {
      title: _title,
      subtitle: _subtitle,
      archived: _archived,
      ...base
    } = item;
    const label = uniqueLabel(item.label, mentionRefs, base);
    const ref: MentionRef = { ...base, label };
    rememberRef(ref);
    updateMentionRefs((prev) =>
      prev.some((r) => r.label === label) ? prev : [...prev, ref],
    );
    const insert = `${mentionToken(label)} `;
    const next = text.slice(0, mentionStart) + insert + text.slice(caret);
    const pos = mentionStart + insert.length;
    updateText(next);
    closeMention();
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(pos, pos);
    });
  }

  // Layout effect so the remeasure happens before paint. Collapsing to "auto"
  // zeroes scrollTop, which makes an overflowing textarea jump on every IME
  // composition update — restore it after the height is reapplied.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    el.style.height = "auto";
    el.style.height =
      Math.min(el.scrollHeight, variant === "hero" ? 320 : 240) + "px";
    el.scrollTop = scrollTop;
    if (highlightRef.current) highlightRef.current.scrollTop = el.scrollTop;
  }, [text, variant]);

  useEffect(() => {
    // preventScroll: after a send/steer the textarea often doesn't have focus
    // yet (e.g. the user clicked "Steer now"), so this is a real focus change.
    // Without preventScroll the browser scrolls the focused textarea into view,
    // which yanks the message list — the steer-jumps-to-top bug.
    if (focusToken !== undefined && !disabled)
      taRef.current?.focus({ preventScroll: true });
  }, [focusToken, disabled]);

  useEffect(() => {
    if (!quoteRequest || quoteRequest.id === lastQuoteIdRef.current) return;
    lastQuoteIdRef.current = quoteRequest.id;
    const cleaned = cleanQuoteText(quoteRequest.text);
    if (!cleaned) return;
    // A new selection replaces the pending one — one quote bar at a time.
    updateQuote(cleaned);
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node || disabled) return;
      node.focus({ preventScroll: true });
      const pos = node.value.length;
      node.setSelectionRange(pos, pos);
    });
  }, [disabled, quoteRequest, updateQuote]);

  useEffect(() => {
    if (!draftRequest || draftRequest.id === lastDraftRequestIdRef.current)
      return;
    lastDraftRequestIdRef.current = draftRequest.id;
    // A queued message comes back with its mention block already appended;
    // peel it off and re-arm the pills from this session's ref cache.
    const { text: prose, labels } = extractMentionRefs(draftRequest.text);
    updateMentionRefs(recallRefs(labels));
    const quoted = splitLeadingQuote(prose);
    updateQuote(quoted?.quote ?? "");
    updateText(quoted?.text ?? prose);
    updateAttachments((previous) => {
      previous.forEach((attachment) => {
        if (
          attachment.type === "image" &&
          attachment.previewUrl.startsWith("blob:")
        ) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      return draftRequest.attachments.map((attachment) =>
        attachment.type === "image"
          ? {
              ...attachment,
              // The original object URL is revoked when the message is queued.
              // A data URL gives the composer a durable thumbnail while editing.
              previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
            }
          : attachment,
      );
    });
    setAttachError(null);
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node || disabled) return;
      node.focus({ preventScroll: true });
      const pos = node.value.length;
      node.setSelectionRange(pos, pos);
    });
  }, [
    disabled,
    draftRequest,
    updateAttachments,
    updateText,
    updateMentionRefs,
    updateQuote,
  ]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.isComposing ||
        !FOCUS_TRIGGER_CHARS.has(e.key) ||
        isEditableTarget(e.target)
      ) {
        return;
      }

      const root = rootRef.current;
      const el = taRef.current;
      if (!root || !el) return;
      const openDialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role='dialog'][data-state='open']",
        ),
      );
      const topDialog = openDialogs.at(-1);
      if (topDialog && !topDialog.contains(root)) return;
      if (!topDialog && root.closest("[role='dialog']")) return;

      e.preventDefault();
      slashSuppress.current = false;
      mentionSuppress.current = false;
      requestAnimationFrame(() => {
        el.focus({ preventScroll: true });
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled]);

  // Revoke preview URLs on unmount so we don't leak object URLs.
  useEffect(() => {
    return () => {
      attachments.forEach(
        (a) => a.type === "image" && URL.revokeObjectURL(a.previewUrl),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Add dropped/pasted/picked files as attachments. `pathHints` maps a file's
   *  name to its real on-disk path (from a Finder copy); when a file is too big
   *  to inline, we reference that path in the message instead of skipping it —
   *  graceful degradation matching how a terminal agent takes a pasted path. */
  async function addFiles(
    files: FileList | File[],
    pathHints?: Map<string, string>,
  ) {
    setAttachError(null);
    const next: ComposerAttachment[] = [];
    const referenced: string[] = [];
    let tooLarge: string | null = null;
    for (const f of Array.from(files)) {
      const isImage = f.type.startsWith("image/");
      if (!isImage && f.size > MAX_FILE_BYTES) {
        const realPath = pathHints?.get(f.name);
        if (realPath) {
          referenced.push(realPath);
        } else {
          tooLarge = t("composer.fileTooLarge", {
            name: f.name || t("composer.unnamedFile"),
            limit: Math.round(MAX_FILE_BYTES / 1024 / 1024),
          });
        }
        continue;
      }
      try {
        if (isImage) {
          const image = await prepareImageAttachment(f);
          next.push({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
            name: f.name || t("composer.pastedImageName"),
            previewUrl: URL.createObjectURL(image.previewBlob),
          });
        } else {
          const data = await fileToBase64(f);
          next.push({
            type: "file",
            data,
            mimeType: f.type || "application/octet-stream",
            name: f.name || t("composer.unnamedFile"),
            sizeBytes: f.size,
          });
        }
      } catch (e) {
        // WebKit hands us unreadable `File`s for pasted folders and
        // not-yet-downloaded iCloud items (NotFoundError on read). When the
        // pasteboard carried a real path, reference it in the draft instead of
        // erroring — the agent reads it off disk, same as a dropped folder.
        const realPath = pathHints?.get(f.name);
        if (realPath) referenced.push(realPath);
        else setAttachError(String(e));
      }
    }
    if (next.length) updateAttachments((prev) => [...prev, ...next]);
    if (referenced.length) insertPaths(referenced);
    // Only surface the size error when nothing salvaged the file by path.
    if (tooLarge) setAttachError(tooLarge);
  }

  /** Drop one or more absolute paths into the composer at the caret, each on its
   *  own line and separated from surrounding text, so the agent can read the
   *  files from disk without us inlining their bytes. */
  function insertPaths(paths: string[]) {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const needsLead = before.length > 0 && !/\s$/.test(before);
    insertTextAtCaret((needsLead ? "\n" : "") + paths.join("\n") + " ");
  }

  useEffect(() => {
    const onInsertFilePaths = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      if (!Array.isArray(paths) || paths.length === 0) return;
      insertPaths(paths);
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("cetus-insert-file-paths", onInsertFilePaths);
    return () =>
      window.removeEventListener("cetus-insert-file-paths", onInsertFilePaths);
    // insertPaths intentionally tracks the current draft/caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  /** Attach files dropped anywhere in the window. A drop hands us paths rather
   *  than bytes, so read them into `File`s and reuse the paste/file-picker
   *  pipeline; folders and anything too big to inline get named in the draft
   *  instead, which is what the agent needs to open them off disk anyway. */
  async function addPaths(paths: string[]) {
    const { files, hints, referenced } = await readDroppedFiles(
      paths,
      MAX_FILE_BYTES,
    );
    if (files.length) await addFiles(files, hints);
    if (referenced.length) insertPaths(referenced);
  }

  // Drops are delivered by FileDropHost as events on this composer's root.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFileDrag = (event: Event) =>
      setIsDragging((event as CustomEvent<boolean>).detail);
    const onFileDrop = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      setIsDragging(false);
      if (Array.isArray(paths) && paths.length) void addPaths(paths);
    };
    root.addEventListener(FILE_DRAG_EVENT, onFileDrag);
    root.addEventListener(FILE_DROP_EVENT, onFileDrop);
    return () => {
      root.removeEventListener(FILE_DRAG_EVENT, onFileDrag);
      root.removeEventListener(FILE_DROP_EVENT, onFileDrop);
    };
    // addPaths → insertPaths reads the live draft and caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function removeAttachment(i: number) {
    const removed = attachments[i];
    if (removed?.type === "image" && previewImage === removed)
      setPreviewImage(null);
    updateAttachments((prev) => {
      const dropped = prev[i];
      if (dropped?.type === "image") URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  async function submit() {
    if (disabled) return;
    // Terminal mode: hand the command to the right-side Terminal surface and
    // bypass the agent entirely. An empty command (`!` alone) is a no-op.
    if (bashMode) {
      if (!bashCommand || !onBash) return;
      onBash(bashCommand);
      closeSlash();
      updateText("");
      setAttachError(null);
      return;
    }
    const trimmedText = text.trim();
    if (backend === "codex" && attachments.length === 0) {
      if (trimmedText === "/status") {
        const model = conversationId
          ? cliTuning.model
          : (pendingCliModel ?? "");
        const effort = conversationId
          ? cliTuning.effort
          : (pendingCliEffort ?? "");
        const context = contextUsage?.contextWindow
          ? `${Math.round((contextUsage.usedTokens / contextUsage.contextWindow) * 100)}% (${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens)`
          : "Not available until the first turn";
        const quota =
          codexRateLimit?.utilization !== undefined
            ? [
                `${Math.round(codexRateLimit.utilization * 100)}% used`,
                codexRateLimit.resetsAt
                  ? `resets ${new Date(codexRateLimit.resetsAt * 1000).toLocaleString()}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Not available yet";
        toast.info("Codex status", {
          description: (
            <div className="space-y-0.5">
              <div className="break-all">
                Chat: {conversationId ?? "New chat"}
              </div>
              <div>
                Model: {model || "Default"} · Reasoning: {effort || "Default"}
              </div>
              <div>Context: {context}</div>
              <div>Rate limit: {quota}</div>
            </div>
          ),
          duration: 8000,
        });
        closeSlash();
        updateText("");
        return;
      }
      if (trimmedText === "/model" || trimmedText === "/reasoning") {
        closeSlash();
        updateText("");
        setCliTuningOpen(true);
        return;
      }
    }
    // Mentions stay in the prose as `@label` tokens; a machine block appended
    // below resolves each for the model (and is stripped from the bubble).
    // A draft that is nothing but tokens (a bare `@goal`) has no objective and
    // is treated as empty.
    const used = mentionsInText(trimmedText, mentionRefs);
    const prose = textWithoutMentions(trimmedText, used);
    let outgoing = prose || attachments.length > 0 ? trimmedText : "";
    if (outgoing && used.length > 0) {
      const resolutions = new Map<string, MentionResolution>();
      for (const ref of used) {
        if (ref.kind !== "conversation") continue;
        try {
          const exported = await api.exportConversationTranscript(ref.id);
          resolutions.set(ref.label, { transcriptPath: exported.path });
        } catch (e) {
          console.warn("[mention] transcript export failed", ref.id, e);
        }
      }
      outgoing += buildMentionRefs(used, resolutions);
    }
    // Pending quote leads the message as a Markdown blockquote — the bubble
    // renderer splits it back out into the quote header above the bubble.
    const quoteMarkdown = quote ? formatQuoteMarkdown(quote) : "";
    if (quoteMarkdown)
      outgoing = outgoing ? `${quoteMarkdown}\n\n${outgoing}` : quoteMarkdown;
    if (!outgoing && attachments.length === 0) {
      // Only a truly blank draft triggers the queue shortcut. A visible token
      // that happens to expand to nothing should remain a no-op.
      if (!trimmedText) onSendFirstQueued?.();
      return;
    }
    // Lead with the rolling ambient-context fence when the chip is on. Captured
    // at compose time — "what I was looking at when I wrote this" — so a queued
    // message keeps the context of its writing moment. Best-effort: a failed
    // fetch sends the bare prompt.
    if (ambientOn && ambientAvailable && outgoing) {
      try {
        outgoing = composeWithAmbient(
          outgoing,
          await api.ambientRecentSummary(),
        );
      } catch {
        // bare prompt
      }
    }
    // Mid-run: park the message in the follow-up queue instead of sending. The
    // user can still promote it to a steer from the queue UI. Falls back to a
    // direct send (immediate steer) when no queue handler is wired.
    const runtime = runtimeReady
      ? {
          backend,
          cliModel: conversationId ? cliTuning.model : (pendingCliModel ?? ""),
          cliEffort: conversationId
            ? cliTuning.effort
            : (pendingCliEffort ?? ""),
        }
      : undefined;
    if (streaming && onQueue) onQueue(outgoing, attachments, runtime);
    else onSend(outgoing, attachments, runtime);
    setPreviewImage(null);
    closeSlash();
    closeMention();
    // Drop refs to revoke after send completes — onSend may consume async.
    updateAttachments((prev) => {
      prev.forEach(
        (a) => a.type === "image" && URL.revokeObjectURL(a.previewUrl),
      );
      return [];
    });
    updateText("");
    updateQuote("");
    updateMentionRefs([]);
    setAttachError(null);
  }
  return renderComposer({
    rootRef,
    streaming,
    bashMode,
    backend,
    isDragging,
    variant,
    t,
    slashVisible,
    slashItems,
    slashIdx,
    applySlash,
    setSlashActive,
    setEditingCommand,
    setNewCommandSeed,
    slashQuery,
    setCommandDialogOpen,
    closeSlash,
    commandDialogOpen,
    editingCommand,
    newCommandSeed,
    slashStart,
    text,
    updateText,
    taRef,
    slashSuppress,
    setSlashOpen,
    mentionVisible,
    mentionTab,
    setMentionTab,
    setMentionActive,
    mentionItems,
    mentionIdx,
    filesWanted,
    mentionFilesLoading,
    applyMention,
    quote,
    updateQuote,
    attachments,
    setPreviewImage,
    removeAttachment,
    previewImage,
    highlightRef,
    mentionLabels,
    mentionSuppress,
    syncSlash,
    syncMention,
    addFiles,
    insertTextAtCaret,
    mentionRefs,
    closeMention,
    onRequestBackendSwitch,
    runtimeEntries,
    enabledBackendIds,
    conversationId,
    cliTuning,
    pendingCliModel,
    pendingCliEffort,
    submit,
    withFocusHint,
    placeholder,
    onQueue,
    heroPlaceholder,
    disabled,
    attachError,
    fileInputRef,
    workspaceDir,
    defaultWorkspace,
    onWorkspaceChange,
    pendingBackend,
    onPendingTuningChange,
    backendSwitch,
    cliTuningOpen,
    setCliTuningOpen,
    onRuntimeTuningChange,
    setBackend,
    setRuntimeReady,
    onPendingBackendChange,
    modelChoice,
    onModelChange,
    ambientAvailable,
    toggleAmbient,
    ambientOn,
    bashCommand,
    onAbort,
  });
}
