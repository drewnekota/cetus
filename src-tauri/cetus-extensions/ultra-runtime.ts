/**
 * cetus Ultra Code runtime extension.
 *
 * Provides the `run_workflow` tool the model calls when Ultra Code mode is ON
 * (see ULTRA_SYSTEM_PROMPT in src-tauri/src/pi_rpc.rs). The model authors a JS
 * script that orchestrates the task; the script runs in-process here with a
 * `cetus` global whose primitives spawn real cetus sub-agents.
 *
 * Round-trip: `cetus.agent()` tunnels a sub-agent request to the Rust host
 * through a sentinel `ctx.ui.input` whose title is "__cetus_ultra_agent__" and
 * whose `placeholder` carries the JSON-encoded params. dispatch_line /
 * is_ultra_agent_request in pi_rpc.rs recognize it and route it to
 * ultra::handle_agent_request, which runs a sub-agent via run_agent_node and
 * replies through `extension_ui_response`. pi resolves `ctx.ui.input` to the
 * response's `value` (a JSON string of `{ ok, summary, result }`).
 *
 * Keep ULTRA_AGENT_TITLE and the request/reply shapes in sync with
 * pi_rpc.rs (ULTRA_AGENT_TITLE, is_ultra_agent_request) and ultra.rs (run_one,
 * the reply envelope).
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Must equal pi_rpc::ULTRA_AGENT_TITLE. */
const ULTRA_AGENT_TITLE = "__cetus_ultra_agent__";

// Compile-a-string-into-an-async-function constructor. Lets a script body use
// top-level `await` and `return`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

interface AgentOpts {
  label?: string;
  /** Subfolder of the workspace the sub-agent must write into. */
  subdir?: string;
  /** Per-agent model override; inherits the parent's choice when omitted. */
  model?: unknown;
  /**
   * A JSON Schema. When set, the sub-agent is instructed to emit JSON
   * conforming to it as its final message, and `agent()` returns the parsed +
   * (best-effort) validated object instead of a string.
   */
  schema?: { required?: unknown } & Record<string, unknown>;
}

interface AgentReply {
  ok?: boolean;
  /** The sub-agent's final message — the default return value. */
  text?: unknown;
  summary?: unknown;
  result?: unknown;
  error?: string;
}

/**
 * Coerce a schema-mode reply into an object. Prefers an explicit structured
 * `result`; otherwise parses the final message text as JSON (tolerating a
 * ```json fence). Does a best-effort required-keys check — NOT full JSON-Schema
 * validation — and throws a clear error the orchestrator can react to.
 */
function coerceSchemaResult(reply: AgentReply, schema: AgentOpts["schema"]): unknown {
  let obj: unknown = reply.result;
  if (obj == null || typeof obj !== "object") {
    const text = typeof reply.text === "string" ? reply.text.trim() : "";
    if (!text) {
      throw new Error("cetus.agent: schema requested but the sub-agent returned no JSON");
    }
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      obj = JSON.parse(cleaned);
    } catch {
      throw new Error("cetus.agent: the sub-agent's result is not valid JSON for the requested schema");
    }
  }
  const required = schema && Array.isArray(schema.required) ? (schema.required as string[]) : null;
  if (required && obj && typeof obj === "object") {
    const missing = required.filter((k) => !(k in (obj as Record<string, unknown>)));
    if (missing.length) {
      throw new Error("cetus.agent: result is missing required fields: " + missing.join(", "));
    }
  }
  return obj;
}

/** A sink for live progress lines — backed by the run_workflow tool's onUpdate. */
type Report = (line: string) => void;

