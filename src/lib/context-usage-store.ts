// Persisted context-window occupancy per conversation.
//
// The runtime only reports context usage when a turn finishes (claude's
// `result`, codex's token-usage notification), so a freshly launched app has
// nothing to show for any conversation until it runs a new turn. That defeats
// the point of the number — it is read *before* deciding whether to continue
// in an old thread. Write-through to localStorage keeps the last completed
// turn's snapshot across restarts and sidebar eviction. The value is at most
// stale by one turn (it only changes when the runtime runs again), so showing
// the previous reading is accurate, not misleading.
//
// This module is the single owner of the key; callers go through the chat
// store and never touch localStorage directly.

import type { CliContextUsage } from "./types";

const KEY = "cetus:contextUsage";

/** Upper bound on remembered conversations. Deleted conversations never
 *  purge here (deletion happens in settings without touching the chat
 *  store), so the oldest snapshots age out instead. */
export const MAX_ENTRIES = 512;

type Entry = CliContextUsage & { at: number };

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isFinite(v.usedTokens) &&
    Number.isFinite(v.contextWindow) &&
    (v.contextWindow as number) > 0 &&
    Number.isFinite(v.at)
  );
}

/** Parse a raw snapshot, dropping malformed rows. Exposed for tests. */
export function parseContextUsage(raw: string | null): Record<string, Entry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Entry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEntry(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Trim to MAX_ENTRIES, keeping the most recently written. Exposed for tests. */
export function pruneContextUsage(
  entries: Record<string, Entry>,
  max = MAX_ENTRIES,
): Record<string, Entry> {
  const ids = Object.keys(entries);
  if (ids.length <= max) return entries;
  ids.sort((a, b) => entries[b].at - entries[a].at);
  const out: Record<string, Entry> = {};
  for (const id of ids.slice(0, max)) out[id] = entries[id];
  return out;
}

function load(): Record<string, Entry> {
  const s = storage();
  if (!s) return {};
  try {
    return parseContextUsage(s.getItem(KEY));
  } catch {
    return {};
  }
}

function save(entries: Record<string, Entry>) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(entries));
  } catch {}
}

function strip({ at: _at, ...usage }: Entry): CliContextUsage {
  return usage;
}

/** Snapshot for seeding the chat store at startup. */
export function loadContextUsage(): Record<string, CliContextUsage> {
  const out: Record<string, CliContextUsage> = {};
  for (const [id, entry] of Object.entries(load())) out[id] = strip(entry);
  return out;
}

export function persistContextUsage(id: string, usage: CliContextUsage) {
  const entries = load();
  entries[id] = { ...usage, at: Date.now() };
  save(pruneContextUsage(entries));
}

export function forgetContextUsage(id: string) {
  const entries = load();
  if (!(id in entries)) return;
  delete entries[id];
  save(entries);
}
