"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { MessageBubble } from "@/components/chat/message-bubble";
import { AssistantGroup } from "@/components/chat/assistant-turn";
import { AgentControlCard } from "@/components/chat/agent-control-card";
import { CliControlCard } from "@/components/chat/cli-control-card";
import { GlyphBackdrop } from "@/components/chat/glyph-backdrop";
import { AlertTriangle, ArrowDown, ArrowUp, Bot, GitBranch, Loader2, MessageCircle, RotateCw, X } from "lucide-react";
import {
  Composer,
  type ComposerAttachment,
  type QuoteRequest,
  type QueuedMessage,
} from "@/components/chat/composer";
import {
  getTurnPreview,
  useAwaitingAssistant,
  useChatError,
  useHasMessages,
  useIsStreaming,
  useMessageKeys,
  useMessageRoles,
  useRunningSubagents,
  useUserTurnKeys,
} from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import { flavorHeadline } from "@/lib/chat-flavor";
import type { BackendId, ModelChoice, WorktreeInfo } from "@/lib/types";
import { api } from "@/lib/tauri";

interface Props {
  /** Conversation id to subscribe to. Null means "new chat" — shows hero. */
  convId: string | null;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  /** Route a leading-`!` command from the Composer to the Terminal surface. */
  onBash?: (command: string) => void;
  onAbort: () => void;
  /** Roll back + rerun the last turn. Wired only on the last assistant message.
   *  Omitted (e.g. detail dialog) → no Regenerate button. */
  onRegenerate?: () => void;
  /** Roll back + rerun the last (failed) turn — drives the inline error row's
   *  Retry button. Same handler as onRegenerate but shown on send failure. */
  onRetry?: () => void;
  /** Copy the current conversation through a specific message into a new chat. */
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  /** Whether a retry is currently in flight (disables/animates the button). */
  retrying?: boolean;
  /** Follow-up queue (messages typed while the agent is mid-run). When omitted,
   *  the composer falls back to immediate steer while streaming. */
  queued?: QueuedMessage[];
  onQueue?: (text: string, attachments: ComposerAttachment[]) => void;
  onSteerQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Ultra Code state + toggle, forwarded to the composer. */
  ultra?: boolean;
  onUltraToggle?: () => void;
  focusToken: number;
  /** Persist the composer's unsent draft under this key (forwarded to Composer).
   *  Omit to keep the draft ephemeral (e.g. the detail dialog). */
  draftKey?: string;
  /** Headline shown above the composer when no messages exist yet. */
  emptyHeadline?: string;
  /** Visually pause the composer (e.g. detail dialog before history loads). */
  disabled?: boolean;
  /** Backend choice for the not-yet-created conversation (hero composer);
   *  forwarded to the Composer. See Composer's prop docs. */
  pendingBackend?: BackendId;
  onPendingBackendChange?: (backend: BackendId) => void;
  pendingCliModel?: string;
  pendingCliEffort?: string;
  onPendingTuningChange?: (model: string, effort: string) => void;
  /** Keyboard runtime-switch request (token-keyed), forwarded to the Composer. */
  backendSwitch?: { token: number; backend: BackendId } | null;
  /** Tab-to-cycle-runtime request, forwarded to the Composer. */
  onRequestBackendSwitch?: (backend: BackendId) => void;
}

/** The shared "chat experience" body — messages list + composer with
 *  workspace/model pickers. Used by the main chat view, the new-task dialog,
 *  and the session detail dialog so each one feels identical to compose in.
 *  Sticks to the bottom while streaming, releases stick when the user scrolls
 *  up (so reading older context doesn't fight live updates). */
