import { createContext, type ReactNode, useContext } from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * Shared rehype-katex options. Assistant output routinely drops CJK text or
 * stray symbols inside `$ … $` (e.g. "斯" in a formula), which KaTeX's default
 * `strict: "warn"` floods the console with (unicodeTextInMathMode and friends).
 * These are chat messages, not spec-authored LaTeX, so downgrade strict checks
 * to "ignore" — the math still renders; we just stop the warning spam. Errors
 * that actually break rendering still surface (throwOnError stays off → KaTeX
 * shows the offending source in red, as before).
 */
export const KATEX_OPTIONS = { strict: "ignore" as const, throwOnError: false };

/**
 * Shared remark-math options. Single-dollar math is OFF: chat text routinely
 * contains currency ("$1", "-$0.10"), and remark-math pairs those bare `$`
 * signs into one giant inline "formula" spanning whole sentences — which KaTeX
 * then renders as an unwrappable nowrap span that forces a horizontal
 * scrollbar. Real math still works: models emit `\( … \)` / `\[ … \]`, which
 * normalizeMath rewrites to the double-dollar form below.
 */
export const REMARK_MATH_OPTIONS = { singleDollarTextMath: false };

/**
 * Models emit math in LaTeX delimiters (`\[ … \]` for display, `\( … \)` for
 * inline), but remark-math only understands dollar delimiters. Worse, raw
 * markdown treats `\[` as an *escaped* bracket, so untouched output renders as
 * literal `[ … ]` with bare TeX inside. Rewrite the delimiters to the
 * double-dollar form (single-dollar parsing is disabled — see
 * REMARK_MATH_OPTIONS; inline `$$ … $$` is still inline math to remark-math)
 * so KaTeX can pick them up — but skip fenced/inline code so a literal `\(`
 * in a code sample isn't mangled.
 */
export function normalizeMath(text: string): string {
  // Odd indices are the captured code spans/blocks; leave those untouched.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            // GFM's literal-autolink tokenizer treats emphasis delimiters
            // touching a bare URL as part of the URL. For example,
            // `**https://example.com**` otherwise renders both pairs of `**`
            // literally and opens `https://example.com**`. Make the link
            // explicit before parsing so the surrounding emphasis remains
            // structural Markdown. Keep this inside the code-span split so
            // examples in code stay byte-for-byte unchanged.
            .replace(
              // The closer must be followed by a break: whitespace, end, or
              // punctuation — including full-width CJK marks like （ and ，.
              /(\*{1,3})(https?:\/\/[^\s<*]+?)\1(?=\s|$|\p{P})/giu,
              "$1[$2]($2)$1",
            )
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `$$${body}$$`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$$${body}$$`),
    )
    .join("");
}

// Codex desktop cites files with a remark directive — `:codex-file-citation
// {path="/abs/path" purpose="source"}` — that plain markdown renders as literal
// text. Only the opening token is fixed; attributes never contain braces.
const CODEX_CITATION_RE = /:codex-file-citation\{([^{}]*)\}/g;
const CODEX_CITATION_OPEN = ":codex-file-citation{";

/**
 * Rewrite Codex file-citation directives into ordinary markdown file links so
 * the existing link pipeline (open_path for local paths) picks them up. The
 * label is the basename; for files Cetus itself stashed under an attachments
 * dir, the anti-collision `<8-hex>-` prefix is dropped to restore the name the
 * user attached. Code spans/fences are left byte-for-byte untouched.
 */
export function normalizeCodexCitations(text: string): string {
  if (!text.includes(CODEX_CITATION_OPEN)) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(CODEX_CITATION_RE, (whole, attrs: string) => {
            const path = /path="([^"]*)"/.exec(attrs)?.[1];
            if (!path) return "";
            let name = path.split(/[\\/]/).pop() || path;
            if (/[\\/]attachments[\\/]/.test(path))
              name = name.replace(/^[0-9a-f]{8}-/, "");
            // Angle-bracket destinations tolerate spaces/CJK but not <, >, or
            // a raw backslash-escapable sequence; label brackets would end the
            // link text early.
            const label = name.replace(/([[\]])/g, "\\$1");
            const dest = path.replace(/</g, "%3C").replace(/>/g, "%3E");
            return `[${label}](<${dest}>)`;
          }),
    )
    .join("");
}

/** Hide a citation directive the stream hasn't finished emitting: either an
 *  opened-but-unclosed attribute block, or a partially streamed opener at the
 *  very end of the text. Streaming-tail only — settled text renders in full. */
