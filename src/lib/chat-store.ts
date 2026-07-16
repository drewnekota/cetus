// Zustand store wrapping the existing chat reducer.
//
// Why a store and not useReducer-in-page: per-message subscriptions. Selectors
// keyed by (convId, messageKey) only re-render when *that specific* message
// changes, so a streaming token mutation only repaints the active bubble — not
// the whole list.
//
// Reducer logic stays in chat-state.ts; this is just the React glue plus an
// IndexedDB write-through cache for happy-path hydration on cold start.

import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  delMany as idbDelMany,
  get as idbGet,
  getMany as idbGetMany,
  keys as idbKeys,
  setMany as idbSetMany,
} from "idb-keyval";
import {
  chatReducer,
  computeHasArtifacts,
  emptyChatState,
  type ChatAction,
  type ChatState,
} from "./chat-state";
import { artifactsFromDetails } from "./artifact";
import { isReviewRequestDetails, type ReviewRequestDetails } from "./review";
import type {
  BashResult,
  CliBackgroundTask,
  CliControlRequest,
  CliRateLimitInfo,
  CliSlashCommand,
  PiEvent,
  PiMessage,
  RenderedBlock,
  RenderedMessage,
} from "./types";

interface ChatsStore {
  chats: Record<string, ChatState>;
  /** Conversation ids with an active or pending run. Maintained incrementally
   *  as each conv's run-active flag flips, so sidebar/board indicators don't
   *  have to scan every conversation on every streaming token. A new Set is
   *  minted only when membership actually changes — identity-stable otherwise. */
  streamingIds: Set<string>;
  /** True once we've finished loading the IDB snapshot for the active conv. */
  hydrated: Record<string, boolean>;
  /** Lightweight card previews (last reply / artifact count / review payload)
   *  for conversations that are NOT resident in `chats`. Loaded from the small
   *  `cetus:preview:*` IDB records so the board can light up its badges without
   *  hydrating full message lists (which froze startup once the cache grew).
   *  A resident ChatState always wins over its preview entry. */
  previews: Record<string, ConvPreview>;
  /** Merge a batch of loaded previews in one store tick. */
  setPreviews: (entries: Record<string, ConvPreview>) => void;
  /** Pending claude-code control requests (permission prompts / AskUserQuestion)
   *  per conversation, awaiting the user's answer. Captured here — off the
   *  reducer's message list — by the app's single always-mounted event listener
   *  so the card survives conversation switches and never races a per-component
   *  listener's async registration. Cleared when answered or when the turn ends. */
  controlRequests: Record<string, CliControlRequest[]>;
  /** Live background tasks (Monitors, async agents, background Bash) per
   *  conversation — the CLI session owns them across turns, so they're
   *  standing state, not part of any streaming turn. Replaced wholesale on
   *  each `cli_background_tasks` snapshot from the bridge. */
  backgroundTasks: Record<string, CliBackgroundTask[]>;
  ensure: (id: string) => void;
  drop: (id: string) => void;
  reset: (id: string, messages: PiMessage[] | undefined) => void;
  userSent: (
    id: string,
    text: string,
    images?: { dataUrl: string; name?: string }[],
    files?: { name: string; path: string; mimeType: string; sizeBytes: number }[],
  ) => void;
  piEvent: (id: string, event: PiEvent) => void;
  /** Queue a pending control request for `id` (dedup by requestId). */
  pushControlRequest: (id: string, req: CliControlRequest) => void;
  /** Drop one answered control request; also used to clear all of a
   *  conversation's pending requests when its turn ends (`requestId` omitted). */
  clearControlRequest: (id: string, requestId?: string | number) => void;
  /** Replace the conversation's live background-task list. */
  setBackgroundTasks: (id: string, tasks: CliBackgroundTask[]) => void;
  /** Native slash commands reported by the conversation's CLI session
   *  (initialize ack). Refreshed on every session (re)spawn. */
  cliCommands: Record<string, CliSlashCommand[]>;
  setCliCommands: (id: string, commands: CliSlashCommand[]) => void;
  /** Latest account-level quota snapshot per CLI runtime (backend id →
   *  rate_limit_info), from `cli_rate_limit` events. Only claude-code emits
   *  these today; the runtime picker renders them as a quota line. */
  cliRateLimits: Record<string, CliRateLimitInfo>;
  setCliRateLimit: (backend: string, info: CliRateLimitInfo) => void;
  /** Append a "running" breadcrumb for a local `!` bash command. */
  bashStart: (id: string, key: string, command: string, cwd?: string) => void;
  /** Settle a bash breadcrumb (by key) with its captured output. */
  bashDone: (id: string, key: string, result: BashResult) => void;
  /** Append the runtime-switch audit divider (backend ids, e.g. "codex" →
   *  "claude-code"). Mirrors the marker the backend persists to the transcript. */
  runtimeSwitch: (id: string, from: string, to: string) => void;
  setError: (id: string, message: string | null) => void;
  /** Locally end an interrupted run (abort emits no agent_end). Flips
   *  isStreaming false so the write-through cache flushes the rendered turn.
   *  keepPartial keeps the in-flight assistant turn (settled) instead of
   *  dropping it — for CLI backends, which persist the partial on abort. */
  endStream: (id: string, keepPartial?: boolean) => void;
  /** Hydrate from IDB cache without going through the reducer (already-rendered). */
  hydrate: (id: string, messages: RenderedMessage[]) => void;
  /** Copy the settled rendered view from one conversation id to another. */
  cloneRendered: (
    fromId: string,
    toId: string,
    throughKey?: string | null,
  ) => RenderedMessage[] | null;
}

