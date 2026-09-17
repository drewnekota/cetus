"use client";

import { type SlashItem } from "@/components/chat/slash-menu";
import type { Automation } from "@/lib/types";

/** Walk back from the caret to find an open `/<token>` the user is typing: a `/`
 *  at line start or after whitespace, with no whitespace between it and the
 *  caret. Returns the slash index + the text after it, or null when the caret
 *  isn't inside such a token. */
export function detectSlashToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "/") break;
    if (/\s/.test(ch)) return null; // hit whitespace before a slash → not a token
    i--;
  }
  if (i < 0 || value[i] !== "/") return null;
  const before = i > 0 ? value[i - 1] : "";
  if (before && !/\s/.test(before)) return null; // `/` must start a word
  return { start: i, query: value.slice(i + 1, caret) };
}

/** Same walk-back as {@link detectSlashToken} but for an open `@<token>`: an `@`
 *  at line start or after whitespace, with no whitespace up to the caret. Powers
 *  the `@`-mention menu (`@goal`). */
export function detectMentionToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") break;
    if (/\s/.test(ch)) return null; // hit whitespace before an `@` → not a token
    i--;
  }
  if (i < 0 || value[i] !== "@") return null;
  const before = i > 0 ? value[i - 1] : "";
  if (before && !/\s/.test(before)) return null; // `@` must start a word (not an email)
  return { start: i, query: value.slice(i + 1, caret) };
}

export const escapeRegExp = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Claude Code built-in slash commands that work headless (verified against
 *  CLI 2.1.199: handled locally, zero model tokens; /status, /model etc. are
 *  TUI-only and refuse in -p mode). Offered in the slash menu for claude-code
 *  conversations; the picked token is passed through to the CLI verbatim. */
export const CLAUDE_CLI_COMMANDS: SlashItem[] = [
  {
    kind: "command",
    id: "cli:usage",
    name: "usage",
    description: "Claude subscription usage and limits",
    prompt: "/usage ",
  },
  {
    kind: "command",
    id: "cli:cost",
    name: "cost",
    description: "Token spend and usage for this session",
    prompt: "/cost ",
  },
  {
    kind: "command",
    id: "cli:context",
    name: "context",
    description: "Context window usage breakdown",
    prompt: "/context ",
  },
  {
    kind: "command",
    id: "cli:compact",
    name: "compact",
    description: "Compact conversation history to free up context",
    prompt: "/compact ",
  },
];

export const CODEX_CLI_COMMANDS: SlashItem[] = [
  {
    kind: "command",
    id: "codex:status",
    name: "status",
    description: "Show chat ID, model, reasoning, and context usage",
    prompt: "/status",
  },
  {
    kind: "command",
    id: "codex:model",
    name: "model",
    description: "Choose the model for this chat",
    prompt: "/model",
  },
  {
    kind: "command",
    id: "codex:reasoning",
    name: "reasoning",
    description: "Choose the reasoning effort for this chat",
    prompt: "/reasoning",
  },
  {
    kind: "command",
    id: "codex:compact",
    name: "compact",
    description: "Compact the Codex thread and free context",
    prompt: "/compact ",
  },
];

// Skills rarely change, so a recently checked catalog can serve repeated menu
// opens without spawning another vendor CLI process.
export const RUNTIME_CATALOG_REFRESH_MS = 30_000;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// 25MB — docx/xlsx/pdf etc., read on disk by the agent

/** Text pastes longer than this become a `pasted.txt` attachment instead of
 *  entering the textarea. A controlled textarea holding megabytes (a crash log,
 *  a terminal dump) wedges the webview: WebKit re-lays-out and spellchecks the
 *  whole run on every render, and the draft write-through rewrites it all to
 *  localStorage on each keystroke. */
export const LONG_PASTE_CHARS = 20_000;

export const FOCUS_TRIGGER_CHARS = new Set(["/", "、", "／"]);

/** Draft-store key for the pending quote attached to a composer draft. */
export function quoteKey(draftKey: string): string {
  return `${draftKey}#quote`;
}

/** One-line schedule summary for the model's view of an `@automation`. */
export function describeSchedule(a: Automation): string {
  const s = a.schedule;
  switch (s.kind) {
    case "once":
      return `runs once at ${new Date(s.atMs).toISOString()}`;
    case "interval":
      return `runs every ${s.everyMinutes} minutes`;
    case "daily":
      return `runs daily at ${s.time}`;
    case "cron":
      return `cron ${s.expr}`;
    default:
      return "scheduled";
  }
}

export function cleanQuoteText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The wire format for a quote: a leading `>` blockquote the bubble renderer
 *  recognizes and lifts back out as the quote header. */
export function formatQuoteMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<payload>" — keep just the payload.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