export function stripDanglingCodexCitation(text: string): string {
  const open = text.lastIndexOf(CODEX_CITATION_OPEN);
  if (open !== -1 && !text.includes("}", open)) return text.slice(0, open);
  for (let n = CODEX_CITATION_OPEN.length - 1; n >= 2; n--) {
    if (text.endsWith(CODEX_CITATION_OPEN.slice(0, n)))
      return text.slice(0, text.length - n);
  }
  return text;
}

/**
 * Open a link in the default browser instead of letting the WKWebView navigate.
 *
 * A bare in-webview `<a>` click both replaces the cetus UI and triggers macOS
 * Universal Links — so Lark/Feishu doc links (`*.larksuite.com`, `*.feishu.cn`)
 * open the Feishu app instead of the page. Routing through `open_external`
 * resolves the http(s) scheme to the browser, so the page actually opens there.
 */
export function openExternal(href: string) {
  invoke("open_external", { url: href }).catch(console.error);
}

/** Keep react-markdown's URL filtering, but allow explicit local file URLs. */
export function markdownUrlTransform(url: string): string {
  return url.toLowerCase().startsWith("file:") ? url : defaultUrlTransform(url);
}

function decodeLocalPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    // A literal '%' is valid in a filename even though it is not a valid URL
    // escape. In that case, hand the original path to the OS unchanged.
    return path;
  }
}

