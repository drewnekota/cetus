// Reducer that converts pi streaming events into RenderedMessage[].
//
// Design: each assistant message keeps blocks indexed by pi's `contentIndex`.
// Tool execution events carry only `toolCallId`; we keep a side-table mapping
// toolCallId -> (messageKey, blockIndex) for fast updates.

import type {
  AssistantMessageEvent,
  BashResult,
  PiContentBlock,
  PiEvent,
  PiMessage,
  RenderedBlock,
  RenderedMessage,
} from "./types";

/** Captured output of a finished `!` bash-mode command, as stored in the
 *  custom block's `details`. Mirrors BashResult plus a settled status. */
export type BashExecResult = BashResult;
import { stripAttachmentRefs } from "./attachments";
import { userTextBlocks } from "./quick-context";
import { isArtifactDetails } from "./artifact";

export interface ChatState {
  messages: RenderedMessage[];
  // O(1) lookup of a message by its stable key. Entries are the SAME object
  // refs held in `messages`, so element-wise shallow selectors still re-render
  // only the message that actually changed. Maintained centrally by the store's
  // `step()` whenever `messages` changes — keeps useMessage / useMessagesByKeys
  // from scanning the whole transcript on every streaming token (was O(n²)).
  byKey: Record<string, RenderedMessage>;
  // Index into messages[] for the currently-streaming assistant message, if any.
  activeAssistantIdx: number | null;
  // toolCallId -> { messageIdx, blockIdx }
  toolIndex: Record<string, { messageIdx: number; blockIdx: number }>;
  // True while an agent run is active (between agent_start and agent_end).
  isStreaming: boolean;
  // True from user_sent / agent_start until the first message_start (or stream
  // ends without one). UI renders a "thinking…" placeholder so the gap between
  // hitting send and pi emitting the first token doesn't look like a stall.
  awaitingAssistant: boolean;
  // Sticky: flipped true the moment a send_artifact tool result lands (or on
  // load if history already has one). Lets useHasArtifacts read a field instead
  // of re-scanning every message×block on each store tick.
  hasArtifacts: boolean;
  error: string | null;
  // True when the current/just-finished run was deliberately cancelled by the
  // user (pi emits an assistant error event with reason "aborted", or we call
  // endStream on the abort button). Suppresses the trailing agent_end's
  // "empty response" hint — a manual cancel isn't a model failure. Reset at the
  // start of the next run (agent_start).
  aborted: boolean;
}

export const emptyChatState: ChatState = {
  messages: [],
  byKey: {},
  activeAssistantIdx: null,
  toolIndex: {},
  isStreaming: false,
  awaitingAssistant: false,
  hasArtifacts: false,
  error: null,
  aborted: false,
};

/** True if any block is a settled send_artifact tool result. Used once on
 *  load/hydrate; live runs flip the flag incrementally in reduceToolExec. */
export function computeHasArtifacts(messages: RenderedMessage[]): boolean {
  for (const m of messages) {
    for (const b of m.blocks) {
      if (
        b.kind === "tool_use" &&
        b.name === "send_artifact" &&
        b.result &&
        isArtifactDetails(b.result.details)
      ) {
        return true;
      }
    }
  }
  return false;
}

export type ChatAction =
  | { type: "reset"; messages?: PiMessage[] }
  | {
      type: "user_sent";
      text: string;
      images?: { dataUrl: string; name?: string }[];
      files?: { name: string; path: string; mimeType: string; sizeBytes: number }[];
    }
  | { type: "pi_event"; event: PiEvent }
  | { type: "set_error"; message: string | null }
  | { type: "end_stream" }
  // Local `!` bash-mode command: append a running breadcrumb (bash_start) then
  // settle it with the captured output (bash_done). The key is minted by the
  // caller so the two phases address the same message.
  | { type: "bash_start"; key: string; command: string; cwd?: string }
  | { type: "bash_done"; key: string; result: BashExecResult };

function nowMs() {
  return Date.now();
}

