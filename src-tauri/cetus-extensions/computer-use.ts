/**
 * computer-use.ts — a pi extension that gives a TEXT-ONLY agent OS-level
 * (macOS) control over the frontmost application's UI, with ZERO npm deps.
 *
 * WHY THIS EXISTS
 * ---------------
 * The base model is text-only: it cannot see a screen, move a mouse, or read
 * pixels. Yet a huge amount of real work lives behind native GUIs that have no
 * API. This extension closes that gap WITHOUT vision: instead of screenshots,
 * it exposes the live macOS Accessibility (AX) tree of the frontmost app as a
 * flat, NUMBERED list of actionable elements. The model "sees" the UI as text
 * ("[7] AXButton \"Send\" (enabled)") and acts by INDEX ("click [7]"). This is
 * cheaper, more reliable, and more deterministic than pixel coordinates — the
 * helper resolves an index back to a concrete AXUIElement and presses it.
 *
 * TRANSPORT (the host tunnel)
 * ---------------------------
 * pi is a Bun-compiled binary running inside the cetus desktop app. It has no
 * direct access to the macOS Accessibility APIs (those need a native, signed,
 * permission-granted process). So every native request is tunneled through the
 * host via the blocking UI RPC surface, exCtx.ui.input:
 *
 *     model tool  ──exCtx.ui.input(title="__cetus_cua_request__")──►  Rust (cua.rs)
 *                                                                       │ stdin
 *                                                                       ▼
 *                                                            cetus-cua-helper.swift
 *                                                            (long-lived, holds the
 *                                                             last dump's index map)
 *
 * A ui.input whose `title` is the SENTINEL "__cetus_cua_request__" is intercepted
 * by a Rust handler (NOT shown to the user). The handler forwards the JSON
 * `placeholder` payload to the long-lived Swift helper as one newline-delimited
 * line and returns the helper's one-line JSON reply as the resolved string. We
 * parse that string back into a typed reply object.
 *
 * WHY ONE LONG-LIVED HELPER: AXUIElement references are process-local and not
 * serializable. The helper therefore keeps the last dump's observationId and its
 * index -> AXUIElement map IN MEMORY, so a "dump" and a subsequent "act" must be
 * served by the SAME process. Indices are only valid for the observation that
 * produced them; after acting, the UI may change, so the model MUST re-observe.
 *
 * LIVE "WATCH" STEPS (Contract A)
 * -------------------------------
 * After each meaningful action we emit a best-effort step via the sentinel
 * "__cetus_agent_step__", which Rust acks immediately and forwards to the UI on
 * the "app-event" channel (type "agent_step"). For computer use the screenshot
 * is attached by Rust, so TS only sends {surface:"computer", action}.
 *
 * CONFIRMATION POLICY (Contract D, user-selected)
 * -----------------------------------------------
 * Confirm ONCE per conversation for the first consequential action, and ALWAYS
 * confirm destructive/sensitive actions (key combos, typing into password
 * fields, etc.). Pure reads (observe/verify) auto-run. Approval state is kept in
 * a module-level Set keyed by conversation id, best-effort for the extension's
 * lifetime.
 *
 * TOOLS EXPOSED
 * -------------
 *   computer_observe { app?, includeOcr? }
 *       Dump the frontmost (or named) app's actionable UI as a numbered list +
 *       observation_id. Indices are valid ONLY for this observation.
 *   computer_act { observationId, actions:[{op,index?,text?,keys?,dx?,dy?,x?,y?}] }
 *       Apply actions in order against a prior observation, honoring the
 *       confirmation policy, then return the result + a FRESH observation so the
 *       model sees the new state.
 *   computer_verify { expect? }
 *       Re-dump current state so the model can check its own expectation.
 *
 * All tools catch their own errors and return a useful string (execute() must
 * return a string). No npm deps: only globals + the host tunnel are used.
 */

import { errMsg } from "./bridge/protocol";

