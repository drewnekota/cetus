"use client";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { ArrowUp, Square, Paperclip, X, File, Terminal } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/artifact";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/chat/model-picker";
import { BackendPicker } from "@/components/chat/backend-picker";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { SlashMenu, type SlashItem } from "@/components/chat/slash-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { flavorHeroPlaceholder } from "@/lib/chat-flavor";
import { api } from "@/lib/tauri";
import { readDraft, writeDraft } from "@/lib/draft-store";
import type { BackendId, ModelChoice } from "@/lib/types";

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

/** A composer attachment. Images ride pi's `images` channel (→ vision-bridge);
 *  every other file is written to disk and read by the agent via read_document. */
export type ComposerAttachment = ImageAttachment | FileAttachment;

/** A message parked in the follow-up queue while the agent is mid-run. */
export interface QueuedMessage {
  id: string;
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
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  /** Called instead of onSend when the agent is mid-run: the message is parked
   *  in a follow-up queue (shown above the composer) and delivered when the run
   *  ends, unless the user promotes it to a steer. Omit to fall back to onSend
   *  (immediate steer) while streaming. */
  onQueue?: (text: string, attachments: ComposerAttachment[]) => void;
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
}

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
  onSend,
  onQueue,
  onBash,
  onAbort,
  ultra,
  onUltraToggle,
  variant = "docked",
  placeholder,
  focusToken,
  draftKey,
  quoteRequest,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
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
  }, [draftKey]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Mirrors the BackendPicker's value so pi-only affordances (the DeepSeek
  // model picker) hide when a CLI backend serves this conversation — the CLIs
  // run their own default models, so the picker would be a no-op there.
  const [backend, setBackend] = useState<BackendId>("pi");
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastQuoteIdRef = useRef<number | null>(null);

  // A leading `!` flips the composer into Terminal mode: submit opens/focuses
  // the Terminal surface and runs the command there instead of sending a chat
  // message. Gated on a wired onBash handler — otherwise `!` is just text.
  const bashMode = !!onBash && text.startsWith("!");
  const bashCommand = bashMode ? text.slice(1).trim() : "";

  // ---- Slash menu (commands + skills) -------------------------------------
  const [slashCommands, setSlashCommands] = useState<SlashItem[]>([]);
  const [slashSkills, setSlashSkills] = useState<SlashItem[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashStart, setSlashStart] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  // Set when the user dismisses with Esc; cleared on the next edit so the menu
  // stays closed for the current token but a later `/` reopens it.
  const slashSuppress = useRef(false);
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
    return [...slashCommands.filter(match), ...slashSkills.filter(match)];
  }, [slashCommands, slashSkills, slashQuery]);

  const slashVisible = slashOpen && slashItems.length > 0;
  const slashIdx = Math.min(slashActive, slashItems.length - 1);

  function closeSlash() {
    setSlashOpen(false);
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
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  }

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, variant === "hero" ? 320 : 240) + "px";
  }, [text, variant]);

  useEffect(() => {
    if (focusToken !== undefined && !disabled) taRef.current?.focus();
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
      node.focus();
      const pos = node.value.length;
      node.setSelectionRange(pos, pos);
    });
  }, [disabled, draftKey, quoteRequest]);

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
      requestAnimationFrame(() => {
        el.focus();
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

  async function addFiles(files: FileList | File[]) {
    setAttachError(null);
    const next: ComposerAttachment[] = [];
    for (const f of Array.from(files)) {
      const isImage = f.type.startsWith("image/");
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (f.size > limit) {
        setAttachError(
          t("composer.fileTooLarge", {
            name: f.name || t("composer.unnamedFile"),
            limit: Math.round(limit / 1024 / 1024),
          }),
        );
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
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(i: number) {
    setAttachments((prev) => {
      const dropped = prev[i];
      if (dropped?.type === "image") URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  function submit() {
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
    const t = text.trim();
    if ((!t && attachments.length === 0)) return;
    // Mid-run: park the message in the follow-up queue instead of sending. The
    // user can still promote it to a steer from the queue UI. Falls back to a
    // direct send (immediate steer) when no queue handler is wired.
    if (streaming && onQueue) onQueue(t, attachments);
    else onSend(t, attachments);
    closeSlash();
    // Drop refs to revoke after send completes — onSend may consume async.
    setAttachments((prev) => {
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
          "border-[#d97757]/60 ring-1 ring-[#d97757]/30 dark:border-[#d97757]/50",
        !bashMode &&
          backend === "codex" &&
          "border-[#10a37f]/60 ring-1 ring-[#10a37f]/30 dark:border-[#10a37f]/50",
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
          updateText(e.target.value);
          syncSlash();
        }}
        onClick={syncSlash}
        onKeyUp={(e) => {
          // Re-detect on caret moves (arrows/home/end/click); typing is already
          // covered by onChange. Skip keys the slash-nav handler consumes.
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
          syncSlash();
        }}
        onPaste={(e) => {
          const files: File[] = [];
          for (const item of Array.from(e.clipboardData?.items ?? [])) {
            if (item.kind === "file") {
              const f = item.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
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
          <BackendPicker
            conversationId={conversationId ?? null}
            disabled={disabled}
            pendingValue={pendingBackend}
            pendingModel={pendingCliModel}
            pendingEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            onBackendChange={(b) => {
              setBackend(b);
              if (!conversationId) {
                onPendingBackendChange?.(b);
                onPendingTuningChange?.("", "");
              }
            }}
          />
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
            disabled={disabled || (!text.trim() && attachments.length === 0)}
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