/** Build the by-key index. Entries reuse the message refs from `messages`, so
 *  shallow per-message selectors keep their fine-grained re-render gating. */
function indexByKey(
  messages: RenderedMessage[],
): Record<string, RenderedMessage> {
  const out: Record<string, RenderedMessage> = {};
  for (const m of messages) out[m.key] = m;
  return out;
}

type Slice = Pick<ChatsStore, "chats" | "streamingIds">;

/** Apply one action to conversation `id`: run the reducer, rebuild the byKey
 *  index only when the message list changed, and keep streamingIds in sync.
 *  Returns the input slice unchanged on a reducer no-op (so set() is a no-op). */
function step(s: Slice, id: string, action: ChatAction): Slice {
  const prev = s.chats[id] ?? emptyChatState;
  const next = chatReducer(prev, action);
  if (next === prev) return s;
  const withIndex =
    next.messages !== prev.messages
      ? { ...next, byKey: indexByKey(next.messages) }
      : next;
  const chats = { ...s.chats, [id]: withIndex };
  let streamingIds = s.streamingIds;
  const wasActive = prev.isStreaming || prev.awaitingAssistant;
  const isActive = withIndex.isStreaming || withIndex.awaitingAssistant;
  if (isActive !== wasActive) {
    streamingIds = new Set(s.streamingIds);
    if (isActive) streamingIds.add(id);
    else streamingIds.delete(id);
  }
  return { chats, streamingIds };
}