export function ChatPane({
  convId,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  onSend,
  onBash,
  onAbort,
  onRegenerate,
  onRetry,
  onForkMessage,
  retrying,
  queued,
  onQueue,
  onSteerQueued,
  onRemoveQueued,
  ultra,
  onUltraToggle,
  focusToken,
  draftKey,
  emptyHeadline,
  disabled,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  backendSwitch,
  onRequestBackendSwitch,
}: Props) {
  const { locale } = useTranslation("chat");
  const hasMessages = useHasMessages(convId);
  const isStreaming = useIsStreaming(convId);
  const [quoteRequest, setQuoteRequest] = useState<QuoteRequest | null>(null);
  const quoteIdRef = useRef(0);
  // A fresh greeting per new chat. Keyed on focusToken (bumped when "New chat"
  // is clicked) + convId + locale so it re-rolls on a new chat but stays put
  // across keystrokes/re-renders. An explicit emptyHeadline prop still wins.
  const randomHeadline = useMemo(
    () => flavorHeadline(locale),
    [locale, convId, focusToken],
  );
  const headline = emptyHeadline ?? randomHeadline;
  const addQuote = useCallback((text: string) => {
    quoteIdRef.current += 1;
    setQuoteRequest({ id: quoteIdRef.current, text });
  }, []);
  // Lifted out of MessageList so the turn navigator (sibling overlay) can drive
  // the same scroll container — scroll-to-turn and active-turn tracking.
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!hasMessages) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6">
        <GlyphBackdrop />
        <div className="relative z-10 w-full max-w-2xl space-y-5">
          <h2 className="text-center font-serif text-3xl italic tracking-tight text-foreground">
            {headline}
          </h2>
          <Composer
            variant="hero"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            conversationId={convId}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={onSend}
            onBash={onBash}
            onAbort={onAbort}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            quoteRequest={quoteRequest}
            pendingBackend={pendingBackend}
            onPendingBackendChange={onPendingBackendChange}
            pendingCliModel={pendingCliModel}
            pendingCliEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList
          convId={convId}
          isStreaming={isStreaming}
          onRegenerate={onRegenerate}
          onRetry={onRetry}
          onForkMessage={onForkMessage}
          retrying={retrying}
          onQuote={addQuote}
          scrollRef={scrollRef}
        />
        <TurnNavigator convId={convId} scrollRef={scrollRef} />
        <ScrollToBottomButton scrollRef={scrollRef} />
      </div>
      <div className="relative z-10 bg-background px-4 pb-3 pt-2">
        <div className="mx-auto max-w-3xl space-y-2">
          {convId ? <BackgroundAgentsBar convId={convId} /> : null}
          {convId ? <WorktreeChip convId={convId} isStreaming={isStreaming} /> : null}
          {convId ? <CliControlCard convId={convId} /> : null}
          {convId ? <AgentControlCard conversationId={convId} /> : null}
          <QueuedMessages
            items={queued ?? []}
            onSteer={onSteerQueued}
            onRemove={onRemoveQueued}
          />
          <Composer
            variant="docked"
            focusToken={focusToken}
            draftKey={draftKey}
            disabled={disabled}
            streaming={isStreaming}
            modelChoice={modelChoice}
            conversationId={convId}
            onModelChange={onModelChange}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            onSend={onSend}
            onQueue={onQueue}
            onBash={onBash}
            onAbort={onAbort}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            quoteRequest={quoteRequest}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={onRequestBackendSwitch}
          />
        </div>
      </div>
    </div>
  );
}

/** Awareness strip for background subagents (claude-code run_in_background
 *  Agent/Task, e.g. an UltraCode workflow) still running after the main reply
 *  landed. Without it the composer just says "Agent is running…" with no hint of
 *  *what* — the run is held open waiting on these to report back. Renders
 *  nothing when none are active. */
function BackgroundAgentsBar({ convId }: { convId: string }) {
  const { t } = useTranslation("chat");
  const agents = useRunningSubagents(convId);
  if (agents.length === 0) return null;
  // Prefer the human task description; fall back to the agent type.
  const labels = agents.map((a) => a.description || a.type).filter(Boolean);
  const shown = labels.slice(0, 3).join(", ");
  const extra = labels.length - Math.min(labels.length, 3);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#d97757]/30 bg-[#d97757]/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <Bot className="size-3.5 shrink-0 text-[#d97757]" />
      <Loader2 className="size-3 shrink-0 animate-spin text-[#d97757]" />
      <span className="shrink-0 font-medium text-foreground">
        {t("pane.backgroundAgents.title", { count: agents.length })}
      </span>
      {shown ? (
        <span className="truncate">
          {shown}
          {extra > 0 ? t("pane.backgroundAgents.more", { count: extra }) : ""}
        </span>
      ) : null}
    </div>
  );
}

