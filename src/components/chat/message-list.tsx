"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ChatVirtualList,
  type ChatListSnapshot,
  type ChatListHandle,
} from "./chat-virtual-list";
import { MessageBubble } from "@/components/chat/message-bubble";
import { AssistantGroup } from "@/components/chat/assistant-turn";
import { bindChatTailScroll } from "@/lib/chat-tail-scroll";
import { clearHoverOwner } from "@/components/chat/hover-owner";
import { ArrowDown } from "lucide-react";
import {
  getTurnPreview,
  useAwaitingAssistant,
  useChatError,
  useChatStore,
  useMessageKeys,
  useMessageRoles,
} from "@/lib/chat-store";
import { toast } from "sonner";
import { findQuoteSource, quoteRange } from "@/lib/quote-navigation";
import { FindBar } from "@/components/chat/find-bar";
import {
  clearFindHighlights,
  FIND_IN_CHAT_EVENT,
  paintFindHighlights,
  revealRange,
} from "@/components/chat/find-highlight";
import {
  buildFindMatches,
  firstMatchFrom,
  messageFindText,
  preserveActive,
  stepMatch,
} from "@/lib/message-search";
import { useTranslation } from "@/lib/i18n";
import { ThinkingPlaceholder, MessageError } from "./chat-status";
import { QuoteSelectionToolbar } from "./quote-selection";

// The elevator is intentionally less eager than sticky-bottom follow: a small
// nudge away from the latest message should not summon a floating control.
const SCROLL_TO_BOTTOM_BUTTON_MIN_PX = 360;

const SCROLL_TO_BOTTOM_BUTTON_VIEWPORT_RATIO = 0.5;

// The turn navigator occupies the left 48px from `sm` upward. Before the
// max-w-3xl reading column has enough viewport space to center itself clear of
// that rail (896px), reserve the rail explicitly so its ticks never overlap
// message text. At wider sizes the column's normal centering provides the gap.
const MESSAGE_ROW_GUTTER_CLASS = "px-4 sm:pl-14 min-[896px]:px-4";

/** Reading position per conversation, so a half-read history resumes where it
 *  was left instead of snapping to the newest turn. Only conversations the
 *  reader scrolled AWAY from the bottom get an entry: sitting at the bottom is
 *  the default open position and must keep following new messages.
 *
 *  ChatListSnapshot is the unit here (scrollTop + the measured item
 *  sizes): a raw scrollTop alone restores wrong, because a remounted list only
 *  has height ESTIMATES for the turns it hasn't mounted yet. Deliberately
 *  in-memory (module scope, not IndexedDB): it is worth exactly one app session,
 *  and the message store already pays enough persistence cost. */
const readingAnchors = new Map<string, ChatListSnapshot>();

const MAX_READING_ANCHORS = 64;

// How long after opening a conversation scroll events are still treated as part
// of the landing rather than as the reader moving.
const OPEN_SETTLE_MS = 1000;

function rememberReadingAnchor(convId: string, snapshot: ChatListSnapshot) {
  // Delete-then-set so the Map's insertion order stays a true LRU.
  readingAnchors.delete(convId);
  readingAnchors.set(convId, snapshot);
  while (readingAnchors.size > MAX_READING_ANCHORS) {
    const oldest = readingAnchors.keys().next().value;
    if (oldest === undefined) break;
    readingAnchors.delete(oldest);
  }
}

type MessageGroup =
  { kind: "assistant"; keys: string[] } | { kind: "single"; key: string };

/** Every visible element is a measured row. Transient tail UI must be a real
 * row rather than a Footer: scrollToIndex("LAST") cannot account for Footer
 * height, which made conversation-open alignment fight the streaming
 * scroll-to-bottom observer while Thinking was visible. */
type MessageListItem = MessageGroup | { kind: "thinking" } | { kind: "error" };

/** Collapse consecutive assistant/tool messages (one agent loop) into a single
 *  group; user and custom messages stay standalone. */
