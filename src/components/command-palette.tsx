"use client";
import { useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  Check,
  Clock,
  CornerDownLeft,
  Flame,
  Gauge,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Plug,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useTranslation } from "@/lib/i18n";
import { workspaceName as shortenWorkspace } from "@/lib/paths";
import { loadCachedMessages, useChatStore } from "@/lib/chat-store";
import {
  buildSnippet,
  extractConversationText,
  formatRelativeTime,
  highlightRanges,
  scoreConversation,
  tokenize,
  type MatchRange,
} from "@/lib/conversation-search";
import type { SidebarView } from "@/components/sidebar/view-toggle";
import type { Conversation, ModelChoice, ReasoningLevel } from "@/lib/types";
import { api, type Screenshot } from "@/lib/tauri";
import { convertFileSrc } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: Conversation[];
  activeId: string | null;
  modelChoice: ModelChoice;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onModelChange: (next: ModelChoice) => void;
  onOpenSettings: () => void;
  onOpenScreenHistory: (query?: string, frame?: Screenshot) => void;
  onViewChange: (v: SidebarView) => void;
}

const REASONING: {
  level: ReasoningLevel;
  labelKey: string;
  hintKey: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { level: "non_think", labelKey: "reasoning.quick.label", hintKey: "reasoning.quick.hint", icon: Gauge },
  { level: "think_high", labelKey: "reasoning.think.label", hintKey: "reasoning.think.hint", icon: BrainCircuit },
  { level: "think_max", labelKey: "reasoning.max.label", hintKey: "reasoning.max.hint", icon: Flame },
];

// Cross-invocation content index. The palette is lazy-mounted (page.tsx renders
// it only while open), so a component-state cache would die on every close.
// Keep it at module scope and rebuild only the entries whose signature changed,
// so reopening doesn't re-read + re-lowercase every conversation's message blob
// from IndexedDB. Live (in-store) conversations are always rebuilt so a streamed
// reply is never searched stale.
const contentIndexCache = new Map<
  string,
  { sig: string; raw: string; lower: string }
>();

/** Wrap matched ranges of `text` in subtle <mark>s. Ranges are pre-merged and
 *  sorted by the search helpers. */
function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const nodes: React.ReactNode[] = [];
  let i = 0;
  for (let k = 0; k < ranges.length; k++) {
    const r = ranges[k];
    if (r.start > i) nodes.push(text.slice(i, r.start));
    nodes.push(
      <mark
        key={k}
        className="rounded-[3px] bg-foreground/20 px-px font-medium text-foreground"
      >
        {text.slice(r.start, r.end)}
      </mark>,
    );
    i = r.end;
  }
  if (i < text.length) nodes.push(text.slice(i));
  return <>{nodes}</>;
}

