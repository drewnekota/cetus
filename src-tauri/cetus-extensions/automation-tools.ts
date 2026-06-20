/**
 * cetus automation-tools — lets the agent create / list / update the user's
 * scheduled automations from inside a normal conversation.
 *
 * Instead of asking the user to open the Automations dialog and fill a form, the
 * agent can turn "every weekday at 9am, summarize my unread mail and message me"
 * into a real saved automation. The actual store write happens in Rust: each tool
 * tunnels its request through a sentinel `ctx.ui.input` (title
 * "__cetus_automation__"), which `pi_rpc::dispatch_line` routes to
 * `automation_tool.rs`; the reply (the resulting automation, or an error) comes
 * back as the input's resolved string. Same round-trip the computer-use and Ultra
 * extensions use.
 *
 *   model tool ──ui.input(title="__cetus_automation__", placeholder=JSON)──► Rust
 *              ◄────────────────── JSON reply (value) ───────────────────────
 *
 * ENABLING: the agent may arm automations directly — `create` defaults to
 * enabled (pass `enabled: false` for a draft) and `update` can flip the flag.
 * Keep the sentinel and the field names in sync with
 * src-tauri/src/automation_tool.rs and the `AUTOMATION_TOOL_TITLE` constant in
 * src-tauri/src/pi_rpc.rs.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Sentinel title intercepted by the Rust host (never shown to the user). */
const SENTINEL_AUTOMATION = "__cetus_automation__";

/** The exec context pi passes as the 5th execute() argument carries the UI RPC. */
interface ExtensionContext {
  // pi's RPC `ui.input` takes positional args (title, placeholder, opts) — NOT
  // an options object. Passing an object makes `title` the object, which breaks
  // sentinel routing on the host and leaks a broken dialog to the frontend.
  ui?: {
    input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | null>;
  };
}

interface HostReply {
  ok: boolean;
  error?: string;
  note?: string;
  automation?: unknown;
  automations?: unknown[];
}

/**
 * Tunnel one payload to the Rust host and parse its JSON reply. Guarded so a
 * missing channel / malformed reply becomes a typed error the model can read,
 * never a thrown TypeError the agent loop mis-surfaces.
 */
async function hostCall(exCtx: ExtensionContext, payload: unknown): Promise<HostReply> {
  if (typeof exCtx?.ui?.input !== "function") {
    return { ok: false, error: "host tunnel unavailable (no ui.input)" };
  }
  let raw: string | null;
  try {
    raw = await exCtx.ui.input(SENTINEL_AUTOMATION, JSON.stringify(payload));
  } catch (err) {
    return { ok: false, error: `host tunnel failed: ${(err as Error).message}` };
  }
  if (raw === null) return { ok: false, error: "host tunnel returned no reply" };
  try {
    return JSON.parse(raw) as HostReply;
  } catch {
    return { ok: false, error: `unparseable host reply: ${raw.slice(0, 200)}` };
  }
}

/** Render a host reply into a tool result the model reads. */
function result(reply: HostReply) {
  const text = reply.ok
    ? JSON.stringify(reply, null, 2)
    : `error: ${reply.error ?? "unknown error"}`;
  return { content: [{ type: "text" as const, text }] };
}

/** Shared schedule fields, reused by create + update. */
const scheduleFields = {
  scheduleKind: Type.Optional(
    Type.String({
      description:
        "One of: 'daily' (a wall-clock time, optionally on certain weekdays), " +
        "'interval' (every N minutes), 'cron' (5-field expression), 'once' " +
        "(a single future instant). Required for create.",
    }),
  ),
  time: Type.Optional(
    Type.String({ description: "For 'daily': local time as HH:MM (24h), e.g. '09:00'." }),
  ),
  weekdays: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "For 'daily': which weekdays to fire on, 0=Sun..6=Sat. Omit/empty = every day.",
    }),
  ),
  everyMinutes: Type.Optional(
    Type.Number({ description: "For 'interval': minutes between runs (integer ≥ 1)." }),
  ),
  cron: Type.Optional(
    Type.String({ description: "For 'cron': a standard 5-field expression, e.g. '0 9 * * 1-5'." }),
  ),
  at: Type.Optional(
    Type.String({
      description: "For 'once': local datetime 'YYYY-MM-DD HH:MM' (24h).",
    }),
  ),
  workspaceDir: Type.Optional(
    Type.String({ description: "Absolute directory the automation runs in. Defaults to the app workspace." }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model tier for the run: 'flash' (cheap, default) or 'pro'." }),
  ),
  reasoning: Type.Optional(
    Type.String({ description: "Reasoning level: 'non_think' | 'think_high' (default) | 'think_max'." }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether the automation is armed. On create, defaults to true (it runs on " +
        "schedule immediately); pass false to save a draft. On update, pass true to " +
        "enable a disabled automation or false to pause it.",
    }),
  ),
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "create_automation",
    label: "Create scheduled automation",
    description:
      "Save a recurring (or one-shot) automation: a prompt that fires on a " +
      "schedule as a background conversation. Use this when the user wants " +
      "something to happen on a schedule ('every morning…', 'each weekday at " +
      "9…', 'in 2 hours…'). It is enabled and will start running on schedule by " +
      "default; pass `enabled: false` to save it as a draft instead. Returns the " +
      "saved automation or a validation error you should fix and retry.",
    parameters: Type.Object({
      name: Type.String({ description: "Short human label for the automation." }),
      prompt: Type.String({
        description:
          "The instruction the agent runs each time it fires. Write it as a " +
          "self-contained task (the run starts a fresh conversation with no prior context).",
      }),
      ...scheduleFields,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, exCtx) {
      return result(await hostCall(exCtx as ExtensionContext, { op: "create", ...params }));
    },
  });

  pi.registerTool({
    name: "list_automations",
    label: "List automations",
    description:
      "List the user's saved automations (id, name, prompt, schedule, whether " +
      "enabled). Use this to find an automation's id before updating it, or to " +
      "tell the user what's currently scheduled.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, exCtx) {
      return result(await hostCall(exCtx as ExtensionContext, { op: "list" }));
    },
  });

  pi.registerTool({
    name: "update_automation",
    label: "Update automation",
    description:
      "Change an existing automation's name, prompt, schedule, workspace, model, " +
      "or enabled state. Pass the automation's `id` (get it from list_automations) " +
      "plus only the fields you want to change; for the schedule, pass " +
      "`scheduleKind` and its fields. Pass `enabled: true` to arm a disabled " +
      "automation or `enabled: false` to pause it. Returns the updated automation " +
      "or an error.",
    parameters: Type.Object({
      id: Type.String({ description: "Id of the automation to update (from list_automations)." }),
      name: Type.Optional(Type.String({ description: "New label." })),
      prompt: Type.Optional(Type.String({ description: "New prompt the run executes." })),
      ...scheduleFields,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, exCtx) {
      return result(await hostCall(exCtx as ExtensionContext, { op: "update", ...params }));
    },
  });
}
