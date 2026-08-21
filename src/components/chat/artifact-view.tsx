"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  FileText,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  FileIcon,
  Headphones,
  Play,
  Code as CodeIcon,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  artifactUrl,
  artifactsFromDetails,
  formatBytes,
  type ArtifactDetails,
} from "@/lib/artifact";
import { useChatStore } from "@/lib/chat-store";
import { cn } from "@/lib/utils";
import {
  markdownComponents,
  markdownUrlTransform,
  normalizeMath,
  KATEX_OPTIONS,
  REMARK_MATH_OPTIONS,
} from "@/lib/markdown";
import { useTranslation } from "@/lib/i18n";

interface Props {
  artifact: ArtifactDetails;
  /** No longer affects layout — preserved so existing callers still compile. */
  variant?: "inline" | "compact";
}

/** Conversation whose artifacts the preview dialog can page through with the
 *  arrow buttons / arrow keys. Wrap any surface that renders ArtifactViews
 *  belonging to a single conversation (chat message list, board artifacts
 *  grid). Without a provider the dialog shows only the clicked artifact. */
const ArtifactNavContext = createContext<string | null>(null);

export function ArtifactNavProvider({
  convId,
  children,
}: {
  convId: string | null;
  children: React.ReactNode;
}) {
  return (
    <ArtifactNavContext.Provider value={convId}>
      {children}
    </ArtifactNavContext.Provider>
  );
}

const NO_ARTIFACTS: ArtifactDetails[] = [];

/** Artifact kinds that render meaningful content in the aspect-square
 *  preview tile. Everything else (archives, binaries, audio, …) would just
 *  show a huge empty square with an icon, so those fall back to a compact
 *  attachment row instead. */
const RICH_PREVIEW_KINDS = new Set([
  "image",
  "video",
  "html",
  "markdown",
  "text",
  "pdf",
]);

/** Kinds whose source is plain text, so the preview can offer a copy button
 *  that puts the raw file contents on the clipboard. */
const COPYABLE_KINDS = new Set(["markdown", "text", "html"]);

/** Unified file-card used both inline in chat bubbles and in the artifacts
 *  panel. Previewable kinds get an aspect-square preview on top with a
 *  filename + metadata footer;
 *  non-previewable kinds get a compact attachment row. Click opens a full
 *  preview either way. */