/** Build the `cetus` global handed to a workflow script. */
function makeCetus(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  report: Report,
) {
  let agentSeq = 0;

  /** Spawn ONE focused sub-agent, run it, and return its result. */
  async function agent(prompt: string, opts: AgentOpts = {}): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("cetus.agent(prompt): prompt must be a non-empty string");
    }
    const seq = ++agentSeq;
    const label = (opts && typeof opts.label === "string" && opts.label) || "agent";
    report(`▸ #${seq} ${label} — running`);
    // The host parses the `placeholder` argument as JSON into the request params.
    let raw: string | null | undefined;
    try {
      raw = await ctx.ui.input(
        ULTRA_AGENT_TITLE,
        JSON.stringify({ prompt, opts: opts ?? {} }),
        signal ? { signal } : undefined,
      );
    } catch (e) {
      report(`✗ #${seq} ${label} — error`);
      throw e;
    }
    if (raw == null) {
      report(`✗ #${seq} ${label} — aborted`);
      throw new Error("cetus.agent: no response from host (aborted or cancelled)");
    }
    let reply: AgentReply;
    try {
      reply = JSON.parse(raw);
    } catch {
      throw new Error("cetus.agent: malformed host reply: " + raw);
    }
    if (!reply.ok) {
      report(`✗ #${seq} ${label} — failed`);
      throw new Error(reply.error || "cetus.agent: sub-agent failed");
    }
    report(`✓ #${seq} ${label} — done`);
    // With a schema, return the parsed/validated object. Otherwise return the
    // sub-agent's final message (a string) — Claude-Code semantics — falling
    // back to an explicit structured result, then the one-line summary.
    if (opts && opts.schema) {
      return coerceSchemaResult(reply, opts.schema);
    }
    if (typeof reply.text === "string" && reply.text.trim()) {
      return reply.text;
    }
    return reply.result != null ? reply.result : reply.summary;
  }

  /** Run thunks concurrently; resolve to their results in order (a barrier). */
  async function parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
    if (!Array.isArray(thunks)) {
      throw new Error("cetus.parallel(thunks): expected an array of functions");
    }
    return Promise.all(thunks.map((t) => t()));
  }

  /** Flow each item through the stages in sequence; items run concurrently. */
  async function pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    if (!Array.isArray(items)) {
      throw new Error("cetus.pipeline(items, ...stages): items must be an array");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) acc = await stage(acc, item, index);
        return acc;
      }),
    );
  }

  // Progress markers — surfaced live on the run_workflow tool card via `report`.
  function phase(title: string): void {
    if (typeof title === "string" && title.trim()) report(`■ ${title}`);
  }
  function log(message: string): void {
    if (typeof message === "string" && message.trim()) report(`· ${message}`);
  }

  return { agent, parallel, pipeline, phase, log };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_workflow",
    label: "Run workflow",
    description:
      "Orchestrate a substantial task by running a JavaScript workflow. The `script` " +
      "runs in a sandbox with a `cetus` global: `await cetus.agent(prompt, {label?, model?, schema?})` " +
      "spawns one sub-agent and returns its FINAL MESSAGE as a string — or, when a JSON " +
      "Schema is passed as `schema`, a parsed+validated object; " +
      "`await cetus.parallel([()=>cetus.agent(a), ()=>cetus.agent(b)])` runs thunks " +
      "concurrently (barrier); `await cetus.pipeline(items, stage1, stage2)` flows each item " +
      "through the stages (no barrier); `cetus.phase(title)` / `cetus.log(msg)` stream live " +
      "progress onto this tool's card. " +
      "The script MUST `return` the final result (a string or JSON-serializable object). " +
      "This tool blocks and returns that result.",
    parameters: Type.Object({
      script: Type.String({
        description:
          "JavaScript source with a top-level `cetus` global. May use top-level " +
          "`await` and `return`. Must return the final result.",
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = params.script;
      if (typeof script !== "string" || !script.trim()) {
        return {
          content: [{ type: "text", text: "run_workflow: empty script." }],
          isError: true,
        };
      }
      // Accumulate progress lines and stream them onto the tool card so the user
      // sees the workflow's phases / sub-agents live instead of an opaque spinner.
      const progress: string[] = [];
      const report: Report = (line) => {
        progress.push(line);
        try {
          onUpdate?.({ content: [{ type: "text", text: progress.join("\n") }] });
        } catch {
          /* best-effort: never let a progress hiccup fail the workflow */
        }
      };
      const cetus = makeCetus(ctx, signal, report);
      try {
        const fn = new AsyncFunction("cetus", script);
        const result = await fn(cetus);
        const text =
          typeof result === "string"
            ? result
            : result === undefined
              ? "(workflow returned no value)"
              : JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { kind: "ultra_workflow_result" },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        return {
          content: [{ type: "text", text: "Workflow threw an error:\n" + msg }],
          isError: true,
        };
      }
    },
  });
}
