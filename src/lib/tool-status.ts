import type { RenderedBlock } from "./types";

export type ToolActivityStatus = "running" | "error" | "incomplete" | "settled";

/** Background agents can outlive their parent's streaming flag. Ordinary
 * tools without a result are incomplete, never a successful completion. */
export function toolActivityStatus(block: Extract<RenderedBlock, { kind: "tool_use" }>): ToolActivityStatus {
  const details = block.result?.details;
  const subagent = details && typeof details === "object"
    ? (details as { subagent?: unknown }).subagent : null;
  const status = subagent && typeof subagent === "object"
    ? (subagent as { status?: unknown }).status : undefined;
  if (block.streaming || status === "running") return "running";
  if (block.result?.isError || status === "failed" || status === "error") return "error";
  if (!block.result || status === "cancelled" || status === "canceled" || status === "interrupted") return "incomplete";
  return "settled";
}