function buildGroups(keys: string[], roles: string[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let run: string[] | null = null;
  const flush = () => {
    if (run) {
      groups.push({ kind: "assistant", keys: run });
      run = null;
    }
  };
  for (let i = 0; i < keys.length; i++) {
    const role = roles[i] ?? "assistant";
    if (role === "assistant" || role === "tool") {
      if (!run) run = [];
      run.push(keys[i]);
    } else {
      flush();
      groups.push({ kind: "single", key: keys[i] });
    }
  }
  flush();
  return groups;
}

/** Isolated so per-token store updates don't re-render the composer subtree.
 *  Each MessageBubble subscribes to its own slot, so a streaming text_delta
 *  repaints exactly one bubble. The list container only re-renders when
 *  messages are added or removed (message_start / user_sent). */
export function MessageList({
  convId,
  workspaceDir,
  isStreaming,
  onRetry,
  onForkMessage,
  retrying,
  onQuote,
  opticalCenter,
}: {
  convId: string | null;
  workspaceDir: string | null;
  isStreaming: boolean;
  onRetry?: () => void;
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  retrying?: boolean;
  onQuote: (text: string) => void;
  opticalCenter: boolean;
}) {
  const keys = useMessageKeys(convId);
  const roles = useMessageRoles(convId);
  // Merge consecutive assistant (+tool) messages into one group so the whole
  // agent loop reads as a single turn — one ASSISTANT header, one activity
  // timeline — instead of a header + tool cards per round.
  const groups = useMemo(() => buildGroups(keys, roles), [keys, roles]);
  const awaiting = useAwaitingAssistant(convId);
  const hasError = !!useChatError(convId);
  // Thinking and errors are measured rows so every bottom seek uses the same
  // edge as the streaming follow controller.
  const items = useMemo<MessageListItem[]>(() => {
    if (awaiting) return [...groups, { kind: "thinking" }];
    if (!isStreaming && hasError) return [...groups, { kind: "error" }];
    return groups;
  }, [groups, awaiting, isStreaming, hasError]);

  // Virtualization measures rows; the intent controller owns tail-following.
  const listRef = useRef<ChatListHandle>(null);
  // The real scroll DOM node the virtual list hands back — needed only by the quote
  // toolbar (selection root + scroll-to-dismiss). Held in state so its effects
  // re-run once the node exists.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Keep the ref callback stable. An inline callback gets a new identity on
  // every render, so React clears the old ref with `null` and attaches the new
  // one again. Calling setState from both ref calls can recurse until React
  // throws "Maximum update depth exceeded" while the virtual list is settling a large
  // conversation (especially in the faster production build).
  const setScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    setScroller((current) => (current === next ? current : next));
  }, []);
  // The reading position this open should land on, read ONCE per conversation
  // switch (the virtual list only honours it at mount). Undefined = land at the newest
  // turn, the default for a conversation last left at the bottom.
  const restoreRef = useRef<ChatListSnapshot | undefined>(
    convId ? readingAnchors.get(convId) : undefined,
  );
  const [atBottom, setAtBottom] = useState(!restoreRef.current);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const atBottomRef = useRef(!restoreRef.current);
  // User intent is separate from the list's at-bottom reporting so an
  // upward gesture can stop streaming follow immediately.
  const followTailRef = useRef(!restoreRef.current);
  const tailScrollRef = useRef<ReturnType<typeof bindChatTailScroll> | null>(
    null,
  );
  // Topmost visible group index (from the virtualizer's visible range) — drives the turn
  // navigator's active tick with no getBoundingClientRect scanning.
  const [topIndex, setTopIndex] = useState(0);
  const prevLastKeyRef = useRef<string | null>(null);
  const setAtBottomState = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  // ⌘F find state. `focusTick` doubles as the open signal's identity so a second
  // ⌘F re-selects the field instead of doing nothing.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [findFocusTick, setFindFocusTick] = useState(0);
  // Read by the streaming follow, which must not drag the reader off a match.
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;

  // Restore each conversation before mounting its virtual list.
  const [renderedConvId, setRenderedConvId] = useState(convId);
  if (renderedConvId !== convId) {
    setRenderedConvId(convId);
    const anchor = convId ? readingAnchors.get(convId) : undefined;
    restoreRef.current = anchor;
    // Seed the bottom state pessimistically for a restored open. The list will
    // publish the truth a frame later; until then the streaming follow (which
    // reads the ref, not the state) must not yank a restored position down.
    atBottomRef.current = !anchor;
    followTailRef.current = !anchor;
    setAtBottom(!anchor);
    // Forget the previous conversation's tail: switching into a chat that ends
    // on a user turn must not read as "the user just sent" and seek to LAST.
    prevLastKeyRef.current = null;
  }

  // User turns paired with their index in the group list, for the navigator's
  // scroll-to-turn (the virtual list scrollToIndex) and active-tick math.
  const userTurns = useMemo(() => {
    const out: { key: string; index: number }[] = [];
    groups.forEach((g, i) => {
      if (g.kind !== "single") return;
      if (roles[keys.indexOf(g.key)] === "user")
        out.push({ key: g.key, index: i });
    });
    return out;
  }, [groups, keys, roles]);

  // The prose behind each list row, for ⌘F. Read straight off the store rather
  // than through a hook: subscribing to message BODIES here would re-render the
  // whole list on every streamed token, which is exactly what this file's
  // per-bubble subscriptions exist to avoid. The trade-off is that a reply
  // streaming in while the bar is open only joins the match list once the turn
  // count changes — searching live output is not what ⌘F is for.
  const findRowTexts = useMemo(() => {
    if (!findOpen || !convId) return [];
    const byKey = useChatStore.getState().chats[convId]?.byKey;
    if (!byKey) return [];
    return items.map((item) => {
      if (item.kind === "assistant")
        return item.keys
          .map((k) => (byKey[k] ? messageFindText(byKey[k]) : ""))
          .join("\n");
      if (item.kind === "single")
        return byKey[item.key] ? messageFindText(byKey[item.key]) : "";
      return "";
    });
    // `keys` covers hydration filling in a conversation whose groups already exist.
  }, [findOpen, convId, items, keys]);

  const findMatches = useMemo(
    () => buildFindMatches(findRowTexts, findQuery),
    [findRowTexts, findQuery],
  );

  // A new query resumes from the reader's position rather than the first turn.
  // topIndex is read through a ref so this doesn't re-run (and re-jump) on every
  // scroll event while the bar sits open.
  const topIndexRef = useRef(0);
  topIndexRef.current = topIndex;
  useEffect(() => {
    setFindActive(firstMatchFrom(findMatches, topIndexRef.current));
    // findMatches is deliberately not a dependency: it also changes when a
    // message arrives, and re-homing the cursor then would move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery]);

  // Keep the cursor inside the (possibly shrunken) match list when the
  // conversation changes under it.
  useEffect(() => {
    setFindActive((prev) => preserveActive(findMatches.length, prev));
  }, [findMatches]);

  // Scroll the active occurrence into view, then paint. The row may not be
  // mounted in this frame — the virtual list needs a tick to realise a row that was far
  // off-screen — so wait for it rather than painting a miss.
  const current = findMatches[findActive] ?? null;
  useEffect(() => {
    if (!scroller || !findOpen) return;
    if (!current) {
      clearFindHighlights();
      return;
    }
    listRef.current?.scrollToIndex({
      index: current.itemIndex,
      align: "center",
    });
    let frames = 12;
    let frame = requestAnimationFrame(function step() {
      const range = paintFindHighlights(scroller, findQuery, current);
      if (range) {
        revealRange(scroller, range);
        // One more pass: revealing may have mounted rows that were off-screen.
        frame = requestAnimationFrame(() =>
          paintFindHighlights(scroller, findQuery, current),
        );
        return;
      }
      if (--frames > 0) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [scroller, findOpen, findQuery, current]);

  // Repaint when the virtual list mounts or retires rows under an unchanged active
  // match (ordinary scrolling while the bar is open).
  const repaintFind = useCallback(() => {
    if (!scroller || !findOpen || !current) return;
    paintFindHighlights(scroller, findQuery, current);
  }, [scroller, findOpen, findQuery, current]);

  // ⌘F arrives as an event from the app's global handler, which has already
  // cleared the modal and view guards. A repeat press re-focuses and selects
  // the field rather than toggling the bar shut — the browser convention.
  useEffect(() => {
    const onFind = () => {
      followTailRef.current = false;
      listRef.current?.cancelScroll();
      setFindOpen(true);
      setFindFocusTick((n) => n + 1);
    };
    window.addEventListener(FIND_IN_CHAT_EVENT, onFind);
    return () => window.removeEventListener(FIND_IN_CHAT_EVENT, onFind);
  }, []);

  // Esc closes the bar from anywhere in the chat, not just from inside the
  // field (the reader may have clicked back into the transcript).
  useEffect(() => {
    if (!findOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [findOpen]);

  // Leave no paint behind when the bar closes or the conversation switches.
  useEffect(() => {
    if (!findOpen) clearFindHighlights();
  }, [findOpen]);
  useEffect(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindActive(0);
    clearFindHighlights();
  }, [convId]);
  useEffect(() => clearFindHighlights, []);

  const closeFind = useCallback(() => setFindOpen(false), []);
  const stepFind = useCallback(
    (delta: number) =>
      setFindActive((prev) => stepMatch(findMatches.length, prev, delta)),
    [findMatches.length],
  );

  // Snap to the newest message when the user sends (even if scrolled up reading);
  // The tail controller then keeps the streaming reply pinned until the reader
  // scrolls away. Keyed on the last message key so it fires once per send, not per
  // token — and NOT on the first non-empty observation: when a restored
  // conversation happens to end on a user turn (agent never replied), hydration
  // must not count as "the user just sent" or the open position gets yanked.
  useEffect(() => {
    const lastKey = keys[keys.length - 1] ?? null;
    if (
      prevLastKeyRef.current !== null &&
      lastKey !== prevLastKeyRef.current &&
      roles[roles.length - 1] === "user"
    ) {
      followTailRef.current = true;
      listRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
    prevLastKeyRef.current = lastKey;
  }, [keys, roles]);

  // Remember the reading position while the reader is away from the bottom, so
  // switching conversations (or to another view) and back resumes mid-history
  // instead of jumping to the newest turn.
  //
  // Only ARMED scrolls count. The open sequence, the send/elevator seeks and the
  // streaming follow all move the scroller programmatically; if those captured,
  // a conversation opened mid-history would immediately overwrite (or, once
  // the list briefly reports at-bottom during the landing, erase) the very
  // anchor being restored. The arm is either a real pointer/keyboard scroll
  // gesture or simply "the open is long over".
  useEffect(() => {
    if (!scroller || !convId) return;

    let armed = false;
    let frame: number | null = null;
    const arm = () => {
      armed = true;
    };
    const settle = window.setTimeout(arm, OPEN_SETTLE_MS);

    const capture = () => {
      frame = null;
      // At the bottom there is nothing to resume — drop any stale anchor so the
      // next open follows new messages as usual.
      if (followTailRef.current && atBottomRef.current) {
        readingAnchors.delete(convId);
        return;
      }
      // getState reads the virtualizer's measured sizes and scroll offset: no DOM
      // measurement, so this stays off the forced-layout path.
      listRef.current?.getState((snapshot) => {
        // scrollTop === 0 is a valid reading position: after deliberately
        // scrolling a long conversation to its first turn, switching away and
        // back must resume there. Fresh/short conversations do not create a
        // false anchor because capture only runs after an actual scroll event.
        rememberReadingAnchor(convId, snapshot);
      });
    };
    const onScroll = () => {
      if (!armed || frame != null) return;
      frame = requestAnimationFrame(capture);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", arm, { passive: true });
    scroller.addEventListener("touchmove", arm, { passive: true });
    scroller.addEventListener("pointerdown", arm, { passive: true });
    scroller.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(settle);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", arm);
      scroller.removeEventListener("touchmove", arm);
      scroller.removeEventListener("pointerdown", arm);
      scroller.removeEventListener("keydown", arm);
      // Deliberately no final flush here: by the time this cleanup runs the
      // keyed virtual list has already remounted for the NEXT conversation, so
      // getState would file that list's position under this convId.
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [scroller, convId]);

  // One cancellable owner for row growth, appended rows, and viewport resizing.
  // Keep this active after streaming ends too (images and final markdown settle).
  useEffect(() => {
    if (!scroller) return;
    const binding = bindChatTailScroll(scroller, {
      isFollowing: () => followTailRef.current,
      setFollowing: (next) => {
        followTailRef.current = next;
      },
      isSearching: () => findOpenRef.current,
      onRelease: () => {
        listRef.current?.cancelScroll();
      },
    });
    tailScrollRef.current = binding;
    return () => {
      tailScrollRef.current = null;
      binding.dispose();
    };
  }, [scroller]);

  // Any scroll invalidates the hovered turn: content moved under a stationary
  // pointer, and no pointer event will fire to hand the toolbar off or hide
  // it. The next real pointer move re-claims (hover-owner.ts).
  useEffect(() => {
    if (!scroller) return;
    scroller.addEventListener("scroll", clearHoverOwner, { passive: true });
    return () => scroller.removeEventListener("scroll", clearHoverOwner);
  }, [scroller]);

  useEffect(() => {
    if (!scroller) return;

    let frame: number | null = null;
    const updateVisibility = () => {
      frame = null;
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const threshold = Math.max(
        SCROLL_TO_BOTTOM_BUTTON_MIN_PX,
        scroller.clientHeight * SCROLL_TO_BOTTOM_BUTTON_VIEWPORT_RATIO,
      );
      setShowScrollToBottom(distanceFromBottom > threshold);
    };
    const scheduleUpdate = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(updateVisibility);
    };

    updateVisibility();
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroller);
    const content = scroller.querySelector("[data-chat-list-content]");
    if (content) observer.observe(content);
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [scroller, items.length]);

  const quoteCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => quoteCleanupRef.current?.(), [convId]);
  const { t: quoteT } = useTranslation("chat");
  const jumpToQuote = useCallback(
    (messageKey: string, quote: string) => {
      if (!convId || !scroller) return;
      const byKey = useChatStore.getState().chats[convId]?.byKey;
      if (!byKey) return;
      const source = findQuoteSource(
        keys.map((key) => byKey[key]),
        keys.indexOf(messageKey),
        quote,
      );
      const sourceKey = keys[source];
      const rowIndex = groups.findIndex((group) =>
        group.kind === "assistant"
          ? group.keys.includes(sourceKey)
          : group.key === sourceKey,
      );
      if (source < 0 || rowIndex < 0) {
        toast(quoteT("quote.sourceNotFound"));
        return;
      }
      quoteCleanupRef.current?.();
      setFindOpen(false);
      followTailRef.current = false;
      listRef.current?.cancelScroll();
      listRef.current?.scrollToIndex({ index: rowIndex, align: "center" });
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let animation: Animation | undefined;
      const highlights = (
        globalThis.CSS as unknown as {
          highlights?: {
            set: (name: string, value: unknown) => void;
            delete: (name: string) => void;
          };
        }
      )?.highlights;
      const Highlight = (
        globalThis as unknown as {
          Highlight?: new (...ranges: Range[]) => unknown;
        }
      ).Highlight;
      let frame = requestAnimationFrame(function reveal() {
        const row = scroller.querySelector<HTMLElement>(
          `[data-find-row="${rowIndex}"]`,
        );
        // Allow virtual row measurements to settle before refining the position.
        if (++attempts < 3 || !row) {
          if (attempts < 60) frame = requestAnimationFrame(reveal);
          return;
        }
        listRef.current?.cancelScroll();
        const range = quoteRange(row, quote);
        if (range) {
          revealRange(scroller, range);
          if (highlights && Highlight)
            highlights.set("cetus-quote", new Highlight(range));
        }
        if (!range || !highlights || !Highlight) {
          animation = row.animate(
            [
              { backgroundColor: "transparent" },
              { backgroundColor: "rgba(160, 140, 255, 0.22)" },
              { backgroundColor: "transparent" },
            ],
            { duration: 1800 },
          );
        }
        timer = setTimeout(() => highlights?.delete("cetus-quote"), 2400);
      });
      quoteCleanupRef.current = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        animation?.cancel();
        highlights?.delete("cetus-quote");
      };
    },
    [convId, scroller, keys, groups, quoteT],
  );

  const itemContent = useCallback(
    (index: number, item: MessageListItem) => {
      if (item.kind === "thinking") {
        return (
          <div className={MESSAGE_ROW_GUTTER_CLASS}>
            <div
              className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
                opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
              }`}
            >
              <ThinkingPlaceholder />
            </div>
          </div>
        );
      }
      if (item.kind === "error") {
        return (
          <div className={MESSAGE_ROW_GUTTER_CLASS}>
            <div
              className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
                opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
              }`}
            >
              <MessageError
                convId={convId}
                onRetry={onRetry}
                retrying={retrying}
              />
            </div>
          </div>
        );
      }

      const g = item;
      const isLast = index === items.length - 1;
      const messageIndex =
        g.kind === "assistant"
          ? keys.indexOf(g.keys[g.keys.length - 1])
          : keys.indexOf(g.key);
      const forkMessageKey =
        g.kind === "assistant" ? g.keys[g.keys.length - 1] : g.key;
      const node =
        g.kind === "assistant" ? (
          <AssistantGroup
            convId={convId}
            workspaceDir={workspaceDir}
            keys={g.keys}
            active={isStreaming && isLast}
            onFork={
              onForkMessage && messageIndex >= 0
                ? () => onForkMessage(forkMessageKey, messageIndex)
                : undefined
            }
          />
        ) : (
          <MessageBubble
            convId={convId}
            messageKey={g.key}
            onQuoteClick={(quote) => jumpToQuote(g.key, quote)}
            onFork={
              onForkMessage && messageIndex >= 0
                ? () => onForkMessage(forkMessageKey, messageIndex)
                : undefined
            }
          />
        );
      // Center each turn on the reading column. The virtual list measures the outer
      // wrapper. Once the viewport can center max-w-3xl clear of the navigator,
      // this returns to the composer's px-4 geometry so both columns line up.
      return (
        // data-find-row is how the ⌘F painter locates a mounted row's text
        // nodes without knowing anything about the bubbles inside it.
        <div className={MESSAGE_ROW_GUTTER_CLASS} data-find-row={index}>
          <div
            className={`mx-auto max-w-3xl panel-motion transition-[translate] ${
              opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
            }`}
          >
            {node}
          </div>
        </div>
      );
    },
    [
      items.length,
      keys,
      convId,
      isStreaming,
      onForkMessage,
      awaiting,
      hasError,
      onRetry,
      retrying,
      opticalCenter,
      jumpToQuote,
    ],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <QuoteSelectionToolbar scroller={scroller} onQuote={onQuote} />
      <ChatVirtualList
        // Each conversation mounts with its own saved position or newest turn.
        key={convId ?? "new"}
        ref={listRef}
        scrollerRef={setScrollerRef}
        data={items}
        className="chat-message-scroll scrollbar-slim min-h-0 flex-1 bg-background"
        itemKey={(_i, item) => {
          if (item.kind === "assistant") return item.keys[0];
          if (item.kind === "single") return item.key;
          return `${convId ?? "new"}:tail:${item.kind}`;
        }}
        itemContent={itemContent}
        initialState={restoreRef.current}
        onHeightChange={() => tailScrollRef.current?.schedule()}
        onBottomChange={setAtBottomState}
        onRangeChange={(startIndex) => {
          setTopIndex(startIndex);
          repaintFind();
        }}
      />
      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          total={findMatches.length}
          active={findActive}
          onStep={stepFind}
          onClose={closeFind}
          opticalCenter={opticalCenter}
          focusTick={findFocusTick}
        />
      )}
      <TurnNavigator
        convId={convId}
        userTurns={userTurns}
        topIndex={topIndex}
        atBottom={atBottom}
        listRef={listRef}
        onNavigate={() => {
          followTailRef.current = false;
          listRef.current?.cancelScroll();
        }}
      />
      <ScrollToBottomButton
        show={showScrollToBottom}
        listRef={listRef}
        opticalCenter={opticalCenter}
        onFollowTail={() => {
          followTailRef.current = true;
        }}
      />
    </div>
  );
}

/** Codex-style turn navigator: a thin gutter of ticks down the left edge, one
 *  per user turn. Ticks are evenly spaced and clustered together, vertically
 *  centered in the viewport (not spread across the full scroll height). The
 *  active tick (turn nearest the top of the viewport) brightens as you
 *  scroll; hovering a tick reveals a preview popover; click scrolls that turn
 *  to the top. Lives in the otherwise-empty left margin (content is centered
 *  max-w-3xl), and is pointer-transparent except on the ticks themselves so
 *  it never fights text selection. */
function TurnNavigator({
  convId,
  userTurns,
  topIndex,
  atBottom,
  listRef,
  onNavigate,
}: {
  convId: string | null;
  /** User turns paired with their index in the virtualized group list. */
  userTurns: { key: string; index: number }[];
  /** Topmost visible group index, published by the virtualizer. */
  topIndex: number;
  /** Whether the message list is currently pinned to its bottom edge. */
  atBottom: boolean;
  listRef: RefObject<ChatListHandle | null>;
  onNavigate: () => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // At the bottom, the newest turn wins explicitly. During a conversation
  // switch the virtual list can briefly publish an intermediate range while its
  // initial end seek settles; using that range alone leaves a middle tick
  // highlighted even though the viewport has already landed at the bottom.
  // Away from the bottom, keep tracking the last user turn at or above the
  // top of the viewport.
  const active = useMemo(() => {
    if (atBottom) return Math.max(0, userTurns.length - 1);
    let next = 0;
    for (let i = 0; i < userTurns.length; i++) {
      if (userTurns[i].index <= topIndex) next = i;
      else break;
    }
    return next;
  }, [atBottom, userTurns, topIndex]);

  if (userTurns.length < 2) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-12 sm:flex sm:flex-col sm:items-start sm:justify-center">
      <div className="flex flex-col items-start gap-0">
        {userTurns.map((turn, i) => {
          const isActive = i === active;
          return (
            <div
              key={turn.key}
              className="pointer-events-auto relative flex items-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            >
              <button
                type="button"
                aria-label={`Jump to message ${i + 1}`}
                onClick={() => {
                  onNavigate();
                  listRef.current?.scrollToIndex({
                    index: turn.index,
                    align: "start",
                  });
                }}
                className="group flex h-1.5 items-center pl-3 pr-2"
              >
                <span
                  className={`block h-0.5 w-2.5 origin-left rounded-full transition-[background-color,transform] duration-100 group-hover:scale-x-[2] ${
                    isActive
                      ? "bg-foreground/60 group-hover:bg-foreground"
                      : "bg-muted-foreground/40 group-hover:bg-foreground"
                  }`}
                />
              </button>
              {hover === i && (
                <TurnPreview convId={convId} turnKey={turn.key} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TurnPreview({
  convId,
  turnKey,
}: {
  convId: string | null;
  turnKey: string;
}) {
  const { prompt, reply } = useMemo(
    () => getTurnPreview(convId, turnKey),
    [convId, turnKey],
  );
  if (!prompt && !reply) return null;
  return (
    <div className="pointer-events-none absolute left-9 top-1/2 w-72 -translate-y-1/2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-[0_6px_18px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]">
      {prompt && (
        <p className="line-clamp-2 text-xs font-medium text-foreground">
          {prompt}
        </p>
      )}
      {reply && (
        <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">
          {reply}
        </p>
      )}
    </div>
  );
}

/** "Message elevator": a floating button that appears when the reader has
 *  scrolled up away from the bottom of the conversation, and jumps them back
 *  down in one click. Lives outside the scroll container (as a sibling overlay)
 *  so it stays pinned to the viewport instead of scrolling with the messages.
 *  Visibility is deliberately stricter than the list's atBottom state so short
 *  reading nudges do not summon a floating control. */
function ScrollToBottomButton({
  show,
  listRef,
  opticalCenter,
  onFollowTail,
}: {
  show: boolean;
  listRef: RefObject<ChatListHandle | null>;
  opticalCenter: boolean;
  onFollowTail: () => void;
}) {
  const { t } = useTranslation("chat");

  const scrollToBottom = useCallback(() => {
    onFollowTail();
    listRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
    });
  }, [onFollowTail, listRef]);

  return (
    <button
      type="button"
      aria-label={t("pane.scrollToBottom")}
      title={t("pane.scrollToBottom")}
      onClick={scrollToBottom}
      className={`fade-layer absolute bottom-4 right-[max(1rem,calc((100%-48rem)/2))] z-30 flex size-9 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] transition-all panel-motion hover:bg-muted ${
        opticalCenter ? "xl:-translate-x-10 2xl:-translate-x-12" : ""
      } ${
        show
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <ArrowDown className="size-4" />
    </button>
  );
}
