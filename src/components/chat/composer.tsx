"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { ArrowUp, Square, Paperclip, X, File } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/artifact";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { SlashMenu, type SlashItem } from "@/components/chat/slash-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { ModelChoice } from "@/lib/types";

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
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  /** Called instead of onSend when the agent is mid-run: the message is parked
   *  in a follow-up queue (shown above the composer) and delivered when the run
   *  ends, unless the user promotes it to a steer. Omit to fall back to onSend
   *  (immediate steer) while streaming. */
  onQueue?: (text: string, attachments: ComposerAttachment[]) => void;
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
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — Gemini limit is generous but base64 inflates 33%
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — docx/xlsx/pdf etc., read on disk by the agent

export function Composer({
  disabled,
  streaming,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onQueue,
  onAbort,
  ultra,
  onUltraToggle,
  variant = "docked",
  placeholder,
  focusToken,
}: Props) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setText(next);
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
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled) return;
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
    setText("");
    setAttachError(null);
  }

  return (
    <div
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
        "relative rounded-2xl border border-border shadow-sm transition-shadow focus-within:shadow-md",
        isDragging && "ring-2 ring-primary ring-offset-2",
        variant === "hero"
          ? "bg-card/60 p-2 backdrop-blur-xl backdrop-saturate-150"
          : "bg-card p-1.5",
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

      <Textarea
        ref={taRef}
        value={text}
        onChange={(e) => {
          slashSuppress.current = false; // a fresh edit re-arms the menu
          setText(e.target.value);
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
          placeholder ??
          (streaming
            ? (onQueue
                ? t("composer.placeholderQueue")
                : t("composer.placeholderRunning"))
            : variant === "hero"
              ? t("composer.placeholderHero")
              : t("composer.placeholderDocked"))
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
            <Paperclip className="size-3" />
          </Button>
          <WorkspacePicker
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onChange={onWorkspaceChange}
            disabled={disabled}
          />
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
        </div>
        {streaming ? (
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