/** Small affordance for CLI-backend conversations running in an isolated git
 *  worktree: shows the branch the agent's changes land on, click to open the
 *  worktree folder. Renders nothing for pi conversations / non-git workspaces /
 *  before the first turn created the worktree. Re-checks when a turn ends so it
 *  appears right after the first CLI run. */
function WorktreeChip({
  convId,
  isStreaming,
}: {
  convId: string;
  isStreaming: boolean;
}) {
  const { t } = useTranslation("chat");
  const [info, setInfo] = useState<WorktreeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fetch on conversation switch and again when a run finishes (the first
    // turn is what creates the worktree).
    if (isStreaming) return;
    api
      .conversationWorktree(convId)
      .then((w) => {
        if (!cancelled) setInfo(w);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [convId, isStreaming]);

  if (!info?.exists) return null;
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => api.openPath(info.path).catch(() => {})}
        title={t("pane.worktree.tooltip", { path: info.path })}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate">{info.branch}</span>
      </button>
    </div>
  );
}

// Turns mounted on first open of a conversation. Anything older is deferred
// behind a "Load earlier" button so a long history doesn't parse + lay out in
// one shot. A turn = one user message or one merged assistant loop.
const INITIAL_WINDOW = 40;
// Additional turns revealed per "Load earlier" click.
const LOAD_STEP = 40;