// ----------------------------------------------------------------------------
// pi extension types.
//
// The pi runtime provides these via the pi-ai module at load time (the package
// on disk is @earendil-works/pi-ai). To keep this file self-contained and
// zero-dep — so it never has a runtime dependency on a module path — we declare
// the exact shapes we use locally (matching browser-use.ts). If you prefer the
// real types, swap this block for:  import type { Extension, ExtensionContext,
// ToolDefinition } from "@earendil-works/pi-ai";
// ----------------------------------------------------------------------------

/** JSON-Schema-ish tool definition registered via ctx.registerTool. */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  // pi's core invokes a registered tool's execute() POSITIONALLY as
  //   execute(toolCallId, args, signal, onUpdate, execContext)
  // (see the bundled @earendil-works/pi-coding-agent extension runner's
  // wrapToolForExecution). The tool ARGS are the 2nd parameter and the real
  // exec context — the one carrying `ui` and `conversationId` — is the 5th.
  // A 2-arg `(args, exCtx)` shape silently bound `args` to the toolCallId STRING
  // and `exCtx` to the args object (no `.ui`), so every `exCtx.ui.*` call threw
  // locally and every `args.*` read was undefined. Keep aligned with pi.
  execute(
    toolCallId: string,
    args: any,
    signal: unknown,
    onUpdate: unknown,
    exCtx: ExtensionContext,
  ): Promise<string>;
}

/**
 * The pi exec/registration context. The same object both registers tools and is
 * passed to each execute() as the exec context, so it carries `registerTool`,
 * the blocking `ui` RPC surface, and (best-effort) the conversation id.
 */
interface ExtensionContext {
  registerTool(def: ToolDefinition): void;
  conversationId?: string;
  conversation?: { id?: string };
  // pi's RPC UI surface takes positional args (title, message/placeholder, opts)
  // — NOT an options object. Passing an object makes `title` itself the object,
  // which breaks sentinel routing on the host and crashes the dialog renderer.
  ui: {
    input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | null>;
    confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
  };
}

/** An extension is a function of its registration context. */
type Extension = (ctx: ExtensionContext) => void;

/** Sentinel titles intercepted by Rust handlers (NOT shown to the user). */
const SENTINEL_CUA = "__cetus_cua_request__";
const SENTINEL_STEP = "__cetus_agent_step__";

/** A single actionable element as reported by the AX dump. */
interface CuaElement {
  index: number;
  role: string;
  label: string;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  focused: boolean;
}

/** One action in a computer_act batch. */
interface CuaAction {
  op: "click" | "type" | "key" | "scroll" | "move_click";
  index?: number;
  text?: string;
  keys?: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
}

/** Request payloads tunneled to the native helper (Contract B). */
type CuaPayload =
  | { op: "dump"; app?: string; includeOcr?: boolean }
  | { op: "act"; observationId: string; actions: CuaAction[] }
  | { op: "verify"; expect?: string };

/** Parsed reply object from the native helper (Contract B). */
interface CuaReply {
  ok: boolean;
  observationId?: string;
  app?: string;
  elements?: CuaElement[];
  result?: string;
  error?: string;
  fallback?: "ocr";
}

/**
 * Per-conversation memory of "we already got the user's one-time approval".
 * Best-effort, lives only as long as the extension process. Keyed by the
 * conversation id (exCtx.conversationId) or "default" when unavailable.
 */
const approvedOnce = new Set<string>();

/** Resolve a stable conversation key for the confirmation policy. */
function convKey(exCtx: ExtensionContext): string {
  const id = (exCtx as { conversationId?: string }).conversationId;
  return typeof id === "string" && id.length > 0 ? id : "default";
}

/**
 * Tunnel one payload to the native helper through the host and parse the reply.
 * exCtx.ui.input with the CUA sentinel is routed to Rust (cua.rs), which talks
 * to the long-lived Swift helper and returns the helper's one-line JSON reply.
 * JSON.parse is guarded so a malformed/empty reply becomes a typed error reply.
 */
