import type { MentionItem } from "@/components/chat/mention-menu";

/** The `@goal` mention. Picking it inserts a plain `@goal ` token in the
 *  composer; on send the token is expanded into {@link GOAL_PREAMBLE} so the
 *  message that follows is pursued as a persistent goal.
 *
 *  This is deliberately a *prompt-level* goal, not a host primitive: the built-in
 *  runtime and the Claude Code / Codex CLIs all receive the message as opaque
 *  text (nothing downstream parses it), so the only place goal semantics can ride
 *  is the prompt itself. That makes `@goal` work identically across every
 *  backend without per-runtime plumbing. */
export const GOAL_MENTION: MentionItem = {
  id: "goal",
  name: "goal",
  description: "Pursue this as a persistent goal until it's complete",
};

/** Every `@` mention the composer offers. One entry today, but the menu and
 *  detection are generic so more context mentions can slot in here later. */
export const MENTIONS: MentionItem[] = [GOAL_MENTION];

/** Matches a `@goal` token at a word boundary, plus any trailing spaces/tabs so
 *  the leftover objective reads cleanly once the token is stripped. */
const GOAL_TOKEN = /(^|\s)@goal\b[ \t]*/i;

/** The directive prepended to a `@goal` message. Kept English (it's a model
 *  instruction, not UI copy) and runtime-agnostic. */
const GOAL_PREAMBLE =
  "Treat the following as a goal. Work autonomously and keep going until it is " +
  "fully achieved — don't stop to ask for confirmation between steps, and don't " +
  "end your turn while the goal is incomplete. Only stop early if you're " +
  "genuinely blocked, and if so, say exactly what is blocking you. When the goal " +
  "is done, briefly confirm it's complete.";

/** True when `text` carries a `@goal` token. */
export function hasGoalMention(text: string): boolean {
  return GOAL_TOKEN.test(text);
}

/** Expand a `@goal` message into its directive. Strips the `@goal` token, treats
 *  the rest as the objective, and prepends {@link GOAL_PREAMBLE}. Returns the
 *  input unchanged when there's no token, and an empty string when the token had
 *  no objective after it (the caller then treats the message as empty). */
export function expandGoalDirective(text: string): string {
  if (!GOAL_TOKEN.test(text)) return text;
  const objective = text.replace(GOAL_TOKEN, "$1").trim();
  if (!objective) return "";
  return `${GOAL_PREAMBLE}\n\nGOAL: ${objective}`;
}
