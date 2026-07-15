"use client";
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { ArrowUp, Square, Paperclip, X, File, Terminal, Radar } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/artifact";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/chat/model-picker";
import { BackendPicker, nextBackend } from "@/components/chat/backend-picker";
import { useCliCommands } from "@/lib/chat-store";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { SlashMenu, type SlashItem } from "@/components/chat/slash-menu";
import { MentionMenu } from "@/components/chat/mention-menu";
import { MENTIONS, expandGoalDirective } from "@/lib/goal";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { flavorHeroPlaceholder } from "@/lib/chat-flavor";
import { api } from "@/lib/tauri";
import { composeWithAmbient } from "@/lib/quick-context";
import {
  readDraft,
  readDraftAttachments,
  writeDraft,
  writeDraftAttachments,
} from "@/lib/draft-store";
import type { BackendId, ModelChoice } from "@/lib/types";

function GitBranchIndicator({
  conversationId,
  workspaceDir,
  defaultWorkspace,
  streaming,
}: {
  conversationId: string | null;
  workspaceDir: string | null;
  defaultWorkspace: string;
  streaming: boolean;
}) {
  const { t } = useTranslation("chat");
  const [git, setGit] = useState<{ branch: string; path: string; worktree: boolean } | null>(null);
  const workspace = workspaceDir ?? defaultWorkspace;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        if (conversationId) {
          const worktree = await api.conversationWorktree(conversationId);
          if (worktree?.exists) {
            if (!cancelled) setGit({ branch: worktree.branch, path: worktree.path, worktree: true });
            return;
          }
        }
        const branch = workspace ? await api.workspaceGitBranch(workspace) : null;
        if (!cancelled) setGit(branch ? { branch, path: workspace, worktree: false } : null);
      } catch {
        if (!cancelled) setGit(null);
      }
    };
    void refresh();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // Branches can also be switched from Cetus's terminal, which does not
    // blur/refocus the app window. Keep the small label honest without polling
    // while the app is in the background.
    const poll = window.setInterval(refreshVisible, 5_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [conversationId, workspace, streaming]);

  if (!git) return null;
  const content = (
    <>
      <span className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        git /
      </span>
      <span className="max-w-28 truncate">{git.branch}</span>
    </>
  );
  return git.worktree ? (
    <button
      type="button"
      onClick={() => api.openPath(git.path).catch(() => {})}
      title={t("pane.worktree.tooltip", { path: git.path })}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {content}
    </button>
  ) : (
    <span
      title={`${git.branch}\n${git.path}`}
      className="inline-flex h-7 items-center gap-1.5 px-1 text-xs text-muted-foreground"
    >
      {content}
    </span>
  );
}

/** Walk back from the caret to find an open `/<token>` the user is typing: a `/`
 *  at line start or after whitespace, with no whitespace between it and the
 *  caret. Returns the slash index + the text after it, or null when the caret
 *  isn't inside such a token. */
function detectSlashToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "/") break;
    if (/\s/.test(ch)) return null; // hit whitespace before a slash → not a token
    i--;
  }
  if (i < 0 || value[i] !== "/") return null;
  const before = i > 0 ? value[i - 1] : "";
  if (before && !/\s/.test(before)) return null; // `/` must start a word
  return { start: i, query: value.slice(i + 1, caret) };
}

/** Same walk-back as {@link detectSlashToken} but for an open `@<token>`: an `@`
 *  at line start or after whitespace, with no whitespace up to the caret. Powers
 *  the `@`-mention menu (`@goal`). */
function detectMentionToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") break;
    if (/\s/.test(ch)) return null; // hit whitespace before an `@` → not a token
    i--;
  }
  if (i < 0 || value[i] !== "@") return null;
  const before = i > 0 ? value[i - 1] : "";
  if (before && !/\s/.test(before)) return null; // `@` must start a word (not an email)
  return { start: i, query: value.slice(i + 1, caret) };
}

/** A composer attachment. Images ride pi's `images` channel (→ vision-bridge);
 *  every other file is written to disk and read by the agent via read_document. */
export type ComposerAttachment = ImageAttachment | FileAttachment;