async function cua(exCtx: ExtensionContext, payload: CuaPayload): Promise<CuaReply> {
  // Null-guard the UI channel before dereferencing it: pi passes the real
  // exec context (the one carrying `ui`) as the 5th execute() argument, but be
  // defensive so a missing/odd `ui` becomes a typed error reply instead of a
  // local TypeError the agent loop mis-surfaces.
  if (typeof exCtx?.ui?.input !== "function") {
    return { ok: false, error: "host tunnel unavailable (no ui.input)" };
  }
  let raw: string | null;
  try {
    raw = await exCtx.ui.input(SENTINEL_CUA, JSON.stringify(payload));
  } catch (err) {
    return { ok: false, error: `host tunnel failed: ${errMsg(err)}` };
  }
  if (raw === null) return { ok: false, error: "host tunnel returned no reply" };
  try {
    return JSON.parse(raw) as CuaReply;
  } catch {
    return { ok: false, error: `unparseable helper reply: ${raw.slice(0, 200)}` };
  }
}

/**
 * Best-effort live step emit (Contract A). Never throws out of here: a failed
 * watch update must not break the actual action. For computer use we omit the
 * screenshot — Rust attaches one when it forwards the step to the UI.
 */
async function emitStep(
  exCtx: ExtensionContext,
  step: {
    surface: "browser" | "computer";
    action: string;
    observationId?: string;
    highlightedIndex?: number;
    screenshotJpeg?: string;
  },
): Promise<void> {
  try {
    // Null-guard the UI channel (see cua()); the watch stream is best-effort
    // and must never break a tool with a local TypeError.
    if (typeof exCtx?.ui?.input !== "function") return;
    await exCtx.ui.input(SENTINEL_STEP, JSON.stringify(step));
  } catch {
    /* watch stream is best-effort; ignore */
  }
}

/**
 * Render an element list into the compact numbered text the model reads.
 * Each line: `[7] AXButton "Send" (enabled)`. Field values and focus state are
 * appended when present. The header carries the app name + observation_id and a
 * reminder that indices are observation-scoped.
 */
function formatObservation(reply: CuaReply): string {
  const app = reply.app ?? "frontmost app";
  const obs = reply.observationId ?? "(unknown)";
  const lines: string[] = [];
  lines.push(`App: ${app}  observation_id: ${obs}`);
  if (reply.fallback === "ocr") {
    lines.push(
      "NOTE: the Accessibility tree was unavailable for this app (Chromium/" +
        "Electron or AX could not complete), so this is an OCR fallback. " +
        "Index-based actions may be limited; prefer move_click with pixel " +
        "coordinates if no indices are listed.",
    );
  }
  const els = reply.elements ?? [];
  if (els.length === 0) {
    lines.push(
      "(no actionable elements were reported — the app may be empty, blocked, " +
        "or OCR returned nothing; try computer_observe again or a different app.)",
    );
  } else {
    for (const e of els) {
      const flags: string[] = [];
      flags.push(e.enabled ? "enabled" : "disabled");
      if (e.focused) flags.push("focused");
      // Show value for fields/text-bearing elements so the model can read state.
      const valuePart = e.value ? `  = ${JSON.stringify(e.value)}` : "";
      lines.push(`[${e.index}] ${e.role} ${JSON.stringify(e.label)}${valuePart} (${flags.join(", ")})`);
    }
  }
  lines.push(
    "Indices above are valid ONLY for this observation_id. After any action " +
      "that changes the UI, call computer_observe (or rely on the fresh list " +
      "returned by computer_act) before using indices again.",
  );
  return lines.join("\n");
}

/** Find an element by index within a reply's element list. */
function findElement(reply: CuaReply, index?: number): CuaElement | undefined {
  if (index === undefined) return undefined;
  return (reply.elements ?? []).find((e) => e.index === index);
}

/**
 * Decide whether a batch of actions needs an explicit confirmation, and build a
 * concrete human summary. Destructive/sensitive when ANY action is:
 *   - a key combo (op:"key") — these commit/delete/navigate (cmd+s, cmd+delete,
 *     return-to-submit, etc.);
 *   - typing into a field whose label/role suggests a password/secure entry;
 * Otherwise it is "consequential" (mutates the UI) and only needs the one-time
 * per-conversation confirmation. The last observation (when supplied) lets us
 * name the targeted elements in the summary.
 */
