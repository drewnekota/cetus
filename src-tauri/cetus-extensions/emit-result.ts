/**
 * cetus `emit_node_result` extension.
 *
 * Every cetus sub-agent (spawned by the Ultra Code runtime via `run_agent_node`
 * in src-tauri/src/run_engine.rs) calls this tool exactly once to report its
 * outcome. The Rust host watches the resulting `tool_execution_end` event and
 * matches `result.details.kind === "node_result"` (see `handle_app_event` in
 * run_engine.rs); the whole `details` object is then handed back to the waiting
 * parent. ultra.rs reads `details.summary` / `details.result` from it.
 *
 * Keep the `kind` value and the `summary` / `result` field names in sync with
 * run_engine.rs (NodeOutcome / handle_app_event) and ultra.rs (run_one).
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "emit_node_result",
    label: "Emit node result",
    description:
      "Signal to the orchestrator that you are done. Your FINAL MESSAGE is what " +
      "gets returned to the orchestrator, so put your complete answer there first; " +
      "then call this tool EXACTLY ONCE with a one-line `summary` status (and, only " +
      "if you were asked for structured output, a `result` object). Then end your turn.",
    promptSnippet:
      "Put your full answer in your final message, then call emit_node_result with a one-line summary to finish.",
    parameters: Type.Object({
      summary: Type.String({
        description: "A one or two sentence summary of what you produced.",
      }),
      result: Type.Optional(
        Type.Any({
          description:
            "Optional structured result (any JSON value) for the orchestrator to consume.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const summary = typeof params.summary === "string" ? params.summary : "";
      const result = params.result ?? null;
      return {
        content: [{ type: "text", text: "Result reported to the orchestrator." }],
        // The host matches on details.kind === "node_result" and reads summary/result.
        details: { kind: "node_result", summary, result },
      };
    },
  });
}