/** Drop `id` from streamingIds, returning the same Set if it wasn't a member. */
function withoutStreaming(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

// ---------- Per-frame pi-event batching -------------------------------------
//
// Streaming deltas arrive many times per second. Applying each one through
// set() meant an O(messages) array copy + a full byKey re-index + a zustand
// notify (waking every mounted selector: board cards, sidebar dots, …) PER
// TOKEN — pure bookkeeping, since the visible markdown already repaints on its
// own ~90ms throttle. Buffer pi events and flush them in one set() per ~frame:
// the reducer runs per event (ordering-exact), but the copies, re-index, and
// notify happen once per flush.
//
// Ordering with other actions is preserved by flushing the buffer synchronously
// at the head of every other mutation (userSent, reset, endStream, …), so an
// interleaved action can never observe—or apply against—pre-buffer state.

const FLUSH_MS = 16;
let pendingPiEvents: { id: string; event: PiEvent }[] = [];
let piFlushTimer: number | null = null;

function flushPiEvents() {
  if (piFlushTimer != null) {
    clearTimeout(piFlushTimer);
    piFlushTimer = null;
  }
  if (pendingPiEvents.length === 0) return;
  const batch = pendingPiEvents;
  pendingPiEvents = [];
  useChatStore.setState((s) => {
    // Group per conversation, preserving each conversation's event order.
    const byConv = new Map<string, PiEvent[]>();
    for (const { id, event } of batch) {
      const q = byConv.get(id);
      if (q) q.push(event);
      else byConv.set(id, [event]);
    }
    let chats = s.chats;
    let streamingIds = s.streamingIds;
    let chatsCopied = false;
    for (const [id, events] of byConv) {
      const prev = chats[id] ?? emptyChatState;
      let next: ChatState = prev;
      for (const event of events) {
        next = chatReducer(next, { type: "pi_event", event });
      }
      if (next === prev) continue;
      const withIndex =
        next.messages !== prev.messages
          ? { ...next, byKey: indexByKey(next.messages) }
          : next;
      if (!chatsCopied) {
        chats = { ...chats };
        chatsCopied = true;
      }
      chats[id] = withIndex;
      const wasActive = prev.isStreaming || prev.awaitingAssistant;
      const isActive = withIndex.isStreaming || withIndex.awaitingAssistant;
      if (isActive !== wasActive) {
        streamingIds = new Set(streamingIds);
        if (isActive) streamingIds.add(id);
        else streamingIds.delete(id);
      }
    }
    if (!chatsCopied && streamingIds === s.streamingIds) return s;
    return { chats, streamingIds };
  });
}

function schedulePiFlush() {
  if (piFlushTimer != null) return;
  piFlushTimer = window.setTimeout(flushPiEvents, FLUSH_MS);
}

// ---------- In-memory LRU -------------------------------------------------
//
// Every conversation you open stays fully resident (messages + byKey index)
// otherwise, so a long session that touches many chats grows the heap without
// bound → GC pressure and a gradually slower app. We cap the number of resident
// conversations and evict the least-recently-opened ones. Eviction is safe:
// the sidebar list comes from page state, not this store, and reopening an
// evicted conv rehydrates it from the IndexedDB cache (or pi history). The
// active conv is always the most-recently-touched, so it is never evicted, and
// any conv with an in-flight run is skipped.
//
// The cap sits above the board view's warm-up set (WARMUP_CAP = 90 cards
// hydrated for previews), so normal board use never trips eviction; this only
// bounds the unbounded accumulation from opening many chats over a session.

const MAX_RESIDENT_CHATS = 128;
/** Conversation ids in least-recently-opened → most-recent order. */
const accessOrder: string[] = [];

function touchAccess(id: string) {
  const i = accessOrder.indexOf(id);
  if (i !== -1) accessOrder.splice(i, 1);
  accessOrder.push(id);
}

/** Pick LRU conversations to evict so `chats` fits MAX_RESIDENT_CHATS, never
 *  evicting `keepId` or any conv with an active run. */
function evictionTargets(
  chats: Record<string, ChatState>,
  streamingIds: Set<string>,
  keepId: string,
): string[] {
  const residentCount = Object.keys(chats).length;
  if (residentCount <= MAX_RESIDENT_CHATS) return [];
  const drops: string[] = [];
  let remaining = residentCount;
  for (const id of accessOrder) {
    if (remaining <= MAX_RESIDENT_CHATS) break;
    if (id === keepId || !(id in chats) || streamingIds.has(id)) continue;
    drops.push(id);
    remaining--;
  }
  return drops;
}

export const useChatStore = create<ChatsStore>()((set) => ({
  chats: {},
  streamingIds: new Set<string>(),
  hydrated: {},
  previews: {},
  setPreviews: (entries) =>
    set((s) => {
      let changed = false;
      const next = { ...s.previews };
      for (const [id, p] of Object.entries(entries)) {
        if (next[id] !== p) {
          next[id] = p;
          changed = true;
        }
      }
      return changed ? { previews: next } : s;
    }),
  controlRequests: {},
  backgroundTasks: {},
  cliCommands: {},
  cliRateLimits: {},
  ensure: (id) => {
    flushPiEvents();
    set((s) => {
      touchAccess(id);
      const chats = id in s.chats ? s.chats : { ...s.chats, [id]: emptyChatState };
      const drops = evictionTargets(chats, s.streamingIds, id);
      if (drops.length === 0) return chats === s.chats ? s : { chats };
      const nextChats = { ...chats };
      let streamingIds = s.streamingIds;
      for (const d of drops) {
        delete nextChats[d];
        streamingIds = withoutStreaming(streamingIds, d);
        // Release the persist bookkeeping's refs into the evicted arrays —
        // otherwise the evicted conversation's messages stay reachable and
        // eviction frees nothing.
        lastPersisted.delete(d);
        segState.delete(d);
      }
      return { chats: nextChats, streamingIds };
    });
  },
  drop: (id) => {
    flushPiEvents();
    const i = accessOrder.indexOf(id);
    if (i !== -1) accessOrder.splice(i, 1);
    lastPersisted.delete(id);
    segState.delete(id);
    set((s) => {
      if (!(id in s.chats)) return s;
      const next = { ...s.chats };
      delete next[id];
      let controlRequests = s.controlRequests;
      if (id in controlRequests) {
        controlRequests = { ...controlRequests };
        delete controlRequests[id];
      }
      let backgroundTasks = s.backgroundTasks;
      if (id in backgroundTasks) {
        backgroundTasks = { ...backgroundTasks };
        delete backgroundTasks[id];
      }
      let cliCommands = s.cliCommands;
      if (id in cliCommands) {
        cliCommands = { ...cliCommands };
        delete cliCommands[id];
      }
      return {
        chats: next,
        streamingIds: withoutStreaming(s.streamingIds, id),
        controlRequests,
        backgroundTasks,
        cliCommands,
      };
    });
  },
  reset: (id, messages) => {
    flushPiEvents();
    touchAccess(id);
    set((s) => step(s, id, { type: "reset", messages }));
  },
  userSent: (id, text, images, files) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "user_sent", text, images, files }));
  },
  // Streaming hot path: buffered, applied once per frame (see flushPiEvents).
  piEvent: (id, event) => {
    pendingPiEvents.push({ id, event });
    schedulePiFlush();
  },
  pushControlRequest: (id, req) => {
    set((s) => {
      const cur = s.controlRequests[id] ?? [];
      if (cur.some((r) => String(r.requestId) === String(req.requestId))) return s;
      return { controlRequests: { ...s.controlRequests, [id]: [...cur, req] } };
    });
  },
  clearControlRequest: (id, requestId) => {
    set((s) => {
      const cur = s.controlRequests[id];
      if (!cur || cur.length === 0) return s;
      const next = requestId
        ? cur.filter((r) => String(r.requestId) !== String(requestId))
        : [];
      if (next.length === cur.length) return s;
      const controlRequests = { ...s.controlRequests };
      if (next.length === 0) delete controlRequests[id];
      else controlRequests[id] = next;
      return { controlRequests };
    });
  },
  setBackgroundTasks: (id, tasks) => {
    set((s) => {
      if (tasks.length === 0 && !(id in s.backgroundTasks)) return s;
      const backgroundTasks = { ...s.backgroundTasks };
      if (tasks.length === 0) delete backgroundTasks[id];
      else backgroundTasks[id] = tasks;
      return { backgroundTasks };
    });
  },
  setCliCommands: (id, commands) => {
    set((s) => ({ cliCommands: { ...s.cliCommands, [id]: commands } }));
  },
  setCliRateLimit: (backend, info) => {
    set((s) => ({ cliRateLimits: { ...s.cliRateLimits, [backend]: info } }));
  },
  bashStart: (id, key, command, cwd) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "bash_start", key, command, cwd }));
  },
  bashDone: (id, key, result) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "bash_done", key, result }));
  },
  runtimeSwitch: (id, from, to) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "runtime_switch", from, to }));
  },
  setError: (id, message) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "set_error", message }));
  },
  endStream: (id, keepPartial) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "end_stream", keepPartial }));
  },
  hydrate: (id, messages) => {
    flushPiEvents();
    touchAccess(id);
    // This exact array just came out of the IDB cache — mark it as already
    // persisted so the write-through subscriber doesn't re-serialize the whole
    // conversation straight back into IDB (a pure-waste full-cache rewrite
    // that froze startup when many conversations hydrated at once).
    lastPersisted.set(id, messages);
    // Adopt the loaded array's segment layout so the first persist after
    // rehydration stays incremental. Unknown provenance (legacy v1 record or
    // a backend render) drops the bookkeeping → next persist re-splits.
    const counts = loadedCounts.get(messages);
    if (counts) {
      const sealed = messages.length - counts[counts.length - 1];
      segState.set(id, { counts, sealedRefs: messages.slice(0, sealed) });
    } else {
      segState.delete(id);
    }
    return set((s) => ({
      chats: {
        ...s.chats,
        [id]: {
          ...emptyChatState,
          messages,
          byKey: indexByKey(messages),
          hasArtifacts: computeHasArtifacts(messages),
        },
      },
      // A hydrated (cached, settled) render is never mid-stream.
      streamingIds: withoutStreaming(s.streamingIds, id),
      hydrated: { ...s.hydrated, [id]: true },
    }));
  },
  cloneRendered: (fromId, toId, throughKey) => {
    flushPiEvents();
    touchAccess(toId);
    let cloned: RenderedMessage[] | null = null;
    set((s) => {
      const from = s.chats[fromId];
      if (!from || from.messages.length === 0) return s;
      const end =
        throughKey == null
          ? from.messages.length
          : from.messages.findIndex((m) => m.key === throughKey) + 1;
      const messages = stripForPersist(
        from.messages.slice(0, end > 0 ? end : from.messages.length),
      );
      cloned = messages;
      return {
        chats: {
          ...s.chats,
          [toId]: {
            ...emptyChatState,
            messages,
            byKey: indexByKey(messages),
            hasArtifacts: computeHasArtifacts(messages),
          },
        },
        streamingIds: withoutStreaming(s.streamingIds, toId),
        hydrated: { ...s.hydrated, [toId]: true },
      };
    });
    return cloned;
  },
}));

