/**
 * cetus skill-tools — lets the agent create / list / update / delete the user's
 * reusable Skills from inside a normal conversation ("create a skill that does
 * X", "tweak the deploy skill"), instead of the user hand-writing one in
 * Settings → Skills.
 *
 * The store write happens in Rust: the tool tunnels its request through a
 * sentinel `ctx.ui.input` (title "__cetus_skill__"), which `pi_rpc::dispatch_line`
 * routes to `skill_tool.rs`; the reply (the resulting skill, or an error) comes
 * back as the input's resolved string. Same round-trip the automation-tools and
 * Ultra extensions use.
 *
 *   model tool ──ui.input(title="__cetus_skill__", placeholder=JSON)──► Rust
 *              ◄────────────────── JSON reply (value) ──────────────────
 *
 * A skill the user explicitly asks for is created ENABLED and managed (tagged
 * "By agent" in Settings → Skills). Skills are read at session start, so a new
 * skill loads in the NEXT conversation, not retroactively in this one. Keep the
 * sentinel + field names in sync with src-tauri/src/skill_tool.rs and the
 * `SKILL_TOOL_TITLE` constant in src-tauri/src/pi_rpc.rs.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Sentinel title intercepted by the Rust host (never shown to the user). */
const SENTINEL_SKILL = "__cetus_skill__";

/** The exec context pi passes as the 5th execute() argument carries the UI RPC. */
interface ExtensionContext {
  // pi's RPC `ui.input` takes positional args (title, placeholder, opts) — NOT an
  // options object. Passing an object makes `title` the object, which breaks
  // sentinel routing on the host and leaks a broken dialog to the frontend.
  ui?: {
    input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | null>;
  };
}

interface HostReply {
  ok: boolean;
  error?: string;
  note?: string;
  skill?: unknown;
  skills?: unknown[];
  deleted?: string;
  masterEnabled?: boolean;
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
    raw = await exCtx.ui.input(SENTINEL_SKILL, JSON.stringify(payload));
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "manage_skill",
    label: "Manage skills",
    description:
      "Create, list, update, or delete the user's reusable SKILLS (an Agent " +
      "Skill = a SKILL.md the assistant pulls in when a task matches). Use this " +
      "when the user asks you to save/create/update/remove a skill, or to " +
      "capture a repeatable procedure they'll want again.\n" +
      "- op 'create': needs `name`, `body` (the markdown instructions), and a " +
      "one-sentence `description` saying WHEN to use it (the trigger). It lands " +
      "ENABLED and appears in Settings → Skills tagged 'By agent'; it loads in " +
      "the user's NEXT conversation (not retroactively in this one) — say so.\n" +
      "- op 'list': returns each skill's id/name/description/enabled/source. Get " +
      "an `id` from here before update/delete.\n" +
      "- op 'update': pass `id` plus only the fields to change (name/description/body).\n" +
      "- op 'delete': pass `id`.\n" +
      "Only save GENERALIZABLE, reusable know-how — not one-off task logs or " +
      "transient/environment-specific failures.",
    promptSnippet:
      "Save reusable skills for the user with manage_skill (op create/list/update/delete) — e.g. when they ask you to 'create a skill'.",
    parameters: Type.Object({
      op: Type.String({ description: "One of: 'create', 'list', 'update', 'delete'." }),
      id: Type.Optional(Type.String({ description: "Skill id (from op 'list'); required for update/delete." })),
      name: Type.Optional(Type.String({ description: "Skill name (2-5 words). Required for create." })),
      description: Type.Optional(
        Type.String({ description: "One sentence: WHEN the assistant should use this skill (its trigger)." }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "The skill's markdown instructions — the reusable steps/commands/conventions. Required for create.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, exCtx) {
      return result(await hostCall(exCtx as ExtensionContext, params));
    },
  });
}
