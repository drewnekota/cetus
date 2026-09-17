"use client";

import type { RuntimeEntry } from "@/lib/runtime-settings";
import type { Dispatch, SetStateAction, RefObject } from "react";
import {
  ArrowUp,
  Square,
  Paperclip,
  X,
  File as FileIcon,
  Terminal,
  Radar,
  CornerDownRight,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/artifact";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ModelPicker } from "@/components/chat/model-picker";
import {
  BackendPicker,
  nextRuntimeTarget,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { SlashMenu, type SlashItem } from "@/components/chat/slash-menu";
import {
  SlashCommandDialog,
  type EditableSlashCommand,
} from "@/components/chat/slash-command-dialog";
import {
  MentionMenu,
  nextMentionTab,
  type MentionTab,
} from "@/components/chat/mention-menu";
import { MentionHighlight } from "@/components/chat/mention-highlight";
import {
  mentionToken,
  type MentionItem,
  type MentionRef,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import type { BackendId, ModelChoice } from "@/lib/types";
import { runtimeThemeStyle } from "@/lib/runtime-theme";
import { LONG_PASTE_CHARS } from "./composer-utils";
import { GitBranchIndicator } from "./git-branch-indicator";
import {
  ComposerAttachment,
  ImageAttachment,
  ComposerRuntimeSelection,
} from "./composer";

export function renderComposer({
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
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  streaming: boolean | undefined;
  bashMode: boolean;
  backend: BackendId;
  isDragging: boolean;
  variant: "hero" | "docked";
  t: (key: string, vars?: Record<string, string | number>) => string;
  slashVisible: boolean;
  slashItems: SlashItem[];
  slashIdx: number;
  applySlash: (item: SlashItem) => void;
  setSlashActive: Dispatch<SetStateAction<number>>;
  setEditingCommand: Dispatch<SetStateAction<EditableSlashCommand | null>>;
  setNewCommandSeed: Dispatch<SetStateAction<string>>;
  slashQuery: string;
  setCommandDialogOpen: Dispatch<SetStateAction<boolean>>;
  closeSlash: () => void;
  commandDialogOpen: boolean;
  editingCommand: EditableSlashCommand | null;
  newCommandSeed: string;
  slashStart: number;
  text: string;
  updateText: (v: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  slashSuppress: RefObject<boolean>;
  setSlashOpen: Dispatch<SetStateAction<boolean>>;
  mentionVisible: boolean;
  mentionTab: MentionTab;
  setMentionTab: Dispatch<SetStateAction<MentionTab>>;
  setMentionActive: Dispatch<SetStateAction<number>>;
  mentionItems: MentionItem[];
  mentionIdx: number;
  filesWanted: boolean;
  mentionFilesLoading: boolean;
  applyMention: (item: MentionItem | undefined) => void;
  quote: string;
  updateQuote: (v: string) => void;
  attachments: ComposerAttachment[];
  setPreviewImage: Dispatch<SetStateAction<ImageAttachment | null>>;
  removeAttachment: (i: number) => void;
  previewImage: ImageAttachment | null;
  highlightRef: RefObject<HTMLDivElement | null>;
  mentionLabels: string[];
  mentionSuppress: RefObject<boolean>;
  syncSlash: () => void;
  syncMention: () => void;
  addFiles: (
    files: FileList | File[],
    pathHints?: Map<string, string>,
  ) => Promise<void>;
  insertTextAtCaret: (insert: string) => void;
  mentionRefs: MentionRef[];
  closeMention: () => void;
  onRequestBackendSwitch: ((target: RuntimeSwitchTarget) => void) | undefined;
  runtimeEntries: RuntimeEntry[];
  enabledBackendIds: ReadonlySet<BackendId>;
  conversationId: string | null | undefined;
  cliTuning: { model: string; effort: string };
  pendingCliModel: string | undefined;
  pendingCliEffort: string | undefined;
  submit: () => Promise<void>;
  withFocusHint: (base: string) => string;
  placeholder: string | undefined;
  onQueue:
    | ((
        text: string,
        attachments: ComposerAttachment[],
        runtime?: ComposerRuntimeSelection,
      ) => void)
    | undefined;
  heroPlaceholder: string;
  disabled: boolean | undefined;
  attachError: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  pendingBackend: BackendId | undefined;
  onPendingTuningChange: ((model: string, effort: string) => void) | undefined;
  backendSwitch: ({ token: number } & RuntimeSwitchTarget) | null | undefined;
  cliTuningOpen: boolean;
  setCliTuningOpen: Dispatch<SetStateAction<boolean>>;
  onRuntimeTuningChange: (model: string, effort: string) => void;
  setBackend: Dispatch<SetStateAction<BackendId>>;
  setRuntimeReady: Dispatch<SetStateAction<boolean>>;
  onPendingBackendChange: ((backend: BackendId) => void) | undefined;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  ambientAvailable: boolean;
  toggleAmbient: () => void;
  ambientOn: boolean;
  bashCommand: string;
  onAbort: () => void;
}) {
  return (
    <div
      ref={rootRef}
      data-chat-composer
      // Claims drops made anywhere in the window; FileDropHost delivers them
      // here. There are no HTML5 drag handlers on purpose — the Tauri runtime
      // answers the OS drag itself, so `drop` never fires on the webview.
      data-file-drop-target
      data-streaming={streaming && !bashMode ? "true" : undefined}
      data-backend={backend}
      style={{
        ...runtimeThemeStyle(backend),
        ...(!bashMode
          ? {
              borderColor:
                "color-mix(in oklab, var(--runtime-color) 60%, transparent)",
            }
          : {}),
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
        // Runtime identity is supplied by the shared theme registry. Bash
        // mode intentionally replaces it with the primary command tint.
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
          onCreateCommand={() => {
            setEditingCommand(null);
            setNewCommandSeed(slashQuery);
            setCommandDialogOpen(true);
            closeSlash();
          }}
          onEditCommand={(item) => {
            setEditingCommand({
              id: item.commandId!,
              name: item.name,
              description: item.description,
              prompt: item.prompt,
            });
            setCommandDialogOpen(true);
            closeSlash();
          }}
        />
      )}

      <SlashCommandDialog
        open={commandDialogOpen}
        onOpenChange={setCommandDialogOpen}
        command={editingCommand}
        initialName={newCommandSeed}
        onSaved={(command, created) => {
          if (created) {
            // Drop the user straight into the command they just wrote: the
            // token that opened the menu expands to the new prompt, same as
            // picking it. The token's own end (not the live caret, which the
            // dialog may have moved) bounds the replacement.
            const tokenEnd = Math.min(
              slashStart + 1 + slashQuery.length,
              text.length,
            );
            const insert = command.prompt;
            const next =
              text.slice(0, slashStart) + insert + text.slice(tokenEnd);
            const pos = slashStart + insert.length;
            updateText(next);
            requestAnimationFrame(() => {
              const node = taRef.current;
              if (!node) return;
              node.focus({ preventScroll: true });
              node.setSelectionRange(pos, pos);
            });
            return;
          }
          // An edit leaves the message alone and drops back into the menu,
          // which refetches on open and so shows the updated row.
          slashSuppress.current = false;
          setSlashOpen(true);
          requestAnimationFrame(() =>
            taRef.current?.focus({ preventScroll: true }),
          );
        }}
      />

      {mentionVisible && !slashVisible && (
        <MentionMenu
          tab={mentionTab}
          onTabChange={(k) => {
            setMentionTab(k);
            setMentionActive(0);
          }}
          items={mentionItems}
          activeIndex={mentionIdx}
          loading={filesWanted && mentionFilesLoading}
          onSelect={applyMention}
          onHover={setMentionActive}
        />
      )}

      {quote && !bashMode && (
        <div
          className={cn(
            // Flush with the card's top edge (cancel the container padding) so
            // the quote reads as its own section above the input, ChatGPT-style.
            "mb-1 flex items-center gap-2 rounded-t-[15px] border-b border-border/50 bg-muted/30 px-3 pb-2 pt-2.5",
            variant === "hero" ? "-mx-2 -mt-2" : "-mx-1.5 -mt-1.5",
          )}
        >
          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            &ldquo;{quote.replace(/\s+/g, " ")}&rdquo;
          </span>
          <button
            type="button"
            onClick={() => updateQuote("")}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("composer.removeQuote")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1.5 pb-1.5 pt-1">
          {attachments.map((a, i) => (
            <div key={i} className="group relative">
              {a.type === "image" ? (
                <button
                  type="button"
                  onClick={() => setPreviewImage(a)}
                  title={t("bubble.expandImage")}
                  className="fade-layer block cursor-zoom-in rounded-md transition-opacity hover:opacity-90"
                >
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    className="size-14 rounded-md border border-border object-cover"
                  />
                </button>
              ) : (
                <div
                  title={a.name}
                  className="flex h-14 max-w-44 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5"
                >
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{a.name}</div>
                    <div className="text-2xs text-muted-foreground">
                      {formatBytes(a.sizeBytes)}
                    </div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="fade-layer absolute -right-1.5 -top-1.5 rounded-full bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("composer.removeAttachment", { name: a.name })}
              >
                <X className="size-3.5 p-0.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={previewImage !== null}
        onOpenChange={(open) => !open && setPreviewImage(null)}
      >
        <DialogContent
          className="grid max-h-[90vh] max-w-[90vw] place-items-center border-none bg-transparent p-0 ring-0 sm:max-w-[90vw]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {previewImage?.name ?? t("bubble.attachment")}
          </DialogTitle>
          {previewImage && (
            <img
              src={previewImage.previewUrl}
              alt={previewImage.name}
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-xl"
            />
          )}
        </DialogContent>
      </Dialog>

      {bashMode && (
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-xs font-medium text-primary">
          <Terminal className="size-3" />
          <span>{t("composer.bashHint")}</span>
        </div>
      )}

      <div className="relative">
        <MentionHighlight
          ref={highlightRef}
          text={text}
          labels={mentionLabels}
          // Mirror the textarea's type ramp exactly (the shared Textarea adds
          // md:text-sm) — the pills only line up if both layers wrap alike.
          className={cn(
            "min-h-14 text-base md:text-sm",
            variant === "hero" ? "px-3 py-3" : "px-2.5 py-2",
          )}
        />
        <Textarea
          ref={taRef}
          value={text}
          onScroll={(e) => {
            const layer = highlightRef.current;
            if (layer) layer.scrollTop = e.currentTarget.scrollTop;
          }}
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
            if (
              ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)
            )
              return;
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
            const pastedText = e.clipboardData?.getData("text/plain") ?? "";
            const textAsFile =
              pastedText.length > LONG_PASTE_CHARS
                ? new File([pastedText], "pasted.txt", { type: "text/plain" })
                : null;
            // No files and reasonably-sized text → let the browser paste normally.
            if (!files.length && !textAsFile) return;
            // Mixed paste (image + text): hijack the event so the images become
            // attachments, but don't drop the accompanying text — insert it at
            // the caret ourselves since preventDefault cancels the native paste.
            e.preventDefault();
            if (textAsFile) files.push(textAsFile);
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
            if (pastedText && !textAsFile) insertTextAtCaret(pastedText);
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
            // Backspace right after a mention pill removes the whole token (plus
            // the space that follows it) instead of nibbling the label.
            if (e.key === "Backspace" && !composing && mentionRefs.length > 0) {
              const el = e.currentTarget;
              const caret = el.selectionStart ?? 0;
              if (caret > 0 && caret === el.selectionEnd) {
                const head = text.slice(0, caret);
                const tokens = mentionRefs
                  .map((r) => mentionToken(r.label))
                  .sort((a, b) => b.length - a.length);
                for (const token of tokens) {
                  const trailing = head.endsWith(`${token} `)
                    ? 1
                    : head.endsWith(token)
                      ? 0
                      : -1;
                  if (trailing < 0) continue;
                  const start = head.length - token.length - trailing;
                  const before = start > 0 ? text[start - 1] : "";
                  if (before && !/\s/.test(before)) continue;
                  e.preventDefault();
                  const next = text.slice(0, start) + text.slice(caret);
                  updateText(next);
                  requestAnimationFrame(() => {
                    const node = taRef.current;
                    if (!node) return;
                    node.setSelectionRange(start, start);
                    syncMention();
                  });
                  return;
                }
              }
            }
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
                setSlashActive(
                  (i) => (i - 1 + slashItems.length) % slashItems.length,
                );
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
              const n = Math.max(1, mentionItems.length);
              // Clamp at the ends instead of wrapping — pressing ↑ on the first
              // row (or ↓ on the last) is a no-op.
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionActive((i) => Math.min(i + 1, n - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionActive((i) => Math.max(i - 1, 0));
                return;
              }
              // Tab / ⇧Tab walk the kind tabs (All → Functions → … → Chats);
              // ⏎ picks the highlighted row.
              if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                setMentionTab((k) => nextMentionTab(k, e.shiftKey ? -1 : 1));
                setMentionActive(0);
                return;
              }
              if (e.key === "Enter") {
                // Nothing to pick (e.g. an email-like `@word`): close the menu and
                // let Enter fall through to send as usual.
                if (mentionItems.length === 0) {
                  mentionSuppress.current = true;
                  closeMention();
                } else {
                  e.preventDefault();
                  applyMention(mentionItems[mentionIdx]);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                mentionSuppress.current = true;
                closeMention();
                return;
              }
            }
            // Tab cycles the runtime rows — runtimes and presets in the picker
            // order — matching the quick launcher and the task dialog. The slash
            // menu above already consumed Tab when open, so here it's free to
            // repurpose. Only a bare Tab, though — Ctrl/Cmd+Tab must fall through
            // to the window handler (Ctrl+Tab = switch to previous view) instead
            // of being swallowed here.
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
              onRequestBackendSwitch(
                nextRuntimeTarget(runtimeEntries, enabledBackendIds, {
                  backend,
                  model: conversationId ? cliTuning.model : pendingCliModel,
                  effort: conversationId ? cliTuning.effort : pendingCliEffort,
                }),
              );
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
            "relative min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
            variant === "hero"
              ? "px-3 py-3 text-base"
              : "px-2.5 py-2 text-base",
          )}
        />
      </div>
      {attachError && (
        <div className="px-2 pb-1 text-xs text-destructive">{attachError}</div>
      )}
      <div className="flex items-center justify-between gap-2 px-1 pb-1 pt-0.5">
        {/* min-w-0 lets the picker cluster shrink (each trigger truncates) so
            the send button never overflows the frame in a narrow chat pane. */}
        <div className="flex min-w-0 items-center gap-1">
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
            context={
              <GitBranchIndicator
                conversationId={conversationId ?? null}
                workspaceDir={workspaceDir}
                defaultWorkspace={defaultWorkspace}
                streaming={!!streaming}
              />
            }
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
            tuningMenuOpen={cliTuningOpen}
            onTuningMenuOpenChange={setCliTuningOpen}
            onTuningChange={onRuntimeTuningChange}
            onBackendChange={(b) => {
              setBackend(b);
              setRuntimeReady(true);
              if (!conversationId) onPendingBackendChange?.(b);
            }}
          />
          {backend === "pi" && (
            <ModelPicker
              value={modelChoice}
              onChange={onModelChange}
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
              title={t(
                ambientOn ? "composer.ambientOn" : "composer.ambientOff",
              )}
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
            className="shrink-0"
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
            className="shrink-0"
            onClick={onAbort}
            title={t("composer.abort")}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            className="shrink-0"
            onClick={submit}
            disabled={
              disabled || (!text.trim() && !quote && attachments.length === 0)
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