function classifyActions(
  actions: CuaAction[],
  lastObs: CuaReply | null,
): { destructive: boolean; summary: string } {
  let destructive = false;
  const parts: string[] = [];
  for (const a of actions) {
    const el = findElement(lastObs ?? { ok: false }, a.index);
    const target =
      el ? `[${a.index}] ${el.role} ${JSON.stringify(el.label)}` : a.index !== undefined ? `[${a.index}]` : "";
    switch (a.op) {
      case "key": {
        destructive = true;
        parts.push(`press key "${a.keys ?? ""}"`);
        break;
      }
      case "type": {
        const looksSecret =
          el !== undefined &&
          /pass(word)?|secret|secure|otp|pin|credential/i.test(`${el.role} ${el.label}`);
        if (looksSecret) destructive = true;
        const shown = looksSecret ? "••••••" : JSON.stringify(a.text ?? "");
        parts.push(`type ${shown} into ${target || "the focused field"}`);
        break;
      }
      case "click": {
        const looksRisky =
          el !== undefined &&
          /send|submit|delete|remove|buy|purchase|pay|confirm|sign\s?in|log\s?in|authoriz|trash/i.test(
            `${el.role} ${el.label}`,
          );
        if (looksRisky) destructive = true;
        parts.push(`click ${target || "an element"}`);
        break;
      }
      case "move_click": {
        parts.push(`click at (${a.x ?? "?"}, ${a.y ?? "?"})`);
        break;
      }
      case "scroll": {
        parts.push(`scroll (${a.dx ?? 0}, ${a.dy ?? 0})${a.index !== undefined ? ` over ${target}` : ""}`);
        break;
      }
      default: {
        parts.push(`unknown action`);
      }
    }
  }
  return { destructive, summary: parts.join("; ") };
}

/**
 * pi requires every tool's execute() to resolve to an AgentToolResult
 * ({ content: [...] }), NOT a bare string. A string leaves result.content
 * undefined; the toolResult is stored with no content, and the next request
 * build crashes in the openai-completions provider ("undefined is not an
 * object (evaluating 'content')") so the agent goes silent. The tool bodies
 * below return strings for readability — normalize every result here.
 */
type ToolTextResult = { content: Array<{ type: "text"; text: string }> };
function asResult(out: unknown): ToolTextResult {
  if (out && typeof out === "object" && Array.isArray((out as { content?: unknown }).content)) {
    return out as ToolTextResult;
  }
  return { content: [{ type: "text", text: typeof out === "string" ? out : String(out ?? "") }] };
}

