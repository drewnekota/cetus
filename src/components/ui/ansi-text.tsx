import { Fragment, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

interface AnsiStyle {
  foreground?: number | string;
  background?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

// Some CLI bridges decode the ESC byte as U+FFFD before the result reaches the
// UI. Accept that legacy form only when it is followed by a valid SGR command.
const SGR_PATTERN = /(?:\x1b|\uFFFD)\[([0-9;]*)m/g;

const FOREGROUND_CLASSES: Record<number, string> = {
  30: "text-foreground/70",
  31: "text-destructive",
  32: "text-success",
  33: "text-warning",
  34: "text-blue-600 dark:text-blue-400",
  35: "text-fuchsia-600 dark:text-fuchsia-400",
  36: "text-cyan-600 dark:text-cyan-400",
  37: "text-foreground/80",
  90: "text-muted-foreground",
  91: "text-red-500 dark:text-red-400",
  92: "text-emerald-600 dark:text-emerald-400",
  93: "text-amber-500 dark:text-amber-300",
  94: "text-blue-500 dark:text-blue-300",
  95: "text-fuchsia-500 dark:text-fuchsia-300",
  96: "text-cyan-500 dark:text-cyan-300",
  97: "text-foreground",
};

const BACKGROUND_CLASSES: Record<number, string> = {
  40: "bg-foreground/15",
  41: "bg-red-500/20",
  42: "bg-emerald-500/20",
  43: "bg-amber-500/20",
  44: "bg-blue-500/20",
  45: "bg-fuchsia-500/20",
  46: "bg-cyan-500/20",
  47: "bg-foreground/10",
  100: "bg-muted-foreground/20",
  101: "bg-red-400/25",
  102: "bg-emerald-400/25",
  103: "bg-amber-400/25",
  104: "bg-blue-400/25",
  105: "bg-fuchsia-400/25",
  106: "bg-cyan-400/25",
  107: "bg-foreground/15",
};

/** Render terminal SGR colors without injecting HTML. Besides real ESC bytes,
 * this repairs the U+FFFD form produced by older CLI output decoders. */
export function AnsiText({ children }: { children: string }) {
  const segments = parseAnsi(children);
  return segments.map((segment, index) => {
    if (!Object.keys(segment.style).length) return <Fragment key={index}>{segment.text}</Fragment>;
    const { className, style } = ansiPresentation(segment.style);
    return (
      <span key={index} className={className} style={style}>
        {segment.text}
      </span>
    );
  });
}

function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let active: AnsiStyle = {};
  let cursor = 0;

  for (const match of text.matchAll(SGR_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), style: { ...active } });
    active = applyCodes(active, match[1] === "" ? [0] : match[1].split(";").map(Number));
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style: { ...active } });
  return segments;
}

function applyCodes(current: AnsiStyle, codes: number[]): AnsiStyle {
  let next = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code === 39) delete next.foreground;
    else if (code === 49) delete next.background;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.foreground = code;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.background = code;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "foreground" : "background";
      const mode = codes[index + 1];
      if (mode === 5 && codes[index + 2] != null) {
        next[target] = ansi256(codes[index + 2]);
        index += 2;
      } else if (mode === 2 && codes.slice(index + 2, index + 5).length === 3) {
        const [red, green, blue] = codes.slice(index + 2, index + 5).map(clampByte);
        next[target] = `rgb(${red} ${green} ${blue})`;
        index += 4;
      }
    }
  }
  return next;
}

function ansiPresentation(value: AnsiStyle): { className: string; style?: CSSProperties } {
  const foreground = typeof value.foreground === "number" ? FOREGROUND_CLASSES[value.foreground] : undefined;
  const background = typeof value.background === "number" ? BACKGROUND_CLASSES[value.background] : undefined;
  const style: CSSProperties = {};
  if (typeof value.foreground === "string") style.color = value.foreground;
  if (typeof value.background === "string") style.backgroundColor = value.background;
  if (value.inverse) style.filter = "invert(1)";
  return {
    className: cn(
      foreground,
      background,
      value.bold && "font-bold",
      value.dim && "opacity-60",
      value.italic && "italic",
      value.underline && "underline",
      value.strike && "line-through",
    ),
    style: Object.keys(style).length ? style : undefined,
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function ansi256(value: number): string {
  const index = clampByte(value);
  const basic = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  if (index < 16) return basic[index];
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray} ${gray} ${gray})`;
  }
  const cube = index - 16;
  const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40);
  const red = channel(Math.floor(cube / 36));
  const green = channel(Math.floor((cube % 36) / 6));
  const blue = channel(cube % 6);
  return `rgb(${red} ${green} ${blue})`;
}