type MessageGroup =
  | { kind: "assistant"; keys: string[] }
  | { kind: "single"; key: string };

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
function MessageList({
  convId,
  isStreaming,
  onRegenerate,
  onRetry,
  onForkMessage,
  retrying,
  onQuote,
  scrollRef,
}: {
  convId: string | null;
  isStreaming: boolean;
  onRegenerate?: () => void;
  onRetry?: () => void;
  onForkMessage?: (messageKey: string, messageIndex: number) => void;
  retrying?: boolean;
  onQuote: (text: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("chat");
  const keys = useMessageKeys(convId);
  const roles = useMessageRoles(convId);
  // Merge consecutive assistant (+tool) messages into one group so the whole
  // agent loop reads as a single turn — one ASSISTANT header, one activity
  // timeline — instead of a header + tool cards per round.
  const groups = useMemo(() => buildGroups(keys, roles), [keys, roles]);

  // Windowing: a very long conversation otherwise mounts every turn at once —
  // each AssistantGroup runs a full markdown/KaTeX parse on mount and builds a
  // huge DOM, so opening a long chat hitches. We mount only the turns from
  // `firstShown` onward and reveal older ones on demand. Unlike a virtualizer
  // this never unmounts what's already shown (preserving per-message
  // subscriptions + activity-group expand state, same as the content-visibility
  // approach below) — it only defers turns that were never on screen.
  //
  // `firstShown` is an ABSOLUTE index, not a count-from-end, so appending a new
  // turn (user send / new agent reply) never slides the window and never
  // unmounts a turn you're scrolled up reading — it only grows the tail.
  const [firstShown, setFirstShown] = useState(0);
  // Re-anchor to the tail on conversation switch and on the first load of a
  // conversation's messages (groups 0 → N). Adjusting state during render
  // (guarded by a ref) is React's sanctioned pattern here: it restarts the
  // render with the corrected value before committing, so a long history never
  // momentarily mounts in full. After load, appends leave `firstShown` put.
  const windowInitRef = useRef<{ conv: string | null; loaded: boolean }>({
    conv: null,
    loaded: false,
  });
  if (
    windowInitRef.current.conv !== convId ||
    (!windowInitRef.current.loaded && groups.length > 0)
  ) {
    windowInitRef.current = { conv: convId, loaded: groups.length > 0 };
    setFirstShown(Math.max(0, groups.length - INITIAL_WINDOW));
  }
  // Clamp in case a rollback (regenerate) shrank the list past the window.
  const safeFirstShown = Math.min(firstShown, Math.max(0, groups.length - 1));
  const hiddenCount = safeFirstShown;
  const visibleGroups = useMemo(
    () => (hiddenCount > 0 ? groups.slice(hiddenCount) : groups),
    [groups, hiddenCount],
  );

  const awaiting = useAwaitingAssistant(convId);
  // When the turn errored, the inline MessageError row owns the Retry action —
  // don't also put a Regenerate on the trailing user bubble (avoid two buttons).
  const hasError = !!useChatError(convId);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Every scrollTop we write ourselves (pin-to-bottom, height-correction
  // compensation, load-earlier anchor restore) fires a `scroll` event a frame
  // later — by which time content-visibility turns may have grown past the 200px
  // estimate, so `onScroll` would read distance-from-bottom > 32 and wrongly flip
  // follow OFF, stranding a freshly-opened chat in the middle. Record the exact
  // scrollTop we set so `onScroll` can tell our own writes from a real user
  // scroll and only the latter changes the follow state.
  const programmaticTopRef = useRef<number | null>(null);
  const markProgrammaticScroll = useCallback((el: HTMLDivElement) => {
    programmaticTopRef.current = el.scrollTop;
  }, []);
  // Set just before a "Load earlier" reveal so we can restore the reading
  // position after the prepended turns grow the scroll height (otherwise the
  // viewport jumps as content is added above).
  const anchorRef = useRef<{ height: number; top: number } | null>(null);

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setFirstShown((f) => Math.max(0, f - LOAD_STEP));
  }, []);

  // Keep the previously-top turn pinned in place after a reveal. Runs before
  // paint so there's no visible jump. Only fires when an anchor was armed by
  // loadEarlier — the conversation-switch reset leaves it null.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    markProgrammaticScroll(el);
  }, [safeFirstShown, markProgrammaticScroll]);

  // Opening a conversation should land at the newest message. The component is
  // never remounted on switch, so re-arm auto-follow and snap to the bottom
  // whenever convId changes — otherwise a scrolled-up position carried over from
  // the previous conversation leaves stickToBottomRef false and the new one
  // renders pinned to the top.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      markProgrammaticScroll(el);
    }
  }, [convId, markProgrammaticScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore the scroll events our own scrollTop writes emit (they land a frame
      // late, after content-visibility turns have grown, so their distance read
      // is stale and would falsely drop follow). Keep ignoring while the position
      // still matches what we pinned — a real user scroll moves it elsewhere.
      if (
        programmaticTopRef.current !== null &&
        Math.abs(el.scrollTop - programmaticTopRef.current) < 1
      ) {
        return;
      }
      programmaticTopRef.current = null;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 32;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll on add/remove (keys array reference changes).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A fresh user turn means the user just sent — snap to the bottom and
    // re-arm auto-follow even if they'd scrolled up reading older context, so
    // their new message (and the reply that follows) is always in view.
    if (roles[roles.length - 1] === "user") stickToBottomRef.current = true;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    markProgrammaticScroll(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  // Stick to bottom whenever the content actually grows — token deltas mutate
  // the tail bubble's height without changing `keys`. A ResizeObserver fires
  // only on real layout changes, so we no longer reflow every animation frame
  // for the whole stream (the old rAF loop was a continuous jank source).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        markProgrammaticScroll(el);
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Remember each turn's real laid-out height and feed it back as its own
  // content-visibility placeholder size. Without this every off-screen turn
  // collapses to the fixed 200px estimate below — so scrolling past a tall turn
  // constantly changes scrollHeight, jerking the scrollbar and fighting the
  // browser's scroll anchoring (the "jumping" while reading a long chat). The
  // `containIntrinsicSize: auto` keyword is meant to remember this automatically,
  // but WKWebView (the macOS webview) doesn't honor it, so we lock the measured
  // height in ourselves. Kept OFF React's `style` prop on purpose: the list
  // re-renders on every new turn / stream tick and would otherwise clobber the
  // measured value back to 200px each time.
  const [turnSizer] = useState(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const scroller = scrollRef.current;
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const h = Math.round(
              entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight,
            );
            if (h <= 0) continue;
            const next = String(h);
            // Guard against re-setting the same value (locking the size of a
            // skipped turn changes its box, which re-fires the observer).
            if (el.dataset.cis === next) continue;
            const prev = el.dataset.cis ? Number(el.dataset.cis) : 0;
            el.dataset.cis = next;
            el.style.containIntrinsicSize = `auto ${h}px`;
            // Scroll-position compensation. A turn that starts off-screen holds
            // the 200px estimate below until it scrolls into view, then jumps to
            // its (usually much taller) real height. When that turn is above the
            // reading position, its growth shoves everything below it down —
            // and WKWebView has no scroll anchoring to absorb it, so the fixed
            // scrollTop then shows earlier content: scrolling up a little snaps
            // the whole list toward the top. Counter it by shifting scrollTop by
            // the same delta so the visible content stays pinned. (prev === 0 is
            // the initial seed pass — nothing to correct yet.)
            //
            // Only compensate turns that sit ENTIRELY above the fold. A turn
            // straddling the top edge — the one you're scrolling *into* — is
            // being read; correcting its growth would push it back down as fast
            // as you scroll up, so a reflowing turn (KaTeX finishing its layout
            // across several resize passes) would fight every upward scroll and
            // feel like it can't scroll past. content-visibility renders a turn
            // within a margin before it's visible, so the fully-above ones still
            // get corrected here in time to prevent the jump.
            if (scroller && prev > 0) {
              if (stickToBottomRef.current) {
                // Following the tail: a turn jumping from the 200px estimate to
                // its real height (usually taller) grows the list; snap straight
                // to the true bottom so the newest message stays in view. Doing
                // the per-turn delta shift below instead would leave us pinned to
                // the *estimated* bottom — short of the real one — which is the
                // "opens a chat scrolled to the middle" bug.
                scroller.scrollTop = scroller.scrollHeight;
                programmaticTopRef.current = scroller.scrollTop;
              } else {
                const scrollerTop = scroller.getBoundingClientRect().top;
                if (el.getBoundingClientRect().bottom <= scrollerTop) {
                  scroller.scrollTop += h - prev;
                  programmaticTopRef.current = scroller.scrollTop;
                }
              }
            }
          }
        }),
  );
  useEffect(() => () => turnSizer?.disconnect(), [turnSizer]);
  const measureTurn = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !turnSizer) return;
      // Seed an estimate before the observer's first callback so a turn that
      // starts off-screen never momentarily collapses to zero height. Record it
      // as the known height too, so the observer treats the eventual 200px→real
      // correction as a delta to compensate for (rather than a first-seen size).
      if (!el.style.containIntrinsicSize) {
        el.style.containIntrinsicSize = "auto 200px";
        el.dataset.cis = "200";
      }
      turnSizer.observe(el);
      // React 19 cleanup ref: unobserve when this specific turn unmounts
      // (conversation switch / rollback) so the observer never retains it.
      return () => turnSizer.unobserve(el);
    },
    [turnSizer],
  );

  return (
    <div
      ref={scrollRef}
      className="scrollbar-slim relative min-h-0 flex-1 overscroll-contain overflow-y-auto bg-background"
      data-testid="message-list"
    >
      <QuoteSelectionToolbar containerRef={contentRef} scrollRef={scrollRef} onQuote={onQuote} />
      <div ref={contentRef} data-message-content className="mx-auto max-w-3xl px-6 py-4">
        {hiddenCount > 0 && (
          <div className="flex justify-center pb-3">
            <button
              type="button"
              onClick={loadEarlier}
              className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t("pane.loadEarlier")}
            </button>
          </div>
        )}
        {visibleGroups.map((g, gi) => {
          const isLast = gi === visibleGroups.length - 1;
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
                keys={g.keys}
                onRegenerate={onRegenerate && !isStreaming && isLast ? onRegenerate : undefined}
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
                // A trailing user bubble means the agent was interrupted before
                // it replied (no assistant group followed). Offer Regenerate
                // there too — retryLastTurn already handles a user-only tail.
                onRegenerate={
                  onRegenerate && isLast && !isStreaming && !awaiting && !hasError
                    ? onRegenerate
                    : undefined
                }
                onFork={
                  onForkMessage && messageIndex >= 0
                    ? () => onForkMessage(forkMessageKey, messageIndex)
                    : undefined
                }
              />
            );
          // content-visibility lets the browser skip layout + paint for turns
          // scrolled out of view WITHOUT unmounting them — so per-message store
          // subscriptions and activity-group expand state survive (a windowing
          // virtualizer would lose both). The streaming tail (last group) is left
          // always-painted so live token growth + stick-to-bottom stay exact.
          // `containIntrinsicSize` is owned imperatively by measureTurn (above),
          // not set here, so the real measured height survives re-renders.
          return (
            <div
              key={g.kind === "assistant" ? g.keys[0] : g.key}
              ref={measureTurn}
              // Tag user turns so the turn navigator can scroll to / track them.
              data-turn-key={g.kind === "single" ? g.key : undefined}
              style={isLast ? undefined : { contentVisibility: "auto" }}
            >
              {node}
            </div>
          );
        })}
        {awaiting && <ThinkingPlaceholder />}
        {!isStreaming && !awaiting && (
          <MessageError convId={convId} onRetry={onRetry} retrying={retrying} />
        )}
      </div>
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
  scrollRef,
}: {
  convId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const turnKeys = useUserTurnKeys(convId);
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const findNode = useCallback(
    (key: string) =>
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-turn-key="${CSS.escape(key)}"]`,
      ) ?? null,
    [scrollRef],
  );

  // Track which turn sits at the top of the viewport so the matching tick
  // brightens. rAF-throttled to stay off the scroll hot path.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || turnKeys.length === 0) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      let next = 0;
      for (let i = 0; i < turnKeys.length; i++) {
        const node = findNode(turnKeys[i]);
        if (!node) continue;
        // The last turn whose top has scrolled above the fold is active.
        if (node.getBoundingClientRect().top - top <= 8) next = i;
        else break;
      }
      setActive(next);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, turnKeys, findNode]);

  const scrollToTurn = useCallback(
    (key: string) => {
      const el = scrollRef.current;
      const node = findNode(key);
      if (!el || !node) return;
      const delta =
        node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTo({ top: el.scrollTop + delta - 12, behavior: "smooth" });
    },
    [scrollRef, findNode],
  );

  if (turnKeys.length < 2) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-12 sm:flex sm:flex-col sm:items-start sm:justify-center">
      <div className="flex flex-col items-start gap-0">
        {turnKeys.map((key, i) => {
          const isActive = i === active;
          return (
            <div
              key={key}
              className="pointer-events-auto relative flex items-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            >
              <button
                type="button"
                aria-label={`Jump to message ${i + 1}`}
                onClick={() => scrollToTurn(key)}
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
              {hover === i && <TurnPreview convId={convId} turnKey={key} />}
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
        <p className="line-clamp-2 text-xs font-medium text-foreground">{prompt}</p>
      )}
      {reply && (
        <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{reply}</p>
      )}
    </div>
  );
}

/** "Message elevator": a floating button that appears when the reader has
 *  scrolled up away from the bottom of the conversation, and jumps them back
 *  down in one click. Lives outside the scroll container (as a sibling overlay)
 *  so it stays pinned to the viewport instead of scrolling with the messages.
 *  Tracks distance-from-bottom on scroll and whenever the content grows (a
 *  streaming reply lengthening the list), matching the message list's own
 *  32px stick-to-bottom deadzone. */
function ScrollToBottomButton({
  scrollRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("chat");
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Show the moment you're off the bottom — hidden only inside the same
      // 32px deadzone the list uses to re-stick, so it doesn't flicker while
      // streaming re-pins the tail.
      setShow(distance > 32);
    };
    el.addEventListener("scroll", update, { passive: true });
    // Content growth (streaming tokens, new turns) changes distance-from-bottom
    // without a scroll event — observe the messages wrapper so the button shows
    // up when the tail grows below the fold.
    const content = el.querySelector<HTMLElement>("[data-message-content]");
    const ro = content ? new ResizeObserver(update) : null;
    if (content && ro) ro.observe(content);
    update();
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [scrollRef]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  return (
    <button
      type="button"
      aria-label={t("pane.scrollToBottom")}
      title={t("pane.scrollToBottom")}
      onClick={scrollToBottom}
      className={`absolute bottom-4 left-1/2 z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] transition-all duration-150 hover:bg-muted ${
        show
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <ArrowDown className="size-4" />
    </button>
  );
}