// ---------- Selectors ----------------------------------------------------

/** Just the ordered list of message keys. Stable unless messages are added/removed. */
export function useMessageKeys(convId: string | null | undefined): string[] {
  return useChatStore(
    useShallow((s) => {
      const c = convId ? s.chats[convId] : undefined;
      if (!c) return EMPTY_KEYS;
      return c.messages.map((m) => m.key);
    }),
  );
}
const EMPTY_KEYS: string[] = [];

/** Single message by key — only re-renders subscribers when *this* message
 *  changes. O(1) via the byKey index. */
export function useMessage(
  convId: string | null | undefined,
  key: string,
): RenderedMessage | undefined {
  return useChatStore((s) => {
    const c = convId ? s.chats[convId] : undefined;
    return c ? c.byKey[key] : undefined;
  });
}

/** Per-message roles, in order. Shallow-stable — only changes when a message is
 *  added/removed (or, rarely, a role flips). Used to group consecutive assistant
 *  turns without subscribing to message bodies. */
export function useMessageRoles(
  convId: string | null | undefined,
): RenderedMessage["role"][] {
  return useChatStore(
    useShallow((s) => {
      const c = convId ? s.chats[convId] : undefined;
      if (!c) return EMPTY_ROLES;
      return c.messages.map((m) => m.role);
    }),
  );
}
const EMPTY_ROLES: RenderedMessage["role"][] = [];

/** Keys of the user messages, in order — one per turn. Drives the turn
 *  navigator (TOC), where each tick maps to a user prompt. Shallow-stable: only
 *  changes when a user message is added/removed, never on a streaming token. */
export function useUserTurnKeys(convId: string | null | undefined): string[] {
  return useChatStore(
    useShallow((s) => {
      const c = convId ? s.chats[convId] : undefined;
      if (!c) return EMPTY_KEYS;
      const out: string[] = [];
      for (const m of c.messages) if (m.role === "user") out.push(m.key);
      return out.length ? out : EMPTY_KEYS;
    }),
  );
}

function firstText(m: RenderedMessage | undefined): string {
  if (!m) return "";
  for (const b of m.blocks) {
    if (b.kind === "text" && b.text.trim()) return b.text.trim();
  }
  return "";
}

