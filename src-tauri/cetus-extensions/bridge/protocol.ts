export const HOST_TUNNELS = {
  ultraAgent: "__cetus_ultra_agent__",
  agentStep: "__cetus_agent_step__",
  cuaRequest: "__cetus_cua_request__",
  browserRequest: "__cetus_browser_request__",
  automation: "__cetus_automation__",
  mcp: "__cetus_mcp__",
  skill: "__cetus_skill__",
} as const;

export type HostTunnelTitle = (typeof HOST_TUNNELS)[keyof typeof HOST_TUNNELS];

export interface HostTunnelUi {
  input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | null>;
}

export interface HostTunnelContext {
  ui?: HostTunnelUi;
}

export interface HostReply {
  ok: boolean;
  error?: string;
  note?: string;
  [key: string]: unknown;
}

export async function callHost<T extends HostReply = HostReply>(
  exCtx: HostTunnelContext,
  title: HostTunnelTitle,
  payload: unknown,
  opts?: { timeout?: number },
): Promise<T> {
  if (typeof exCtx?.ui?.input !== "function") {
    return { ok: false, error: "host tunnel unavailable (no ui.input)" } as T;
  }

  let raw: string | null;
  try {
    raw = await exCtx.ui.input(title, JSON.stringify(payload), opts);
  } catch (err) {
    return { ok: false, error: `host tunnel failed: ${(err as Error).message}` } as T;
  }
  if (raw === null) return { ok: false, error: "host tunnel returned no reply" } as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return { ok: false, error: `unparseable host reply: ${raw.slice(0, 200)}` } as T;
  }
}

export function toolResult(reply: HostReply) {
  const text = reply.ok ? JSON.stringify(reply, null, 2) : `error: ${reply.error ?? "unknown error"}`;
  return { content: [{ type: "text" as const, text }] };
}
