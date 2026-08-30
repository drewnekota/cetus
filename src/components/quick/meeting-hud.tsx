"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Square, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  api,
  onAppEvent,
  onMeetingCaption,
  type MeetingCaption,
} from "@/lib/tauri";
import { formatElapsed } from "@/lib/format";
import { tt } from "@/lib/i18n";

/** One settled transcript line in the hover card. */
interface CaptionLine {
  ts: number;
  source: string;
  text: string;
}

/** Cap on retained settled lines — the hover card is a live tail, not the
 *  full transcript (that lives in Settings → Meetings). */
const MAX_FINALS = 80;
/** Hover intent delays: don't flash open on a fly-by, don't snap shut while
 *  the cursor crosses the gap between pill and card. */
const EXPAND_DELAY_MS = 120;
const COLLAPSE_DELAY_MS = 300;
/** Within this distance of the bottom the tail auto-follows new captions. */
const PIN_SLOP_PX = 48;

/** The floating meeting-recording pill. The component IS the pill — it floats
 *  in its transparent `meeting` window (a never-key panel the backend shows at
 *  the top-center of the screen while a session is live, mirroring the macOS
 *  screen-recording indicator). Pulsing red dot + elapsed timer + one-click
 *  stop; the capsule is a drag region so it can be moved out of the way.
 *  Hovering the pill expands the panel (Granola-style) into a live-caption
 *  card: settled sentences plus the in-flight hypothesis per stream, replaced
 *  in place as recognition refines it. Visibility is owned by the backend, so
 *  a recording is never on screen without its indicator. */