/** Non-reactive read (called on hover, not subscribed) of a turn's preview for
 *  the navigator popover: the user prompt plus a snippet of the assistant reply
 *  that followed it. Kept off the reactive path so the navigator never
 *  re-renders per streaming token. */
export function getTurnPreview(
  convId: string | null | undefined,
  key: string,
): { prompt: string; reply: string } {
  const c = convId ? useChatStore.getState().chats[convId] : undefined;
  if (!c) return { prompt: "", reply: "" };
  const idx = c.messages.findIndex((m) => m.key === key);
  if (idx < 0) return { prompt: "", reply: "" };
  const prompt = firstText(c.messages[idx]);
  let reply = "";
  for (let i = idx + 1; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.role === "user") break;
    if (m.role === "assistant") {
      const t = firstText(m);
      if (t) {
        reply = t;
        break;
      }
    }
  }
  return { prompt, reply };
}

/** Several messages by key — re-renders only when one of *these* messages
 *  changes (useShallow does element-wise ref comparison). Drives the grouped
 *  assistant turn so a token mutation repaints just the active group. */
export function useMessagesByKeys(
  convId: string | null | undefined,
  keys: string[],
): RenderedMessage[] {
  return useChatStore(
    useShallow((s) => {
      const c = convId ? s.chats[convId] : undefined;
      if (!c) return EMPTY_MESSAGES;
      const out: RenderedMessage[] = [];
      for (const k of keys) {
        const m = c.byKey[k];
        if (m) out.push(m);
      }
      return out;
    }),
  );
}
const EMPTY_MESSAGES: RenderedMessage[] = [];

/** Streaming flag for a conv. */
export function useIsStreaming(convId: string | null | undefined): boolean {
  return useChatStore((s) =>
    Boolean(convId && s.chats[convId]?.isStreaming),
  );
}

/** True between send and the first assistant token — UI shows a placeholder. */
export function useAwaitingAssistant(
  convId: string | null | undefined,
): boolean {
  return useChatStore((s) =>
    Boolean(convId && s.chats[convId]?.awaitingAssistant),
  );
}

/** Error string for a conv. */
export function useChatError(
  convId: string | null | undefined,
): string | null {
  return useChatStore((s) => (convId && s.chats[convId]?.error) || null);
}

/** Cheap boolean read off the sticky reducer flag — O(1) per store tick. */
export function useHasArtifacts(convId: string | null | undefined): boolean {
  return useChatStore((s) =>
    Boolean(convId && s.chats[convId]?.hasArtifacts),
  );
}

/** Has-any-message boolean, used to switch between hero / docked composer. */
export function useHasMessages(convId: string | null | undefined): boolean {
  return useChatStore((s) => {
    const c = convId ? s.chats[convId] : undefined;
    return !!c && c.messages.length > 0;
  });
}

const EMPTY_CONTROL_REQUESTS: CliControlRequest[] = [];

/** Pending control requests for `convId`, awaiting the user's answer. */
export function useControlRequests(
  convId: string | null | undefined,
): CliControlRequest[] {
  return useChatStore((s) =>
    convId ? s.controlRequests[convId] ?? EMPTY_CONTROL_REQUESTS : EMPTY_CONTROL_REQUESTS,
  );
}

const EMPTY_BACKGROUND_TASKS: CliBackgroundTask[] = [];

/** Live background tasks (Monitors, async agents, background Bash) owned by
 *  `convId`'s CLI session. */
export function useBackgroundTasks(
  convId: string | null | undefined,
): CliBackgroundTask[] {
  return useChatStore((s) =>
    convId ? s.backgroundTasks[convId] ?? EMPTY_BACKGROUND_TASKS : EMPTY_BACKGROUND_TASKS,
  );
}

const EMPTY_CLI_COMMANDS: CliSlashCommand[] = [];

/** Native slash commands the conversation's CLI session reported on boot. */
export function useCliCommands(
  convId: string | null | undefined,
): CliSlashCommand[] {
  return useChatStore((s) =>
    convId ? s.cliCommands[convId] ?? EMPTY_CLI_COMMANDS : EMPTY_CLI_COMMANDS,
  );
}

/** Set of conv ids currently active or awaiting the assistant (for board view
 *  dots etc). Maintained incrementally in the store, so this is an
 *  identity-stable read that only changes when a run starts/ends — not on every
 *  streaming token. */
export function useStreamingIds(): Set<string> {
  return useChatStore((s) => s.streamingIds);
}

/** A background subagent (claude-code Task/Agent tool) still running in the
 *  current turn. Surfaced above the composer so the user knows *why* the run
 *  is held open after the main reply already landed. */
export interface RunningSubagent {
  /** The originating Agent tool_use block id. */
  id: string;
  /** subagent_type, e.g. "general-purpose", "Explore". */
  type: string;
  /** The task description the agent was launched with. */
  description: string;
}

const EMPTY_SUBAGENTS: RunningSubagent[] = [];

/** Read a tool_use block's attached subagent progress, returning it only while
 *  the subagent is still running. Mirrors the fields subagentInfo() reads in
 *  tool-use-card, kept here so the store doesn't depend on a component. */
