// Ambient context attached to a quick-launcher prompt (frontmost app, browser
// URL/title, selected text). It travels as a separate `QuickContext` object
// through the launcher → main-window plumbing, and is folded into the prompt at
// a single point as a fenced `<context>` block — the same "fence ambient/
// untrusted content" convention cetus's system prompt already uses, so the model
// reads it as environment data rather than instructions. The UI recognizes the
// identical fence and renders a compact chip instead of the raw XML.
import type { QuickContext, RenderedBlock } from "./types";

const FENCE_OPEN = '<context source="cetus-quick">';
const FENCE_CLOSE = "</context>";

/** True when at least one field carries something worth attaching. */
export function hasContext(ctx: QuickContext | null | undefined): boolean {
  return !!ctx && !!(ctx.app || ctx.url || ctx.title || ctx.selection);
}

/** Render the context into the fenced block. Empty string when nothing to add. */
export function buildContextFence(ctx: QuickContext | null | undefined): string {
  if (!hasContext(ctx)) return "";
  const c = ctx!;
  const lines: string[] = [];
  if (c.app) lines.push(`Active app: ${c.app}`);
  if (c.url) lines.push(`Browser URL: ${c.url}`);
  if (c.title) lines.push(`Page title: ${c.title}`);
  if (c.selection) lines.push(`Selected text:\n${c.selection}`);
  return `${FENCE_OPEN}\n${lines.join("\n")}\n${FENCE_CLOSE}`;
}

/** The message sent to the model: context fence (if any) ahead of typed text. */
export function composeWithContext(
  text: string,
  ctx: QuickContext | null | undefined,
): string {
  const fence = buildContextFence(ctx);
  return fence ? `${fence}\n\n${text}` : text;
}

/** Split a user message into a context chip block (when it leads with the fence)
 *  plus the remaining prose. Shared by the optimistic and reload-from-history
 *  block builders so the chip renders identically either way. */
export function userTextBlocks(text: string): RenderedBlock[] {
  if (!text) return [];
  if (text.startsWith(FENCE_OPEN)) {
    const end = text.indexOf(FENCE_CLOSE);
    if (end !== -1) {
      const inner = text.slice(FENCE_OPEN.length, end).trim();
      const body = text.slice(end + FENCE_CLOSE.length).replace(/^\n+/, "");
      const out: RenderedBlock[] = [
        { kind: "custom", customType: "quick_context", text: inner },
      ];
      if (body.trim()) out.push({ kind: "text", text: body });
      return out;
    }
  }
  return [{ kind: "text", text }];
}

/** One-line label for the chip, derived from the fenced inner text. */
export function contextSummary(inner: string): string {
  const app = /^Active app: (.+)$/m.exec(inner)?.[1]?.trim();
  const url = /^Browser URL: (.+)$/m.exec(inner)?.[1]?.trim();
  if (url) {
    try {
      const host = new URL(url).host;
      return app ? `${app} · ${host}` : host;
    } catch {
      return app ?? "Context";
    }
  }
  return app ?? "Context";
}