/** Return a filesystem path for local markdown links, or null for web links. */
export function localPathFromHref(href: string): string | null {
  if (href.startsWith("/")) return decodeLocalPath(href);
  if (!href.toLowerCase().startsWith("file:")) return null;

  try {
    const url = new URL(href);
    // Do not turn remote file shares into local paths. `localhost` is the only
    // host commonly emitted in an otherwise-local file URL.
    if (url.hostname && url.hostname !== "localhost") return null;
    const path = decodeLocalPath(url.pathname);
    // URL.pathname prefixes Windows drive paths with a slash.
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** Open web links in the browser and local links with their default app. */
export const MarkdownWorkspaceContext = createContext<string | null>(null);

/** Resolve a model-emitted relative file link against its conversation workspace. */
export function relativePathFromHref(href: string, workspaceDir?: string | null): string | null {
  if (!workspaceDir || !href || href.startsWith("#")) return null;
  // Anything with a URI scheme is not a relative filesystem path. This also
  // keeps mailto:, data:, and custom schemes out of open_path.
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;

  const relative = decodeLocalPath(href.split(/[?#]/, 1)[0]);
  if (!relative) return null;
  const separator = workspaceDir.includes("\\") ? "\\" : "/";
  return `${workspaceDir.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

export function openMarkdownLink(href: string, workspaceDir?: string | null) {
  const path = localPathFromHref(href) ?? relativePathFromHref(href, workspaceDir);
  const request = path
    ? invoke("open_path", { path })
    : invoke("open_external", { url: href });
  request.catch(console.error);
}

/** Link renderer for assistant markdown — relies on prose styles for color. */
export const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const workspaceDir = useContext(MarkdownWorkspaceContext);
    return (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          if (!href || href.startsWith("#")) return;
          e.preventDefault();
          openMarkdownLink(href, workspaceDir);
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt, ...props }) {
    // WKWebView cannot load file:// URLs (or absolute filesystem paths treated
    // as web-root URLs) directly. Route local images through Tauri's asset
    // protocol, just like artifact previews do.
    const localPath =
      typeof src === "string" ? localPathFromHref(src) : null;
    return (
      <img
        {...props}
        src={localPath ? convertFileSrc(localPath) : src}
        alt={alt ?? ""}
      />
    );
  },
};

// First non-ASCII punctuation or symbol in a run of URL-ish text: the
// full-width `）。，：` that Chinese prose glues straight onto a URL.
const CJK_URL_BREAK = /(?![\x00-\x7f])[\p{P}\p{S}]/u;
// GFM's trailing-punctuation set for literal autolinks.
const GFM_URL_TRAIL = /[?!.,:*_~]+$/;

/**
 * Split a bare URL from the CJK prose that GFM's literal-autolink tokenizer
 * glued onto it. That tokenizer ends a URL only at whitespace or `<`, so
 * `https://x.com/p/abc）。本地稿在` links the whole run. Cut at the first
 * non-ASCII punctuation/symbol (CJK *letters* stay — `/wiki/中文` is a real
 * path), then re-apply GFM's own trailing rules at the new boundary: strip
 * `?!.,:*_~` and an unbalanced closing paren, as it would have done had the
 * URL ended there. Returns [url, rest]; rest is "" when nothing was cut.
 */
export function splitBareUrl(text: string): [string, string] {
  const m = CJK_URL_BREAK.exec(text);
  if (!m) return [text, ""];
  let url = text.slice(0, m.index);
  for (;;) {
    const trimmed = url.replace(GFM_URL_TRAIL, "");
    if (
      trimmed.endsWith(")") &&
      (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)
    ) {
      url = trimmed.slice(0, -1);
      continue;
    }
    if (trimmed === url) break;
    url = trimmed;
  }
  return [url, text.slice(url.length)];
}

// Minimal mdast shape; enough to walk and patch link nodes without pulling
// in @types/mdast or unist-util-visit as direct deps.
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
}

/**
 * remark plugin: give literal autolinks a CJK-aware end. Runs after remark-gfm
 * has tokenized, and rewrites any link whose href is its own text (the
 * signature of a literal autolink — `www.` ones carry an `http://` prefix)
 * so the URL stops at the first full-width punctuation mark and the rest of
 * the sentence goes back to being prose. See splitBareUrl.
 */
export function remarkTrimAutolinkCjk() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const link = kids[i];
        if (link.type !== "link" || link.children?.length !== 1) {
          walk(link);
          continue;
        }
        const text = link.children[0];
        if (
          text.type !== "text" ||
          typeof text.value !== "string" ||
          typeof link.url !== "string" ||
          !link.url.endsWith(text.value)
        )
          continue;
        const [url, rest] = splitBareUrl(text.value);
        if (!rest || !url) continue;
        const prefix = link.url.slice(0, link.url.length - text.value.length);
        text.value = url;
        link.url = prefix + url;
        kids.splice(i + 1, 0, { type: "text", value: rest });
        i++;
      }
    };
    walk(tree);
  };
}

// Bare http(s):// or www. URLs. Trailing sentence punctuation is peeled off the
// match below so "see https://x.com." doesn't swallow the period.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[a-z0-9][^\s<]*)/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/**
 * Render plain text, turning bare URLs into clickable links while leaving
 * everything else literal. Used for user messages, which are intentionally not
 * markdown-rendered (so a stray `**` or `#` isn't reinterpreted) but should
 * still surface a pasted URL as a styled, openable link.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = new RegExp(URL_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const [bare, cjkRest] = splitBareUrl(raw);
    const punct = bare.match(TRAILING_PUNCT)?.[0] ?? "";
    const url = bare.slice(0, bare.length - punct.length);
    const trail = punct + cjkRest;
    const href = url.startsWith("www.") ? `https://${url}` : url;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={m.index}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          openExternal(href);
        }}
        className="underline underline-offset-2 decoration-1 hover:decoration-2 break-all"
      >
        {url}
      </a>,
    );
    if (trail) parts.push(trail);
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// A fence opener/closer at the start of a line. Used only for parity: an odd
// count means the text ends inside a code block, where nothing is emphasis.
const FENCE_LINE = /^ {0,3}(?:```|~~~)/gm;

/**
 * Close inline markdown that the stream hasn't finished emitting yet.
 *
 * While a reply streams, `**bold**` arrives one chunk at a time, so the tail
 * spends a beat as an unclosed `**…` — which CommonMark renders as literal
 * asterisks (and, for a bare URL, lets GFM's autolinker swallow the delimiter
 * into the href). The text visibly flickers `**` on and off. Feeding the parser
 * a balanced string instead makes the fragment render as the emphasis it is
 * about to become. Only ever applied to the streaming tail; a settled message
 * always renders its exact source (see AssistantMarkdown).
 */
export function healStreamingInline(text: string): string {
  // Inside an open code fence nothing is emphasis, and the fence itself can
  // only be closed by the model. Leave it alone.
  if ((text.match(FENCE_LINE)?.length ?? 0) % 2 === 1) return text;

  // Drop complete code spans (and complete fences) so delimiters written as
  // code don't count. A *dangling* backtick stays behind in `prose`.
  let prose = text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .filter((_, i) => i % 2 === 0)
    .join("");

  let suffix = "";
  const openSpan = prose.lastIndexOf("`");
  if (openSpan !== -1) {
    // Everything after the dangling backtick is code-in-progress, not prose.
    prose = prose.slice(0, openSpan);
    suffix = "`";
  }

  if ((prose.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    // A `**` with nothing after it yet has no content to embolden; closing it
    // would render `****`, which is literal. Hide the opener until text lands.
    if (/\*\*$/.test(text)) return text.slice(0, -2);
    suffix += "**";
  }
  return text + suffix;
}