/** Every token must be a substring of the haystack (AND semantics). */
function commandMatches(haystack: string, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/**
 * ⌘K palette. We drive cmdk with `shouldFilter={false}` and do our own
 * matching so conversations can be searched by *content* (not just title) with
 * highlighted snippets, while commands stay a simple substring match. Hybrid
 * search reads message text from the IndexedDB cache (every conversation this
 * client has opened); titles are always searchable.
 */
export function CommandPalette({
  open,
  onOpenChange,
  conversations,
  activeId,
  modelChoice,
  onSelectConversation,
  onNewChat,
  onModelChange,
  onOpenSettings,
  onOpenScreenHistory,
  onViewChange,
}: Props) {
  const { t } = useTranslation("commandPalette");
  const [query, setQuery] = useState("");
  // convId -> flattened searchable text + a cached lowercased copy (so we don't
  // re-lowercase an 8k blob on every keystroke).
  const [index, setIndex] = useState<Map<string, { raw: string; lower: string }>>(
    () => new Map(),
  );
  const [indexing, setIndexing] = useState(true);
  // Screen-context (OCR) hits for the current query — searched on demand.
  const [screenHits, setScreenHits] = useState<Screenshot[]>([]);

  // Build the content index on open. The palette is lazy-mounted (page.tsx
  // renders it only while open), so this runs once per invocation. Prefer the
  // live store snapshot when present — it holds the freshest messages for the
  // active/streamed conversation, which the IDB cache only catches once a turn
  // settles — and fall back to the IDB cache for everything else.
  useEffect(() => {
    let cancelled = false;
    setIndexing(true);
    (async () => {
      const live = useChatStore.getState().chats;
      const entries = await Promise.all(
        conversations.map(async (c) => {
          try {
            const liveMsgs = live[c.id]?.messages;
            const isLive = !!(liveMsgs && liveMsgs.length);
            // updatedAt covers settled changes; the live length covers a conv
            // being extended this session. Cache only cold (IDB-backed) convs —
            // live ones are few and rebuilt each open so search stays fresh.
            const sig = `${c.updatedAt}:${liveMsgs?.length ?? 0}`;
            const hit = contentIndexCache.get(c.id);
            if (!isLive && hit && hit.sig === sig) {
              return [c.id, hit] as const;
            }
            const msgs = isLive ? liveMsgs! : await loadCachedMessages(c.id);
            if (!msgs || msgs.length === 0) return null;
            const raw = extractConversationText(msgs);
            if (!raw) return null;
            const entry = { sig, raw, lower: raw.toLowerCase() };
            contentIndexCache.set(c.id, entry);
            return [c.id, entry] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map = new Map<string, { raw: string; lower: string }>();
      for (const e of entries) if (e) map.set(e[0], { raw: e[1].raw, lower: e[1].lower });
      setIndex(map);
      setIndexing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversations]);

  const q = query.trim();
  const tokens = useMemo(() => tokenize(q), [q]);

  // Surface captured screen frames by keyword (OCR text + app), not just the
  // "Open screen history" action. Debounced; cleared on an empty query.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      () => {
        const req = q
          ? api.searchScreenshots(q, undefined, 6)
          : api.recentScreenshots(6);
        req
          .then((r) => {
            if (!cancelled) setScreenHits(r);
          })
          .catch(() => {
            if (!cancelled) setScreenHits([]);
          });
      },
      q ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const actions = useMemo(
    () => [
      { id: "new", label: t("action.newChat.label"), keywords: t("action.newChat.keywords"), shortcut: "⌘N", icon: Plus, run: onNewChat },
      { id: "chats", label: t("action.switchChats.label"), keywords: t("action.switchChats.keywords"), shortcut: "⌘1", icon: MessageSquare, run: () => onViewChange("chat") },
      { id: "board", label: t("action.switchBoard.label"), keywords: t("action.switchBoard.keywords"), shortcut: "⌘2", icon: LayoutGrid, run: () => onViewChange("board") },
      { id: "automations", label: t("action.switchAutomations.label"), keywords: t("action.switchAutomations.keywords"), shortcut: "⌘3", icon: Clock, run: () => onViewChange("automations") },
      { id: "plugins", label: t("action.switchPlugins.label"), keywords: t("action.switchPlugins.keywords"), shortcut: "⌘4", icon: Plug, run: () => onViewChange("plugins") },
      { id: "settings", label: t("action.openSettings.label"), keywords: t("action.openSettings.keywords"), shortcut: "⌘,", icon: Settings, run: onOpenSettings },
      { id: "screen-history", label: t("action.screenHistory.label"), keywords: t("action.screenHistory.keywords"), shortcut: "", icon: Monitor, run: () => onOpenScreenHistory() },
    ],
    [t, onNewChat, onOpenSettings, onOpenScreenHistory, onViewChange],
  );

  const shownActions = useMemo(
    () => actions.filter((a) => commandMatches(`${a.label} ${a.keywords}`, tokens)),
    [actions, tokens],
  );
  const shownReasoning = useMemo(
    () =>
      REASONING.filter((r) =>
        commandMatches(`${t(r.labelKey)} ${t(r.hintKey)} ${t("reasoning.keywords")}`, tokens),
      ),
    [t, tokens],
  );

  const convResults = useMemo(() => {
    if (!tokens.length) {
      return [...conversations]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 7)
        .map((conv) => ({ conv, titleRanges: [] as MatchRange[], snippet: null as ReturnType<typeof buildSnippet> }));
    }
    const scored: { conv: Conversation; score: number; raw: string }[] = [];
    for (const conv of conversations) {
      const entry = index.get(conv.id);
      const score = scoreConversation(conv.title || t("untitled"), entry?.lower ?? "", tokens);
      if (score == null) continue;
      scored.push({ conv, score, raw: entry?.raw ?? "" });
    }
    scored.sort((a, b) => b.score - a.score || b.conv.updatedAt - a.conv.updatedAt);
    return scored.slice(0, 12).map(({ conv, raw }) => ({
      conv,
      titleRanges: highlightRanges(conv.title || t("untitled"), tokens),
      snippet: buildSnippet(raw, tokens),
    }));
  }, [t, tokens, conversations, index]);

  const total =
    shownActions.length +
    shownReasoning.length +
    convResults.length +
    screenHits.length;
  const hasCommands =
    shownActions.length > 0 || shownReasoning.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 shadow-2xl sm:max-w-[40rem]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("srTitle")}</DialogTitle>
          <DialogDescription>{t("srDescription")}</DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("searchPlaceholder")}
          />
          <CommandList>
            {total === 0 ? (
              <div className="px-3 py-12 text-center text-sm text-muted-foreground">
                {q && indexing ? (
                  t("searching")
                ) : q ? (
                  t("noResultsFor", { query: q })
                ) : (
                  t("noResults")
                )}
              </div>
            ) : (
              <>
                {convResults.length > 0 && (
                  <CommandGroup
                    heading={
                      q
                        ? indexing
                          ? t("group.conversationsIndexing")
                          : t("group.conversationsCount", { count: convResults.length })
                        : t("group.recent")
                    }
                  >
                    {convResults.map(({ conv, titleRanges, snippet }) => (
                      <CommandItem
                        key={conv.id}
                        value={`conv-${conv.id}`}
                        onSelect={() => onSelectConversation(conv.id)}
                        className="items-start"
                      >
                        <MessageSquare className="mt-0.5 size-4" />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium">
                              <Highlight text={conv.title || t("untitled")} ranges={titleRanges} />
                            </span>
                            {activeId === conv.id && (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-foreground/40"
                                aria-hidden
                              />
                            )}
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                              {formatRelativeTime(conv.updatedAt)}
                            </span>
                          </div>
                          {snippet ? (
                            <span className="truncate text-xs text-muted-foreground">
                              <Highlight text={snippet.text} ranges={snippet.ranges} />
                            </span>
                          ) : (
                            <span className="truncate text-xs text-muted-foreground/60">
                              {shortenWorkspace(conv.workspaceDir)}
                            </span>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {convResults.length > 0 && hasCommands && <CommandSeparator />}

                {shownActions.length > 0 && (
                  <CommandGroup heading={t("group.actions")}>
                    {shownActions.map((a) => (
                      <CommandItem key={a.id} value={`action-${a.id}`} onSelect={a.run}>
                        <a.icon className="size-4" />
                        <span className="flex-1 truncate">{a.label}</span>
                        {a.shortcut && <Kbd>{a.shortcut}</Kbd>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {shownReasoning.length > 0 && (
                  <CommandGroup heading={t("group.reasoning")}>
                    {shownReasoning.map(({ level, labelKey, hintKey, icon: Icon }) => {
                      const current = modelChoice.reasoning === level;
                      return (
                        <CommandItem
                          key={level}
                          value={`reason-${level}`}
                          onSelect={() => onModelChange({ ...modelChoice, reasoning: level })}
                        >
                          <Icon className="size-4" />
                          <span className="truncate">{t(labelKey)}</span>
                          <span className="truncate text-xs text-muted-foreground/70">{t(hintKey)}</span>
                          {current && <Check className="ml-auto size-3.5 opacity-70" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {screenHits.length > 0 && (
                  <>
                    {(convResults.length > 0 || hasCommands) && <CommandSeparator />}
                    <CommandGroup
                      heading={
                        q
                          ? t("group.screenHistoryCount", { count: screenHits.length })
                          : t("group.screenHistoryRecent")
                      }
                    >
                      {screenHits.map((s) => (
                        <CommandItem
                          key={`screen-${s.id}`}
                          value={`screen-${s.id}`}
                          onSelect={() => onOpenScreenHistory(q, s)}
                          className="items-start"
                        >
                          <img
                            src={convertFileSrc(s.thumbPath ?? s.filePath)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="mt-0.5 h-9 w-14 shrink-0 rounded border border-border object-cover"
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {s.appName || t("screenFallback")}
                              </span>
                              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                                {formatRelativeTime(s.ts)}
                              </span>
                            </div>
                            <span className="truncate text-xs text-muted-foreground">
                              {(s.ocrText ?? "").replace(/\s+/g, " ").trim().slice(0, 120) ||
                                t("noRecognizedText")}
                            </span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </>
            )}
          </CommandList>

          <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5 font-serif text-xs italic">
              <Sparkles className="size-3" />
              cetus
            </span>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <span className="ml-0.5">{t("footer.navigate")}</span>
              </span>
              <span className="flex items-center gap-1">
                <Kbd>
                  <CornerDownLeft className="size-2.5" />
                </Kbd>
                <span className="ml-0.5">{t("footer.open")}</span>
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd>
                <span className="ml-0.5">{t("footer.close")}</span>
              </span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
