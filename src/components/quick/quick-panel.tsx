"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, CornerDownLeft, Globe, ImageOff, Loader2, TextSelect, X } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { WorkspacePicker } from "@/components/chat/workspace-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import { api } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";
import {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_QUICK_SETTINGS,
  type ModelChoice,
  type QuickContext,
  type QuickOpenPayload,
  type QuickOpenUrlPayload,
  type QuickScreenshot,
  type QuickSessionMode,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** The frameless global launcher. Lives in the `quick` window (vibrancy applied
 *  natively behind a transparent webview), stays mounted + hidden, and wakes on
 *  the "quick-open" event the gesture listener emits. */
export function QuickPanel() {
  const { t } = useTranslation("quick");
  const [text, setText] = useState("");
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
  // "cetus:lastModelChoice" localStorage key. Ultra Code is a global switch.
  const [modelChoice, setModelChoice] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  const [ultraEnabled, setUltraEnabled] = useState(false);
  // True while the native "Add folder…" dialog is open, so the blur-to-dismiss
  // handler doesn't close the panel when that OS dialog steals focus.
  const pickingWorkspaceRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  // Whether any non-archived chat exists — gates the "Last" session option.
  const [hasLastChat, setHasLastChat] = useState(true);
  const [segmentShaking, setSegmentShaking] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
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
    api
      .getUltraSettings()
      .then((s) => setUltraEnabled(s.enabled))
      .catch(() => {});
    api.listConversations(false).then((cs) => {
      const hasLast = cs.length > 0;
      setHasLastChat(hasLast);
      if (!hasLast) setSessionMode("new");
    }).catch(() => {});
    try {
      const saved = localStorage.getItem("cetus:quickWorkspace");
      if (saved) setWorkspaceDir(saved);
      const rawModel = localStorage.getItem("cetus:lastModelChoice");
      if (rawModel)
        setModelChoice((m) => ({ ...m, ...JSON.parse(rawModel) } as ModelChoice));
    } catch {}
  }, []);

  const onWorkspaceChange = useCallback((dir: string) => {
    setWorkspaceDir(dir);
    try {
      localStorage.setItem("cetus:quickWorkspace", dir);
    } catch {}
  }, []);

  const onModelChange = useCallback((next: ModelChoice) => {
    setModelChoice(next);
    try {
      localStorage.setItem("cetus:lastModelChoice", JSON.stringify(next));
    } catch {}
  }, []);

  const onUltraToggle = useCallback(() => {
    setUltraEnabled((v) => {
      const next = !v;
      api.setUltraSettings({ enabled: next }).catch(() => {});
      return next;
    });
  }, []);

  // Wake on each launcher fire: reset, take the captured shot, focus.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<QuickOpenPayload>("quick-open", (e) => {
      const p = e.payload;
      openIdRef.current = p.openId;
      setText("");
      setSubmitting(false);
      setScreenshot(p.screenshot);
      setScreenshotDenied(p.screenshotDefault && !p.screenshotPermission);
      setIncludeScreenshot(p.screenshotDefault);
      setContext(p.context);
      // The panel stays mounted across opens, so re-read the shared model choice
      // each wake — the main window may have changed it (manual pick or just
      // switching conversations) since we last looked.
      try {
        const rawModel = localStorage.getItem("cetus:lastModelChoice");
        if (rawModel)
          setModelChoice((m) => ({ ...m, ...JSON.parse(rawModel) } as ModelChoice));
      } catch {}
      api.getUltraSettings().then((s) => setUltraEnabled(s.enabled)).catch(() => {});
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
    if (!t || submittingRef.current) return;
    setSubmitting(true);
    submittingRef.current = true;
    try {
      await api.quickSubmit({
        text: t,
        image: includeScreenshot ? screenshot : null,
        sessionMode,
        workspaceDir,
        model: modelChoice.model,
        reasoning: modelChoice.reasoning,
        ultra: ultraEnabled,
        // Context rides only in screenshot mode; whatever chips the user left on.
        context: includeScreenshot ? context : null,
      });
      // quick_submit hides the window for us; clear for the next open so a
      // with-screenshot submit doesn't leave a stale thumbnail that flashes
      // when the no-screenshot launcher opens next.
      setText("");
      setScreenshot(null);
      setScreenshotDenied(false);
      setIncludeScreenshot(false);
      setContext(null);
    } catch {
      // Keep the panel up so the user can retry.
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [text, includeScreenshot, screenshot, context, sessionMode, workspaceDir, modelChoice, ultraEnabled]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      api.quickDismiss().catch(() => {});
      return;
    }
    // Tab toggles the session mode (new ⇄ last) without leaving the input.
    if (e.key === "Tab") {
      e.preventDefault();
      if (!hasLastChat) {
        setSegmentShaking(true);
        return;
      }
      setSessionMode((m) => (m === "new" ? "last" : "new"));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Don't steal the Enter that commits an IME candidate.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-[18px] bg-[color-mix(in_oklab,var(--surface),transparent_18%)] font-medium text-foreground ring-1 ring-[var(--ink)]/[0.06] dark:bg-[color-mix(in_oklab,var(--card),transparent_28%)] dark:[text-shadow:0_1px_2px_rgb(0_0_0_/_0.35)] [&_[data-slot=select-trigger]]:!h-8 [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]_svg]:!size-3.5 [&_kbd]:h-5 [&_kbd]:text-[11px]">
      {/* The input owns the whole region above the action strip: the textarea
          fills it so typing wraps and uses the full height, and the screenshot
          chip (when present) tucks in at the bottom of the same region. */}
      <div className="relative flex flex-1 flex-col overflow-hidden px-6 pt-5 pb-2.5">
        <textarea
          ref={taRef}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("launcher.placeholder")}
          className="w-full flex-1 resize-none overflow-x-hidden overflow-y-auto bg-transparent text-lg font-medium leading-7 text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground/60"
        />
        {submitting && (
          <Loader2 className="absolute right-4 top-4 size-4 shrink-0 animate-spin text-muted-foreground" />
        )}

        {/* Attachments band — screenshot thumbnail (or its denied hint) and the
            ambient-context chips share ONE horizontal row so they don't stack
            and overflow the fixed-height panel. Each ✕ drops that item from the
            prompt. Only rendered once there's something to show. */}
        {includeScreenshot &&
          (screenshot ||
            screenshotDenied ||
            (context && (context.app || context.url || context.selection))) && (
          <div className="flex shrink-0 flex-wrap items-end gap-2 pt-2">
            {screenshot ? (
              <div className="group/shot relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
                  alt={t("screenshot.alt")}
                  className="h-14 rounded-md border border-black/10 object-cover dark:border-white/15"
                />
                <button
                  type="button"
                  onClick={() => {
                    setIncludeScreenshot(false);
                    setScreenshot(null);
                  }}
                  title={t("screenshot.remove")}
                  aria-label={t("screenshot.remove")}
                  className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 ring-1 ring-white/20 transition-opacity hover:bg-black/90 group-hover/shot:opacity-100"
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
            {context && (context.app || context.url || context.selection) && (
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
      <div className="flex items-center gap-2.5 border-t border-black/10 px-4 py-2.5 text-[13px] text-muted-foreground dark:border-white/10">
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
          shaking={segmentShaking}
          onShakeEnd={() => setSegmentShaking(false)}
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
        <ModelPicker
          value={modelChoice}
          onChange={onModelChange}
          ultra={ultraEnabled}
          onUltraToggle={onUltraToggle}
        />
        <span className="ml-auto flex items-center gap-1.5 pr-1">
          <Kbd>
            <CornerDownLeft className="size-2.5" />
          </Kbd>
          {t("footer.start")}
          <span className="text-muted-foreground/40">·</span>
          <span className={cn("flex items-center gap-1.5", !hasLastChat && "opacity-30")}>
            <Kbd>⇥</Kbd>
            {t("footer.switch")}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <Kbd>esc</Kbd>
          {t("footer.dismiss")}
        </span>
      </div>
    </div>
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

/** A removable ambient-context chip in the launcher. */
function ContextChip({
  icon,
  label,
  title,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation("quick");
  return (
    <span
      title={title}
      className="group/ctx inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.04] py-1 pl-2 pr-1 text-xs text-muted-foreground dark:border-white/10 dark:bg-white/[0.06]"
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        title={t("context.remove")}
        aria-label={t("context.remove")}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-black/10 hover:text-foreground dark:hover:bg-white/15"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  shaking,
  onShakeEnd,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean; disabledTooltip?: string }[];
  shaking?: boolean;
  onShakeEnd?: () => void;
}) {
  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex items-center rounded-md border border-black/10 bg-black/5 p-0.5 text-[13px] dark:border-white/10 dark:bg-white/5",
          shaking && "animate-shake",
        )}
        onAnimationEnd={onShakeEnd}
      >
        {options.map((o) => {
          const btn = (
            <button
              key={o.value}
              type="button"
              onClick={() => !o.disabled && onChange(o.value)}
              className={cn(
                "rounded px-2.5 py-1 font-medium transition-colors",
                value === o.value
                  ? "bg-black/10 text-foreground dark:bg-white/15"
                  : "text-muted-foreground hover:text-foreground",
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
