"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  FileText,
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
  formatBytes,
  type ArtifactDetails,
} from "@/lib/artifact";
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

/** Unified file-card used both inline in chat bubbles and in the artifacts
 *  panel. Modelled after nex-studio's PreviewCard: aspect-square preview on
 *  top, filename + metadata footer below, click to open a full preview. */
export function ArtifactView({ artifact }: Props) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const url = artifactUrl(artifact.path);
  const kindLabel = labelFor(artifact, t);

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
        className="group/preview-card block w-96 max-w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("artifact.open", { name: artifact.name })}
      >
        <div
          className={cn(
            "flex flex-col overflow-hidden rounded-xl border border-border/80 bg-card transition-all duration-200",
            "shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]",
            "group-hover/preview-card:border-border group-hover/preview-card:shadow-[0_12px_32px_rgba(0,0,0,0.10),0_2px_6px_rgba(0,0,0,0.06)]",
          )}
        >
          <div className="relative aspect-square w-full overflow-hidden bg-card">
            <Thumbnail artifact={artifact} url={url} />
          </div>
          <div className="border-t border-border/60 bg-muted/40 px-3.5 py-2.5">
            <p className="truncate text-[13px] font-semibold text-foreground">
              {artifact.caption ?? artifact.name}
            </p>
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {artifact.caption ? `${artifact.name} · ` : ""}
              {kindLabel} · {formatBytes(artifact.sizeBytes)}
            </p>
          </div>
        </div>
      </div>

      <ArtifactPreviewDialog
        artifact={artifact}
        url={url}
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
          className="h-full w-full object-cover transition-transform duration-500 group-hover/preview-card:scale-[1.03]"
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
      return <IconThumb Icon={FileText} label="PDF" />;
    default:
      return <IconThumb Icon={FileIcon} label={extLabel(artifact, t)} />;
  }
}

function VideoThumbnail({
  artifact,
  url,
}: {
  artifact: ArtifactDetails;
  url: string;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl(null);
    invoke<string | null>("get_artifact_thumbnail", { path: artifact.path })
      .then((path) => {
        if (!cancelled && path) setThumbnailUrl(artifactUrl(path));
      })
      // Quick Look may not support every codec. The video element below is the
      // cross-platform fallback and seeks just far enough to paint a real frame.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifact.path]);

  const mediaClass =
    "h-full w-full object-cover transition-transform duration-500 group-hover/preview-card:scale-[1.03]";

  return (
    <>
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={artifact.caption ?? artifact.name}
          className={mediaClass}
          loading="lazy"
          onError={() => setThumbnailUrl(null)}
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
        <div className="rounded-full bg-background/80 p-2.5 shadow-md backdrop-blur-sm transition-transform duration-200 group-hover/preview-card:scale-110">
          <Play className="size-5 fill-current" />
        </div>
      </div>
    </>
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
  url,
  open,
  onOpenChange,
}: {
  artifact: ArtifactDetails;
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tc } = useTranslation("common");

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
        className="flex h-[calc(100svh/var(--zoom,1)-4rem)] w-[calc(100svw/var(--zoom,1)-4rem)] max-w-none flex-col gap-0 overflow-hidden bg-background p-0 duration-200 data-[state=open]:slide-in-from-bottom-4 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{artifact.name}</DialogTitle>
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {artifact.caption ?? artifact.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {artifact.caption ? `${artifact.name} · ` : ""}
              {labelFor(artifact, t)} · {formatBytes(artifact.sizeBytes)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                invoke("open_path", { path: artifact.path }).catch(console.error)
              }
              title={t("artifact.openExternal")}
            >
              <ExternalLink className="size-3.5" />
              {t("artifact.openExternal")}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a href={url} download={artifact.name} title={t("artifact.download")}>
                <Download className="size-3.5" />
                {t("artifact.download")}
              </a>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                invoke("reveal_in_finder", { path: artifact.path }).catch(
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
        <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
          <FullPreview artifact={artifact} url={url} />
        </div>
      </DialogContent>
    </Dialog>
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