const ext: Extension = (ctx: ExtensionContext) => {
  // Only register the computer-use tools when the capability is enabled in
  // settings (the host publishes CETUS_COMPUTER_USE=1). Otherwise no-op so a
  // disabled agent never even sees these tools.
  if (process.env.CETUS_COMPUTER_USE !== "1") return;

  // Wrap registration once so every tool's string return is coerced to the
  // { content: [...] } shape pi expects (see asResult above). Tool bodies stay
  // unchanged. Mutating this extension's own context is safe — pi hands each
  // extension its own context object.
  const register = ctx.registerTool.bind(ctx);
  ctx.registerTool = (def: ToolDefinition) =>
    register({
      ...def,
      execute: async (...a: Parameters<ToolDefinition["execute"]>) =>
        asResult(await def.execute(...a)) as unknown as string,
    });

  // -------------------------------------------------------------------------
  // computer_observe — dump the frontmost (or named) app's actionable UI.
  // -------------------------------------------------------------------------
  ctx.registerTool({
    name: "computer_observe",
    description:
      "Observe the macOS frontmost application's UI as a NUMBERED list of " +
      "actionable accessibility elements (buttons, fields, menus, ...). You do " +
      "not see pixels — you act by INDEX. Returns an observation_id; indices are " +
      "valid only for that observation, so re-observe after acting. Optionally " +
      "target a specific app by name or bundle id.",
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "Optional bundle id or app name to inspect (e.g. \"Safari\" or " +
            "\"com.apple.Safari\"). Defaults to the frontmost app.",
        },
        includeOcr: {
          type: "boolean",
          description:
            "If true, allow an OCR fallback when the accessibility tree is " +
            "unavailable (e.g. some Chromium/Electron apps).",
        },
      },
    },
    async execute(_toolCallId: string, args: { app?: string; includeOcr?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ExtensionContext) {
      try {
        const reply = await cua(exCtx, {
          op: "dump",
          app: args.app,
          includeOcr: args.includeOcr,
        });
        if (!reply.ok) {
          if (reply.error === "ax-not-trusted") {
            return (
              "computer_observe failed: Accessibility permission is not granted. " +
              "Ask the user to enable cetus under System Settings > Privacy & " +
              "Security > Accessibility, then try again."
            );
          }
          return `computer_observe failed: ${reply.error ?? "unknown error"}`;
        }
        await emitStep(exCtx, {
          surface: "computer",
          action: `observe ${reply.app ?? "frontmost app"} (${(reply.elements ?? []).length} elements)`,
          observationId: reply.observationId,
        });
        return formatObservation(reply);
      } catch (err) {
        return `computer_observe error: ${errMsg(err)}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // computer_act — apply a batch of actions against a prior observation.
  // -------------------------------------------------------------------------
  ctx.registerTool({
    name: "computer_act",
    description:
      "Act on the macOS frontmost app by INDEX, against a prior observation. " +
      "Pass the observation_id you got from computer_observe and a list of " +
      "actions applied in order (stop at first failure). Supported ops: " +
      "click{index}, type{index,text}, key{keys e.g. \"cmd+s\"}, " +
      "scroll{dx,dy,index?}, move_click{x,y}. Destructive actions (key combos, " +
      "typing secrets) require confirmation. Returns the result plus a FRESH " +
      "observation of the new UI state.",
    parameters: {
      type: "object",
      properties: {
        observationId: {
          type: "string",
          description:
            "The observation_id from the computer_observe whose indices these " +
            "actions reference. Must match the helper's most recent dump.",
        },
        actions: {
          type: "array",
          description: "Actions to apply in order.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["click", "type", "key", "scroll", "move_click"],
              },
              index: { type: "number", description: "Target element index (click/type/scroll)." },
              text: { type: "string", description: "Text to type (op:type)." },
              keys: { type: "string", description: "Key combo, e.g. \"cmd+s\" (op:key)." },
              dx: { type: "number", description: "Horizontal scroll delta (op:scroll)." },
              dy: { type: "number", description: "Vertical scroll delta (op:scroll)." },
              x: { type: "number", description: "Pixel x (op:move_click)." },
              y: { type: "number", description: "Pixel y (op:move_click)." },
            },
            required: ["op"],
          },
        },
      },
      required: ["observationId", "actions"],
    },
    async execute(
      _toolCallId: string,
      args: { observationId: string; actions: CuaAction[] },
      _signal: unknown,
      _onUpdate: unknown,
      exCtx: ExtensionContext,
    ) {
      try {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        if (actions.length === 0) return "computer_act: no actions provided.";

        // Re-dump (cheap) so we can name elements in the confirmation summary
        // and so classification has fresh role/label context. This does not
        // change the index map the helper uses for `act` against the supplied
        // observationId, but it gives us human-readable targets. Failures here
        // are non-fatal; we fall back to bare indices.
        let lastObs: CuaReply | null = null;
        const probe = await cua(exCtx, { op: "verify" });
        if (probe.ok) lastObs = probe;

        const key = convKey(exCtx);
        const { destructive, summary } = classifyActions(actions, lastObs);
        const consequential = true; // any act mutates the UI surface
        const needFirstTimeOk = consequential && !approvedOnce.has(key);

        if (destructive || needFirstTimeOk) {
          const title = destructive
            ? "Confirm action (sensitive)"
            : "Confirm computer control";
          const message =
            (destructive
              ? "This action may send, submit, delete, authenticate or otherwise " +
                "commit a change. Proceed?\n\n"
              : "Allow the agent to control the frontmost app for this task? " +
                "(You will only be asked once per conversation.)\n\n") +
            `Actions: ${summary}`;
          let ok = false;
          try {
            // Null-guard the UI channel (see cua()); without a usable confirm we
            // err on the side of NOT acting rather than throwing a local error.
            if (typeof exCtx?.ui?.confirm !== "function") {
              return "computer_act: confirmation unavailable (no ui.confirm); not acting.";
            }
            ok = (await exCtx.ui.confirm(title, message)) === true;
          } catch (err) {
            return `computer_act: confirmation failed: ${errMsg(err)}`;
          }
          if (!ok) return "User declined the action.";
          // First-time approval is remembered; destructive actions are always
          // re-confirmed regardless, so we only persist the one-time grant.
          if (needFirstTimeOk) approvedOnce.add(key);
        }

        const reply = await cua(exCtx, {
          op: "act",
          observationId: args.observationId,
          actions,
        });

        if (!reply.ok) {
          if (reply.error === "stale-observation") {
            return (
              "computer_act failed: stale observation — the UI changed since " +
              "that observation_id. Call computer_observe again to get a fresh " +
              "list of indices, then retry."
            );
          }
          if (reply.error === "ax-not-trusted") {
            return (
              "computer_act failed: Accessibility permission is not granted. " +
              "Ask the user to enable cetus under System Settings > Privacy & " +
              "Security > Accessibility, then try again."
            );
          }
          return `computer_act failed: ${reply.error ?? "unknown error"}`;
        }

        const resultLine = reply.result ?? "(action applied)";
        await emitStep(exCtx, { surface: "computer", action: resultLine });

        // Return the result AND a fresh observation so the model sees the new
        // state without a separate round trip. Re-use the helper's index map.
        const fresh = await cua(exCtx, { op: "dump" });
        if (fresh.ok) {
          return `Result: ${resultLine}\n\n${formatObservation(fresh)}`;
        }
        return (
          `Result: ${resultLine}\n\n` +
          `(could not re-observe: ${fresh.error ?? "unknown error"}; call ` +
          `computer_observe to get the new state.)`
        );
      } catch (err) {
        return `computer_act error: ${errMsg(err)}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // computer_verify — re-dump current state so the model can check itself.
  // -------------------------------------------------------------------------
  ctx.registerTool({
    name: "computer_verify",
    description:
      "Re-observe the current macOS frontmost app state so you can verify an " +
      "expectation (e.g. that a dialog closed or a field now holds a value). " +
      "Returns the current numbered element list. Pure read — runs without " +
      "confirmation.",
    parameters: {
      type: "object",
      properties: {
        expect: {
          type: "string",
          description:
            "Optional plain-text description of what you expect to see; echoed " +
            "back so you can compare against the current state.",
        },
      },
    },
    async execute(_toolCallId: string, args: { expect?: string }, _signal: unknown, _onUpdate: unknown, exCtx: ExtensionContext) {
      try {
        const reply = await cua(exCtx, { op: "verify", expect: args.expect });
        if (!reply.ok) {
          if (reply.error === "ax-not-trusted") {
            return (
              "computer_verify failed: Accessibility permission is not granted. " +
              "Ask the user to enable cetus under System Settings > Privacy & " +
              "Security > Accessibility, then try again."
            );
          }
          return `computer_verify failed: ${reply.error ?? "unknown error"}`;
        }
        await emitStep(exCtx, {
          surface: "computer",
          action: `verify ${reply.app ?? "frontmost app"}`,
          observationId: reply.observationId,
        });
        const header = args.expect ? `Expected: ${args.expect}\n\n` : "";
        return header + formatObservation(reply);
      } catch (err) {
        return `computer_verify error: ${errMsg(err)}`;
      }
    },
  });
};

export default ext;
