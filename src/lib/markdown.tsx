import { type ReactNode } from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { invoke } from "@tauri-apps/api/core";

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
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `$$${body}$$`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$$${body}$$`),
    )
    .join("");
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
export function openMarkdownLink(href: string) {
  const path = localPathFromHref(href);
  const request = path
    ? invoke("open_path", { path })
    : invoke("open_external", { url: href });
  request.catch(console.error);
}

/** Link renderer for assistant markdown — relies on prose styles for color. */
export const markdownComponents: Components = {
  a({ href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          if (!href) return;
          e.preventDefault();
          openMarkdownLink(href);
        }}
      >
        {children}
      </a>
    );
  },
};

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
    const trail = raw.match(TRAILING_PUNCT)?.[0] ?? "";
    const url = raw.slice(0, raw.length - trail.length);
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
