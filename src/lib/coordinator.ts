// A folder's coordinator: one ordinary pi conversation (DeepSeek Flash) that
// takes the user's stream of work, answers quick questions itself, and runs
// the rest as threads — ordinary sessions in the same folder on any runtime.
// Its thread tools (src-tauri/cetus-extensions/coordinator-tools.ts) and
// `cetus thread …` tunnel here. Nothing is posted back into the coordinator:
// the user reads each thread on its card in the Threads view.

import { create } from "zustand";
import type {
  BackendId,
  CliControlRequest,
  CoordinatorRegistry,
  ModelChoice,
  RenderedMessage,
} from "./types";

/** Coordinators run DeepSeek Flash (alias `deepseek-flash`, served as the
 *  latest Flash build): routing and relaying are light work. */
export const COORDINATOR_MODEL: ModelChoice = { model: "flash", reasoning: "high" };

export const COORDINATOR_TITLE = "Cetus";

/** Custom block type of the "thread started" notes older Cetus transcripts
 *  carry; still rendered, no longer written. */
export const STARTED_NOTE_TYPE = "thread_started";

/** Request ids of `cetus thread …` CLI calls (src-tauri/src/coordinator.rs). */
export const CLI_REQUEST_PREFIX = "cli-";

export type ThreadStatus = "working" | "needs_input" | "error" | "finished" | "idle";

export const useCoordinatorStore = create<{
  registry: CoordinatorRegistry;
  setRegistry: (r: CoordinatorRegistry) => void;
}>()((set) => ({
  registry: { coordinators: {}, threads: {} },
  setRegistry: (registry) => set({ registry }),
}));

export function isCoordinatorId(registry: CoordinatorRegistry, id: string): boolean {
  return Object.values(registry.coordinators).includes(id);
}

/** The conversations the chat list shows: everything but the folders' Cetus
 *  sessions, which live in the Threads view as the folder's timeline. The
 *  sidebar and the keys that walk it (⌘1…⌘9, ⌥⌘↑/↓) must share this, or the
 *  slots land on hidden rows. */
export function listedConversations<T extends { id: string }>(
  conversations: T[],
  registry: CoordinatorRegistry,
): T[] {
  const cetus = new Set(Object.values(registry.coordinators));
  return cetus.size ? conversations.filter((c) => !cetus.has(c.id)) : conversations;
}

/** Thread ids a coordinator started, in insertion order. */
export function threadsOf(registry: CoordinatorRegistry, coordinatorId: string): string[] {
  return Object.entries(registry.threads)
    .filter(([, c]) => c === coordinatorId)
    .map(([t]) => t);
}

/** The thread tool's `runtime` argument → backend; unknown/blank = default. */
export function runtimeToBackend(runtime: unknown): BackendId | null {
  const r = typeof runtime === "string" ? runtime.trim().toLowerCase() : "";
  if (r === "cetus" || r === "pi") return "pi";
  if (r === "claude-code" || r === "claude" || r === "claude code") return "claude-code";
  if (r === "codex") return "codex";
  if (r === "opencode" || r === "grok" || r === "kimi" || r === "dsh") return r;
  return null;
}

/** Letters and digits only, lowercased: "Claude Opus 5.5" → "claudeopus55". */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Vendor and filler words that don't tell models apart. */
const GENERIC = new Set(["claude", "gpt", "model", "the", "use"]);

/** A model name's family words and version: "claude-opus-5-5" →
 *  {opus}, "5.5"; "GPT-6.1-Sol" → {sol}, "6.1". Date stamps are dropped. */
function parseModelName(s: string): { words: Set<string>; version: string } {
  const lower = s.toLowerCase();
  const words = new Set(
    (lower.match(/[a-z]+/g) ?? []).filter((w) => !GENERIC.has(w)),
  );
  const version = (lower.match(/\d+(?:[.-]\d+)*/) ?? [""])[0]
    .split(/[.-]/)
    .filter((n) => n && n.length < 6)
    .join(".");
  return { words, version };
}

/** Resolve the coordinator's free-form `model` argument against a runtime's
 *  catalog. An exact id/label wins; otherwise the first entry (catalogs list
 *  the newest first) whose family has every requested word and whose version
 *  equals the requested one, when one was given. */
export function resolveCliModel(
  requested: string,
  models: { id: string; label: string }[],
): { id: string } | { error: string } {
  const want = squash(requested);
  if (!want) return { error: "model is empty" };
  const exact = models.find((m) => squash(m.id) === want || squash(m.label) === want);
  if (exact) return { id: exact.id };
  const req = parseModelName(requested);
  const hit = models.find((m) => {
    const id = parseModelName(m.id);
    const label = parseModelName(m.label);
    const words = new Set([...id.words, ...label.words]);
    const version = label.version || id.version;
    return (
      req.words.size > 0 &&
      [...req.words].every((w) => words.has(w)) &&
      (!req.version || req.version === version)
    );
  });
  if (hit) return { id: hit.id };
  const list = models.map((m) => (m.label && m.label !== m.id ? `${m.id} (${m.label})` : m.id));
  return { error: `unknown model "${requested}"; available: ${list.join(", ")}` };
}

export function backendLabel(backend: string | undefined): string {
  if (!backend) return "cetus";
  if (backend === "pi") return "cetus";
  return backend;
}

function textOf(m: RenderedMessage): string {
  return m.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n")
    .trim();
}

/** The opening user prompt (the task the thread was given). */
export function firstUserText(messages: RenderedMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = textOf(m);
    if (t) return t;
  }
  return "";
}

/** The thread's latest reply: the text of the last assistant message that has
 *  any, after the most recent user message when there is one. */
export function latestReply(messages: RenderedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role !== "assistant") continue;
    const t = textOf(m);
    if (t) return t;
  }
  return "";
}

/** The question a thread is blocked on, from its pending control request. */
export function pendingQuestion(reqs: CliControlRequest[] | undefined): string {
  const r = reqs?.[0];
  if (!r) return "";
  const qs = r.input?.questions;
  if (Array.isArray(qs) && qs.length) {
    return qs
      .map((q) => {
        const opts = (q.options ?? []).map((o) => o.label).filter(Boolean);
        return opts.length ? `${q.question} (options: ${opts.join(" / ")})` : q.question;
      })
      .join("\n");
  }
  return `Permission requested for ${r.toolName}: ${clip(JSON.stringify(r.input), 600)}`;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[${s.length - max} more characters]`;
}

export interface ParsedReport {
  id: string;
  title: string;
  runtime: string;
  status: string;
  body: string;
}

/** A <thread-report> bubble from an older Cetus transcript (reports are no
 *  longer posted), for rendering it as a card. */
export function parseReport(text: string): ParsedReport | null {
  const m = text
    .trim()
    .match(/^<thread-report\s+([^>]*)>\n?([\s\S]*?)\n?<\/thread-report>$/);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return {
    id: attrs.id ?? "",
    title: attrs.title ?? "",
    runtime: attrs.runtime ?? "",
    status: attrs.status ?? "",
    body: m[2],
  };
}

/** Window event that opens a thread docked in the Threads view. */
export const OPEN_THREAD_EVENT = "cetus:open-thread";

export function openThread(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: { id } }));
}