function QuoteSelectionToolbar({
  containerRef,
  scrollRef,
  onQuote,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onQuote: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [selection, setSelection] = useState<{
    range: Range;
    left: number;
    top: number;
  } | null>(null);

  const clearSelection = useCallback(() => {
    const root = containerRef.current;
    const sel = window.getSelection();
    if (root && sel && selectionBelongsToRoot(root, sel)) {
      sel.removeAllRanges();
    }
    setSelection(null);
  }, [containerRef]);

  const readSelection = useCallback(() => {
    const root = containerRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (!node || !root.contains(node)) {
      setSelection(null);
      return;
    }

    const text = sel.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }

    const rect = selectionAnchorRect(range);
    if (rect.width === 0 && rect.height === 0) {
      setSelection(null);
      return;
    }

    setSelection({
      range: range.cloneRange(),
      left: Math.round(rect.left + rect.width / 2),
      top: Math.round(Math.max(8, rect.top - 8)),
    });
  }, [containerRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-quote-selection-toolbar]")) return;

      const root = containerRef.current;
      const sel = window.getSelection();
      if (!root || !sel || !selectionBelongsToRoot(root, sel)) return;

      sel.removeAllRanges();
      setSelection(null);
    };
    const onPointerUp = () => window.setTimeout(readSelection, 0);
    const onKeyUp = () => readSelection();
    const onSelectionChange = () => readSelection();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    const onScroll = () => clearSelection();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    scrollRef.current?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      scrollRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [clearSelection, containerRef, readSelection, scrollRef]);

  if (!selection) return null;

  // Portal to <body>: the chat pane lives inside SidebarInset, which has a
  // `backdrop-filter` — that establishes a containing block for fixed-position
  // descendants, so a `position: fixed` toolbar rendered inline would resolve
  // its viewport coordinates against the SidebarInset box (offset by the
  // sidebar width) and drift sideways. Rendering into <body> escapes that
  // containing block so `fixed` is viewport-relative again.
  return createPortal(
    <div
      data-quote-selection-toolbar
      className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-full border border-border bg-popover px-1 py-0.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ left: selection.left, top: selection.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(serializeSelection(selection.range));
          window.getSelection()?.removeAllRanges();
          setSelection(null);
        }}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
      >
        <MessageCircle className="size-3.5" />
        {t("quote.addToChat")}
      </button>
    </div>,
    document.body,
  );
}

