"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, CornerDownLeft, File, Globe, ImageOff, Paperclip, ScanText, TextSelect, X } from "lucide-react";
import { formatBytes } from "@/lib/artifact";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import {
  BACKENDS,
  backendSupportsTuning,
  CliTuningMenu,
  nextBackend,
  RuntimeShortcutHint,
  runtimePresetLabel,
  runtimeSwitchTarget,
  useRuntimeCatalog,
  useRuntimeShortcuts,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
import { useEnabledBackendIds } from "@/lib/runtime-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";
import {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_QUICK_SETTINGS,
  type BackendId,
  type ModelChoice,
  type QuickContext,
  type QuickAttachment,
  type QuickOpenPayload,
  type QuickOpenUrlPayload,
  type QuickReplyContextPayload,
  type QuickReplyDeltaPayload,
  type QuickReplyOpenPayload,
  type QuickReplyResultPayload,
  type QuickScreenshot,
  type QuickSessionMode,
} from "@/lib/types";
import { mergeStoredModelChoice, saveModelChoice } from "@/lib/model-choice";
import { runtimeThemeStyle } from "@/lib/runtime-theme";
import {
  loadBackendChoice,
  loadCliTuningChoice,
  saveBackendChoice,
} from "@/lib/backend-choice";
import { cn } from "@/lib/utils";
import { prepareImageAttachment } from "@/lib/image-attachment";
import { readDroppedFiles } from "@/lib/dropped-files";
import { FILE_DRAG_EVENT, FILE_DROP_EVENT } from "@/components/file-drop-host";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Inline budget for a non-image attachment. Bigger files (and folders) are
 *  named in the prompt by path instead — same limit the chat composer uses. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The frameless global launcher. Lives in the `quick` window (vibrancy applied
 *  natively behind a transparent webview), stays mounted + hidden, and wakes on
 *  the "quick-open" event the gesture listener emits. */
export function QuickPanel() {
  const { t } = useTranslation("quick");
  const enabledBackendIds = useEnabledBackendIds();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<QuickAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<QuickScreenshot | null>(null);
  // Permission is only known once a quick-open payload arrives. Until then a
  // null screenshot means "not captured yet", NOT "denied" — so the grant hint
  // stays hidden and never flashes on the first open after launch.
  const [screenshotDenied, setScreenshotDenied] = useState(false);
  // Whether a shot rides along. Seeded false; each open's `quick-open` payload
  // sets it to match the gesture that fired (the with/without-screenshot one).
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  // Ambient context captured pre-focus (frontmost app, browser URL, selection),
  // shown as removable chips. Rides only with a screenshot. Each chip's ✕ clears
  // that field so the user controls exactly what the agent sees.
  const [context, setContext] = useState<QuickContext | null>(null);
  const [sessionMode, setSessionMode] = useState<QuickSessionMode>(
    DEFAULT_QUICK_SETTINGS.sessionMode,
  );
  // Repo the launched task runs in. null → backend default workspace. Sticky
  // across opens via localStorage (recents are shared with the chat picker).
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  // Model + reasoning preset, shared with the main composer via the same
  // "cetus:lastModelChoice" localStorage key.
  const [modelChoice, setModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  // Coding-agent runtime the launched task runs on (Cetus / Claude Code /
  // Codex) plus the CLI backends' model + effort overrides ("" = the CLI's own
  // defaults). Sticky across opens and shared with the main window's hero
  // composer via "cetus:lastBackendChoice"; applies to newly-created
  // conversations.
  const [backend, setBackend] = useState<BackendId>("pi");
  const [cliModel, setCliModel] = useState("");
  const [cliEffort, setCliEffort] = useState("");
  useEffect(() => {
    if (enabledBackendIds.has(backend)) return;
    setBackend("pi");
    setCliModel("");
    setCliEffort("");
  }, [backend, enabledBackendIds]);
  // True while the native "Add folder…" dialog is open, so the blur-to-dismiss
  // handler doesn't close the panel when that OS dialog steals focus.
  const pickingWorkspaceRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  // Whether any non-archived chat exists — gates the "Last" session option.
  const [hasLastChat, setHasLastChat] = useState(true);
  const [surface, setSurface] = useState<"launcher" | "reply">("launcher");
  const [replyOpen, setReplyOpen] = useState<QuickReplyOpenPayload | null>(null);
  const [replyResult, setReplyResult] = useState<QuickReplyResultPayload | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [insertingReply, setInsertingReply] = useState(false);
  // Runtime the reply surface is drafting on. Seeded from the open payload (the
  // resolved `replyBackend` setting) and re-runnable: picking another one
  // re-sends the same capture, so the user can compare drafts without having to
  // re-trigger the gesture — the screen it was reading is gone by then.
  const [replyBackend, setReplyBackend] = useState<BackendId>("pi");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirrors for the mount-once blur listener (which closes over stale state).
  const submittingRef = useRef(false);
  // True for a beat right after the panel opens, so a not-yet-key window losing
  // a transient focus event can't instantly dismiss itself.
  const openingRef = useRef(false);
  // This open's token (from `quick-open`). The deferred `quick-open-url` event
  // only applies if its token still matches — guards against a slow URL from a
  // prior open landing on a newer one.
  const openIdRef = useRef(0);
  submittingRef.current = submitting;

  const focusSoon = useCallback(() => {
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  // The app's global CSS paints an opaque body (bg-background); in the launcher
  // window that hides the native vibrancy behind the transparent webview. Clear
  // it so the frosted glass shows through. Scoped to this window's document.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  // Seed defaults on mount in case the very first gesture beat our listener.
  useEffect(() => {
    api
      .getQuickSettings()
      .then((s) => { setSessionMode(s.sessionMode); })
      .catch(() => {});
    api.defaultWorkspace().then(setDefaultWorkspace).catch(() => {});
    api.listConversations(false).then((cs) => {
      const hasLast = cs.length > 0;
      setHasLastChat(hasLast);
      if (!hasLast) setSessionMode("new");
    }).catch(() => {});
    try {
      const saved = localStorage.getItem("cetus:quickWorkspace");
      if (saved) setWorkspaceDir(saved);
    } catch {}
    const savedBackend = loadBackendChoice();
    if (savedBackend) {
      setBackend(savedBackend.backend);
      setCliModel(savedBackend.cliModel);
      setCliEffort(savedBackend.cliEffort);
    }
    setModelChoice(mergeStoredModelChoice);
  }, []);

  const { entries } = useRuntimeCatalog();
  const onBackendChange = useCallback(
    (id: string) => {
      // Preset rows apply their runtime plus fixed model/effort. They bypass
      // the sticky per-runtime tuning entirely — neither read nor written —
      // so a preset always means the same thing.
      const presetEntry = entries.find(
        (entry) => entry.kind === "preset" && entry.id === id,
      );
      if (presetEntry && presetEntry.kind === "preset") {
        const { preset } = presetEntry;
        setBackend(preset.backend);
        setCliModel(preset.model);
        setCliEffort(preset.effort);
        saveBackendChoice(
          {
            backend: preset.backend,
            cliModel: preset.model,
            cliEffort: preset.effort,
          },
          preset.id,
        );
        return;
      }
      const b = BACKENDS.find((x) => x.id === id);
      if (!b) return;
      const tuning = backendSupportsTuning(b.id)
        ? loadCliTuningChoice(b.id)
        : { model: "", effort: "" };
      setBackend(b.id);
      setCliModel(tuning.model);
      setCliEffort(tuning.effort);
      saveBackendChoice({
        backend: b.id,
        cliModel: tuning.model,
        cliEffort: tuning.effort,
      });
    },
    [entries],
  );

  /** Keyboard slot switch: presets carry fixed tuning, runtimes reuse the
   *  regular picker path. */
  const onRuntimeSwitch = useCallback(
    (target: RuntimeSwitchTarget) => {
      if (target.model !== undefined || target.effort !== undefined) {
        const preset = entries.find(
          (entry) =>
            entry.kind === "preset" &&
            entry.preset.backend === target.backend &&
            entry.preset.model === (target.model ?? "") &&
            entry.preset.effort === (target.effort ?? ""),
        );
        setBackend(target.backend);
        setCliModel(target.model ?? "");
        setCliEffort(target.effort ?? "");
        saveBackendChoice(
          {
            backend: target.backend,
            cliModel: target.model ?? "",
            cliEffort: target.effort ?? "",
          },
          preset && preset.kind === "preset" ? preset.preset.id : undefined,
        );
        return;
      }
      // Same runtime again (e.g. a repeated shortcut) is a no-op so it doesn't
      // reset the model/effort overrides.
      if (target.backend === backend) return;
      onBackendChange(target.backend);
    },
    [backend, entries, onBackendChange],
  );

  const onCliModelChange = useCallback(
    (m: string) => {
      setCliModel(m);
      saveBackendChoice({ backend, cliModel: m, cliEffort });
    },
    [backend, cliEffort],
  );

  const onCliEffortChange = useCallback(
    (e: string) => {
      setCliEffort(e);
      saveBackendChoice({ backend, cliModel, cliEffort: e });
    },
    [backend, cliModel],
  );

  /** Re-draft on another runtime against the capture already in flight. The
   *  turn streams into the same draft, so clear it back to the loading shell
   *  first; a superseded turn's late deltas are dropped natively. */
  const onReplyBackendChange = useCallback(
    (id: string) => {
      const next = BACKENDS.find((b) => b.id === id);
      if (!next || next.id === replyBackend) return;
      setReplyBackend(next.id);
      setReplyResult(null);
      setReplyDraft("");
      api.quickReplyRegenerate(next.id).catch((error) => {
        setReplyResult((current) =>
          current ?? { openId: replyOpen?.openId ?? 0, output: null, error: String(error) },
        );
      });
    },
    [replyBackend, replyOpen],
  );

  // ⌃1…⌃9 (user-editable) switch the runtime, mirroring the main composer.
  // This window only receives keys while the panel is up, and the two surfaces
  // own separate runtime choices — the reply surface re-drafts on switch (and
  // has no tuning, so a preset slot there just selects its runtime).
  const onReplyRuntimeSwitch = useCallback(
    (target: RuntimeSwitchTarget) => onReplyBackendChange(target.backend),
    [onReplyBackendChange],
  );
  useRuntimeShortcuts(
    surface === "reply" ? onReplyRuntimeSwitch : onRuntimeSwitch,
  );

  const onWorkspaceChange = useCallback((dir: string) => {
    setWorkspaceDir(dir);
    try {
      localStorage.setItem("cetus:quickWorkspace", dir);
    } catch {}
  }, []);

  const onModelChange = useCallback((next: ModelChoice) => {
    setModelChoice(next);
    saveModelChoice(next);
  }, []);

  // Wake on each launcher fire: reset, take the captured shot, focus.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<QuickOpenPayload>("quick-open", (e) => {
      const p = e.payload;
      setSurface("launcher");
      openIdRef.current = p.openId;
      setText("");
      setAttachments([]);
      setAttachError(null);
      setSubmitting(false);
      setScreenshot(p.screenshot);
      setScreenshotDenied(p.screenshotDefault && !p.screenshotPermission);
      setIncludeScreenshot(p.screenshotDefault);
      setContext(p.context);
      // The panel stays mounted across opens, so re-read the shared model and
      // runtime choices each wake — the main window may have changed them
      // (manual pick or just switching conversations) since we last looked.
      setModelChoice(mergeStoredModelChoice);
      const savedBackend = loadBackendChoice();
      if (savedBackend) {
        setBackend(savedBackend.backend);
        setCliModel(savedBackend.cliModel);
        setCliEffort(savedBackend.cliEffort);
      }
      focusSoon();
      openingRef.current = true;
      window.setTimeout(() => {
        openingRef.current = false;
      }, 400);
      // Re-check for non-archived chats each time the panel wakes, then apply
      // the payload's session mode (falling back to "new" when none exist).
      api.listConversations(false).then((cs) => {
        const hasLast = cs.length > 0;
        setHasLastChat(hasLast);
        setSessionMode(hasLast ? p.sessionMode : "new");
      }).catch(() => {
        setSessionMode(p.sessionMode);
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [focusSoon]);

  // Direct visual reply is a separate state of the same warm, non-activating
  // window. The open event paints a loading shell immediately; the turn then
  // streams draft deltas and settles with one result, both accepted only for
  // the matching capture token.
  useEffect(() => {
    let unlisteners: (() => void)[] | undefined;
    let cancelled = false;
    Promise.all([
      listen<QuickReplyOpenPayload>("quick-reply-open", (e) => {
        setSurface("reply");
        setReplyOpen(e.payload);
        setReplyBackend(e.payload.backend ?? "pi");
        setReplyResult(null);
        setReplyDraft("");
        setInsertingReply(false);
        openingRef.current = true;
        window.setTimeout(() => { openingRef.current = false; }, 400);
      }),
      // The AX walk and browser probe land after the panel is already up; fold
      // their result into the captured-input band the user is looking at.
      listen<QuickReplyContextPayload>("quick-reply-context", (e) => {
        setReplyOpen((current) =>
          current && current.openId === e.payload.openId
            ? { ...current, context: e.payload.context, axChars: e.payload.axChars }
            : current,
        );
      }),
      listen<QuickReplyDeltaPayload>("quick-reply-delta", (e) => {
        setReplyOpen((current) => {
          if (!current || current.openId !== e.payload.openId) return current;
          setReplyResult((result) => {
            if (!result) setReplyDraft((draft) => draft + e.payload.delta);
            return result;
          });
          return current;
        });
      }),
      listen<QuickReplyResultPayload>("quick-reply-result", (e) => {
        setReplyOpen((current) => {
          if (!current || current.openId !== e.payload.openId) return current;
          setReplyResult(e.payload);
          // The settled text is authoritative over the streamed concatenation
          // (some runtimes normalize whitespace or emit preamble blocks).
          setReplyDraft(e.payload.output?.reply ?? "");
          return current;
        });
      }),
    ]).then((fns) => {
      if (cancelled) {
        fns.forEach((fn) => fn());
      } else {
        unlisteners = fns;
      }
    });
    return () => {
      cancelled = true;
      unlisteners?.forEach((fn) => fn());
    };
  }, []);

  // The browser URL is fetched after the panel presents (off the first-paint
  // path) and streamed in here. Merge it into the existing context only — if the
  // panel was dismissed (context cleared) or a newer open superseded this token,
  // drop it so a stale URL never appears as a chip.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<QuickOpenUrlPayload>("quick-open-url", (e) => {
      const p = e.payload;
      if (p.openId !== openIdRef.current) return;
      setContext((c) => (c ? { ...c, url: p.url, title: p.title } : c));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Dismiss when focus leaves the panel (Raycast-style), unless we're mid
  // submit.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused && pickingWorkspaceRef.current) {
          pickingWorkspaceRef.current = false;
          focusSoon();
          return;
        }
        if (
          !focused &&
          !submittingRef.current &&
          !openingRef.current &&
          !pickingWorkspaceRef.current
        ) {
          api.quickDismiss().catch(() => {});
          // Drop the captured shot as we hide. The window stays mounted, so
          // without this the next open (e.g. the no-screenshot launcher) would
          // paint this stale thumbnail for a frame before quick-open clears it.
          setScreenshot(null);
          setScreenshotDenied(false);
          setIncludeScreenshot(false);
          setContext(null);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const submit = useCallback(async () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || submittingRef.current) return;
    setSubmitting(true);
    submittingRef.current = true;
    try {
      await api.quickSubmit({
        text: t,
        image: includeScreenshot ? screenshot : null,
        attachments,
        sessionMode,
        workspaceDir,
        model: modelChoice.model,
        reasoning: modelChoice.reasoning,
        // Context rides only in screenshot mode; whatever chips the user left on.
        context: includeScreenshot ? context : null,
        backend,
        cliModel: backend === "pi" ? "" : cliModel,
        cliEffort: backend === "pi" ? "" : cliEffort,
      });
      // quick_submit hides the window for us; clear for the next open so a
      // with-screenshot submit doesn't leave a stale thumbnail that flashes
      // when the no-screenshot launcher opens next.
      setText("");
      setAttachments([]);
      setScreenshot(null);
      setScreenshotDenied(false);
      setIncludeScreenshot(false);
      setContext(null);
    } catch {
      // Keep the panel up so the user can retry.
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [text, attachments, includeScreenshot, screenshot, context, sessionMode, workspaceDir, modelChoice, backend, cliModel, cliEffort]);

  const insertReply = useCallback(async () => {
    const value = replyDraft.trim();
    // The draft is insertable only once the turn settled; a partial stream
    // could otherwise send half a sentence into the focused app.
    if (!value || insertingReply || !replyResult?.output) return;
    setInsertingReply(true);
    submittingRef.current = true;
    try {
      await api.quickReplyInsert(value);
      setReplyDraft("");
      setReplyResult(null);
      setReplyOpen(null);
    } catch {
      setInsertingReply(false);
      submittingRef.current = false;
    }
  }, [replyDraft, insertingReply, replyResult]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setAttachError(null);
    const next: QuickAttachment[] = [];
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      const limit = MAX_ATTACHMENT_BYTES;
      if (!isImage && file.size > limit) {
        setAttachError(t("attachment.tooLarge", { name: file.name, limit: limit / 1024 / 1024 }));
        continue;
      }
      try {
        if (isImage) {
          const image = await prepareImageAttachment(file);
          next.push({ type: "image", data: image.data, mimeType: image.mimeType, name: file.name || t("attachment.pastedImage") });
        } else {
          const data = await fileToBase64(file);
          next.push({ type: "file", data, mimeType: file.type || "application/octet-stream", name: file.name || t("attachment.unnamed"), sizeBytes: file.size });
        }
      } catch (error) {
        setAttachError(String(error));
      }
    }
    if (next.length) setAttachments((current) => [...current, ...next]);
  }, [t]);

  /** Files dropped on the launcher, routed here by FileDropHost. Drops carry
   *  paths, so read them into `File`s and reuse the paste pipeline; a folder or
   *  an oversized file is named in the prompt instead, for the agent to open
   *  off disk. */
  const addPaths = useCallback(
    async (paths: string[]) => {
      const { files, referenced } = await readDroppedFiles(paths, MAX_ATTACHMENT_BYTES);
      if (files.length) await addFiles(files);
      if (referenced.length) {
        setText((value) => {
          const head = value.replace(/\s+$/, "");
          return (head ? `${head}\n` : "") + referenced.join("\n") + " ";
        });
      }
    },
    [addFiles],
  );

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
  }, [addPaths]);

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
    const pastedText = e.clipboardData.getData("text/plain");
    if (pastedText) {
      const el = taRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? start;
      setText((value) => value.slice(0, start) + pastedText + value.slice(end));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      api.quickDismiss().catch(() => {});
      return;
    }
    // Tab cycles the runtime (Cetus → Claude Code → Codex), matching the main
    // composer and the task dialog. Bare Tab only — a modifier keeps its
    // default meaning rather than being repurposed here.
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onBackendChange(nextBackend(backend, enabledBackendIds));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Don't steal the Enter that commits an IME candidate.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      void submit();
    }
  }

  if (surface === "reply") {
    return (
      <QuickReplySurface
        open={replyOpen}
        result={replyResult}
        draft={replyDraft}
        inserting={insertingReply}
        backend={replyBackend}
        onBackendChange={onReplyBackendChange}
        onDraftChange={setReplyDraft}
        onInsert={() => { void insertReply(); }}
        onDismiss={() => { api.quickDismiss().catch(() => {}); }}
      />
    );
  }

  // Every action-strip control shares one quiet language: borderless ghost
  // triggers at h-8/13px, hovering to black/5 (white/8 in dark), selected
  // state black/10 (white/15). The select-trigger overrides on the root
  // normalize the shared pickers (workspace/model) that carry their own
  // solid-token hover styles; alpha overlays keep the vibrancy visible.
  return (
    <div
      ref={rootRef}
      // Takes file drops made anywhere in the launcher window; FileDropHost
      // delivers them here (the Tauri runtime answers the OS drag itself, so
      // there is no HTML5 `drop` to listen for).
      data-file-drop-target
      className={cn(
        "flex h-screen w-screen flex-col overflow-hidden rounded-[16px] bg-[color-mix(in_oklab,var(--surface),transparent_42%)] font-medium text-foreground dark:bg-[color-mix(in_oklab,var(--card),transparent_45%)] dark:ring-1 dark:ring-inset dark:ring-white/[0.07] dark:[text-shadow:0_1px_2px_rgb(0_0_0_/_0.35)] [&_[data-slot=select-trigger]]:!h-8 [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]:hover]:!bg-black/5 dark:[&_[data-slot=select-trigger]:hover]:!bg-white/[0.08] [&_[data-slot=select-trigger]_svg]:!size-3.5 [&_kbd]:h-5 [&_kbd]:border-black/[0.06] [&_kbd]:bg-black/5 [&_kbd]:text-[11px] dark:[&_kbd]:border-white/[0.08] dark:[&_kbd]:bg-white/[0.06]",
        // Drop affordance: overrides the panel's own hairline ring in both
        // themes so the launcher reads as "release here".
        isDragging && "ring-2 ring-inset ring-primary dark:ring-2 dark:ring-primary",
      )}
    >
      {/* The input owns the whole region above the action strip: the textarea
          fills it so typing wraps and uses the full height, and the screenshot
          chip (when present) tucks in at the bottom of the same region. */}
      <div className="relative flex flex-1 flex-col overflow-hidden px-6 pt-5 pb-2.5">
        <textarea
          ref={taRef}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={t("launcher.placeholder")}
          className="w-full flex-1 resize-none overflow-x-hidden overflow-y-auto bg-transparent text-lg font-medium leading-7 text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground/60"
        />
        {submitting && (
          <Spinner className="absolute right-4 top-4 size-4 text-muted-foreground" />
        )}

        {/* Attachments band — screenshot thumbnail (or its denied hint) and the
            ambient-context chips share ONE horizontal row so they don't stack
            and overflow the fixed-height panel. Each ✕ drops that item from the
            prompt. Only rendered once there's something to show. */}
        {(attachments.length > 0 || (includeScreenshot &&
          (screenshot ||
            screenshotDenied ||
            (context && (context.app || context.url || context.selection))))) && (
          <div className="flex shrink-0 flex-wrap items-end gap-2 pt-2">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} className="group/shot relative inline-block">
                {attachment.type === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} className="size-14 rounded-md border border-black/[0.06] object-cover dark:border-white/[0.08]" />
                ) : (
                  <div className="flex h-14 max-w-44 items-center gap-2 rounded-md border border-black/[0.06] bg-black/[0.03] px-2.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
                    <File className="size-4 shrink-0" />
                    <div className="min-w-0"><div className="truncate text-xs">{attachment.name}</div><div className="text-[10px] opacity-60">{formatBytes(attachment.sizeBytes)}</div></div>
                  </div>
                )}
                <button type="button" onClick={() => setAttachments((items) => items.filter((_, i) => i !== index))} aria-label={t("attachment.remove", { name: attachment.name })} className="fade-layer absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 ring-1 ring-white/20 transition-opacity hover:bg-black/90 group-hover/shot:opacity-100"><X className="size-3" /></button>
              </div>
            ))}
            {screenshot ? (
              <div className="group/shot relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
                  alt={t("screenshot.alt")}
                  className="h-14 rounded-md border border-black/[0.06] object-cover dark:border-white/[0.08]"
                />
                <button
                  type="button"
                  onClick={() => {
                    setIncludeScreenshot(false);
                    setScreenshot(null);
                  }}
                  title={t("screenshot.remove")}
                  aria-label={t("screenshot.remove")}
                  className="fade-layer absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 ring-1 ring-white/20 transition-opacity hover:bg-black/90 group-hover/shot:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ) : screenshotDenied ? (
              <span className="flex items-center gap-1.5 text-xs text-warning">
                <ImageOff className="size-3.5" />
                {t("screenshot.permission")}
              </span>
            ) : null}
            {includeScreenshot && context && (context.app || context.url || context.selection) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {context.app && (
                  <ContextChip
                    icon={<AppWindow className="size-3" />}
                    label={context.app}
                    title={context.app}
                    onRemove={() => setContext((c) => (c ? { ...c, app: "", bundleId: "" } : c))}
                  />
                )}
                {context.url && (
                  <ContextChip
                    icon={<Globe className="size-3" />}
                    label={hostOf(context.url)}
                    title={context.title ? `${context.title}\n${context.url}` : context.url}
                    onRemove={() => setContext((c) => (c ? { ...c, url: "", title: "" } : c))}
                  />
                )}
                {context.selection && (
                  <ContextChip
                    icon={<TextSelect className="size-3" />}
                    label={t("context.selection", { count: context.selection.length })}
                    title={context.selection.slice(0, 280)}
                    onRemove={() => setContext((c) => (c ? { ...c, selection: "" } : c))}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Thin, muted action strip — subordinate to the input. */}
      <div className="flex items-center gap-2.5 border-t border-black/[0.06] px-4 py-2.5 text-[13px] text-muted-foreground dark:border-white/[0.06]">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { pickingWorkspaceRef.current = false; if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => { pickingWorkspaceRef.current = true; fileInputRef.current?.click(); }} title={t("attachment.add")} aria-label={t("attachment.add")} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-black/5 hover:text-foreground dark:hover:bg-white/[0.08]"><Paperclip className="size-3.5" /></button>
        <Segmented
          value={sessionMode}
          onChange={setSessionMode}
          options={[
            { value: "new", label: t("session.new") },
            {
              value: "last",
              label: t("session.last"),
              disabled: !hasLastChat,
              disabledTooltip: t("session.last.empty"),
            },
          ]}
        />
        <WorkspacePicker
          workspaceDir={workspaceDir}
          defaultWorkspace={defaultWorkspace}
          onChange={onWorkspaceChange}
          disabled={sessionMode === "last"}
          onNativePick={(active) => {
            pickingWorkspaceRef.current = active;
          }}
        />
        <BackendSelect
          value={backend}
          onChange={onBackendChange}
          includePresets
          model={cliModel}
          effort={cliEffort}
        />
        {backend === "pi" ? (
          <ModelPicker
            value={modelChoice}
            onChange={onModelChange}
          />
        ) : backendSupportsTuning(backend) ? (
          <CliTuningMenu
            backend={backend}
            model={cliModel}
            effort={cliEffort}
            onModelChange={onCliModelChange}
            onEffortChange={onCliEffortChange}
            className="h-8 text-[13px] hover:bg-black/5 dark:hover:bg-white/[0.08]"
          />
        ) : null}
        <span className="ml-auto flex items-center gap-1.5 pr-1">
          <Kbd>
            <CornerDownLeft className="size-2.5" />
          </Kbd>
          {t("footer.start")}
          <span className="text-muted-foreground/40">·</span>
          <span className={cn("flex items-center gap-1.5", !hasLastChat && "opacity-35")}>
            <Kbd>⇥</Kbd>
            {t("footer.switch")}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <Kbd>esc</Kbd>
          {t("footer.dismiss")}
        </span>
      </div>
      {attachError && <div className="absolute bottom-12 left-4 text-[11px] text-destructive">{attachError}</div>}
    </div>
  );
}