function readRunningSubagent(block: RenderedBlock): RunningSubagent | null {
  if (block.kind !== "tool_use") return null;
  const details = block.result?.details;
  if (!details || typeof details !== "object") return null;
  const sub = (details as { subagent?: unknown }).subagent;
  if (!sub || typeof sub !== "object") return null;
  const s = sub as { type?: unknown; description?: unknown; status?: unknown };
  if (s.status !== "running") return null;
  return {
    id: block.id,
    type: typeof s.type === "string" ? s.type : "agent",
    description: typeof s.description === "string" ? s.description : "",
  };
}

/** Background subagents still running in the conversation (Claude async tasks
 *  and Codex child threads, which may outlive their launching root turn). The selector returns a signature string so the
 *  strip only re-renders when the *set* changes — not on every streaming token —
 *  and useMemo re-inflates the array off that signature. Scans backwards from
 *  the end to the turn's user boundary, so it's robust to whether the main
 *  assistant slot has already settled while the turn is held open. */
export function useRunningSubagents(
  convId: string | null | undefined,
): RunningSubagent[] {
  const sig = useChatStore((s) => {
    const c = convId ? s.chats[convId] : undefined;
    if (!c) return "";
    const found: RunningSubagent[] = [];
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      for (const b of m.blocks) {
        const sub = readRunningSubagent(b);
        if (sub) found.push(sub);
      }
    }
    // A JSON signature keeps the selector's return primitive: identical sets
    // compare equal (no re-render churn per token), and useMemo re-inflates the
    // array only when the string changes. Collision-proof over free-form text.
    return found.length ? JSON.stringify(found) : "";
  });
  return useMemo(
    () => (sig ? (JSON.parse(sig) as RunningSubagent[]) : EMPTY_SUBAGENTS),
    [sig],
  );
}

// ---------- IndexedDB write-through cache --------------------------------
//
// Persists the rendered render with streaming flags / _raw stripped. We can't
// only write on the settled (agent_end) frame: an interrupted run (abort, or a
// killed pi) never emits agent_end, so a settle-only cache loses the whole turn
// on reload. Instead we throttle writes WHILE streaming (so we don't thrash IDB
// on every token) and write immediately once settled — bounding worst-case loss
// to one throttle window.

const STREAM_PERSIST_THROTTLE_MS = 2000;

/** Messages per sealed segment record. Sealed segments are immutable on disk:
 *  a persist rewrites only the open tail segment (plus the tiny index), so the
 *  cost of caching a conversation is bounded by the tail size, not the
 *  conversation length. Rewriting the whole array on every settle is what
 *  ground the app down once a conversation grew past ~1000 messages. */
const SEGMENT_SIZE = 100;

const IDB_PREFIX = "cetus:chat:";
const idbKey = (convId: string) => `${IDB_PREFIX}${convId}`;
const segKey = (convId: string, index: number) =>
  `${IDB_PREFIX}${convId}:s${index}`;
const PREVIEW_PREFIX = "cetus:preview:";
const previewKey = (convId: string) => `${PREVIEW_PREFIX}${convId}`;

/** Conversation id a cache key belongs to (index, segment, or preview key),
 *  or null for keys outside the cache's namespaces. */
function convIdOfCacheKey(key: string): string | null {
  const body = key.startsWith(IDB_PREFIX)
    ? key.slice(IDB_PREFIX.length)
    : key.startsWith(PREVIEW_PREFIX)
      ? key.slice(PREVIEW_PREFIX.length)
      : null;
  if (body === null) return null;
  const colon = body.indexOf(":");
  return colon === -1 ? body : body.slice(0, colon);
}

/** Last message-array reference persisted (or loaded — a cache read is by
 *  definition already persisted) per convId, so the write-through subscriber
 *  only writes on actual change. Module-scoped so `hydrate` can pre-mark the
 *  arrays it loads from the cache. */
const lastPersisted = new Map<string, RenderedMessage[]>();

/** The index record under `cetus:chat:<id>`: per-segment message counts, with
 *  the last entry describing the open (still-growing) segment. */
interface CachedIndex {
  v: 2;
  counts: number[];
}

/** Pre-segmentation record shape: the whole conversation in one value. Still
 *  readable so updating doesn't cold-start every cache; replaced by a v2
 *  index + segments on the first persist after load. */
interface LegacyCachedShape {
  v: 1;
  messages: RenderedMessage[];
}

/** Per-conversation segment bookkeeping for the write path. `counts` mirrors
 *  the stored index; `sealedRefs` holds the store-side refs of every message
 *  inside a sealed segment, so a persist can prove a sealed segment unchanged
 *  by ref equality and skip re-serializing it. A ref mismatch (e.g. a tool
 *  result landing in an old message) dirties just that segment. */
const segState = new Map<
  string,
  { counts: number[]; sealedRefs: RenderedMessage[] }
>();

/** Segment counts of arrays returned by `loadCachedMessages`, keyed by the
 *  array itself; `hydrate` transfers them into `segState` so the first persist
 *  after rehydration stays incremental instead of re-splitting everything. */
const loadedCounts = new WeakMap<RenderedMessage[], number[]>();

/** Per-conversation promise chain so cache writes for one conversation never
 *  interleave (segment bookkeeping assumes strictly ordered writes). */
const writeChains = new Map<string, Promise<void>>();