/** A message parked in the follow-up queue while the agent is mid-run. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
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
  /** Require a real repository instead of the repository-free Chat workspace. */
  requireRepository?: boolean;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  /** Called instead of onSend when the agent is mid-run: the message is parked
   *  in a follow-up queue (shown above the composer) and delivered when the run
   *  ends, unless the user promotes it to a steer. Omit to fall back to onSend
   *  (immediate steer) while streaming. */
  onQueue?: (text: string, attachments: ComposerAttachment[]) => void;
  /** Send the first queued follow-up when Enter is pressed with an otherwise
   *  empty composer. Omit when there is no queued message to send. */
  onSendFirstQueued?: () => void;
  /** Send a shell command to the Terminal surface (the `!` mode). Receives the
   *  command with the leading `!` already stripped. Omit to disable this mode
   *  (the `!` is then just a normal character). */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Ultra Code state + toggle. When provided, the model picker exposes an
   *  "UltraCode" preset so the user enables/disables autonomous orchestration at
   *  the input (not buried in settings). Omit both to hide it. */
  ultra?: boolean;
  onUltraToggle?: () => void;
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
  backendSwitch?: { token: number; backend: BackendId } | null;
  /** Request cycling to a specific runtime (Tab in the composer). Routes back
   *  through the parent's token machinery so BackendPicker applies it. */
  onRequestBackendSwitch?: (backend: BackendId) => void;
}

/** Claude Code built-in slash commands that work headless (verified against
 *  CLI 2.1.199: handled locally, zero model tokens; /status, /model etc. are
 *  TUI-only and refuse in -p mode). Offered in the slash menu for claude-code
 *  conversations; the picked token is passed through to the CLI verbatim. */
