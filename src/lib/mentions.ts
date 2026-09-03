// `@`-mentions in the composer. A mention is a plain `@<label>` token in the
// textarea (drawn as a pill by the composer's highlight layer) plus a side
// record — the MentionRef — that says what the label points at. On send the
// tokens stay in the prose exactly as typed and a machine-delimited
// `<cetus-mentions>` block is appended that resolves each one for the model.
//
// This is deliberately prompt-level, like the `<cetus-attachments>` block: the
// built-in runtime and the Claude Code / Codex CLIs all receive the message as
// opaque text, so the only place mention semantics can ride is the prompt. The
// reducer strips the block back off the displayed bubble (see
// stripMentionRefs) and keeps the labels so the bubble can draw the pills.

export type MentionKind = "function" | "automation" | "artifact" | "file" | "conversation";

/** Tab order in the menu — functions first, then the context kinds. */
export const MENTION_KINDS: MentionKind[] = [
  "function",
  "automation",
  "artifact",
  "file",
  "conversation",
];

/** What a `@label` token points at. Enough to expand it for the model and to
 *  re-identify it (dedupe, prune) while the draft is being edited. */
export interface MentionRef {
  kind: MentionKind;
  /** Bare label; the token in the text is `@${label}`. Unique per draft. */
  label: string;
  /** Kind-specific identity: function name, automation id, artifact / file
   *  absolute path, conversation id. */
  id: string;
  /** Absolute on-disk path for artifacts, files and folders. */
  path?: string;
  isDir?: boolean;
  /** One human line the model gets alongside the reference (mime + size for
   *  an artifact, schedule for an automation, backend + last-updated for a
   *  conversation). */
  meta?: string;
}

/** A menu row: a ref plus what to show for it. */
export interface MentionItem extends MentionRef {
  title: string;
  subtitle?: string;
  archived?: boolean;
}

export const GOAL_DESCRIPTION = "Pursue this as a persistent goal until it's complete";

/** The one built-in function. Picking it inserts `@goal `; the block below tells
 *  the model to treat the message as a goal. Kept English — it's a model
 *  instruction, not UI copy — and runtime-agnostic. */
export const GOAL_MENTION: MentionItem = {
  kind: "function",
  label: "goal",
  id: "goal",
  title: "goal",
  subtitle: GOAL_DESCRIPTION,
};

const GOAL_DIRECTIVE =
  "Treat the whole message as a goal. Work autonomously and keep going until it is " +
  "fully achieved — don't stop to ask for confirmation between steps, and don't " +
  "end your turn while the goal is incomplete. Only stop early if you're " +
  "genuinely blocked, and if so, say exactly what is blocking you. When the goal " +
  "is done, briefly confirm it's complete.";

export const FUNCTION_MENTIONS: MentionItem[] = [GOAL_MENTION];

export function mentionToken(label: string): string {
  return `@${label}`;
}

export const MENTION_OPEN = "<cetus-mentions>";
export const MENTION_CLOSE = "</cetus-mentions>";

/** Per-send resolution the composer supplies for refs that need work at send
 *  time (a conversation's transcript is exported to disk right before sending). */
export interface MentionResolution {
  transcriptPath?: string;
}

/** The one-line resolution of a ref, as the model reads it. */
export function describeMention(ref: MentionRef, resolution?: MentionResolution): string {
  switch (ref.kind) {
    case "function":
      return ref.id === "goal" ? GOAL_DIRECTIVE : `Function "${ref.id}".`;
    case "automation":
      return (
        `Cetus scheduled automation "${ref.label}" (id ${ref.id}` +
        (ref.meta ? `, ${ref.meta}` : "") +
        `). Inspect it with \`cetus cron get ${ref.id}\`; change it with ` +
        `\`cetus cron edit ${ref.id} '<patch-json>'\` (see \`cetus help\`).`
      );
    case "artifact":
      return (
        `File the agent produced earlier in this conversation: ${ref.path ?? ref.id}` +
        (ref.meta ? ` (${ref.meta})` : "") +
        `. Read it from disk.`
      );
    case "file":
      return ref.isDir
        ? `Folder in the workspace: ${ref.path ?? ref.id}`
        : `File in the workspace: ${ref.path ?? ref.id}`;
    case "conversation": {
      const head =
        `Another Cetus conversation titled "${ref.label}" (id ${ref.id}` +
        (ref.meta ? `, ${ref.meta}` : "") +
        `).`;
      return resolution?.transcriptPath
        ? `${head} Its transcript is exported as Markdown at ${resolution.transcriptPath} — read it from disk for the details.`
        : `${head} Its transcript could not be exported; ask the user if you need details.`;
    }
  }
}

/** The block appended to the outgoing prompt (never shown in the bubble). */
export function buildMentionRefs(
  refs: MentionRef[],
  resolutions?: Map<string, MentionResolution>,
): string {
  if (refs.length === 0) return "";
  const lines = refs
    .map((ref) => `- ${mentionToken(ref.label)} → ${describeMention(ref, resolutions?.get(ref.label))}`)
    .join("\n");
  return (
    `\n\n${MENTION_OPEN}\n` +
    `The user's message references these items with @-mentions. Resolve each as described:\n` +
    `${lines}\n${MENTION_CLOSE}`
  );
}

