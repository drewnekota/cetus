import hljs from "highlight.js/lib/common";

/** Tailwind token colors (GitHub light + dark) applied to highlight.js output.
 *  Spread onto a container whose children are hljs spans. */
export const HLJS_THEME_CLASS = [
  "[&_.hljs-comment]:text-[#6e7781] dark:[&_.hljs-comment]:text-[#8b949e]",
  "[&_.hljs-quote]:text-[#6e7781] dark:[&_.hljs-quote]:text-[#8b949e]",
  "[&_.hljs-keyword]:text-[#cf222e] dark:[&_.hljs-keyword]:text-[#ff7b72]",
  "[&_.hljs-selector-tag]:text-[#cf222e] dark:[&_.hljs-selector-tag]:text-[#ff7b72]",
  "[&_.hljs-subst]:text-[#24292f] dark:[&_.hljs-subst]:text-[#c9d1d9]",
  "[&_.hljs-number]:text-[#0550ae] dark:[&_.hljs-number]:text-[#79c0ff]",
  "[&_.hljs-literal]:text-[#0550ae] dark:[&_.hljs-literal]:text-[#79c0ff]",
  "[&_.hljs-variable]:text-[#953800] dark:[&_.hljs-variable]:text-[#ffa657]",
  "[&_.hljs-template-variable]:text-[#953800] dark:[&_.hljs-template-variable]:text-[#ffa657]",
  "[&_.hljs-string]:text-[#0a3069] dark:[&_.hljs-string]:text-[#a5d6ff]",
  "[&_.hljs-doctag]:text-[#0a3069] dark:[&_.hljs-doctag]:text-[#a5d6ff]",
  "[&_.hljs-title]:text-[#8250df] dark:[&_.hljs-title]:text-[#d2a8ff]",
  "[&_.hljs-section]:text-[#8250df] dark:[&_.hljs-section]:text-[#d2a8ff]",
  "[&_.hljs-selector-id]:text-[#8250df] dark:[&_.hljs-selector-id]:text-[#d2a8ff]",
  "[&_.hljs-type]:text-[#953800] dark:[&_.hljs-type]:text-[#ffa657]",
  "[&_.hljs-class_.hljs-title]:text-[#953800] dark:[&_.hljs-class_.hljs-title]:text-[#ffa657]",
  "[&_.hljs-tag]:text-[#116329] dark:[&_.hljs-tag]:text-[#7ee787]",
  "[&_.hljs-name]:text-[#116329] dark:[&_.hljs-name]:text-[#7ee787]",
  "[&_.hljs-attribute]:text-[#0550ae] dark:[&_.hljs-attribute]:text-[#79c0ff]",
  "[&_.hljs-regexp]:text-[#0a3069] dark:[&_.hljs-regexp]:text-[#a5d6ff]",
  "[&_.hljs-symbol]:text-[#0a3069] dark:[&_.hljs-symbol]:text-[#a5d6ff]",
  "[&_.hljs-bullet]:text-[#0a3069] dark:[&_.hljs-bullet]:text-[#a5d6ff]",
  "[&_.hljs-built_in]:text-[#953800] dark:[&_.hljs-built_in]:text-[#ffa657]",
  "[&_.hljs-builtin-name]:text-[#953800] dark:[&_.hljs-builtin-name]:text-[#ffa657]",
  "[&_.hljs-meta]:text-[#6e7781] dark:[&_.hljs-meta]:text-[#8b949e]",
  "[&_.hljs-deletion]:bg-[#ffebe9] [&_.hljs-deletion]:text-[#82071e] dark:[&_.hljs-deletion]:bg-[#490202] dark:[&_.hljs-deletion]:text-[#ffdcd7]",
  "[&_.hljs-addition]:bg-[#dafbe1] [&_.hljs-addition]:text-[#116329] dark:[&_.hljs-addition]:bg-[#033a16] dark:[&_.hljs-addition]:text-[#aff5b4]",
  "[&_.hljs-emphasis]:italic [&_.hljs-strong]:font-semibold",
] as const;

/** Lowercase extension of a file name ("" when there is none). */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** Map a file extension to a highlight.js language name, or null. */
export function languageForExtension(ext: string): string | null {
  const languages: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    html: "xml",
    htm: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    log: "plaintext",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    ts: "typescript",
    tsx: "typescript",
    toml: "ini",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };
  return languages[ext] ?? null;
}

/** Escape text for safe injection into a code block. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Syntax-highlight source text by extension, falling back to auto-detection,
 *  then plain escaping when highlighting fails. Returns HTML. */
export function highlightSource(text: string, ext: string): string {
  const language = languageForExtension(ext);
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}
