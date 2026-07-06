"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Sparkles,
  CornerDownLeft,
  Command as CommandKey,
  Paperclip,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import {
  BACKENDS,
  CliTuningMenu,
  RuntimeShortcutHint,
  useRuntimeShortcuts,
} from "@/components/chat/backend-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import type { ComposerAttachment, ImageAttachment } from "@/components/chat/composer";
import type { BackendId, ModelChoice } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  /** Fire-and-forget submit. Parent creates the conversation and sends the
   *  prompt; dialog just collects the text + attachments + runtime choice
   *  (backend "pi" | "claude-code" | "codex", cliModel "" = CLI default). */
  onSubmit: (
    text: string,
    attachments: ComposerAttachment[],
    backend: BackendId,
    cliModel: string,
    cliEffort: string,
  ) => Promise<void>;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Linear-style quick-create task dialog. Compact centered modal; opens with
 *  ⌘N on the Kanban view. ⌘↵ submits and closes (or resets when "Create more"
 *  is on). Esc closes via Radix Dialog. */
export function CreateTaskDialog({
  open,
  onOpenChange,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation("board");
  const { t: tc } = useTranslation("common");
  const [text, setText] = useState("");
  // This dialog is image-only (addFiles skips non-images), so the attachment
  // list narrows to ImageAttachment — keeps previewUrl access type-safe now
  // that ComposerAttachment is an image|file union. Still assignable to the
  // ComposerAttachment[] the submit handler expects.
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [createMore, setCreateMore] = useState(false);
  // Runtime the task runs on (Cetus / Claude Code / Codex) + the CLI
  // backends' optional model override. Sticky across "create more" resets.
  const [backend, setBackend] = useState<BackendId>("pi");
  const [cliModel, setCliModel] = useState("");
  const [cliEffort, setCliEffort] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ⌃1/⌃2/⌃3 (user-editable) switch the task's runtime while the dialog is
  // open — page.tsx's global handler is modal-guarded, so this is the only
  // listener live here.
  const switchRuntime = useCallback(
    (b: BackendId) => {
      if (b === backend) return;
      setBackend(b);
      // Model/effort overrides belong to one backend's catalog.
      setCliModel("");
      setCliEffort("");
    },
    [backend],
  );
  useRuntimeShortcuts(switchRuntime, open);

  // Reset on close. Focus on open (after the dialog mount animation settles).
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => taRef.current?.focus());
    } else {
      setText("");
      setAttachments((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
        return [];
      });
      setSubmitting(false);
      setAttachError(null);
    }
  }, [open]);

  // Autosize textarea. Layout effect so the remeasure happens before paint;
  // collapsing to "auto" zeroes scrollTop, which makes an overflowing textarea
  // jump on every IME composition update — restore it afterwards.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 320) + "px";
    el.scrollTop = scrollTop;
  }, [text]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setAttachError(null);
    const next: ImageAttachment[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        setAttachError(t("create.imageOverLimit", { name: f.name || "image" }));
        continue;
      }
      const buf = await f.arrayBuffer();
      const data = arrayBufferToBase64(buf);
      const previewUrl = URL.createObjectURL(f);
      next.push({
        type: "image",
        data,
        mimeType: f.type,
        name: f.name || t("create.pastedImageName"),
        previewUrl,
      });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }, [t]);

  const removeAttachment = useCallback((i: number) => {
    setAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(i, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, attachments, backend, backend === "pi" ? "" : cliModel, backend === "pi" ? "" : cliEffort);
      // Attachments are owned by the parent now; clear ours without revoking
      // (parent still references the data URLs).
      setAttachments([]);
      if (createMore) {
        setText("");
        setSubmitting(false);
        requestAnimationFrame(() => taRef.current?.focus());
      } else {
        onOpenChange(false);
      }
    } catch {
      setSubmitting(false);
    }
  }, [text, attachments, submitting, createMore, backend, cliModel, cliEffort, onSubmit, onOpenChange]);

  // ⌘↵ submits.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleSubmit]);

  // Paste image from clipboard.
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Compact Linear-style modal: ~640px wide, centered, slides up.
        className="flex w-[90vw] max-w-2xl flex-col gap-0 overflow-visible p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">{t("create.srTitle")}</DialogTitle>

        {/* Breadcrumb header */}
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
            <Sparkles className="size-3" />
            cetus
          </div>
          <span className="text-xs text-muted-foreground">›</span>
          <span className="text-xs font-medium text-foreground">{t("create.newTask")}</span>
        </div>

        {/* Prompt */}
        <div className="relative flex min-h-[180px] flex-1 flex-col gap-3 px-5 py-4">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            placeholder={t("create.placeholder")}
            rows={4}
            className="min-h-[120px] w-full resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <div
                  key={a.previewUrl}
                  className="group relative size-16 overflow-hidden rounded-md border border-border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    title={a.name}
                    className="size-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-foreground/80 p-0.5 text-background opacity-0 transition-opacity group-hover:opacity-100"
                    title={tc("action.remove")}
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachError && (
            <div className="text-xs text-destructive">{attachError}</div>
          )}
        </div>

        {/* Metadata bar — workspace + model + reasoning */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <WorkspacePicker
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onChange={onWorkspaceChange}
          />
          <div className="ml-auto flex items-center gap-1">
            <Select
              value={backend}
              onValueChange={(v) => {
                setBackend(v as BackendId);
                setCliModel("");
                setCliEffort("");
              }}
            >
              <SelectTrigger
                size="sm"
                className={
                  "h-7 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted focus-visible:ring-0 data-[size=sm]:h-7 " +
                  (backend === "claude-code"
                    ? "text-[#d97757] hover:text-[#d97757]"
                    : backend === "codex"
                      ? "text-[#10a37f] hover:text-[#10a37f]"
                      : "text-muted-foreground hover:text-foreground")
                }
              >
                {(() => {
                  const current =
                    BACKENDS.find((b) => b.id === backend) ?? BACKENDS[0];
                  const Icon = current.icon;
                  return (
                    <>
                      <Icon className="size-3" />
                      <span className="truncate">{current.label}</span>
                    </>
                  );
                })()}
              </SelectTrigger>
              <SelectContent align="end">
                {BACKENDS.map((b) => {
                  const Icon = b.icon;
                  return (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      <Icon className="size-4" />
                      <span className="truncate">{b.label}</span>
                      <RuntimeShortcutHint backend={b.id} />
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {backend === "pi" ? (
              <ModelPicker value={modelChoice} onChange={onModelChange} />
            ) : (
              <CliTuningMenu
                backend={backend}
                model={cliModel}
                effort={cliEffort}
                onModelChange={setCliModel}
                onEffortChange={setCliEffort}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => fileInputRef.current?.click()}
              title={t("create.attachImage")}
            >
              <Paperclip className="size-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Switch
                id="create-more"
                checked={createMore}
                onCheckedChange={setCreateMore}
                className="scale-75 origin-left"
              />
              <Label
                htmlFor="create-more"
                className="cursor-pointer select-none text-xs text-muted-foreground"
              >
                {t("create.createMore")}
              </Label>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!text.trim() || submitting}
            className="h-7 gap-1.5 text-xs"
          >
            {submitting ? t("create.creating") : t("create.createTask")}
            <kbd className="flex items-center gap-0.5 rounded border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0.5 leading-none text-primary-foreground/70">
              <CommandKey className="size-3" />
              <CornerDownLeft className="size-3" />
            </kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}