export function MeetingHud() {
  const [startedTs, setStartedTs] = useState<number | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [finals, setFinals] = useState<CaptionLine[]>([]);
  const [partials, setPartials] = useState<Record<string, CaptionLine>>({});
  // 1s re-render tick driving the timer — elapsed derives locally from
  // startedTs, so ticking costs no IPC.
  const [, setTick] = useState(0);

  const meetingIdRef = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Clear the opaque app body so only the capsule is visible.
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

  const refresh = useCallback(() => {
    api
      .meetingStatus()
      .then((s) => {
        setStartedTs(s.recording ? (s.startedTs ?? Date.now()) : null);
        const id = s.recording ? s.meetingId : null;
        if (id !== meetingIdRef.current) {
          // New session (or session over): drop the previous call's captions.
          meetingIdRef.current = id;
          setMeetingId(id);
          setFinals([]);
          setPartials({});
          pinnedRef.current = true;
        }
        if (!s.recording) setStopping(false);
      })
      .catch(() => {});
  }, []);

  // The webview persists hidden between sessions — sync off the backend's
  // session events instead of polling while invisible.
  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "meeting_event") refresh();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [refresh]);

  // Live captions: `final` appends (and clears that source's partial),
  // `partial` replaces the source's in-flight line wholesale.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onMeetingCaption((c: MeetingCaption) => {
      if (meetingIdRef.current && c.meetingId !== meetingIdRef.current) return;
      if (c.kind === "final") {
        setPartials((p) => {
          if (!(c.source in p)) return p;
          const next = { ...p };
          delete next[c.source];
          return next;
        });
        if (c.text)
          setFinals((f) =>
            [...f, { ts: c.ts, source: c.source, text: c.text }].slice(
              -MAX_FINALS,
            ),
          );
      } else if (c.text.trim()) {
        setPartials((p) => ({
          ...p,
          [c.source]: { ts: c.ts, source: c.source, text: c.text },
        }));
      } else {
        setPartials((p) => {
          if (!(c.source in p)) return p;
          const next = { ...p };
          delete next[c.source];
          return next;
        });
      }
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Events are the fast path, but a hidden/persisted WebView can subscribe
  // after the backend has already emitted one (or be reloaded mid-session).
  // While the card is visible, reconcile it with the durable local transcript
  // so missed captions repair themselves instead of leaving an empty panel.
  const syncTranscript = useCallback((id: string) => {
    api
      .meetingTranscript(id)
      .then((segs) => {
        if (meetingIdRef.current !== id) return;
        setFinals((current) => {
          const merged = new Map<string, CaptionLine>();
          for (const line of [...segs, ...current]) {
            merged.set(`${line.ts}:${line.source}:${line.text}`, {
              ts: line.ts,
              source: line.source,
              text: line.text,
            });
          }
          return [...merged.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_FINALS);
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!expanded || !meetingId) return;
    syncTranscript(meetingId);
    const timer = setInterval(() => syncTranscript(meetingId), 1500);
    return () => clearInterval(timer);
  }, [expanded, meetingId, syncTranscript]);

  useEffect(() => {
    if (startedTs === null) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [startedTs]);

  // Session ended while the card was open (auto-stop, crash): fold the panel
  // back so the next show presents a clean collapsed pill.
  useEffect(() => {
    if (startedTs === null && expanded) {
      setExpanded(false);
      api.meetingHudSetExpanded(false).catch(() => {});
    }
  }, [startedTs, expanded]);

  // Follow the live tail unless the user scrolled up to read.
  useEffect(() => {
    if (!expanded || !pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, finals, partials]);

  const expand = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setExpanded(true);
      api.meetingHudSetExpanded(true).catch(() => {});
      const id = meetingIdRef.current;
      if (id) syncTranscript(id);
    }, EXPAND_DELAY_MS);
  }, [syncTranscript]);

  const collapseNow = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setExpanded(false);
    pinnedRef.current = true;
    api.meetingHudSetExpanded(false).catch(() => {});
  }, []);

  const scheduleCollapse = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(collapseNow, COLLAPSE_DELAY_MS);
  }, [collapseNow]);

  // Watchdog: WebKit's hover tracking in this never-key panel can drop the
  // `mouseleave` (same family of bugs as the stuck `:hover` under auto-scroll
  // elsewhere in the app — and this card auto-scrolls on every caption), which
  // leaves the panel stuck open with no way to close it. While expanded, poll
  // the real cursor against the window frame and fold once it has truly left.
  // The containment test runs backend-side (`meeting_hud_cursor_inside`): the
  // JS cursorPosition()/outerPosition() pair mixes coordinate spaces on
  // scaled/secondary displays and read "outside" during a legitimate hover,
  // auto-folding the card moments after it opened.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    let outsideSince: number | null = null;
    const timer = setInterval(() => {
      api
        .meetingHudCursorInside()
        .then((inside) => {
          if (cancelled) return;
          if (inside) {
            outsideSince = null;
            return;
          }
          // Two consecutive outside reads ≈ the collapse delay, so the
          // watchdog matches the mouseleave path instead of racing it.
          if (outsideSince === null) {
            outsideSince = Date.now();
          } else if (Date.now() - outsideSince >= COLLAPSE_DELAY_MS) {
            collapseNow();
          }
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [expanded, collapseNow]);

  if (startedTs === null) return null;

  const elapsed = formatElapsed(startedTs);

  async function onStop() {
    setStopping(true);
    try {
      await api.meetingStop();
    } finally {
      // Always drop the spinner once the stop call settles: if the backend
      // reports a session again afterwards it is a NEW session (the old one is
      // gone), and the pill must show its stop button, not a stuck spinner.
      setStopping(false);
    }
  }

  const youLabel = tt("meeting", "transcript.you");
  const themLabel = tt("meeting", "transcript.them");
  const partialLines = Object.values(partials).sort((a, b) => a.ts - b.ts);

  return (
    <div
      className="flex h-screen w-screen flex-col items-center"
      onMouseEnter={expand}
      onMouseLeave={scheduleCollapse}
    >
      <div
        data-tauri-drag-region
        // Starting a drag hands the mouse to the native window-move loop, so
        // WebKit may never deliver the matching mouseleave — cancel a pending
        // hover-expand so a drag can't pop the card open in a state it can't
        // cleanly leave. (The cursor watchdog covers a card already open.)
        onMouseDown={() => {
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
        }}
        className="flex h-[52px] w-full shrink-0 items-center justify-center"
      >
        <div
          data-tauri-drag-region
          className="flex h-8 items-center gap-2 rounded-full bg-black pl-3 pr-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
        >
          <span className="pointer-events-none relative flex size-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-destructive" />
          </span>
          <span className="pointer-events-none text-xs font-medium tabular-nums text-white">
            {elapsed}
          </span>
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={tt("meeting", "action.stop")}
            title={tt("meeting", "action.stop")}
            className="flex size-5.5 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          >
            {stopping ? (
              <Spinner className="size-3" />
            ) : (
              <Square className="size-2.5 fill-current" />
            )}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mb-4 flex min-h-0 w-[400px] flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/95 shadow-[0_4px_12px_rgba(0,0,0,0.5)]">
          <div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-1 pt-2.5">
            <span className="size-1.5 rounded-full bg-destructive" />
            <span className="text-2xs font-medium uppercase tracking-wide text-white/50">
              {tt("meeting", "transcript.live")}
            </span>
            <button
              type="button"
              onClick={collapseNow}
              aria-label={tt("meeting", "transcript.close")}
              title={tt("meeting", "transcript.close")}
              className="ml-auto flex size-5 items-center justify-center rounded text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-3" />
            </button>
          </div>
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinnedRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLOP_PX;
            }}
            className="min-h-0 flex-1 select-text overflow-y-auto px-3.5 pb-3 pt-1"
          >
            {finals.length === 0 && partialLines.length === 0 ? (
              <p className="pt-6 text-center text-xs text-white/40">
                {tt("meeting", "transcript.empty")}
              </p>
            ) : (
              <div className="space-y-1.5">
                {finals.map((line, i) => (
                  <CaptionRow
                    key={`${line.ts}-${i}`}
                    line={line}
                    showLabel={i === 0 || finals[i - 1].source !== line.source}
                    youLabel={youLabel}
                    themLabel={themLabel}
                  />
                ))}
                {partialLines.map((line) => (
                  <CaptionRow
                    key={`partial-${line.source}`}
                    line={line}
                    partial
                    showLabel
                    youLabel={youLabel}
                    themLabel={themLabel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CaptionRow({
  line,
  partial = false,
  showLabel,
  youLabel,
  themLabel,
}: {
  line: CaptionLine;
  partial?: boolean;
  showLabel: boolean;
  youLabel: string;
  themLabel: string;
}) {
  const you = line.source === "mic";
  return (
    <div className="text-xs leading-relaxed">
      {showLabel && (
        <span
          className={`mr-1.5 font-semibold ${you ? "text-primary" : "text-white/50"}`}
        >
          {you ? youLabel : themLabel}
        </span>
      )}
      <span className={partial ? "text-white/55" : "text-white/90"}>
        {line.text}
      </span>
      {partial && (
        <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse rounded-full bg-white/60" />
      )}
    </div>
  );
}