function genKey(prefix: string) {
  return `${prefix}-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Inflate a historical PiMessage (from get_messages on switch) into RenderedMessage.
function inflate(msg: PiMessage): RenderedMessage {
  const blocks: RenderedBlock[] = [];
  const content = Array.isArray(msg.content)
    ? msg.content
    : typeof msg.content === "string"
      ? [{ type: "text" as const, text: msg.content }]
      : [];
  for (const c of content as PiContentBlock[]) {
    if (c.type === "text") {
      // Custom messages (e.g. vision_describe) ride in as role="custom" with
      // a single text block — wrap into a custom RenderedBlock so the bubble
      // can render a distinct card instead of plain prose.
      if (msg.role === "custom" && msg.customType) {
        blocks.push({
          kind: "custom",
          customType: msg.customType,
          text: c.text,
          details: msg.details,
        });
      } else if (msg.role === "user") {
        // A quick-launcher prompt may lead with a fenced <context> block —
        // split it back into a chip + prose so reloaded history reads like the
        // live turn did, not raw XML.
        blocks.push(...userTextBlocks(c.text));
      } else {
        blocks.push({ kind: "text", text: c.text });
      }
    } else if (c.type === "thinking") blocks.push({ kind: "thinking", text: c.thinking });
    else if (c.type === "toolCall")
      blocks.push({ kind: "tool_use", id: c.id, name: c.name, args: c.arguments, result: null });
    else if (c.type === "image")
      // Defensive: pi's vision-bridge strips image bytes before persisting, so
      // history rarely carries one — but if it ever does, render the thumbnail
      // instead of silently dropping the block.
      blocks.push({ kind: "image", dataUrl: `data:${c.mimeType};base64,${c.data}` });
  }
  // pi-ai uses "toolResult" but our internal RenderedMessage role stays "tool";
  // attachToolResults later folds these into the preceding assistant block.
  const role: RenderedMessage["role"] =
    msg.role === "toolResult" ? "tool" : (msg.role as RenderedMessage["role"]);
  return {
    key: (msg.id as string) || genKey("hist"),
    role,
    blocks,
    createdAt: nowMs(),
  };
}

// Re-attach tool results from a tool-role message onto the preceding tool_use blocks.
function attachToolResults(messages: RenderedMessage[]): RenderedMessage[] {
  const toolUseBlock: Record<string, { msg: RenderedMessage; block: RenderedBlock & { kind: "tool_use" } }> = {};
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const b of m.blocks) {
        if (b.kind === "tool_use") toolUseBlock[b.id] = { msg: m, block: b };
      }
    }
  }
  return messages.filter((m) => {
    if (m.role !== "tool") return true;
    // pi-ai's ToolResultMessage carries toolCallId / content / isError at the
    // top level of the message — not nested in a tool_result content block.
    const raw = (m as unknown as { _raw?: PiMessage })._raw;
    if (!raw) return false;
    const id = raw.toolCallId;
    const target = id ? toolUseBlock[id] : undefined;
    if (target) {
      const innerContent: PiContentBlock[] = Array.isArray(raw.content)
        ? (raw.content as PiContentBlock[])
        : typeof raw.content === "string"
          ? [{ type: "text", text: raw.content }]
          : [];
      target.block.result = {
        content: innerContent,
        details: raw.details,
        isError: !!raw.isError,
      };
    }
    return false; // drop tool-result messages — they piggyback on tool_use blocks
  });
}

// pi's vision-bridge rewrites an image prompt into "<user text>\n\n<gemini
// descriptions>" so the text-only model can "see" the picture, and persists
// THAT merged text as the user message (the raw image bytes are dropped). It
// also drops a separate vision_describe custom message holding just the
// descriptions. On reload that means the descriptions render twice — once
// bloating the user bubble, once in the collapsed VisionCard. Strip the echoed
// descriptions back off the user bubble so reloaded history reads like the live
// turn did: a short prompt followed by the vision card.
function stripVisionEcho(messages: RenderedMessage[]): RenderedMessage[] {
  const out = messages.slice();
  for (let i = 0; i < out.length; i++) {
    const desc = visionDescription(out[i]);
    if (!desc) continue;
    // The bridge emits this breadcrumb immediately before committing the
    // rewritten prompt, so the prose it echoed lives in the *next* user message
    // — strip it only from that one. Matching descriptions globally would risk
    // clobbering a later turn that happens to repeat the same text.
    const j = nextUserIndex(out, i);
    if (j === -1) continue;
    const stripped = stripDescription(out[j], desc);
    if (stripped) out[j] = stripped;
  }
  return out;
}

/** The vision_describe prose carried by a custom message, or null. */
function visionDescription(m: RenderedMessage): string | null {
  if (m.role !== "custom") return null;
  for (const b of m.blocks) {
    if (b.kind === "custom" && b.customType === "vision_describe" && b.text.trim()) {
      return b.text.trim();
    }
  }
  return null;
}

function nextUserIndex(messages: RenderedMessage[], from: number): number {
  for (let k = from + 1; k < messages.length; k++) {
    if (messages[k].role === "user") return k;
  }
  return -1;
}

/** Strip the echoed description off a user message's text blocks; null if no
 *  block actually ended with it (so the caller can leave the message intact). */
function stripDescription(m: RenderedMessage, desc: string): RenderedMessage | null {
  let changed = false;
  const blocks = m.blocks.flatMap((b): RenderedBlock[] => {
    if (b.kind !== "text") return [b];
    const head = stripSuffix(b.text, desc);
    if (head === b.text) return [b];
    changed = true;
    // Drop a text block emptied to nothing (image-only prompt) so the bubble
    // doesn't keep a blank line where the merged prose used to be.
    return head ? [{ ...b, text: head }] : [];
  });
  return changed ? { ...m, blocks } : null;
}

// pi persists the user message with the file-reference block we appended for
// the model (see lib/attachments.ts). Strip it back off the displayed bubble on
// reload so history reads like the live turn — clean prompt, no path block.
function stripAttachmentEcho(messages: RenderedMessage[]): RenderedMessage[] {
  return messages.map((m) => {
    if (m.role !== "user") return m;
    let changed = false;
    const blocks = m.blocks.flatMap((b): RenderedBlock[] => {
      if (b.kind !== "text") return [b];
      const stripped = stripAttachmentRefs(b.text);
      if (stripped === b.text) return [b];
      changed = true;
      return stripped ? [{ ...b, text: stripped }] : [];
    });
    return changed ? { ...m, blocks } : m;
  });
}

/** Remove `desc` from the end of `text` (plus the joining blank line), if present. */
function stripSuffix(text: string, desc: string): string {
  const t = text.trimEnd();
  const d = desc.trim();
  if (!d || !t.endsWith(d)) return text;
  return t.slice(0, t.length - d.length).replace(/\n+$/, "").trimEnd();
}

function removeMessageAndReindexTools(
  messages: RenderedMessage[],
  toolIndex: ChatState["toolIndex"],
  removeIdx: number,
): Pick<ChatState, "messages" | "toolIndex"> {
  const nextMessages = messages.filter((_, idx) => idx !== removeIdx);
  const nextToolIndex: ChatState["toolIndex"] = {};
  for (const [id, loc] of Object.entries(toolIndex)) {
    if (loc.messageIdx === removeIdx) continue;
    nextToolIndex[id] = {
      ...loc,
      messageIdx: loc.messageIdx > removeIdx ? loc.messageIdx - 1 : loc.messageIdx,
    };
  }
  return { messages: nextMessages, toolIndex: nextToolIndex };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset": {
      if (!action.messages) return emptyChatState;
      // Inflate, attach tool_results, drop synthetic tool messages.
      const rendered = action.messages.map((m) => {
        const r = inflate(m);
        (r as unknown as { _raw: PiMessage })._raw = m;
        return r;
      });
      const cleaned = stripAttachmentEcho(stripVisionEcho(attachToolResults(rendered)));
      return { ...emptyChatState, messages: cleaned, hasArtifacts: computeHasArtifacts(cleaned) };
    }
    case "user_sent": {
      const blocks: RenderedBlock[] = [];
      // Attachments first so they render above the text in the bubble — matches
      // how chat apps typically lay out an attachment + caption.
      for (const img of action.images ?? []) {
        blocks.push({ kind: "image", dataUrl: img.dataUrl, name: img.name });
      }
      for (const f of action.files ?? []) {
        blocks.push({
          kind: "file",
          name: f.name,
          path: f.path,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
        });
      }
      if (action.text) blocks.push(...userTextBlocks(action.text));
      const msg: RenderedMessage = {
        key: genKey("user"),
        role: "user",
        blocks,
        createdAt: nowMs(),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        awaitingAssistant: true,
      };
    }
    case "set_error":
      return { ...state, error: action.message, awaitingAssistant: false };
    case "end_stream": {
      // Locally finalize an interrupted run. pi.abort() stops the model but
      // emits no agent_end, so isStreaming would stay stuck true — the
      // persistence cache (skipped mid-stream) never flushes and the run looks
      // "active" so get_messages stalls on the next reopen. Drop the in-flight
      // assistant turn entirely: a partial thought/text/tool_call is not a
      // replayable protocol message, and keeping it can poison the next request.
      if (!state.isStreaming && state.activeAssistantIdx == null) return state;
      let messages = state.messages;
      let toolIndex = state.toolIndex;
      if (state.activeAssistantIdx != null && messages[state.activeAssistantIdx]) {
        const stripped = removeMessageAndReindexTools(
          messages,
          toolIndex,
          state.activeAssistantIdx,
        );
        messages = stripped.messages;
        toolIndex = stripped.toolIndex;
      }
      return {
        ...state,
        messages,
        toolIndex,
        isStreaming: false,
        awaitingAssistant: false,
        activeAssistantIdx: null,
        // endStream is only dispatched on a user abort — flag it so a trailing
        // agent_end doesn't mistake the empty bubble for a model failure.
        aborted: true,
      };
    }
    case "bash_start": {
      const msg: RenderedMessage = {
        key: action.key,
        role: "custom",
        blocks: [
          {
            kind: "custom",
            customType: "bash_exec",
            text: action.command,
            details: { status: "running", cwd: action.cwd },
          },
        ],
        createdAt: nowMs(),
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case "bash_done": {
      const idx = state.messages.findIndex((m) => m.key === action.key);
      if (idx === -1) return state;
      const messages = [...state.messages];
      messages[idx] = {
        ...messages[idx],
        blocks: messages[idx].blocks.map((b) =>
          b.kind === "custom" && b.customType === "bash_exec"
            ? { ...b, details: { status: "done", result: action.result } }
            : b,
        ),
      };
      return { ...state, messages };
    }
    case "pi_event":
      return reducePiEvent(state, action.event);
  }
}

/** True if an assistant turn produced something the user can actually use — a
 *  non-empty text answer, a tool call, or an attachment. A turn whose only
 *  output is a thinking block (or nothing at all) is a degenerate/empty
 *  completion: DeepSeek V4 occasionally stalls and returns ~1 token of reasoning
 *  and no content, which pi accepts as a clean turn-end. Without this check the
 *  run just stops on a blank/dangling bubble with no error. */
function assistantHasVisibleContent(m: RenderedMessage): boolean {
  return m.blocks.some(
    (b) =>
      (b.kind === "text" && b.text.trim().length > 0) ||
      b.kind === "tool_use" ||
      b.kind === "image" ||
      b.kind === "file" ||
      b.kind === "custom",
  );
}

function reducePiEvent(state: ChatState, event: PiEvent): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true, awaitingAssistant: true, error: null, aborted: false };
    case "agent_end": {
      // Catch a turn that ended with NO visible answer (empty/degenerate
      // completion — see assistantHasVisibleContent) and surface a recoverable
      // hint instead of silently leaving the user on a blank bubble. Regenerate
      // is already wired, so this just makes the dead-end visible.
      const idx = state.activeAssistantIdx ?? state.messages.length - 1;
      const last = idx >= 0 ? state.messages[idx] : undefined;
      const emptyAnswer =
        last?.role === "assistant" && !assistantHasVisibleContent(last);
      return {
        ...state,
        isStreaming: false,
        awaitingAssistant: false,
        activeAssistantIdx: null,
        error:
          emptyAnswer && !state.error && !state.aborted
            ? "The model returned an empty response — no answer was produced. Tap Regenerate to try again."
            : state.error,
      };
    }
    case "message_start": {
      // Assistant messages get a streaming slot tracked by activeAssistantIdx.
      // Custom messages (extension breadcrumbs) are inserted as fully-formed
      // bubbles right here — pi already includes their content in this event.
      if (event.message.role === "custom") {
        const inflated = inflate(event.message);
        return { ...state, messages: [...state.messages, inflated] };
      }
      // pi echoes a user-role message_start at the head of every turn. In a
      // foreground chat the optimistic user_sent bubble already exists, so we
      // skip the echo to avoid a duplicate. But background runs (automations,
      // scheduled fires) have no optimistic bubble — without this the user's
      // prompt never renders and the assistant-only render gets cached, so the
      // prompt stays missing even after reload. Dedupe by the trailing message:
      // the optimistic bubble is always last when the echo arrives (no assistant
      // token yet), so "last is already user" means it's a duplicate.
      if (event.message.role === "user") {
        const last = state.messages[state.messages.length - 1];
        if (last?.role === "user") return state;
        const inflated = inflate(event.message);
        return {
          ...state,
          messages: [...state.messages, inflated],
          awaitingAssistant: true,
        };
      }
      if (event.message.role !== "assistant") return state;
      const next: RenderedMessage = {
        key: genKey("asst"),
        role: "assistant",
        blocks: [],
        createdAt: nowMs(),
      };
      return {
        ...state,
        messages: [...state.messages, next],
        activeAssistantIdx: state.messages.length,
        awaitingAssistant: false,
      };
    }
    case "message_end": {
      // Mark all blocks of active assistant as non-streaming.
      if (state.activeAssistantIdx == null) return state;
      const messages = [...state.messages];
      const m = { ...messages[state.activeAssistantIdx] };
      m.blocks = m.blocks.map((b) => ({ ...b, streaming: false }));
      messages[state.activeAssistantIdx] = m;
      return { ...state, messages };
    }
    case "message_update": {
      // A user-initiated cancel surfaces as an assistant error event with
      // reason "aborted". Catch it here, before delegating: the abort button's
      // endStream has already nulled activeAssistantIdx, which would make
      // reduceAssistantDelta early-return without recording the abort.
      const amEvent = event.assistantMessageEvent;
      if (amEvent.type === "error" && amEvent.reason === "aborted") {
        return { ...state, aborted: true };
      }
      return reduceAssistantDelta(state, amEvent);
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return reduceToolExec(state, event);
    default:
      return state;
  }
}

function reduceAssistantDelta(state: ChatState, e: AssistantMessageEvent): ChatState {
  if (state.activeAssistantIdx == null) return state;
  const messages = [...state.messages];
  const m = { ...messages[state.activeAssistantIdx] };
  m.blocks = [...m.blocks];

  const ensureBlock = (idx: number, fill: RenderedBlock) => {
    while (m.blocks.length <= idx) m.blocks.push({ kind: "text", text: "" });
    if (
      !m.blocks[idx] ||
      (m.blocks[idx].kind !== fill.kind && (m.blocks[idx] as RenderedBlock).kind === "text" && !(m.blocks[idx] as { text: string }).text)
    ) {
      m.blocks[idx] = fill;
    }
  };

  switch (e.type) {
    case "text_start":
      ensureBlock(e.contentIndex, { kind: "text", text: "", streaming: true });
      break;
    case "text_delta": {
      ensureBlock(e.contentIndex, { kind: "text", text: "", streaming: true });
      const b = m.blocks[e.contentIndex];
      if (b.kind === "text") m.blocks[e.contentIndex] = { ...b, text: b.text + e.delta, streaming: true };
      break;
    }
    case "text_end": {
      const b = m.blocks[e.contentIndex];
      if (b && b.kind === "text") m.blocks[e.contentIndex] = { ...b, text: e.content, streaming: false };
      break;
    }
    case "thinking_start":
      ensureBlock(e.contentIndex, { kind: "thinking", text: "", streaming: true });
      break;
    case "thinking_delta": {
      ensureBlock(e.contentIndex, { kind: "thinking", text: "", streaming: true });
      const b = m.blocks[e.contentIndex];
      if (b.kind === "thinking") m.blocks[e.contentIndex] = { ...b, text: b.text + e.delta, streaming: true };
      break;
    }
    case "thinking_end": {
      const b = m.blocks[e.contentIndex];
      if (b && b.kind === "thinking") m.blocks[e.contentIndex] = { ...b, text: e.content, streaming: false };
      break;
    }
    case "toolcall_start": {
      // pi-ai's toolcall_start has no id/name yet — those land on toolcall_end.
      // Reserve the slot so the UI can show a "running" tool card immediately;
      // name/args/id fill in once the model finishes emitting the call.
      const block: RenderedBlock = {
        kind: "tool_use",
        id: "",
        name: "",
        args: null,
        result: null,
        streaming: true,
      };
      ensureBlock(e.contentIndex, block);
      m.blocks[e.contentIndex] = block;
      break;
    }
    case "toolcall_delta":
      // pi streams JSON-string deltas; we let toolcall_end deliver the final object.
      break;
    case "toolcall_end": {
      const b = m.blocks[e.contentIndex];
      if (b && b.kind === "tool_use") {
        m.blocks[e.contentIndex] = {
          ...b,
          id: e.toolCall.id,
          name: e.toolCall.name,
          args: e.toolCall.arguments,
          // Stay "streaming" (= running) until the result lands via
          // tool_execution_end, message_end, or end_stream clears it. Keeps the
          // card on the spinner through the gap before tool_execution_start, and
          // lets a result-less SETTLED block read as interrupted rather than
          // stuck-running.
          streaming: true,
        };
      }
      messages[state.activeAssistantIdx] = m;
      return {
        ...state,
        messages,
        toolIndex: {
          ...state.toolIndex,
          [e.toolCall.id]: { messageIdx: state.activeAssistantIdx, blockIdx: e.contentIndex },
        },
      };
    }
    case "done":
    case "start":
    case "error":
      break;
  }

  messages[state.activeAssistantIdx] = m;
  return { ...state, messages };
}

function reduceToolExec(
  state: ChatState,
  event: Extract<PiEvent, { type: `tool_execution_${string}` }>,
): ChatState {
  const loc = state.toolIndex[event.toolCallId];
  if (!loc) return state;
  const messages = [...state.messages];
  const m = { ...messages[loc.messageIdx] };
  m.blocks = [...m.blocks];
  const b = m.blocks[loc.blockIdx];
  if (!b || b.kind !== "tool_use") return state;

  if (event.type === "tool_execution_start") {
    m.blocks[loc.blockIdx] = { ...b, streaming: true };
  } else if (event.type === "tool_execution_update") {
    m.blocks[loc.blockIdx] = {
      ...b,
      result: {
        content: event.partialResult.content,
        details: event.partialResult.details,
        isError: false,
      },
      streaming: true,
    };
  } else if (event.type === "tool_execution_end") {
    m.blocks[loc.blockIdx] = {
      ...b,
      result: {
        content: event.result.content,
        details: event.result.details,
        isError: event.isError,
      },
      streaming: false,
    };
  }
  messages[loc.messageIdx] = m;
  // Flip the sticky hasArtifacts flag the moment a send_artifact result settles,
  // so useHasArtifacts never has to scan the transcript per tick.
  const updated = m.blocks[loc.blockIdx];
  const hasArtifacts =
    state.hasArtifacts ||
    (updated.kind === "tool_use" &&
      updated.name === "send_artifact" &&
      !!updated.result &&
      isArtifactDetails(updated.result.details));
  return { ...state, messages, hasArtifacts };
}
