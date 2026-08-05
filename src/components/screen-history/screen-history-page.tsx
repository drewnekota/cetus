"use client";
// Full-window viewer for the screen-context collection — both streams. Renders
// a searchable, day-grouped timeline mixing captured frames (screenshot+OCR)
// with text-only AX observations (ambient collector); clicking one opens a
// lightbox with the full image / full text. Mirrors SettingsPage's full-screen
// overlay pattern (opened from the command palette or Settings → Screen
// context; closed with Back or Esc).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowLeft, FileText, FolderOpen, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, type AmbientEntry, type Screenshot } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** One row of the merged history: a captured frame or an AX text observation. */
type HistoryItem =
  | { kind: "frame"; frame: Screenshot }
  | { kind: "ax"; entry: AmbientEntry };

function itemTs(i: HistoryItem): number {
  return i.kind === "frame" ? i.frame.ts : i.entry.ts;
}

function itemId(i: HistoryItem): string {
  return i.kind === "frame" ? `f-${i.frame.id}` : `a-${i.entry.id}`;
}

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
  // The two streams are fetched and paginated independently (each has its own
  // keyset cursor); the merged, ts-sorted view is derived below.
  const [frames, setFrames] = useState<Screenshot[]>([]);
  const [axRows, setAxRows] = useState<AmbientEntry[]>([]);
  // Per-stream "no more pages" flags (a short page marks the stream done).
  const [frameDone, setFrameDone] = useState(true);
  const [axDone, setAxDone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<HistoryItem | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    const qt = q.trim();
    const [fr, ax] = await Promise.all([
      (qt
        ? api.searchScreenshots(qt, undefined, PAGE_SIZE)
        : api.recentScreenshots(PAGE_SIZE)
      ).catch(() => [] as Screenshot[]),
      (qt
        ? api.searchAmbientContext(qt, undefined, PAGE_SIZE)
        : api.recentAmbientContext(PAGE_SIZE)
      ).catch(() => [] as AmbientEntry[]),
    ]);
    setFrames(fr);
    setAxRows(ax);
    setFrameDone(fr.length < PAGE_SIZE);
    setAxDone(ax.length < PAGE_SIZE);
    setLoading(false);
  }, []);

  // (Re)load when opened, and debounce on query changes while open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, query, load]);

  const hasMore = !frameDone || !axDone;

  // Keyset pagination: fetch the next older page (ts < oldest loaded) for every
  // stream that still has one, and append. Reads live state through refs so the
  // IntersectionObserver below can stay a single, stable subscription instead
  // of re-binding on every list change.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const axRef = useRef(axRows);
  axRef.current = axRows;
  const doneRef = useRef({ frameDone, axDone });
  doneRef.current = { frameDone, axDone };
  const queryRef = useRef(query);
  queryRef.current = query;
  const guardRef = useRef({ hasMore, loading, loadingMore });
  guardRef.current = { hasMore, loading, loadingMore };

  const loadMore = useCallback(async () => {
    const q = queryRef.current.trim();
    const done = doneRef.current;
    setLoadingMore(true);
    const jobs: Promise<void>[] = [];
    const frCursor = framesRef.current[framesRef.current.length - 1]?.ts;
    if (!done.frameDone && frCursor != null) {
      jobs.push(
        (q
          ? api.searchScreenshots(q, undefined, PAGE_SIZE, frCursor)
          : api.recentScreenshots(PAGE_SIZE, frCursor)
        )
          .then((rows) => {
            setFrames((prev) => [...prev, ...rows]);
            setFrameDone(rows.length < PAGE_SIZE);
          })
          .catch(() => setFrameDone(true)),
      );
    }
    const axCursor = axRef.current[axRef.current.length - 1]?.ts;
    if (!done.axDone && axCursor != null) {
      jobs.push(
        (q
          ? api.searchAmbientContext(q, undefined, PAGE_SIZE, axCursor)
          : api.recentAmbientContext(PAGE_SIZE, axCursor)
        )
          .then((rows) => {
            setAxRows((prev) => [...prev, ...rows]);
            setAxDone(rows.length < PAGE_SIZE);
          })
          .catch(() => setAxDone(true)),
      );
    }
    await Promise.all(jobs);
    setLoadingMore(false);
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
      setSelected(initialFrame ? { kind: "frame", frame: initialFrame } : null);
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

  // Merge the two streams newest-first, hiding anything older than the
  // shallower stream's fetch frontier — otherwise the deeper stream's tail
  // would render with holes that later pages fill in above the fold.
  const items = useMemo(() => {
    const all: HistoryItem[] = [
      ...frames.map((f) => ({ kind: "frame" as const, frame: f })),
      ...axRows.map((e) => ({ kind: "ax" as const, entry: e })),
    ];
    all.sort((a, b) => itemTs(b) - itemTs(a));
    let frontier = -Infinity;
    if (!frameDone && frames.length) {
      frontier = Math.max(frontier, frames[frames.length - 1].ts);
    }
    if (!axDone && axRows.length) {
      frontier = Math.max(frontier, axRows[axRows.length - 1].ts);
    }
    return frontier === -Infinity ? all : all.filter((i) => itemTs(i) >= frontier);
  }, [frames, axRows, frameDone, axDone]);

  const groups = useMemo(() => groupByDay(items, t), [items, t]);

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
          {items.length === 1
            ? t("itemCount.one", { count: items.length })
            : t("itemCount.other", { count: items.length })}
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
        {loading && items.length === 0 ? (
          // Cold load: skeleton grid matching the real tile layout so the panel
          // doesn't flash an empty "loading" line then snap to a full grid.
          <div className="mx-auto max-w-6xl">
            <Skeleton className="mb-3 h-4 w-28" />
            <FrameSkeletonGrid count={12} />
          </div>
        ) : items.length === 0 ? (
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
            {groups.map(({ key, label, items: dayItems }) => (
              <section key={key}>
                <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-background px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label} · {dayItems.length}
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {dayItems.map((it) =>
                    it.kind === "frame" ? (
                      <FrameCard
                        key={itemId(it)}
                        frame={it.frame}
                        onOpen={() => setSelected(it)}
                      />
                    ) : (
                      <AxCard
                        key={itemId(it)}
                        entry={it.entry}
                        onOpen={() => setSelected(it)}
                      />
                    ),
                  )}
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

      {selected &&
        (selected.kind === "frame" ? (
          <Lightbox frame={selected.frame} onClose={() => setSelected(null)} />
        ) : (
          <AxLightbox entry={selected.entry} onClose={() => setSelected(null)} />
        ))}
    </div>
  );
}

/** How far past the viewport a tile keeps its `<img>` mounted. Beyond this the
 *  src is dropped so WebKit can release the decoded bitmap — `loading="lazy"`
 *  only defers the *first* load and `content-visibility:auto` only skips
 *  layout/paint; neither frees decode memory once an image has loaded. Without
 *  this, scrolling a multi-thousand-frame timeline pins every decoded thumb
 *  (~0.4MB each) for the life of the page — gigabytes of webview footprint. */
const IMG_KEEP_MARGIN = "1200px 0px";

function FrameCard({ frame, onOpen }: { frame: Screenshot; onOpen: () => void }) {
  const { t } = useTranslation("screen");
  const [loaded, setLoaded] = useState(false);
  const [nearby, setNearby] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setNearby(entry.isIntersecting);
        // Re-run the fade-in when the tile scrolls back and the img remounts.
        if (!entry.isIntersecting) setLoaded(false);
      },
      { rootMargin: IMG_KEEP_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const snippet = (frame.ocrText ?? "").replace(/\s+/g, " ").trim();
  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onOpen}
      // content-visibility:auto skips layout + paint for tiles scrolled out of
      // view (with a reserved intrinsic height so the scrollbar stays stable) —
      // the lever that keeps a several-hundred-frame timeline smooth.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/30"
    >
      <div className="aspect-[16/10] overflow-hidden bg-muted">
        {nearby && (frame.thumbPath || frame.filePath) ? (
          <img
            // Prefer the small thumbnail; fall back to the full frame for rows
            // captured before thumbnails existed. decoding=async keeps JPEG decode
            // off the main thread; the opacity fade hides the decode pop-in.
            src={convertFileSrc(frame.thumbPath || frame.filePath)}
            loading="lazy"
            decoding="async"
            alt=""
            onLoad={() => setLoaded(true)}
            className={cn(
              "size-full object-cover transition-[opacity,transform] duration-200 group-hover:scale-[1.02]",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        ) : frame.thumbPath || frame.filePath ? (
          // Far offscreen: keep the aspect box (scroll stability) but no <img>.
          <div className="size-full" />
        ) : (
          // Pixels pruned by tiered retention — the searchable text remains.
          <div className="flex size-full flex-col items-center justify-center gap-1.5 p-3 text-muted-foreground">
            <FileText className="size-5" />
            <span className="text-[10px]">{t("textOnly")}</span>
          </div>
        )}
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

/** Text-only tile for an AX observation (ambient collector): the excerpt fills
 *  the image slot so the grid stays uniform, with a small badge telling it
 *  apart from a frame. */
function AxCard({ entry, onOpen }: { entry: AmbientEntry; onOpen: () => void }) {
  const { t } = useTranslation("screen");
  const excerpt = entry.text.replace(/\s+/g, " ").trim();
  const title = (entry.pageTitle || entry.windowTitle || "").trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/30"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-muted/60 p-2.5">
        <p className="line-clamp-[7] break-words text-[11px] leading-snug text-muted-foreground">
          {excerpt || title}
        </p>
        <span className="absolute right-1.5 top-1.5 rounded border border-border bg-background/85 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("axBadge")}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium">
            {entry.appName || t("unknownApp")}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatTime(entry.ts)}
          </span>
        </div>
        {title && (
          <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {title}
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
          {frame.filePath ? (
            <img
              src={convertFileSrc(frame.filePath)}
              alt=""
              className="max-h-[82vh] max-w-full rounded object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <FileText className="size-8" />
              <span className="text-xs">{t("textOnly")}</span>
            </div>
          )}
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
          {frame.filePath && (
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
          )}
        </aside>
      </div>
    </div>
  );
}

/** Full-text view of one AX observation — the text-only sibling of Lightbox. */
function AxLightbox({ entry, onClose }: { entry: AmbientEntry; onClose: () => void }) {
  const { t } = useTranslation("screen");
  const { t: tc } = useTranslation("common");
  const title = (entry.pageTitle || entry.windowTitle || "").trim();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-border p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                {entry.appName || t("unknownAppFull")}
              </span>
              <span className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("axBadge")}
              </span>
            </div>
            {title && (
              <div className="truncate text-xs text-muted-foreground">{title}</div>
            )}
            <div className="text-xs text-muted-foreground">
              {new Date(entry.ts).toLocaleString()}
            </div>
            {entry.url && (
              <div className="select-text break-all text-xs text-muted-foreground">
                {entry.url}
              </div>
            )}
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
            {t("axCapturedText")}
          </div>
          {entry.text.trim() ? (
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
              {entry.text.trim()}
            </p>
          ) : (
            <p className="text-xs italic text-muted-foreground">
              {t("noRecognizedText")}
            </p>
          )}
        </div>
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

function groupByDay(items: HistoryItem[], t: TFn) {
  const order: string[] = [];
  const map = new Map<string, { key: string; label: string; items: HistoryItem[] }>();
  for (const it of items) {
    const ts = itemTs(it);
    const key = dayKey(ts);
    let g = map.get(key);
    if (!g) {
      g = { key, label: dayLabel(ts, t), items: [] };
      map.set(key, g);
      order.push(key);
    }
    g.items.push(it);
  }
  return order.map((k) => map.get(k)!);
}
