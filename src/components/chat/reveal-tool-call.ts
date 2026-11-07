/** Raised by surfaces outside the transcript (the background-task strip) to
 *  scroll a tool call's card into view and flash it. The message list owns the
 *  virtual scroller, so it listens rather than exposing a handle. */
export const REVEAL_TOOL_CALL_EVENT = "cetus-reveal-tool-call";

export interface RevealToolCallDetail {
  convId: string;
  toolCallId: string;
}

export function revealToolCall(detail: RevealToolCallDetail) {
  window.dispatchEvent(
    new CustomEvent<RevealToolCallDetail>(REVEAL_TOOL_CALL_EVENT, { detail }),
  );
}