/** Split a message into its displayed prose and the labels its mention block
 *  declared (for drawing pills). Text without a block comes back unchanged. */
export function extractMentionRefs(text: string): { text: string; labels: string[] } {
  const open = text.indexOf(MENTION_OPEN);
  if (open === -1) return { text, labels: [] };
  const close = text.indexOf(MENTION_CLOSE, open);
  if (close === -1) return { text, labels: [] };
  const block = text.slice(open + MENTION_OPEN.length, close);
  const labels: string[] = [];
  for (const line of block.split("\n")) {
    const m = /^- @(.+?) → /.exec(line);
    if (m) labels.push(m[1]);
  }
  const before = text.slice(0, open);
  const after = text.slice(close + MENTION_CLOSE.length);
  return { text: (before.replace(/\n+$/, "") + after).trim(), labels };
}

export function stripMentionRefs(text: string): string {
  return extractMentionRefs(text).text;
}

/** Positions of every `@label` token in `text` for the given labels, longest
 *  label first so `@foo.md` isn't claimed by a shorter `@foo`. Tokens must sit
 *  at a word boundary (line start or after whitespace) — the same rule the
 *  composer uses to open the menu. Non-overlapping, sorted by start. */
export function findMentionSpans(
  text: string,
  labels: string[],
): { start: number; end: number; label: string }[] {
  if (labels.length === 0 || !text) return [];
  const ordered = [...new Set(labels)].sort((a, b) => b.length - a.length);
  const spans: { start: number; end: number; label: string }[] = [];
  const taken: boolean[] = [];
  for (const label of ordered) {
    const token = mentionToken(label);
    let from = 0;
    while (from <= text.length) {
      const at = text.indexOf(token, from);
      if (at === -1) break;
      from = at + 1;
      const before = at > 0 ? text[at - 1] : "";
      if (before && !/\s/.test(before)) continue;
      const end = at + token.length;
      let clash = false;
      for (let i = at; i < end; i++) if (taken[i]) { clash = true; break; }
      if (clash) continue;
      for (let i = at; i < end; i++) taken[i] = true;
      spans.push({ start: at, end, label });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The refs whose token actually appears in the text, in order of appearance. */
export function mentionsInText(text: string, refs: MentionRef[]): MentionRef[] {
  const byLabel = new Map(refs.map((r) => [r.label, r]));
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  for (const span of findMentionSpans(text, refs.map((r) => r.label))) {
    if (seen.has(span.label)) continue;
    seen.add(span.label);
    const ref = byLabel.get(span.label);
    if (ref) out.push(ref);
  }
  return out;
}

/** `text` with every mention token removed — used to decide whether a message
 *  is "only mentions" (e.g. a bare `@goal`) and so shouldn't be sent. */
export function textWithoutMentions(text: string, refs: MentionRef[]): string {
  const spans = findMentionSpans(text, refs.map((r) => r.label));
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start);
    last = s.end;
  }
  out += text.slice(last);
  return out.trim();
}

/** A label that doesn't collide with an existing ref pointing elsewhere. Same
 *  target → same label (so re-picking an item is idempotent); a different
 *  target with the same display name gets a ` (2)` / ` (3)` suffix. */
export function uniqueLabel(base: string, existing: MentionRef[], incoming: MentionRef): string {
  const clean = base.replace(/\s+/g, " ").trim() || incoming.kind;
  const sameTarget = (r: MentionRef) => r.kind === incoming.kind && r.id === incoming.id;
  let label = clean;
  for (let n = 2; ; n++) {
    const clash = existing.find((r) => r.label === label);
    if (!clash || sameTarget(clash)) return label;
    label = `${clean} (${n})`;
  }
}

// Refs inserted this session, by label. A queued message hands its already
// expanded text back to the composer for editing; the block gives us the
// labels and this cache gives the refs behind them, so the pills come back
// live instead of degrading to plain text.
const sessionRefs = new Map<string, MentionRef>();

export function rememberRef(ref: MentionRef): void {
  sessionRefs.set(ref.label, ref);
}

export function recallRefs(labels: string[]): MentionRef[] {
  return labels.map((l) => sessionRefs.get(l)).filter((r): r is MentionRef => !!r);
}

const REFS_SUFFIX = "#mentions";

export function mentionDraftKey(draftKey: string): string {
  return `${draftKey}${REFS_SUFFIX}`;
}

export function serializeRefs(refs: MentionRef[]): string {
  return refs.length ? JSON.stringify(refs) : "";
}

export function parseRefs(raw: string): MentionRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is MentionRef =>
        !!r && typeof r === "object" && typeof r.label === "string" && typeof r.kind === "string",
    );
  } catch {
    return [];
  }
}