function QuickReplySurface({
  open,
  result,
  draft,
  inserting,
  backend,
  onBackendChange,
  onDraftChange,
  onInsert,
  onDismiss,
}: {
  open: QuickReplyOpenPayload | null;
  result: QuickReplyResultPayload | null;
  draft: string;
  inserting: boolean;
  backend: BackendId;
  onBackendChange: (id: string) => void;
  onDraftChange: (value: string) => void;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("quick");
  const enabledBackendIds = useEnabledBackendIds();
  // The turn streams the draft in before the result settles; show the text as
  // soon as the first delta lands and keep the footer in "reading" state.
  const streaming = !result && draft.length > 0;
  const status = open?.app
    ? t("reply.readingApp", { app: open.app })
    : t("reply.readingScreen");

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    // Tab re-drafts on the next runtime, same key that cycles runtimes in the
    // launcher and the main composer.
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onBackendChange(nextBackend(backend, enabledBackendIds));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if ((e.nativeEvent as KeyboardEvent).isComposing) return;
      e.preventDefault();
      onInsert();
    }
  }

  // Same quiet shell as the launcher: no header, the editable draft owns the
  // region above a thin muted action strip.
  return (
    <div
      tabIndex={-1}
      autoFocus
      onKeyDown={onKeyDown}
      className="flex h-screen w-screen flex-col overflow-hidden rounded-[16px] bg-[color-mix(in_oklab,var(--surface),transparent_42%)] font-medium text-foreground outline-none dark:bg-[color-mix(in_oklab,var(--card),transparent_45%)] dark:ring-1 dark:ring-inset dark:ring-white/[0.07] dark:[text-shadow:0_1px_2px_rgb(0_0_0_/_0.35)] [&_kbd]:h-5 [&_kbd]:border-black/[0.06] [&_kbd]:bg-black/5 [&_kbd]:text-[11px] dark:[&_kbd]:border-white/[0.08] dark:[&_kbd]:bg-white/[0.06]"
    >
      {!result && !streaming ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <Spinner className="size-5" />
          <span>{open?.screenshotPermission === false ? t("reply.permission") : t("reply.generating")}</span>
        </div>
      ) : result?.error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
          <ImageOff className="size-5 text-warning" />
          <div className="max-w-xl text-sm text-foreground">{result.error}</div>
          <div className="text-xs text-muted-foreground">{t("reply.retryRuntime")}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t("reply.edit")}
            className="w-full flex-1 resize-none overflow-x-hidden overflow-y-auto bg-transparent text-lg font-medium leading-7 text-foreground outline-none"
          />
        </div>
      )}

      {/* Captured-input band — mirrors the launcher's attachments row: exactly
          what rode along to the model (screenshot, frontmost app, page, AX
          text volume), visible from the first loading frame. Read-only: the
          capture is already in flight. */}
      {(open?.screenshot || open?.context || (open?.axChars ?? 0) > 0) && (
        <div className="flex shrink-0 items-end gap-2 px-6 pb-2.5 pt-2">
          {open?.screenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:${open.screenshot.mimeType};base64,${open.screenshot.data}`}
              alt={t("screenshot.alt")}
              className="h-14 rounded-md border border-black/[0.06] object-cover dark:border-white/[0.08]"
            />
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {open?.context?.app && (
              <ContextChip
                icon={<AppWindow className="size-3" />}
                label={open.context.app}
                title={open.context.title ? `${open.context.app}\n${open.context.title}` : open.context.app}
              />
            )}
            {open?.context?.url && (
              <ContextChip
                icon={<Globe className="size-3" />}
                label={hostOf(open.context.url)}
                title={open.context.title ? `${open.context.title}\n${open.context.url}` : open.context.url}
              />
            )}
            {open?.context?.selection && (
              <ContextChip
                icon={<TextSelect className="size-3" />}
                label={t("context.selection", { count: open.context.selection.length })}
                title={open.context.selection}
              />
            )}
            {(open?.axChars ?? 0) > 0 && (
              <ContextChip
                icon={<ScanText className="size-3" />}
                label={t("reply.screenText", { count: open?.axChars ?? 0 })}
              />
            )}
          </div>
        </div>
      )}

      {/* Same action strip as the launcher, minus everything a one-shot turn
          doesn't have: just the runtime, which doubles as the re-draft control. */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-black/[0.06] px-4 py-2.5 text-[13px] text-muted-foreground dark:border-white/[0.06] [&_[data-slot=select-trigger]]:!h-8 [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]:hover]:!bg-black/5 dark:[&_[data-slot=select-trigger]:hover]:!bg-white/[0.08] [&_[data-slot=select-trigger]_svg]:!size-3.5">
        <BackendSelect value={backend} onChange={onBackendChange} />
        <span className="min-w-0 truncate text-muted-foreground/70">
          {result?.output ? t("reply.drafted") : status}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-4 pr-1">
          {result?.output && (
            <>
              <Kbd>
                <CornerDownLeft className="size-2.5" />
              </Kbd>
              {inserting ? t("reply.inserting") : t("reply.insert")}
              <span className="text-muted-foreground/40">·</span>
            </>
          )}
          <Kbd>⇥</Kbd>
          {t("reply.redraft")}
          <span className="text-muted-foreground/40">·</span>
          <Kbd>esc</Kbd>
          {t("footer.dismiss")}
        </span>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Compact coding-agent picker for the launcher's action strip. With
 *  `includePresets` the user's runtime presets are interleaved in the list
 *  (the reply surface has no tuning, so it leaves them out). */
function BackendSelect({
  value,
  onChange,
  includePresets,
  model,
  effort,
}: {
  value: BackendId;
  onChange: (id: string) => void;
  includePresets?: boolean;
  /** Current model/effort overrides, used to put the checkmark on a preset
   *  row (instead of its runtime) when the selection matches one exactly. */
  model?: string;
  effort?: string;
}) {
  const { entries, enabledBackendIds } = useRuntimeCatalog();
  const availableEntries = entries.filter((entry) =>
    entry.kind === "backend"
      ? enabledBackendIds.has(entry.id)
      : includePresets && enabledBackendIds.has(entry.preset.backend),
  );
  const current = BACKENDS.find((b) => b.id === value) ?? BACKENDS[0];
  const TriggerIcon = current.icon;
  const matchedPreset = availableEntries.find(
    (entry) =>
      entry.kind === "preset" &&
      entry.preset.backend === value &&
      entry.preset.model === (model ?? "") &&
      entry.preset.effort === (effort ?? ""),
  );
  return (
    <Select value={matchedPreset ? matchedPreset.id : value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        style={{ ...runtimeThemeStyle(value), color: "var(--runtime-color)" }}
        className="gap-1.5 border-0 bg-transparent px-2 text-[13px] shadow-none focus-visible:ring-0"
      >
        <TriggerIcon className="size-3.5" />
        <span className="truncate">{current.label}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {availableEntries.map((entry) => {
          if (entry.kind === "preset") {
            const { preset } = entry;
            const PresetIcon =
              BACKENDS.find((x) => x.id === preset.backend)?.icon ??
              BACKENDS[0].icon;
            return (
              <SelectItem
                key={entry.id}
                value={entry.id}
                className="text-[13px] *:[span]:last:w-full"
              >
                <PresetIcon className="size-4" />
                <span className="truncate">{runtimePresetLabel(preset)}</span>
                <RuntimeShortcutHint entryId={entry.id} />
              </SelectItem>
            );
          }
          const b = BACKENDS.find((x) => x.id === entry.id);
          if (!b) return null;
          const Icon = b.icon;
          return (
            <SelectItem
              key={b.id}
              value={b.id}
              className="text-[13px] *:[span]:last:w-full"
            >
              <Icon className="size-4" />
              <span className="truncate">{b.label}</span>
              <RuntimeShortcutHint entryId={b.id} />
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** The host of a URL for a compact chip label; the raw string if unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** An ambient-context chip. Removable in the launcher (where dropping a chip
 *  edits the prompt); read-only in the reply surface (the capture is already
 *  in flight, so there is nothing to remove). */
function ContextChip({
  icon,
  label,
  title,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("quick");
  return (
    <span
      title={title}
      className={cn(
        "group/ctx inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-black/[0.06] bg-black/5 py-1 pl-2 text-xs text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.06]",
        onRemove ? "pr-1" : "pr-2",
      )}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={t("context.remove")}
          aria-label={t("context.remove")}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-black/10 hover:text-foreground dark:hover:bg-white/15"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean; disabledTooltip?: string }[];
}) {
  return (
    <TooltipProvider disableHoverableContent>
      <div className="flex items-center gap-0.5">
        {options.map((o) => {
          const btn = (
            <button
              key={o.value}
              type="button"
              onClick={() => !o.disabled && onChange(o.value)}
              className={cn(
                "flex h-8 items-center rounded-md px-2.5 font-medium transition-colors",
                value === o.value
                  ? "bg-black/10 text-foreground dark:bg-white/15"
                  : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/[0.08]",
                o.disabled && "pointer-events-none opacity-35",
              )}
            >
              {o.label}
            </button>
          );

          if (o.disabled && o.disabledTooltip) {
            return (
              <Tooltip key={o.value}>
                <TooltipTrigger asChild>
                  <span className="cursor-not-allowed">{btn}</span>
                </TooltipTrigger>
                <TooltipContent side="top">{o.disabledTooltip}</TooltipContent>
              </Tooltip>
            );
          }

          return btn;
        })}
      </div>
    </TooltipProvider>
  );
}
