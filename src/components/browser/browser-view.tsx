"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Highlighter,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ZOOM_EVENT } from "@/hooks/use-zoom";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

export interface BrowserAnnotation {
  id: string;
  url: string;
  xPct: number;
  yPct: number;
  note: string;
}

export interface BrowserViewState {
  address: string;
  url: string;
  inlinePreview: boolean;
  annotations: BrowserAnnotation[];
  history: string[];
  historyIndex: number;
}

export function createBrowserViewState(): BrowserViewState {
  return {
    address: "about:blank",
    url: "about:blank",
    inlinePreview: false,
    annotations: [],
    history: ["about:blank"],
    historyIndex: 0,
  };
}

interface Props {
  state: BrowserViewState;
  onStateChange: (state: BrowserViewState) => void;
  onAnnotate: (message: string) => Promise<void>;
}

export function BrowserView({ state, onStateChange, onAnnotate }: Props) {
  const { t } = useTranslation("chat");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const panelHostRef = useRef<HTMLDivElement | null>(null);
  const embeddedUrlRef = useRef<string | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  const suppressNextEmitRef = useRef(false);
  const panelAnnotationModeRef = useRef(false);
  const [address, setAddress] = useState(state.address);
  const [url, setUrl] = useState(state.url);
  const [loading, setLoading] = useState(false);
  const [inlinePreview, setInlinePreview] = useState(state.inlinePreview);
  const [panelAnnotating, setPanelAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>(state.annotations);
  const [history, setHistory] = useState<string[]>(state.history);
  const [historyIndex, setHistoryIndex] = useState(state.historyIndex);
  const [openError, setOpenError] = useState<string | null>(null);

  const displayHost = useMemo(() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }, [url]);

  const annotationLabels = useMemo(
    () => ({
      annotate: t("browser.annotate"),
      placeholder: t("browser.annotationPlaceholder"),
      cancel: t("browser.cancelAnnotation"),
      send: t("browser.send"),
    }),
    [t],
  );

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("browser-annotation", () => {
      panelAnnotationModeRef.current = false;
      setPanelAnnotating(false);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const incomingUrlChanged = state.url !== url;
    let changed = false;
    if (state.address !== address) setAddress(state.address);
    if (incomingUrlChanged) {
      setUrl(state.url);
      setPanelAnnotating(false);
      panelAnnotationModeRef.current = false;
      changed = true;
    }
    if (state.address !== address) changed = true;
    if (state.inlinePreview !== inlinePreview) {
      setInlinePreview(state.inlinePreview);
      changed = true;
    }
    if (!sameAnnotations(state.annotations, annotations)) {
      setAnnotations(state.annotations);
      changed = true;
    }
    if (!sameStringArray(state.history, history)) {
      setHistory(state.history);
      changed = true;
    }
    if (state.historyIndex !== historyIndex) {
      setHistoryIndex(state.historyIndex);
      changed = true;
    }
    if (changed) suppressNextEmitRef.current = true;
    // Only external tab-state changes should drive this sync. Local edits are
    // written upward by the effect below and must not be rolled back by stale
    // props from the previous render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (suppressNextEmitRef.current) {
      suppressNextEmitRef.current = false;
      return;
    }
    onStateChangeRef.current({
      address,
      url,
      inlinePreview,
      annotations,
      history,
      historyIndex,
    });
  }, [address, url, inlinePreview, annotations, history, historyIndex]);

  const panelBounds = useCallback(() => {
    const el = panelHostRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const zoom = currentZoom();
    return {
      x: rect.left * zoom,
      y: rect.top * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }, []);

  const openEmbedded = useCallback(async (next: string) => {
    if (inlinePreview) return;
    if (next === "about:blank") {
      embeddedUrlRef.current = null;
      setLoading(false);
      setOpenError(null);
      await api.closeBrowserPanel();
      return;
    }
    const bounds = panelBounds();
    if (!bounds || bounds.width < 2 || bounds.height < 2) return;
    setLoading(true);
    setOpenError(null);
    try {
      await api.openBrowserPanel(next, bounds, annotationLabels);
      embeddedUrlRef.current = next;
      if (panelAnnotationModeRef.current) {
        await api.setBrowserPanelAnnotationMode(true);
      }
    } catch (e) {
      setOpenError(String(e));
    } finally {
      setLoading(false);
    }
  }, [annotationLabels, inlinePreview, panelBounds]);

  function navigate(nextRaw: string, replace = false) {
    const next = normalizeUrl(nextRaw);
    setAddress(next);
    setUrl(next);
    if (replace) {
      setHistory((xs) => xs.map((x, i) => (i === historyIndex ? next : x)));
    } else {
      setHistory((xs) => [...xs.slice(0, historyIndex + 1), next]);
      setHistoryIndex((i) => i + 1);
    }
    void openEmbedded(next);
  }

  function submitAddress(e: FormEvent) {
    e.preventDefault();
    navigate(address);
  }

  function moveHistory(delta: -1 | 1) {
    const nextIndex = historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setHistoryIndex(nextIndex);
    setAddress(history[nextIndex]);
    setUrl(history[nextIndex]);
    void openEmbedded(history[nextIndex]);
  }

  async function setElementAnnotationMode(enabled: boolean) {
    panelAnnotationModeRef.current = enabled;
    setPanelAnnotating(enabled);
    if (inlinePreview) {
      setInlinePreview(false);
      return;
    }
    if (embeddedUrlRef.current !== url) {
      await openEmbedded(url);
    }
    await api.setBrowserPanelAnnotationMode(enabled);
  }

  useEffect(() => {
    if (inlinePreview) {
      embeddedUrlRef.current = null;
      api.closeBrowserPanel().catch(console.error);
      panelAnnotationModeRef.current = false;
      setPanelAnnotating(false);
      return;
    }
    let frame = 0;
    const open = () => {
      frame = window.requestAnimationFrame(() => {
        void openEmbedded(url);
      });
    };
    open();
    const el = panelHostRef.current;
    const resize = new ResizeObserver(() => {
      const bounds = panelBounds();
      if (bounds && bounds.width >= 2 && bounds.height >= 2) {
        if (embeddedUrlRef.current === url) {
          api.setBrowserPanelBounds(bounds).catch(console.error);
        } else {
          void openEmbedded(url);
        }
      }
    });
    if (el) resize.observe(el);
    window.addEventListener("resize", open);
    window.addEventListener(ZOOM_EVENT, open);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", open);
      window.removeEventListener(ZOOM_EVENT, open);
      resize.disconnect();
      embeddedUrlRef.current = null;
      api.closeBrowserPanel().catch(console.error);
    };
  }, [inlinePreview, openEmbedded, panelBounds, url]);

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      data-testid="browser-view"
      data-url={url}
      data-inline-preview={inlinePreview ? "true" : "false"}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            onClick={() => moveHistory(-1)}
            disabled={historyIndex === 0}
            title={t("browser.back")}
            aria-label={t("browser.back")}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            onClick={() => moveHistory(1)}
            disabled={historyIndex >= history.length - 1}
            title={t("browser.forward")}
            aria-label={t("browser.forward")}
          >
            <ArrowRight className="size-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            onClick={() => {
              void openEmbedded(url);
              if (inlinePreview) iframeRef.current?.contentWindow?.location.reload();
            }}
            title={t("browser.reload")}
            aria-label={t("browser.reload")}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        <form onSubmit={submitAddress} className="min-w-0 flex-1">
          <div className="relative">
            <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="h-7 pl-8 pr-2 text-[13px]"
              spellCheck={false}
              data-testid="browser-address"
            />
          </div>
        </form>
        <Button
          type="button"
          size="xs"
          variant={inlinePreview ? "default" : "outline"}
          data-testid="browser-inline-preview-toggle"
          onClick={() => {
            setInlinePreview((v) => !v);
          }}
          title={t("browser.togglePreview")}
        >
          <Globe className="size-3.5" />
          {t("browser.preview")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant={panelAnnotating ? "default" : "outline"}
          data-testid="browser-annotate"
          onClick={() => {
            void setElementAnnotationMode(!panelAnnotating);
          }}
          title={t("browser.annotate")}
        >
          <Highlighter className="size-3.5" />
          {t("browser.annotate")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 px-0"
          onClick={() => api.openBrowserWindow(url).catch(console.error)}
          title={t("browser.openWindow")}
          aria-label={t("browser.openWindow")}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        {loading && (
          <div className="pointer-events-none absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
            <Loader2 className="size-3.5 animate-spin" />
            {displayHost}
          </div>
        )}
        {inlinePreview ? (
          <>
            <iframe
              ref={iframeRef}
              src={url}
              title={t("browser.title")}
              className="h-full w-full bg-white"
              data-testid="browser-inline-frame"
              onLoad={() => setLoading(false)}
              referrerPolicy="no-referrer-when-downgrade"
              allow="clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera"
            />
          </>
        ) : (
          <div
            ref={panelHostRef}
            className="h-full bg-background"
            data-testid="browser-panel-host"
          >
            {openError && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-center">
                <div className="max-w-md px-6">
                  <div className="mx-auto grid size-12 place-items-center rounded-md border border-border bg-muted/40">
                    <Globe className="size-5 text-muted-foreground" />
                  </div>
                  <h2 className="mt-4 text-sm font-medium">{t("browser.title")}</h2>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {url}
                  </p>
                  <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {openError}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    onClick={() => void openEmbedded(url)}
                  >
                    <ExternalLink className="size-3.5" />
                    {t("browser.open")}
                  </Button>
                </div>
              </div>
            )}
            {!openError && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background text-center text-xs text-muted-foreground">
                <div>
                  <Globe className="mx-auto mb-3 size-6 opacity-50" />
                  <p className="font-medium text-foreground">{t("browser.title")}</p>
                  <p className="mt-1">{t("browser.empty")}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "about:blank";
  if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

function currentZoom(): number {
  try {
    const value = Number(localStorage.getItem("cetus:zoom"));
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameAnnotations(a: BrowserAnnotation[], b: BrowserAnnotation[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => {
      const other = b[index];
      return (
        other &&
        value.id === other.id &&
        value.url === other.url &&
        value.xPct === other.xPct &&
        value.yPct === other.yPct &&
        value.note === other.note
      );
    })
  );
}
