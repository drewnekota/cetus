// Zustand store wrapping the existing chat reducer.
//
// Why a store and not useReducer-in-page: per-message subscriptions. Selectors
// keyed by (convId, messageKey) only re-render when *that specific* message
// changes, so a streaming token mutation only repaints the active bubble — not
// the whole list.
//
// Reducer logic stays in chat-state.ts; this is just the React glue plus an
// IndexedDB write-through cache for happy-path hydration on cold start.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { get as idbGet, set as idbSet } from "idb-keyval";
import {
  chatReducer,
  computeHasArtifacts,
  emptyChatState,
  type ChatAction,
  type ChatState,
} from "./chat-state";
import type { BashResult, PiEvent, PiMessage, RenderedMessage } from "./types";

interface ChatsStore {
  chats: Record<string, ChatState>;
  /** Conversation ids with an active or pending run. Maintained incrementally
   *  as each conv's run-active flag flips, so sidebar/board indicators don't
   *  have to scan every conversation on every streaming token. A new Set is
   *  minted only when membership actually changes — identity-stable otherwise. */
  streamingIds: Set<string>;
  /** True once we've finished loading the IDB snapshot for the active conv. */
  hydrated: Record<string, boolean>;
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
  /** Append a "running" breadcrumb for a local `!` bash command. */
  bashStart: (id: string, key: string, command: string, cwd?: string) => void;
  /** Settle a bash breadcrumb (by key) with its captured output. */
  bashDone: (id: string, key: string, result: BashResult) => void;
  setError: (id: string, message: string | null) => void;
  /** Locally end an interrupted run (abort emits no agent_end). Flips
   *  isStreaming false so the write-through cache flushes the rendered turn. */
  endStream: (id: string) => void;
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
      }
      return { chats: nextChats, streamingIds };
    });
  },
  drop: (id) => {
    flushPiEvents();
    const i = accessOrder.indexOf(id);
    if (i !== -1) accessOrder.splice(i, 1);
    set((s) => {
      if (!(id in s.chats)) return s;
      const next = { ...s.chats };
      delete next[id];
      return { chats: next, streamingIds: withoutStreaming(s.streamingIds, id) };
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
  bashStart: (id, key, command, cwd) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "bash_start", key, command, cwd }));
  },
  bashDone: (id, key, result) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "bash_done", key, result }));
  },
  setError: (id, message) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "set_error", message }));
  },
  endStream: (id) => {
    flushPiEvents();
    set((s) => step(s, id, { type: "end_stream" }));
  },
  hydrate: (id, messages) => {
    flushPiEvents();
    touchAccess(id);
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

/** Set of conv ids currently active or awaiting the assistant (for board view
 *  dots etc). Maintained incrementally in the store, so this is an
 *  identity-stable read that only changes when a run starts/ends — not on every
 *  streaming token. */
export function useStreamingIds(): Set<string> {
  return useChatStore((s) => s.streamingIds);
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

const IDB_PREFIX = "cetus:chat:";
const idbKey = (convId: string) => `${IDB_PREFIX}${convId}`;

interface CachedShape {
  v: 1;
  messages: RenderedMessage[];
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
    const raw = await idbGet<CachedShape>(idbKey(convId));
    if (!raw || raw.v !== 1) return null;
    return raw.messages;
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

async function saveCachedMessages(
  convId: string,
  messages: RenderedMessage[],
) {
  try {
    await idbSet(idbKey(convId), {
      v: 1,
      messages: stripForPersist(messages),
    } satisfies CachedShape);
  } catch {
    // best-effort; quota/private-mode failures are fine.
  }
}

/** Subscribe to store changes and persist conversations. Idempotent. */
let persistInstalled = false;
export function installChatPersistence() {
  if (persistInstalled) return;
  persistInstalled = true;
  // Track last persisted reference per convId so we only write on actual change.
  const lastSeen = new Map<string, RenderedMessage[]>();
  // Last write timestamp per conv, to throttle mid-stream writes.
  const lastWriteAt = new Map<string, number>();
  // Convs with messages buffered but not yet flushed (throttle window open) —
  // flushed on pagehide so a reload mid-stream keeps the latest render.
  const dirty = new Map<string, RenderedMessage[]>();

  const persist = (id: string, messages: RenderedMessage[]) => {
    lastSeen.set(id, messages);
    lastWriteAt.set(id, Date.now());
    dirty.delete(id);
    void saveCachedMessages(id, messages);
  };

  useChatStore.subscribe((s, prev) => {
    for (const [id, c] of Object.entries(s.chats)) {
      // Fast path: chat ref unchanged from previous tick → skip.
      if (prev && c === prev.chats[id]) continue;
      if (c.messages.length === 0) continue;
      if (lastSeen.get(id) === c.messages) continue;
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
