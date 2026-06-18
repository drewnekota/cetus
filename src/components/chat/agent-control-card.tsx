import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, MonitorCog, Square } from "lucide-react";

import { onAppEvent } from "@/lib/tauri";
import type { AppEvent } from "@/lib/types";
import { useChatStore } from "@/lib/chat-store";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

type AgentStepEvent = Extract<AppEvent, { type: "agent_step" }>;

interface AgentStep {
  surface: AgentStepEvent["surface"];
  action: string;
  highlightedIndex?: number;
  screenshotJpeg?: string;
}

const MAX_STEPS = 50;
const IDLE_HIDE_MS = 8000;

interface AgentControlCardProps {
  conversationId: string;
}

export function AgentControlCard({ conversationId }: AgentControlCardProps) {
  const { t } = useTranslation("chat");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [active, setActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const clearIdleTimer = () => {
      if (idleTimer.current !== null) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };

    const scheduleIdleHide = () => {
      clearIdleTimer();
      idleTimer.current = setTimeout(() => {
        setActive(false);
      }, IDLE_HIDE_MS);
    };

    void onAppEvent((event) => {
      if (event.type !== "agent_step") return;
      if (event.conversationId !== conversationId) return;

      const step: AgentStep = {
        surface: event.surface,
        action: event.action,
        highlightedIndex: event.highlightedIndex,
        screenshotJpeg: event.screenshotJpeg,
      };

      setSteps((prev) => {
        // Only the latest step's screenshot is ever rendered (see `latest`
        // below); drop prior steps' base64 JPEGs so an active run doesn't retain
        // up to MAX_STEPS full screenshots in memory for no visual benefit. The
        // text list keeps each step's action/surface.
        const trimmed = prev.map((s) =>
          s.screenshotJpeg ? { ...s, screenshotJpeg: undefined } : s,
        );
        const next = [...trimmed, step];
        return next.length > MAX_STEPS ? next.slice(next.length - MAX_STEPS) : next;
      });
      setActive(true);
      scheduleIdleHide();
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      clearIdleTimer();
      unlisten?.();
    };
  }, [conversationId]);

  // Render nothing until at least one step has arrived, and hide once idle.
  if (steps.length === 0 || !active) return null;

  const latest = steps[steps.length - 1];
  const recent = [...steps].reverse();
  const SurfaceIcon = latest.surface === "browser" ? Globe : MonitorCog;

  const handleStop = () => {
    setStopped(true);
    // End the run locally too — agent_stop aborts pi but emits no agent_end, so
    // without this isStreaming stays stuck and the rendered turn never caches.
    useChatStore.getState().endStream(conversationId);
    void invoke("agent_stop", { convId: conversationId }).catch(() => {
      /* best-effort */
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <SurfaceIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">
          {t("agent.controlling", { surface: latest.surface })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(steps.length === 1 ? "agent.step" : "agent.step_plural", { count: steps.length })}
        </span>
        <button
          type="button"
          onClick={handleStop}
          disabled={stopped}
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-xs font-medium text-red-500 transition-colors",
            "hover:bg-red-500/10",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
          )}
        >
          <Square className="h-3 w-3" />
          {stopped ? t("agent.stopping") : t("agent.stop")}
        </button>
      </div>

      <div className="space-y-2 p-3">
        {latest.screenshotJpeg ? (
          <div className="relative overflow-hidden rounded-md border border-border bg-muted">
            <img
              src={`data:image/jpeg;base64,${latest.screenshotJpeg}`}
              alt={t("agent.screenAlt")}
              className="max-h-52 w-full object-contain"
            />
            {typeof latest.highlightedIndex === "number" ? (
              <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white">
                #{latest.highlightedIndex}
              </span>
            ) : null}
          </div>
        ) : null}

        <ul className="max-h-28 space-y-0.5 overflow-y-auto">
          {recent.map((step, i) => (
            <li
              key={steps.length - 1 - i}
              className={cn(
                "truncate font-mono text-xs text-muted-foreground",
                i === 0 && "text-foreground",
              )}
              title={step.action}
            >
              {step.action}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default AgentControlCard;