function selectionBelongsToRoot(root: HTMLElement, sel: Selection): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (node && root.contains(node)) return true;
  }
  return false;
}

// Turn a live selection Range into plain text suitable for a `>` blockquote.
//
// `Selection.toString()` is unusable on rendered markdown that contains KaTeX:
// each math atom is its own inline-block span, so the serializer emits a newline
// after every character (turning `$0**$` into `0\n*\n*`), and the hidden MathML
// mirror gets duplicated alongside the visible render. Instead we clone the
// selected DOM, swap every `.katex` node back to its LaTeX source (pulled from
// the MathML `annotation`), then read `innerText` — which collapses the render
// noise while still honoring real block boundaries (paragraphs, list items).
function serializeSelection(range: Range): string {
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());

  container.querySelectorAll(".katex").forEach((el) => {
    const tex = el
      .querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent?.trim();
    const display = !!el.closest(".katex-display");
    const replacement = tex
      ? `${display ? "$$" : "$"}${tex}${display ? "$$" : "$"}`
      : (el.textContent ?? "");
    el.replaceWith(document.createTextNode(replacement));
  });

  // `innerText` needs layout, so the node must be attached and rendered. Keep it
  // offscreen and preserve line breaks, then remove it synchronously.
  container.style.cssText =
    "position:fixed;left:-99999px;top:0;white-space:pre-wrap;";
  document.body.appendChild(container);
  const text = container.innerText;
  container.remove();
  return text.trim();
}