const CLAUDE_CLI_COMMANDS: SlashItem[] = [
  {
    kind: "command",
    id: "cli:usage",
    name: "usage",
    description: "Claude subscription usage and limits",
    prompt: "/usage ",
  },
  {
    kind: "command",
    id: "cli:cost",
    name: "cost",
    description: "Token spend and usage for this session",
    prompt: "/cost ",
  },
  {
    kind: "command",
    id: "cli:context",
    name: "context",
    description: "Context window usage breakdown",
    prompt: "/context ",
  },
  {
    kind: "command",
    id: "cli:compact",
    name: "compact",
    description: "Compact conversation history to free up context",
    prompt: "/compact ",
  },
];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — Gemini limit is generous but base64 inflates 33%
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — docx/xlsx/pdf etc., read on disk by the agent
const FOCUS_TRIGGER_CHARS = new Set(["/", "、", "／"]);

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
  requireRepository = false,
  onSend,
  onQueue,
  onSendFirstQueued,
  onBash,
  onAbort,
  ultra,
  onUltraToggle,
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
    setText(draftKey ? readDraft(draftKey) : "");
    setAttachments(restoreAttachments(draftKey));
  }, [draftKey, restoreAttachments]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() =>
    restoreAttachments(draftKey),
  );

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
  const [slashCommands, setSlashCommands] = useState<SlashItem[]>([]);
  const [slashSkills, setSlashSkills] = useState<SlashItem[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashStart, setSlashStart] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  // Set when the user dismisses with Esc; cleared on the next edit so the menu
  // stays closed for the current token but a later `/` reopens it.
  const slashSuppress = useRef(false);

  // ---- @-mention menu (goal, …) -------------------------------------------
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionActive, setMentionActive] = useState(0);
  const mentionSuppress = useRef(false);
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
        const [commands, skillState, discovered] = await Promise.all([
          api.listSlashCommands(),
          api.listSkills(),
          api.listDiscoveredSkills(),
        ]);
        if (!alive) return;
        setSlashCommands(
          commands.map((c) => ({
            kind: "command",
            id: c.id,
            name: c.name,
            description: c.description,
            prompt: c.prompt,
          })),
        );
        const libs = skillState.enabled ? skillState.entries.filter((e) => e.enabled) : [];
        const seen = new Set<string>();
        const skills: SlashItem[] = [];
        for (const s of [...libs, ...discovered]) {
          const key = s.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          skills.push({ kind: "skill", id: s.id, name: s.name, description: s.description });
        }
        setSlashSkills(skills);
      } catch {
        // Slash menu is a convenience — a load failure just leaves it empty.
      }
    })();
    return () => {
      alive = false;
    };
  }, [slashOpen]);

  const slashItems = useMemo(() => {
    const q = slashQuery.toLowerCase();
    const match = (it: SlashItem) =>
      it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q);
    // Runtime built-ins first: on claude-code they're what /-muscle-memory
    // from the native CLI reaches for. Prefer the catalog the session itself
    // reported on boot (initialize ack — /usage, /compact, /context, /model …);
    // the hardcoded snapshot only covers conversations whose session hasn't
    // spawned yet. Skills ride the catalog too, suffixed "(user)"/"(project)"
    // — dropped here since the menu already lists them from its own sources.
    const skillNames = new Set(slashSkills.map((s) => s.name.toLowerCase()));
    const native: SlashItem[] = nativeCommands
      .filter((c) => !/\((?:user|project|plugin|builtin)\)\s*$/.test(c.description))
      .filter((c) => !skillNames.has(c.name.toLowerCase()))
      .map((c) => ({
        kind: "command",
        id: `cli:${c.name}`,
        name: c.name,
        description: c.argumentHint
          ? `${c.description} — ${c.argumentHint}`
          : c.description,
        prompt: `/${c.name} `,
      }));
    const builtins =
      backend === "claude-code"
        ? (native.length > 0 ? native : CLAUDE_CLI_COMMANDS).filter(match)
        : [];
    return [...builtins, ...slashCommands.filter(match), ...slashSkills.filter(match)];
  }, [slashCommands, slashSkills, slashQuery, backend, nativeCommands]);

  const slashVisible = slashOpen && slashItems.length > 0;
  const slashIdx = Math.min(slashActive, slashItems.length - 1);

  function closeSlash() {
    setSlashOpen(false);
  }

  const mentionItems = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return MENTIONS.filter(
      (it) => it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
    );
  }, [mentionQuery]);

  const mentionVisible = mentionOpen && mentionItems.length > 0;
  const mentionIdx = Math.min(mentionActive, mentionItems.length - 1);

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
    if (slashOpen && detected.start === slashStart && detected.query === slashQuery) return;
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
   *  prompt; a skill inserts its `/name ` token verbatim. */
  function applySlash(item: SlashItem) {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = item.kind === "command" ? item.prompt : `/${item.name} `;
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
    if (mentionOpen && detected.start === mentionStart && detected.query === mentionQuery) return;
    setMentionStart(detected.start);
    setMentionQuery(detected.query);
    setMentionActive(0);
    setMentionOpen(true);
  }

  /** Replace the `@<token>` with the picked mention's `@name ` token. The token
   *  is expanded into its full directive at send time (see {@link expandGoalDirective}). */
  function applyMention(item: (typeof MENTIONS)[number]) {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${item.name} `;
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
    el.style.height = Math.min(el.scrollHeight, variant === "hero" ? 320 : 240) + "px";
    el.scrollTop = scrollTop;
  }, [text, variant]);

  useEffect(() => {
    // preventScroll: after a send/steer the textarea often doesn't have focus
    // yet (e.g. the user clicked "Steer now"), so this is a real focus change.
    // Without preventScroll the browser scrolls the focused textarea into view,
    // which yanks the message list — the steer-jumps-to-top bug.
    if (focusToken !== undefined && !disabled) taRef.current?.focus({ preventScroll: true });
  }, [focusToken, disabled]);

  useEffect(() => {
    if (!quoteRequest || quoteRequest.id === lastQuoteIdRef.current) return;
    lastQuoteIdRef.current = quoteRequest.id;
    const quote = formatQuoteForComposer(quoteRequest.text);
    if (!quote) return;
    setText((prev) => {
      const trimmed = prev.trimEnd();
      const next = `${trimmed ? `${trimmed}\n\n` : ""}${quote}\n\n`;
      if (draftKey) writeDraft(draftKey, next);
      return next;
    });
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node || disabled) return;
      node.focus({ preventScroll: true });
      const pos = node.value.length;
      node.setSelectionRange(pos, pos);
    });
  }, [disabled, draftKey, quoteRequest]);

  useEffect(() => {
    if (!draftRequest || draftRequest.id === lastDraftRequestIdRef.current) return;
    lastDraftRequestIdRef.current = draftRequest.id;
    updateText(draftRequest.text);
    updateAttachments((previous) => {
      previous.forEach((attachment) => {
        if (attachment.type === "image" && attachment.previewUrl.startsWith("blob:")) {
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
  }, [disabled, draftRequest, updateAttachments, updateText]);

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
        document.querySelectorAll<HTMLElement>("[role='dialog'][data-state='open']"),
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
      attachments.forEach((a) => a.type === "image" && URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Add dropped/pasted/picked files as attachments. `pathHints` maps a file's
   *  name to its real on-disk path (from a Finder copy); when a file is too big
   *  to inline, we reference that path in the message instead of skipping it —
   *  graceful degradation matching how a terminal agent takes a pasted path. */
  async function addFiles(files: FileList | File[], pathHints?: Map<string, string>) {
    setAttachError(null);
    const next: ComposerAttachment[] = [];
    const referenced: string[] = [];
    let tooLarge: string | null = null;
    for (const f of Array.from(files)) {
      const isImage = f.type.startsWith("image/");
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (f.size > limit) {
        const realPath = pathHints?.get(f.name);
        if (realPath) {
          referenced.push(realPath);
        } else {
          tooLarge = t("composer.fileTooLarge", {
            name: f.name || t("composer.unnamedFile"),
            limit: Math.round(limit / 1024 / 1024),
          });
        }
        continue;
      }
      try {
        const data = await fileToBase64(f);
        if (isImage) {
          next.push({
            type: "image",
            data,
            mimeType: f.type,
            name: f.name || t("composer.pastedImageName"),
            previewUrl: URL.createObjectURL(f),
          });
        } else {
          next.push({
            type: "file",
            data,
            mimeType: f.type || "application/octet-stream",
            name: f.name || t("composer.unnamedFile"),
            sizeBytes: f.size,
          });
        }
      } catch (e) {
        setAttachError(String(e));
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

  function removeAttachment(i: number) {
    updateAttachments((prev) => {
      const dropped = prev[i];
      if (dropped?.type === "image") URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  async function submit() {
    if (disabled) return;
    if (requireRepository && (!workspaceDir || workspaceDir === defaultWorkspace)) return;
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
    // Expand any `@goal` token into its full directive before sending. Empty
    // when the user typed only `@goal` with no objective — treated as no message.
    const trimmedText = text.trim();
    let outgoing = expandGoalDirective(trimmedText);
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
        outgoing = composeWithAmbient(outgoing, await api.ambientRecentSummary());
      } catch {
        // bare prompt
      }
    }
    // Mid-run: park the message in the follow-up queue instead of sending. The
    // user can still promote it to a steer from the queue UI. Falls back to a
    // direct send (immediate steer) when no queue handler is wired.
    if (streaming && onQueue) onQueue(outgoing, attachments);
    else onSend(outgoing, attachments);
    closeSlash();
    closeMention();
    // Drop refs to revoke after send completes — onSend may consume async.
    updateAttachments((prev) => {
      prev.forEach((a) => a.type === "image" && URL.revokeObjectURL(a.previewUrl));
      return [];
    });
    updateText("");
    setAttachError(null);
  }

  return (
    <div
      ref={rootRef}
      data-chat-composer
      data-streaming={streaming && !bashMode ? "true" : undefined}
      data-backend={backend}
      onDragOver={(e) => {
        // Hijack drag enter only when files are involved — text-from-textarea
        // drags would otherwise highlight the drop zone too.
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setIsDragging(true);
        }
      }}
      onDragLeave={(e) => {
        // Fires for every nested child enter/leave too; only clear when leaving
        // the composer entirely.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsDragging(false);
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }
      }}
      className={cn(
        "relative rounded-2xl border border-border",
        // Soft, wide, low-opacity shadow (large blur, ~6% alpha) for a premium
        // subtle lift rather than a hard drop shadow. Constant across focus.
        // Matches the layered-shadow convention used by artifact cards.
        "shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]",
        isDragging && "ring-2 ring-primary ring-offset-2",
        // Bash mode: tint the frame so it's unmistakably "running a command",
        // not "messaging the agent".
        bashMode && "border-primary/60 ring-1 ring-primary/40",
        // CLI backends tint the frame so it's obvious at a glance which
        // runtime the next message runs on: Claude Code gets Anthropic's
        // clay orange, Codex a teal. Bash mode's tint wins while active.
        !bashMode &&
          backend === "claude-code" &&
          "border-[#d97757]/60 dark:border-[#d97757]/50",
        !bashMode &&
          backend === "codex" &&
          "border-[#10a37f]/60 dark:border-[#10a37f]/50",
        variant === "hero" ? "bg-card p-2" : "bg-card p-1.5",
      )}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 text-xs font-medium text-primary">
          {t("composer.dropFiles")}
        </div>
      )}

      {slashVisible && (
        <SlashMenu
          items={slashItems}
          activeIndex={slashIdx}
          onSelect={applySlash}
          onHover={setSlashActive}
        />
      )}

      {mentionVisible && !slashVisible && (
        <MentionMenu
          items={mentionItems}
          activeIndex={mentionIdx}
          onSelect={applyMention}
          onHover={setMentionActive}
        />
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1.5 pb-1.5 pt-1">
          {attachments.map((a, i) => (
            <div key={i} className="group relative">
              {a.type === "image" ? (
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  title={a.name}
                  className="size-14 rounded-md border border-border object-cover"
                />
              ) : (
                <div
                  title={a.name}
                  className="flex h-14 max-w-44 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5"
                >
                  <File className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{a.name}</div>
                    <div className="text-[10px] text-muted-foreground">{formatBytes(a.sizeBytes)}</div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("composer.removeAttachment", { name: a.name })}
              >
                <X className="size-3.5 p-0.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {bashMode && (
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[11px] font-medium text-primary">
          <Terminal className="size-3" />
          <span>{t("composer.bashHint")}</span>
        </div>
      )}

      <Textarea
        ref={taRef}
        value={text}
        onChange={(e) => {
          slashSuppress.current = false; // a fresh edit re-arms the menu
          mentionSuppress.current = false;
          updateText(e.target.value);
          syncSlash();
          syncMention();
        }}
        onClick={() => {
          syncSlash();
          syncMention();
        }}
        onKeyUp={(e) => {
          // Re-detect on caret moves (arrows/home/end/click); typing is already
          // covered by onChange. Skip keys the slash/mention-nav handler consumes.
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
          syncSlash();
          syncMention();
        }}
        onPaste={(e) => {
          const files: File[] = [];
          for (const item of Array.from(e.clipboardData?.items ?? [])) {
            if (item.kind === "file") {
              const f = item.getAsFile();
              if (f) files.push(f);
            }
          }
          // No files → let the browser paste text normally.
          if (!files.length) return;
          // Mixed paste (image + text): hijack the event so the images become
          // attachments, but don't drop the accompanying text — insert it at
          // the caret ourselves since preventDefault cancels the native paste.
          e.preventDefault();
          // A Finder file copy carries the real path on the pasteboard; resolve
          // it first so addFiles can reference a too-large file by path instead
          // of skipping it. Best-effort — falls back to the byte path on any
          // failure or off macOS.
          api
            .readClipboardFilePaths()
            .then((paths) => {
              const hints = new Map<string, string>();
              for (const p of paths) {
                const base = p.split("/").pop();
                if (base) hints.set(base, p);
              }
              return addFiles(files, hints);
            })
            .catch(() => addFiles(files));
          const pastedText = e.clipboardData?.getData("text/plain") ?? "";
          if (pastedText) insertTextAtCaret(pastedText);
        }}
        onKeyDown={(e) => {
          const composing = e.nativeEvent.isComposing || e.keyCode === 229;
          // Slash menu owns the navigation keys while it's open. Guard against
          // IME composition so candidate selection isn't stolen.
          if (slashVisible && !composing) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSlashActive((i) => (i + 1) % slashItems.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSlashActive((i) => (i - 1 + slashItems.length) % slashItems.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              applySlash(slashItems[slashIdx]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              slashSuppress.current = true;
              closeSlash();
              return;
            }
          }
          // The @-mention menu owns the same nav keys when it's open (and the
          // slash menu isn't — they're mutually exclusive per caret token).
          if (mentionVisible && !slashVisible && !composing) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionActive((i) => (i + 1) % mentionItems.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionActive((i) => (i - 1 + mentionItems.length) % mentionItems.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              applyMention(mentionItems[mentionIdx]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              mentionSuppress.current = true;
              closeMention();
              return;
            }
          }
          // Tab cycles the runtime (Cetus → Claude Code → Codex), matching the
          // quick launcher and the task dialog. The slash menu above already
          // consumed Tab when open, so here it's free to repurpose. Only a bare
          // Tab, though — Ctrl/Cmd+Tab must fall through to the window handler
          // (Ctrl+Tab = switch to previous view) instead of being swallowed here.
          if (
            e.key === "Tab" &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !composing &&
            onRequestBackendSwitch
          ) {
            e.preventDefault();
            onRequestBackendSwitch(nextBackend(backend));
            return;
          }
          // Don't intercept Enter while an IME is composing — Chinese / Japanese
          // / Korean users press Enter to commit candidates, and a naive check
          // would steal that keystroke and send a half-typed prompt.
          // `nativeEvent.isComposing` is the spec; `keyCode === 229` is the
          // legacy fallback for browsers that drop isComposing during commit.
          if (e.key === "Enter" && !e.shiftKey) {
            if (composing) return;
            e.preventDefault();
            submit();
          }
        }}
        placeholder={
          bashMode
            ? t("composer.bashPlaceholder")
            : withFocusHint(
                placeholder ??
                  (streaming
                    ? onQueue
                      ? t("composer.placeholderQueue")
                      : t("composer.placeholderRunning")
                    : variant === "hero"
                      ? heroPlaceholder
                      : t("composer.placeholderDocked")),
              )
        }
        rows={1}
        disabled={disabled}
        className={cn(
          "min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
          variant === "hero" ? "px-3 py-3 text-base" : "px-2.5 py-2 text-sm",
        )}
      />
      {attachError && (
        <div className="px-2 pb-1 text-[11px] text-destructive">{attachError}</div>
      )}
      <div className="flex items-center justify-between gap-2 px-1 pb-1 pt-0.5">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title={t("composer.attachFile")}
          >
            <Paperclip className="size-3 text-muted-foreground" />
          </Button>
          <WorkspacePicker
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onChange={onWorkspaceChange}
            disabled={disabled}
            excludeDefault={requireRepository}
          />
          <GitBranchIndicator
            conversationId={conversationId ?? null}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            streaming={!!streaming}
          />
          {/* Runtime on the left, its model/effort tuning on the right — the
              BackendPicker renders the CLI tuning menu itself; the pi model
              picker follows for the built-in runtime. */}
          <BackendPicker
            conversationId={conversationId ?? null}
            disabled={disabled}
            pendingValue={pendingBackend}
            pendingModel={pendingCliModel}
            pendingEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            backendSwitch={backendSwitch}
            onBackendChange={(b) => {
              setBackend(b);
              if (!conversationId) onPendingBackendChange?.(b);
            }}
          />
          {backend === "pi" && (
            <ModelPicker
              value={modelChoice}
              onChange={onModelChange}
              ultra={ultra}
              onUltraToggle={onUltraToggle}
              // Recycling pis to apply the prompt change mid-stream would abort
              // the active run, so only allow toggling Ultra when idle.
              lockUltra={streaming}
              disabled={disabled}
            />
          )}
          {ambientAvailable && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={toggleAmbient}
              disabled={disabled}
              title={t(ambientOn ? "composer.ambientOn" : "composer.ambientOff")}
              aria-pressed={ambientOn}
            >
              <Radar
                className={cn(
                  "size-3",
                  ambientOn ? "text-primary" : "text-muted-foreground",
                )}
              />
            </Button>
          )}
        </div>
        {bashMode ? (
          // Terminal commands are independent of the agent stream, so always
          // offer a Run button here (never the abort affordance).
          <Button
            type="button"
            size="icon-sm"
            onClick={submit}
            disabled={disabled || !bashCommand}
            title={t("composer.runBash")}
          >
            <Terminal className="h-4 w-4" />
          </Button>
        ) : streaming ? (
          <Button
            type="button"
            size="icon-sm"
            variant="destructive"
            onClick={onAbort}
            title={t("composer.abort")}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            onClick={submit}
            disabled={
              disabled ||
              (requireRepository && (!workspaceDir || workspaceDir === defaultWorkspace)) ||
              (!text.trim() && attachments.length === 0)
            }
            title={t("composer.send")}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function formatQuoteForComposer(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<payload>" — keep just the payload.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
