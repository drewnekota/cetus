"use client";
// Fenced code that is really a diagram (Mermaid) renders as the picture, with
// a Diagram / Code switch so the source stays one click away. Mermaid is
// loaded on first use only: it is by far the heaviest dependency in the chat
// pane and most replies never contain a diagram.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Code2, Copy, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** True while the enclosing markdown fragment is still being streamed. A
 *  diagram inside a still-growing fence would fail to parse on every token, so
 *  consumers keep showing the source until the fragment settles. */
export const MarkdownStreamingContext = createContext(false);

// Diagram languages we render. Only Mermaid today; the switch is here so a
// second engine (e.g. Graphviz) slots in without touching the fence renderer.
export type DiagramLanguage = "mermaid";

// First meaningful line of a Mermaid document. Models routinely omit the
// ```mermaid tag, so an untagged fence that opens like one is treated as one.
const MERMAID_HEAD =
  /^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b|^(sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|xychart-beta|sankey-beta|block-beta|packet-beta|kanban|architecture-beta|radar-beta|treemap-beta)\b/;

/** Diagram language for a fenced block, or null when it is ordinary code. */
export function detectDiagramLanguage(
  language: string | null,
  source: string,
): DiagramLanguage | null {
  if (language === "mermaid" || language === "mmd") return "mermaid";
  if (language) return null;
  // Skip Mermaid front matter / directives / comments before the header line.
  const lines = source.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    return MERMAID_HEAD.test(line) ? "mermaid" : null;
  }
  return null;
}

// Mermaid wants concrete colors; the app's tokens are color-mix() expressions
// on <html>, so resolve them through a probe element instead of reading the
// custom properties directly.
function resolveColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function themeVariables() {
  const dark = document.documentElement.classList.contains("dark");
  const foreground = resolveColor("--foreground");
  const background = resolveColor("--background");
  const secondary = resolveColor("--secondary");
  const border = resolveColor("--border");
  const muted = resolveColor("--muted-foreground");
  const primary = resolveColor("--primary");
  return {
    darkMode: dark,
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: "14px",
    background,
    mainBkg: secondary,
    primaryColor: secondary,
    primaryTextColor: foreground,
    primaryBorderColor: border,
    secondaryColor: secondary,
    secondaryTextColor: foreground,
    secondaryBorderColor: border,
    tertiaryColor: background,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: border,
    lineColor: muted,
    textColor: foreground,
    titleColor: foreground,
    nodeBorder: border,
    nodeTextColor: foreground,
    clusterBkg: background,
    clusterBorder: border,
    edgeLabelBackground: background,
    actorBkg: secondary,
    actorBorder: border,
    actorTextColor: foreground,
    signalColor: foreground,
    signalTextColor: foreground,
    labelBoxBkgColor: secondary,
    labelBoxBorderColor: border,
    labelTextColor: foreground,
    loopTextColor: foreground,
    noteBkgColor: background,
    noteBorderColor: border,
    noteTextColor: foreground,
    activationBkgColor: background,
    activationBorderColor: primary,
    pie1: primary,
  };
}

/** Bumps whenever the skin or light/dark class on <html> changes, so rendered
 *  diagrams re-theme along with the rest of the UI. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid() {
  mermaidModule ??= import("mermaid").then((m) => m.default);
  return mermaidModule;
}

async function renderMermaid(id: string, source: string): Promise<string | null> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: themeVariables(),
    // strict still allows <br/> in labels (DOMPurify keeps it); anything
    // scriptable is stripped, which matters because the source is model output.
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
  const ok = await mermaid.parse(source, { suppressErrors: true });
  if (!ok) return null;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

type View = "diagram" | "code";

/** A code fence rendered as a diagram, with the source one toggle away. `code`
 *  is the already-rendered <pre> so the code view is byte-identical to any
 *  other fence (same highlighting, same copy behaviour). */
export function DiagramBlock({
  source,
  language: _language,
  code,
}: {
  source: string;
  language: DiagramLanguage;
  code: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const { t: tc } = useTranslation("common");
  const streaming = useContext(MarkdownStreamingContext);
  const themeVersion = useThemeVersion();
  const reactId = useId();
  const [view, setView] = useState<View>("diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    // Mermaid ids must be valid CSS identifiers; React ids contain colons.
    const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    renderMermaid(id, source)
      .then((result) => {
        if (cancelled) return;
        setSvg(result);
        setFailed(result == null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("mermaid render failed", e);
        setSvg(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, streaming, themeVersion, reactId]);

  useEffect(
    () => () => {
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy diagram source failed", e);
    }
  }, [source]);

  // The picture is only available once the fragment settled and Mermaid
  // accepted it; everything else shows the source.
  const showDiagram = view === "diagram" && !streaming && svg != null;
  const copyLabel = copied ? tc("action.copied") : tc("action.copy");

  return (
    <div className="group/diagram relative my-2 min-w-0 max-w-full">
      {showDiagram ? (
        <div
          className="scrollbar-slim flex max-w-full justify-center overflow-x-auto rounded-md border border-border/60 bg-background p-3 pt-9 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="[&_pre]:!my-0 [&_pre]:pr-44">
          {failed && !streaming && (
            <div className="not-prose mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3 shrink-0" />
              <span>{t("diagram.error")}</span>
            </div>
          )}
          {code}
        </div>
      )}
      <div className="not-prose absolute right-1.5 top-1.5 flex h-6 items-center gap-1">
        {!failed && !streaming && (
          <div
            role="tablist"
            className="flex h-6 items-center rounded-md border border-border/60 bg-background p-0.5 text-xs text-muted-foreground shadow-sm"
          >
            <ViewTab
              active={view === "diagram"}
              onClick={() => setView("diagram")}
              icon={<Workflow className="size-3" />}
              label={t("diagram.view")}
            />
            <ViewTab
              active={view === "code"}
              onClick={() => setView("code")}
              icon={<Code2 className="size-3" />}
              label={t("diagram.code")}
            />
          </div>
        )}
        <button
          type="button"
          onClick={copy}
          title={copyLabel}
          aria-label={copyLabel}
          className="flex h-6 items-center gap-1 rounded-md border border-border/60 bg-background px-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span>{copyLabel}</span>
        </button>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-5 items-center gap-1 rounded-[4px] px-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-secondary text-foreground" : "hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