function selectionAnchorRect(range: Range): DOMRect {
  const rects = selectionTextRects(range);
  if (rects.length === 0) return range.getBoundingClientRect();

  // Anchor to the FIRST (top) line of the selection only, so the toolbar sits
  // centered directly above where the selection begins. Using the full
  // bounding box would center over the widest line, drifting the button off
  // the visible top edge on multi-line selections.
  const top = Math.min(...rects.map((rect) => rect.top));
  const firstLine = rects.filter((rect) => rect.top <= top + 2);
  const left = Math.min(...firstLine.map((rect) => rect.left));
  const right = Math.max(...firstLine.map((rect) => rect.right));
  const bottom = Math.max(...firstLine.map((rect) => rect.bottom));

  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function selectionTextRects(range: Range): DOMRect[] {
  const common = range.commonAncestorContainer;
  const rects: DOMRect[] = [];

  const pushTextNodeRects = (node: Text) => {
    if (!node.data || !range.intersectsNode(node)) return;
    const textRange = document.createRange();
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (start >= end) return;

    textRange.setStart(node, start);
    textRange.setEnd(node, end);
    rects.push(
      ...Array.from(textRange.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    );
    textRange.detach();
  };

  if (common.nodeType === Node.TEXT_NODE) {
    pushTextNodeRects(common as Text);
    return rects;
  }

  const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) pushTextNodeRects(walker.currentNode as Text);
  return rects;
}

/** Inline failure row pinned to the end of the message list: surfaces a send /
 *  run error right under the last message (rather than in the far-off header)
 *  and offers a Retry that rolls back + reruns the last turn. Self-guards on the
 *  conversation-level error, so it renders nothing on a healthy chat. */
function MessageError({
  convId,
  onRetry,
  retrying,
}: {
  convId: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation("chat");
  const error = useChatError(convId);
  if (!error) return null;
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="break-words">{error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex w-fit items-center gap-1 rounded-md border border-destructive/30 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              <RotateCw className={`size-3 ${retrying ? "animate-spin" : ""}`} />
              {retrying ? t("pane.retrying") : t("pane.retry")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The follow-up queue rendered just above the composer: messages the user
 *  typed while the agent was mid-run. Each waits for the run to end (then it's
 *  delivered as a new turn), or the user can "Steer now" to inject it into the
 *  current run immediately. */
function QueuedMessages({
  items,
  onSteer,
  onRemove,
}: {
  items: QueuedMessage[];
  onSteer?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((m) => {
        const label =
          m.text.trim() ||
          (m.attachments.length
            ? t("pane.attachmentCount", { count: m.attachments.length })
            : t("pane.emptyMessage"));
        return (
          <div
            key={m.id}
            className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs"
          >
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("pane.queued")}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/80">{label}</span>
            {onSteer && (
              <button
                type="button"
                onClick={() => onSteer(m.id)}
                title={t("pane.steerTooltip")}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <ArrowUp className="size-3" />
                {t("pane.steerNow")}
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove?.(m.id)}
              aria-label={t("pane.removeFromQueue")}
              className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Shown between the user's send and the first message_start event so the
 *  conversation doesn't feel like it's hanging. For CLI backends
 *  (claude-code / codex) this covers the whole process boot — message_start is
 *  deferred until real content streams — so it reads like the native desktop
 *  apps: a shimmering status word plus an elapsed-seconds counter once the
 *  wait is long enough to notice. */
function ThinkingPlaceholder() {
  const { t } = useTranslation("chat");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] flex-col gap-2 items-start">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pane.assistant")}
        </div>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="animate-shimmer-text font-medium">
            {t("pane.thinking")}
          </span>
          {elapsed >= 3 && (
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {elapsed}s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