/** Small per-conversation record backing board cards for conversations that
 *  aren't resident in memory. Written alongside the full message cache; read
 *  in bulk by the board warm-up instead of hydrating full conversations. */
export interface ConvPreview {
  v: 1;
  lastReply: string | null;
  artifactCount: number;
  review: ReviewRequestDetails | null;
}

/** Most recent assistant text, whitespace-collapsed and capped for card use. */
export function computeLastReplyPreview(
  messages: RenderedMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind === "text" && b.text.trim()) {
        return b.text.replace(/\s+/g, " ").slice(0, 220);
      }
    }
  }
  return null;
}

export function computeArtifactCount(messages: RenderedMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_use" && b.result) {
        n += artifactsFromDetails(b.result.details).length;
      }
    }
  }
  return n;
}

export function computeLatestReviewRequest(
  messages: RenderedMessage[],
): ReviewRequestDetails | null {
  let latest: ReviewRequestDetails | null = null;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (
        b.kind === "tool_use" &&
        b.name === "request_review" &&
        b.result &&
        isReviewRequestDetails(b.result.details)
      ) {
        latest = b.result.details as ReviewRequestDetails; // last one wins
      }
    }
  }
  return latest;
}

function computePreview(messages: RenderedMessage[]): ConvPreview {
  return {
    v: 1,
    lastReply: computeLastReplyPreview(messages),
    artifactCount: computeArtifactCount(messages),
    review: computeLatestReviewRequest(messages),
  };
}

function stripForPersist(messages: RenderedMessage[]): RenderedMessage[] {
  return messages.map((m) => {
    const { ...rest } = m;
    // Drop the _raw escape hatch — it's only needed during initial inflate.
    if ("_raw" in rest) delete (rest as Record<string, unknown>)._raw;
    rest.blocks = rest.blocks.map((b) => {
      if ("streaming" in b && b.streaming) {
        const { streaming: _s, ...r } = b;
        void _s;
        return r as typeof b;
      }
      return b;
    });
    return rest;
  });
}

export async function loadCachedMessages(
  convId: string,
): Promise<RenderedMessage[] | null> {
  try {
    const raw = await idbGet<CachedIndex | LegacyCachedShape>(idbKey(convId));
    if (!raw) return null;
    if (raw.v === 1) return raw.messages;
    if (raw.v !== 2 || raw.counts.length === 0) return null;
    const segments = await idbGetMany<RenderedMessage[] | undefined>(
      raw.counts.map((_, i) => segKey(convId, i)),
    );
    const messages: RenderedMessage[] = [];
    for (let i = 0; i < raw.counts.length; i++) {
      const segment = segments[i];
      // A missing or short segment means a torn write; treat the whole record
      // as a cache miss and let the backend rebuild the render.
      if (!Array.isArray(segment) || segment.length !== raw.counts[i]) {
        return null;
      }
      messages.push(...segment);
    }
    loadedCounts.set(messages, raw.counts);
    return messages;
  } catch {
    return null;
  }
}

export async function copyCachedMessages(
  fromConvId: string,
  toConvId: string,
): Promise<RenderedMessage[] | null> {
  const messages = await loadCachedMessages(fromConvId);
  if (!messages || messages.length === 0) return null;
  await saveCachedMessages(toConvId, messages);
  return messages;
}

function saveCachedMessages(
  convId: string,
  messages: RenderedMessage[],
): Promise<void> {
  const prev = writeChains.get(convId) ?? Promise.resolve();
  const next = prev
    .then(() => writeCacheRecords(convId, messages))
    .catch(() => {
      // best-effort; quota/private-mode failures are fine.
    });
  writeChains.set(convId, next);
  return next;
}

/** Write one conversation's cache records. Incremental when the sealed prefix
 *  is provably unchanged (ref equality against `segState`): rewrites only the
 *  open tail segment, any dirtied sealed segments, and the index. Falls back
 *  to a full re-split when the array shrank or has unknown provenance. Runs
 *  inside the per-conversation write chain — never call directly. */