export function ArtifactView({ artifact }: Props) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const url = artifactUrl(artifact.path);
  const kindLabel = labelFor(artifact, t);
  const compact = !RICH_PREVIEW_KINDS.has(artifact.artifactKind);

  const meta = (
    <>
      <p className="truncate text-[13px] font-semibold text-foreground">
        {artifact.caption ?? artifact.name}
      </p>
      <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
        {artifact.caption ? `${artifact.name} · ` : ""}
        {kindLabel} · {formatBytes(artifact.sizeBytes)}
      </p>
    </>
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "block max-w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "w-72" : "w-80",
        )}
        aria-label={t("artifact.open", { name: artifact.name })}
      >
        <div
          className={cn(
            "relative isolate overflow-hidden rounded-xl bg-card",
            "shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]",
            compact ? "flex items-center gap-3 px-3.5 py-3" : "flex flex-col",
          )}
        >
          {compact ? (
            <>
              <CompactThumb artifact={artifact} />
              <div className="min-w-0 flex-1">{meta}</div>
            </>
          ) : (
            <>
              <div className="relative aspect-square w-full overflow-hidden bg-card">
                <Thumbnail artifact={artifact} url={url} />
              </div>
              <div className="border-t border-border/60 bg-muted/40 px-3.5 py-2.5">
                {meta}
              </div>
            </>
          )}
          {/* Paint the outline above media layers. A regular border can be
              partially covered by an accelerated image during rounded
              clipping, leaving intermittent 1px gaps at fractional DPRs. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] border border-border/80"
          />
        </div>
      </div>

      <ArtifactPreviewDialog
        artifact={artifact}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

// ---- Thumbnails (small preview tiles) ----------------------------------

function Thumbnail({
  artifact,
  url,
}: {
  artifact: ArtifactDetails;
  url: string;
}) {
  const { t } = useTranslation("chat");
  switch (artifact.artifactKind) {
    case "image":
      return (
        <img
          src={url}
          alt={artifact.caption ?? artifact.name}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      );
    case "video":
      return <VideoThumbnail artifact={artifact} url={url} />;
    case "audio":
      return <IconThumb Icon={Headphones} />;
    case "html":
      return (
        <div className="relative h-full w-full overflow-hidden bg-white">
          <iframe
            src={url}
            title={artifact.name}
            className="pointer-events-none absolute inset-0 h-[200%] w-[200%] origin-top-left scale-[0.5]"
            sandbox=""
            loading="lazy"
            referrerPolicy="no-referrer"
            tabIndex={-1}
          />
        </div>
      );
    case "markdown":
      return (
        <TextThumb
          path={artifact.path}
          fallbackIcon={FileText}
          render={(text) => (
            <div className="prose prose-sm dark:prose-invert h-full w-full max-w-none overflow-hidden bg-card p-4 text-[12px] leading-[1.55] [&>*]:my-1.5 [&>:first-child]:mt-0 [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_pre]:text-[10px]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, [remarkMath, REMARK_MATH_OPTIONS], remarkCjkFriendly]}
                rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
                components={markdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {normalizeMath(text)}
              </ReactMarkdown>
            </div>
          )}
        />
      );
    case "text":
      return (
        <TextThumb
          path={artifact.path}
          fallbackIcon={FileText}
          render={(text) => (
            <pre className="h-full w-full overflow-hidden whitespace-pre-wrap bg-card p-4 text-left font-mono text-[10px] leading-[1.6] text-foreground/80">
              {text}
            </pre>
          )}
        />
      );
    case "pdf":
      return (
        <NativeThumbnail
          artifact={artifact}
          fallback={<IconThumb Icon={FileText} label="PDF" />}
        />
      );
    default:
      return (
        <NativeThumbnail
          artifact={artifact}
          fallback={<IconThumb Icon={FileIcon} label={extLabel(artifact, t)} />}
        />
      );
  }
}

function useArtifactThumbnail(path: string) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl(null);
    invoke<string | null>("get_artifact_thumbnail", { path })
      .then((thumbnailPath) => {
        if (!cancelled && thumbnailPath) {
          setThumbnailUrl(artifactUrl(thumbnailPath));
        }
      })
      // Quick Look may not support every file type. Callers retain their
      // existing icon or media fallback on macOS and other platforms.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { thumbnailUrl, clearThumbnail: () => setThumbnailUrl(null) };
}

function NativeThumbnail({
  artifact,
  fallback,
}: {
  artifact: ArtifactDetails;
  fallback: React.ReactNode;
}) {
  const { thumbnailUrl, clearThumbnail } = useArtifactThumbnail(artifact.path);

  if (!thumbnailUrl) return <>{fallback}</>;

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/20 p-3">
      <img
        src={thumbnailUrl}
        alt={artifact.caption ?? artifact.name}
        className="h-full w-full object-contain drop-shadow-sm"
        loading="lazy"
        onError={clearThumbnail}
      />
    </div>
  );
}

function VideoThumbnail({
  artifact,
  url,
}: {
  artifact: ArtifactDetails;
  url: string;
}) {
  const { thumbnailUrl, clearThumbnail } = useArtifactThumbnail(artifact.path);
  const videoRef = useRef<HTMLVideoElement>(null);

  const mediaClass = "h-full w-full object-cover";

  return (
    <>
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={artifact.caption ?? artifact.name}
          className={mediaClass}
          loading="lazy"
          onError={clearThumbnail}
        />
      ) : (
        <video
          ref={videoRef}
          src={url}
          preload="metadata"
          muted
          playsInline
          className={mediaClass}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
            video.currentTime = Math.min(0.1, video.duration / 10);
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="rounded-full bg-background/80 p-2.5 shadow-md backdrop-blur-sm">
          <Play className="size-5 fill-current" />
        </div>
      </div>
    </>
  );
}

/** Small square tile for the compact attachment row. Tries the native
 *  Quick Look thumbnail (e.g. album art, custom archive icons); falls back
 *  to a kind icon. */
function CompactThumb({ artifact }: { artifact: ArtifactDetails }) {
  const { thumbnailUrl, clearThumbnail } = useArtifactThumbnail(artifact.path);
  const Icon = artifact.artifactKind === "audio" ? Headphones : FileIcon;

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-contain p-1"
          loading="lazy"
          onError={clearThumbnail}
        />
      ) : (
        <Icon className="size-5 text-muted-foreground/60" />
      )}
    </div>
  );
}

