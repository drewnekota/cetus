/** Continuation prompts Cetus dispatches on the user's behalf (auto-retry
 *  after a transient provider error, resume after an app restart). They are
 *  real user-role transcript rows — the vendor CLI needs the instruction — but
 *  the chat renders them as centered system notices instead of user bubbles.
 *  Detection is by exact text, which covers both the live `message_start`
 *  event and reloads replaying the persisted row. */

/** Keep in sync with `CLI_AUTO_RETRY_PROMPT` in src-tauri/src/cli_backend.rs. */
export const CLI_AUTO_RETRY_PROMPT =
  "The previous turn stopped early due to a transient provider error (rate limited or " +
  "overloaded). This is an automatic retry: review what has already been done in this " +
  "conversation, then continue the original task from where it left off. Don't redo work " +
  "that has already completed.";

/** Continuation sent to pick an interrupted run back up (auto-resume sweep
 *  and the banner's Resume button). Deliberately not a bare "continue": the
 *  cut-down turn may have already produced side effects (files written,
 *  messages sent), so the agent is told to check before redoing work. */
export const INTERRUPTED_RESUME_PROMPT =
  "The previous run was interrupted by an app restart. Review the conversation and the " +
  "current workspace state, then continue the original task from where it left off. " +
  "Don't redo work that has already completed.";

export type ContinuationNoticeKind = "autoRetry" | "interruptedResume";

/** True when a cached/live render starts mid-conversation: its first user row
 *  is a Cetus-dispatched continuation rather than a real prompt. Such a render
 *  was seeded after the conversation already had history (the pre-fix
 *  auto-resume sweep wrote caches this way), so it is strictly less faithful
 *  than pi history and should be repaired from it. */
export function renderStartsMidConversation(
  messages: readonly { role: string; blocks: readonly { kind: string; text?: string }[] }[],
): boolean {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser || firstUser.blocks.length !== 1) return false;
  const block = firstUser.blocks[0];
  if (block.kind !== "text" || typeof block.text !== "string") return false;
  return continuationNoticeKind(block.text) !== null;
}

/** Classify a user message's text as one of the known system continuations,
 *  or null for an ordinary user message. */
export function continuationNoticeKind(text: string): ContinuationNoticeKind | null {
  const trimmed = text.trim();
  if (trimmed === CLI_AUTO_RETRY_PROMPT) return "autoRetry";
  if (trimmed === INTERRUPTED_RESUME_PROMPT) return "interruptedResume";
  return null;
}
