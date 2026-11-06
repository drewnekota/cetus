/**
 * Small Browser Use bridge for the visible Cetus Browser surface.
 *
 * The existing browser-use core tools drive a managed Chrome/CDP session. This
 * extension adds one host-tunneled tool that opens or updates the right-side
 * in-app Browser the user can see and annotate, matching the Codex-style
 * visible surface without stealing OS focus from the user's current app.
 */

interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  execute(
    toolCallId: string,
    args: any,
    signal: unknown,
    onUpdate: unknown,
    exCtx: ExtensionContext,
  ): Promise<unknown>;
}

interface ExtensionContext {
  registerTool(def: ToolDefinition): void;
  ui: {
    input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | null>;
  };
}

type Extension = (ctx: ExtensionContext) => void;
type ToolTextResult = { content: Array<{ type: "text"; text: string }> };

const SENTINEL_BROWSER = "__cetus_browser_request__";
const SENTINEL_STEP = "__cetus_agent_step__";

function asResult(out: unknown): ToolTextResult {
  if (out && typeof out === "object" && Array.isArray((out as { content?: unknown }).content)) {
    return out as ToolTextResult;
  }
  return { content: [{ type: "text", text: typeof out === "string" ? out : String(out ?? "") }] };
}

async function hostRequest(exCtx: ExtensionContext, payload: unknown): Promise<any> {
  if (typeof exCtx?.ui?.input !== "function") {
    return { ok: false, error: "host tunnel unavailable (no ui.input)" };
  }
  const raw = await exCtx.ui.input(SENTINEL_BROWSER, JSON.stringify(payload));
  if (raw === null) return { ok: false, error: "host tunnel returned no reply" };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: `unparseable host reply: ${raw.slice(0, 200)}` };
  }
}

async function emitStep(exCtx: ExtensionContext, action: string): Promise<void> {
  try {
    await exCtx.ui.input(
      SENTINEL_STEP,
      JSON.stringify({ surface: "browser", action }),
      { timeout: 1000 },
    );
  } catch {
    // Watch updates are best-effort and must not fail the actual tool.
  }
}

const extension: Extension = (ctx) => {
  const register = ctx.registerTool.bind(ctx);
  ctx.registerTool = (def: ToolDefinition) =>
    register({
      ...def,
      execute: async (...a: Parameters<ToolDefinition["execute"]>) => asResult(await def.execute(...a)),
    });

  ctx.registerTool({
    name: "browser_open_visible",
    description:
      "Open or update a URL in the visible right-side Cetus Browser tab so the user can inspect and annotate it. Do not use this to steal OS focus from the user's current app.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "URL to open. Supports http(s), localhost, about:blank, and file:// URLs.",
        },
      },
      required: ["url"],
    },
    async execute(_toolCallId, args, _signal, _onUpdate, exCtx) {
      const url = typeof args?.url === "string" ? args.url.trim() : "";
      if (!url) return "browser_open_visible failed: missing url";
      const reply = await hostRequest(exCtx, { op: "open", url });
      if (!reply?.ok) {
        return `browser_open_visible failed: ${reply?.error || "unknown error"}`;
      }
      await emitStep(exCtx, `opened visible Browser: ${url}`);
      return `Opened ${url} in the visible Cetus Browser.`;
    },
  });
};

export default extension;