async function writeCacheRecords(
  convId: string,
  messages: RenderedMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const st = segState.get(convId);
  const sealedCount = st ? st.sealedRefs.length : 0;
  const incremental = st !== undefined && messages.length > sealedCount;

  const entries: [string, unknown][] = [];
  let counts: number[];
  let staleSegKeys: string[] = [];

  if (!incremental || !st) {
    // Full split. Read the previous index (if any) so segment records beyond
    // the new count don't linger as unreadable orphans.
    const prev = await idbGet<CachedIndex | LegacyCachedShape>(
      idbKey(convId),
    ).catch(() => undefined);
    counts = [];
    for (let start = 0; start < messages.length; start += SEGMENT_SIZE) {
      const chunk = stripForPersist(messages.slice(start, start + SEGMENT_SIZE));
      entries.push([segKey(convId, counts.length), chunk]);
      counts.push(chunk.length);
    }
    if (prev && prev.v === 2 && prev.counts.length > counts.length) {
      staleSegKeys = prev.counts
        .slice(counts.length)
        .map((_, i) => segKey(convId, counts.length + i));
    }
  } else {
    counts = st.counts.slice();
    // Rewrite sealed segments whose message refs changed (late tool results).
    let start = 0;
    for (let seg = 0; seg < counts.length - 1; seg++) {
      const end = start + counts[seg];
      for (let i = start; i < end; i++) {
        if (messages[i] !== st.sealedRefs[i]) {
          entries.push([
            segKey(convId, seg),
            stripForPersist(messages.slice(start, end)),
          ]);
          break;
        }
      }
      start = end;
    }
    // Seal full tail chunks, then rewrite the open segment.
    let openStart = sealedCount;
    while (messages.length - openStart > SEGMENT_SIZE) {
      counts[counts.length - 1] = SEGMENT_SIZE;
      entries.push([
        segKey(convId, counts.length - 1),
        stripForPersist(messages.slice(openStart, openStart + SEGMENT_SIZE)),
      ]);
      openStart += SEGMENT_SIZE;
      counts.push(0);
    }
    counts[counts.length - 1] = messages.length - openStart;
    entries.push([
      segKey(convId, counts.length - 1),
      stripForPersist(messages.slice(openStart)),
    ]);
  }

  entries.push([idbKey(convId), { v: 2, counts } satisfies CachedIndex]);
  // Keep the lightweight card preview in step with the full cache, so the
  // board can read just this record instead of the whole conversation.
  entries.push([previewKey(convId), computePreview(messages)]);

  segState.set(convId, {
    counts,
    sealedRefs: messages.slice(0, messages.length - counts[counts.length - 1]),
  });
  try {
    // One transaction: segments, index, and preview land atomically.
    await idbSetMany(entries);
  } catch (error) {
    // Bookkeeping may no longer match disk — force a full re-split next time.
    segState.delete(convId);
    throw error;
  }
  if (staleSegKeys.length > 0) await idbDelMany(staleSegKeys);
}

/** Bulk-load card previews. Returns only the ids that had a valid record. */
export async function loadCachedPreviews(
  convIds: string[],
): Promise<Record<string, ConvPreview>> {
  const out: Record<string, ConvPreview> = {};
  if (convIds.length === 0) return out;
  try {
    const values = await idbGetMany<ConvPreview | undefined>(
      convIds.map(previewKey),
    );
    values.forEach((v, i) => {
      if (v && v.v === 1) out[convIds[i]] = v;
    });
  } catch {
    // best-effort; a dark preview is fine.
  }
  return out;
}

/** Drop cache + preview records whose conversation is no longer live (deleted
 *  or archived). The cache is purely a render accelerator — evicted ids fall
 *  back to the backend on open — but without pruning it grows without bound
 *  (hundreds of MB), and hydrating against it froze startup. */
export async function pruneMessageCache(liveIds: Iterable<string>) {
  const keep = new Set<string>(liveIds);
  try {
    const all = await idbKeys();
    const stale = all.filter((k): k is string => {
      if (typeof k !== "string") return false;
      const conv = convIdOfCacheKey(k);
      return conv !== null && !keep.has(conv);
    });
    if (stale.length > 0) await idbDelMany(stale);
  } catch {
    // best-effort; a fat cache is a perf bug, not a correctness bug.
  }
}

/** Subscribe to store changes and persist conversations. Idempotent. */
let persistInstalled = false;
export function installChatPersistence() {
  if (persistInstalled) return;
  persistInstalled = true;
  // Last write timestamp per conv, to throttle mid-stream writes.
  const lastWriteAt = new Map<string, number>();
  // Convs with messages buffered but not yet flushed (throttle window open) —
  // flushed on pagehide so a reload mid-stream keeps the latest render.
  const dirty = new Map<string, RenderedMessage[]>();

  const persist = (id: string, messages: RenderedMessage[]) => {
    lastPersisted.set(id, messages);
    lastWriteAt.set(id, Date.now());
    dirty.delete(id);
    void saveCachedMessages(id, messages);
  };

  useChatStore.subscribe((s, prev) => {
    for (const [id, c] of Object.entries(s.chats)) {
      // Fast path: chat ref unchanged from previous tick → skip.
      if (prev && c === prev.chats[id]) continue;
      if (c.messages.length === 0) continue;
      // Skips both already-written arrays and arrays freshly loaded from the
      // cache (`hydrate` pre-marks those) — hydration must never bounce the
      // whole conversation back into IDB.
      if (lastPersisted.get(id) === c.messages) continue;
      if (c.isStreaming) {
        // Throttle while streaming so we don't thrash IDB on every token, but
        // still capture progress so an interrupted run survives a reload.
        const last = lastWriteAt.get(id) ?? 0;
        if (Date.now() - last < STREAM_PERSIST_THROTTLE_MS) {
          dirty.set(id, c.messages);
          continue;
        }
      }
      persist(id, c.messages);
    }
  });

  // Best-effort flush of any throttled-but-unwritten render when the page is
  // hidden / unloaded, so a reload mid-stream doesn't lose the last window.
  if (typeof window !== "undefined") {
    const flush = () => {
      for (const [id, messages] of dirty) persist(id, messages);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

// ---------- localStorage: last active conversation -----------------------

const ACTIVE_KEY = "cetus:activeConversationId";

export function loadLastActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveLastActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}
