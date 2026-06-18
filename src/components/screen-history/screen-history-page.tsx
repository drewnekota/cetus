"use client";
// Full-window viewer for the Rewind-like screen-context collection. Renders a
// searchable, day-grouped timeline of captured frames; clicking one opens a
// lightbox with the full image and its OCR text. Mirrors SettingsPage's
// full-screen overlay pattern (opened from the command palette or Settings →
// Screen context; closed with Back or Esc).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowLeft, FolderOpen, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, type Screenshot } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Seed the search box when opening (e.g. from a command-palette result). */
  initialQuery?: string;
  /** Open straight into this frame's lightbox (command-palette frame select). */
  initialFrame?: Screenshot | null;
};

const PAGE_SIZE = 200;

export function ScreenHistoryPage({ open, onClose, initialQuery, initialFrame }: Props) {
  const { t } = useTranslation("screen");
  const { t: tc } = useTranslation("common");
  const [query, setQuery] = useState("");
  const [frames, setFrames] = useState<Screenshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A full page came back → there may be older frames to fetch on scroll.
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Screenshot | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const rows = q.trim()
        ? await api.searchScreenshots(q.trim(), undefined, PAGE_SIZE)
        : await api.recentScreenshots(PAGE_SIZE);
      setFrames(rows);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setFrames([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load when opened, and debounce on query changes while open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, query, load]);

  // Keyset pagination: fetch the next older page (ts < oldest loaded) and append.
  // Reads live state through refs so the IntersectionObserver below can stay a
  // single, stable subscription instead of re-binding on every frame change.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const queryRef = useRef(query);
  queryRef.current = query;
  const guardRef = useRef({ hasMore, loading, loadingMore });
  guardRef.current = { hasMore, loading, loadingMore };

  const loadMore = useCallback(async () => {
    const cur = framesRef.current;
    const cursor = cur[cur.length - 1]?.ts;
    if (cursor == null) return;
    setLoadingMore(true);
    try {
      const q = queryRef.current.trim();
      const rows = q
        ? await api.searchScreenshots(q, undefined, PAGE_SIZE, cursor)
        : await api.recentScreenshots(PAGE_SIZE, cursor);
      setFrames((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, []);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Infinite scroll: a sentinel near the end of the list triggers the next page
  // when it scrolls into view (600px lookahead so it feels seamless).
  const sentinelCb = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const g = guardRef.current;
        if (g.hasMore && !g.loading && !g.loadingMore) loadMoreRef.current();
      },
      { rootMargin: "600px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  // Seed the search box from `initialQuery` on open (e.g. opened from a
  // command-palette screen-history hit); clear transient UI when closing.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setSelected(initialFrame ?? null);
    } else {
      setSelected(null);
    }
  }, [open, initialQuery, initialFrame]);

  // Esc: close the lightbox first, then the page. Capture phase + stop so it
  // wins over the app-level Esc handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (selected) setSelected(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, selected, onClose]);

  const groups = useMemo(() => groupByDay(frames, t), [frames, t]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* `pl-20` clears the macOS traffic lights (Overlay title bar floats them
          over the top-left); the bar also doubles as a window drag handle. */}
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-20 pr-3"
      >
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <ArrowLeft className="size-4" />
          {tc("action.back")}
        </Button>
        <span className="font-serif text-base font-semibold italic">
          {t("title")}
        </span>
        <span className="ml-1 text-xs text-muted-foreground">
          {frames.length === 1
            ? t("frameCount.one", { count: frames.length })
            : t("frameCount.other", { count: frames.length })}
        </span>
        <div className="relative ml-auto w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8 pr-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t("clearSearch")}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {loading && frames.length === 0 ? (
          // Cold load: skeleton grid matching the real tile layout so the panel
          // doesn't flash an empty "loading" line then snap to a full grid.
          <div className="mx-auto max-w-6xl">
            <Skeleton className="mb-3 h-4 w-28" />
            <FrameSkeletonGrid count={12} />
          </div>
        ) : frames.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            {query ? (
              <>{t("noMatches", { query })}</>
            ) : (
              <div className="max-w-md space-y-1">
                <p className="font-medium text-foreground">{t("empty.title")}</p>
                <p>{t("empty.body")}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-8">
            {groups.map(({ key, label, items }) => (
              <section key={key}>
                <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-background/90 px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {label} · {items.length}
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {items.map((s) => (
                    <FrameCard key={s.id} frame={s} onOpen={() => setSelected(s)} />
                  ))}
                </div>
              </section>
            ))}
            {/* Infinite-scroll trigger + the next-page placeholder. */}
            {hasMore && (
              <div ref={sentinelCb} aria-hidden>
                {loadingMore && <FrameSkeletonGrid count={6} />}
              </div>
            )}
          </div>
        )}
      </main>

      {selected && (
        <Lightbox frame={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function FrameCard({ frame, onOpen }: { frame: Screenshot; onOpen: () => void }) {
  const { t } = useTranslation("screen");
  const [loaded, setLoaded] = useState(false);
  const snippet = (frame.ocrText ?? "").replace(/\s+/g, " ").trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      // content-visibility:auto skips layout + paint for tiles scrolled out of
      // view (with a reserved intrinsic height so the scrollbar stays stable) —
      // the lever that keeps a several-hundred-frame timeline smooth.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/30"
    >
      <div className="aspect-[16/10] overflow-hidden bg-muted">
        <img
          // Prefer the small thumbnail; fall back to the full frame for rows
          // captured before thumbnails existed. decoding=async keeps JPEG decode
          // off the main thread; the opacity fade hides the decode pop-in.
          src={convertFileSrc(frame.thumbPath ?? frame.filePath)}
          loading="lazy"
          decoding="async"
          alt=""
          onLoad={() => setLoaded(true)}
          className={cn(
            "size-full object-cover transition-[opacity,transform] duration-200 group-hover:scale-[1.02]",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium">{frame.appName || t("unknownApp")}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatTime(frame.ts)}
          </span>
        </div>
        {snippet && (
          <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {snippet}
          </p>
        )}
      </div>
    </button>
  );
}

/** Placeholder tiles in the real grid layout, for the cold load and the
 *  next-page fetch — keeps the timeline from flashing empty then snapping. */
function FrameSkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <div className="flex flex-col gap-1.5 px-2.5 py-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Lightbox({ frame, onClose }: { frame: Screenshot; onClose: () => void }) {
  const { t } = useTranslation("screen");
  const { t: tc } = useTranslation("common");
  const ocr = (frame.ocrText ?? "").trim();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-6xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 flex-1 items-center justify-center bg-black/40 p-3">
          <img
            src={convertFileSrc(frame.filePath)}
            alt=""
            className="max-h-[82vh] max-w-full rounded object-contain"
          />
        </div>
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          <div className="flex items-start justify-between gap-2 border-b border-border p-4">
            <div className="min-w-0">
              <div className="truncate font-medium">{frame.appName || t("unknownAppFull")}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(frame.ts).toLocaleString()}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={tc("action.close")}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("recognizedText")}
            </div>
            {ocr ? (
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
                {ocr}
              </p>
            ) : (
              <p className="text-xs italic text-muted-foreground">
                {t("noRecognizedText")}
              </p>
            )}
          </div>
          <div className="border-t border-border p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={() =>
                invoke("reveal_in_finder", { path: frame.filePath }).catch(() => {})
              }
            >
              <FolderOpen className="size-3.5" />
              {t("showInFinder")}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(ts: number, t: TFn): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return t("day.today");
  if (dayKey(ts) === dayKey(yesterday.getTime())) return t("day.yesterday");
  return d.toLocaleDateString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function groupByDay(frames: Screenshot[], t: TFn) {
  const order: string[] = [];
  const map = new Map<string, { key: string; label: string; items: Screenshot[] }>();
  for (const f of frames) {
    const key = dayKey(f.ts);
    let g = map.get(key);
    if (!g) {
      g = { key, label: dayLabel(f.ts, t), items: [] };
      map.set(key, g);
      order.push(key);
    }
    g.items.push(f);
  }
  return order.map((k) => map.get(k)!);
}