function IconThumb({
  Icon,
  label,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/30">
      <Icon className="size-10 text-muted-foreground/40" />
      {label && (
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

function TextThumb({
  path,
  render,
  fallbackIcon: Fallback,
}: {
  path: string;
  render: (text: string) => React.ReactNode;
  fallbackIcon: React.ComponentType<{ className?: string }>;
}) {
  const { text, error } = useFileText(path);
  if (error || text == null) {
    return <IconThumb Icon={Fallback} />;
  }
  return <>{render(text)}</>;
}

// ---- Full-screen preview dialog ----------------------------------------

function ArtifactPreviewDialog({
  artifact,
  open,
  onOpenChange,
}: {
  artifact: ArtifactDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tc } = useTranslation("common");

  const convId = useContext(ArtifactNavContext);
  // Every artifact this conversation has produced, deduped by path so each
  // file appears once in the nav order. Collected only while the dialog is
  // open, so the many closed cards in a long chat don't pay for the scan.
  const sessionArtifacts = useChatStore(
    useShallow((s) => {
      if (!open || !convId) return NO_ARTIFACTS;
      const chat = s.chats[convId];
      if (!chat) return NO_ARTIFACTS;
      const seen = new Set<string>();
      const out: ArtifactDetails[] = [];
      for (const m of chat.messages) {
        for (const b of m.blocks) {
          if (b.kind !== "tool_use" || !b.result) continue;
          for (const a of artifactsFromDetails(b.result.details)) {
            if (!seen.has(a.path)) {
              seen.add(a.path);
              out.push(a);
            }
          }
        }
      }
      return out;
    }),
  );

  // Which artifact the dialog currently shows; null = the one that was
  // clicked. Reset on close so reopening always starts from the clicked card.
  const [activePath, setActivePath] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setActivePath(null);
  }, [open]);

  const currentPath = activePath ?? artifact.path;
  const index = sessionArtifacts.findIndex((a) => a.path === currentPath);
  const current = index >= 0 ? sessionArtifacts[index] : artifact;
  const count = sessionArtifacts.length;
  const canNavigate = count > 1 && index >= 0;
  const url = artifactUrl(current.path);

  const step = useCallback(
    (delta: number) => {
      if (!canNavigate) return;
      const next = sessionArtifacts[(index + delta + count) % count];
      setActivePath(next.path);
    },
    [canNavigate, sessionArtifacts, index, count],
  );

  // Arrow keys page between artifacts. Left alone when a media element or
  // editable target owns the keys (native <video>/<audio> seek with arrows).
  useEffect(() => {
    if (!open || !canNavigate) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(target.tagName))
      )
        return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, canNavigate, step]);

  // HTML artifacts render in a sandboxed iframe whose origin differs from the
  // app webview, so the embedded page can't reach us directly. The injected
  // bridge (see buildHtmlSrcDoc) postMessages Escape presses and link clicks
  // back here: Escape closes the dialog even when focus is inside the iframe,
  // and links open in the system browser rather than navigating the iframe.
  useEffect(() => {
    if (!open) return;
    function onMessage(e: MessageEvent) {
      const d = e.data as { __cetus?: string; url?: string } | null;
      if (!d || typeof d !== "object") return;
      if (d.__cetus === "esc") {
        onOpenChange(false);
      } else if (d.__cetus === "open" && typeof d.url === "string") {
        invoke("open_external", { url: d.url }).catch(console.error);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[calc(100svh-4rem)] w-[calc(100svw-4rem)] max-w-none flex-col gap-0 overflow-hidden bg-background p-0 duration-200 data-[state=open]:slide-in-from-bottom-4 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{current.name}</DialogTitle>
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {current.caption ?? current.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {current.caption ? `${current.name} · ` : ""}
              {labelFor(current, t)} · {formatBytes(current.sizeBytes)}
              {canNavigate ? ` · ${index + 1} / ${count}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {COPYABLE_KINDS.has(current.artifactKind) && (
              <CopySourceButton path={current.path} />
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                invoke("open_path", { path: current.path }).catch(console.error)
              }
              title={t("artifact.openExternal")}
            >
              <ExternalLink className="size-3.5" />
              {t("artifact.openExternal")}
            </Button>
            {/* A native save panel, NOT `<a href={url} download>`: WKWebView
                ignores the download attribute on the asset:// scheme and
                navigates instead, so that anchor replaced the whole cetus UI
                with the raw file — unrecoverable without relaunching. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                invoke("save_artifact_copy", { path: current.path }).catch(
                  console.error,
                )
              }
              title={t("artifact.download")}
            >
              <Download className="size-3.5" />
              {t("artifact.download")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                invoke("reveal_in_finder", { path: current.path }).catch(
                  console.error,
                )
              }
              title={t("artifact.revealInFinder")}
            >
              <FolderOpen className="size-3.5" />
              {t("artifact.reveal")}
            </Button>
            <DialogClose asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                title={tc("action.close")}
                aria-label={tc("action.close")}
              >
                <X className="size-3.5" />
              </Button>
            </DialogClose>
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
          <div className="h-full w-full overflow-auto bg-muted/10">
            {/* Keyed on path so scroll position / media playback reset when
                paging to another artifact. */}
            <FullPreview key={current.path} artifact={current} url={url} />
          </div>
          {canNavigate && (
            <>
              <button
                type="button"
                onClick={() => step(-1)}
                title={t("artifact.prev")}
                aria-label={t("artifact.prev")}
                className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/85 p-2 text-foreground/80 shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                title={t("artifact.next")}
                aria-label={t("artifact.next")}
                className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/85 p-2 text-foreground/80 shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Copies the artifact's raw source (not the rendered DOM) to the clipboard.
 *  Reads on click so opening a preview never pays for a file read it may not
 *  need — the rendered preview loads the same text on its own. */
function CopySourceButton({ path }: { path: string }) {
  const { t: tc } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      const text = await invoke<string>("read_text_file", { path });
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy artifact source failed", e);
    }
  }, [path]);

  const label = copied ? tc("action.copied") : tc("action.copy");
  return (
    <Button type="button" size="sm" variant="ghost" onClick={copy} title={label}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label}
    </Button>
  );
}

function FullPreview({
  artifact,
  url,
}: {
  artifact: ArtifactDetails;
  url: string;
}) {
  const { t } = useTranslation("chat");
  switch (artifact.artifactKind) {
    case "image":
      return (
        <div className="flex h-full w-full items-center justify-center p-4">
          <img
            src={url}
            alt={artifact.caption ?? artifact.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case "video":
      return (
        <div className="flex h-full w-full items-center justify-center bg-black">
          <video src={url} controls className="max-h-full max-w-full" />
        </div>
      );
    case "audio":
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <audio src={url} controls className="w-full max-w-xl" />
        </div>
      );
    case "pdf":
      return (
        <iframe
          src={url}
          title={artifact.name}
          className="h-full w-full bg-white"
        />
      );
    case "html":
      return <HtmlPreview path={artifact.path} url={url} name={artifact.name} />;
    case "markdown":
      return (
        <FullTextLoader
          path={artifact.path}
          render={(text) => (
            <div className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-6">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, [remarkMath, REMARK_MATH_OPTIONS], remarkCjkFriendly]}
                rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
                components={markdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {normalizeMath(text)}
              </ReactMarkdown>
            </div>
          )}
        />
      );
    case "text":
      return (
        <FullTextLoader
          path={artifact.path}
          render={(text) => (
            <pre className="mx-auto max-w-5xl whitespace-pre-wrap px-6 py-6 font-mono text-xs leading-relaxed text-foreground/90">
              {text}
            </pre>
          )}
        />
      );
    default:
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <CodeIcon className="size-12 opacity-40" />
          <span className="text-xs">
            {t("artifact.noPreview")}
          </span>
        </div>
      );
  }
}

// ---- HTML preview (sandboxed iframe + parent bridge) -------------------

/** Bridge script injected into the artifact's <head>. Runs inside the iframe
 *  and forwards Escape presses and link clicks to the parent window so the
 *  dialog can close and links can open externally. Stringified as-is into the
 *  srcdoc; keep it dependency-free. */
const HTML_BRIDGE = `
(function () {
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') parent.postMessage({ __cetus: 'esc' }, '*');
  });
  document.addEventListener('click', function (e) {
    var n = e.target;
    while (n && n.nodeType === 3) n = n.parentNode;
    var a = n && n.closest ? n.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (!raw || raw.charAt(0) === '#') return;
    e.preventDefault();
    parent.postMessage({ __cetus: 'open', url: a.href }, '*');
  }, true);
})();
`;

/** Inject a <base> (so relative resources resolve against the artifact's own
 *  location, matching the previous src= behaviour) and the bridge script into
 *  the document's head. */
function buildHtmlSrcDoc(html: string, baseHref: string): string {
  const base = /<base[\s>]/i.test(html)
    ? ""
    : `<base href="${baseHref}">`;
  const inject = `${base}<script>${HTML_BRIDGE}</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1<head>${inject}</head>`);
  }
  return `${inject}${html}`;
}

function HtmlPreview({
  path,
  url,
  name,
}: {
  path: string;
  url: string;
  name: string;
}) {
  const { text, error } = useFileText(path);
  const { t } = useTranslation("chat");
  if (error)
    return (
      <div className="px-6 py-6 text-destructive">
        {t("artifact.readFailed", { error })}
      </div>
    );
  if (text == null)
    return (
      <div className="px-6 py-6 text-muted-foreground">
        {t("artifact.loading")}
      </div>
    );
  return (
    <iframe
      srcDoc={buildHtmlSrcDoc(text, url)}
      title={name}
      sandbox="allow-same-origin allow-scripts"
      className="h-full w-full bg-white"
    />
  );
}

function FullTextLoader({
  path,
  render,
}: {
  path: string;
  render: (text: string) => React.ReactNode;
}) {
  const { t } = useTranslation("chat");
  const { text, error } = useFileText(path);
  if (error)
    return (
      <div className="px-6 py-6 text-destructive">{t("artifact.readFailed", { error })}</div>
    );
  if (text == null)
    return <div className="px-6 py-6 text-muted-foreground">{t("artifact.loading")}</div>;
  return <>{render(text)}</>;
}

// ---- Shared text loader -------------------------------------------------

function useFileText(path: string) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    invoke<string>("read_text_file", { path })
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  return { text, error };
}

// ---- Labels -------------------------------------------------------------

type Translator = (key: string, vars?: Record<string, string | number>) => string;

function labelFor(a: ArtifactDetails, t: Translator): string {
  switch (a.artifactKind) {
    case "image":
      return t("artifact.kind.image");
    case "video":
      return t("artifact.kind.video");
    case "audio":
      return t("artifact.kind.audio");
    case "pdf":
      return t("artifact.kind.pdf");
    case "markdown":
      return t("artifact.kind.markdown");
    case "html":
      return t("artifact.kind.html");
    case "text":
      return t("artifact.kind.text");
    default:
      return extLabel(a, t);
  }
}

function extLabel(a: ArtifactDetails, t: Translator): string {
  const ext = a.name.split(".").pop();
  if (ext && ext.length <= 5) return ext.toUpperCase();
  const sub = a.mimeType.split("/")[1];
  return sub ? sub.toUpperCase() : t("artifact.kind.file");
}
