// What a Threads feed card knows of a session's latest turn without opening
// it: its steps (tool calls / thinking) and a digest of the tool calls by kind.

import { artifactsFromDetails } from "./artifact";
import type { RenderedBlock, RenderedMessage } from "./types";

export type StepKind = "explore" | "edit" | "run" | "web" | "agent" | "other";

/** Counts of the latest turn's tool calls by kind. Persisted in the preview
 *  record so settled, non-resident threads can show it too. */
export type ActivityDigest = Partial<Record<StepKind, number>>;

const KIND_BY_NAME: Record<string, StepKind> = {
  read: "explore",
  read_file: "explore",
  grep: "explore",
  glob: "explore",
  ls: "explore",
  find: "explore",
  list: "explore",
  list_dir: "explore",
  search_files: "explore",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  write_file: "edit",
  apply_patch: "edit",
  notebookedit: "edit",
  str_replace: "edit",
  bash: "run",
  shell: "run",
  local_shell: "run",
  exec: "run",
  exec_command: "run",
  websearch: "web",
  webfetch: "web",
  web_search: "web",
  web_fetch: "web",
  fetch: "web",
  task: "agent",
  agent: "agent",
  spawn_agent: "agent",
};

export function stepKind(name: string): StepKind {
  return KIND_BY_NAME[name.trim().toLowerCase()] ?? "other";
}

export type ToolBlock = Extract<RenderedBlock, { kind: "tool_use" }>;

export type StepBlock = ToolBlock | Extract<RenderedBlock, { kind: "thinking" }>;

/** Thinking and tool calls; artifact deliveries are results, not steps. */
export function isStep(b: RenderedBlock): b is StepBlock {
  if (b.kind === "thinking") return !!b.text.trim() || !!b.streaming;
  return b.kind === "tool_use" && !(b.result && artifactsFromDetails(b.result.details).length > 0);
}

/** Index of the first message of the latest turn (the last user prompt). */
export function turnStart(messages: RenderedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return 0;
}

export function computeDigest(messages: RenderedMessage[]): ActivityDigest {
  const digest: ActivityDigest = {};
  for (let i = turnStart(messages); i < messages.length; i++) {
    for (const b of messages[i].blocks) {
      if (b.kind !== "tool_use" || !isStep(b)) continue;
      const k = stepKind(b.name);
      digest[k] = (digest[k] ?? 0) + 1;
    }
  }
  return digest;
}
