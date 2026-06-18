/**
 * cetus MCP bridge — make user-configured MCP servers' tools callable by the agent.
 *
 * pi has no built-in MCP client (by design: see its README, "No MCP… build an
 * extension that adds MCP support"). cetus manages MCP servers in the Connectors
 * settings page (src-tauri/src/mcp.rs) and exports the ENABLED ones to a standard
 * config file — `{ "mcpServers": { … } }` — whose absolute path the host publishes
 * as `CETUS_MCP_CONFIG` (and `MCPORTER_CONFIG`). This extension reads that file via
 * `mcporter` (a small MCP client library), connects to each server, lists its
 * tools, and exposes them to the agent.
 *
 * ---------------------------------------------------------------------------
 * PROGRESSIVE DISCLOSURE
 * ---------------------------------------------------------------------------
 * Registering every connector tool as a first-class `mcp__server__tool` with its
 * full input schema inflates the model's tool list every single turn — with the
 * connector ecosystem (Gmail, Calendar, Notion, Meta Ads, …) that's easily
 * hundreds of schemas, the single largest per-turn token cost. So:
 *   - Few tools (≤ EAGER_IF_FEW)  → register them all directly, as before. Small
 *     setups keep direct, named tools and pay nothing for the machinery.
 *   - Many tools                  → register just three bridge tools — `mcp_search`
 *     (find tools by keyword), `mcp_describe` (get one tool's schema), `mcp_call`
 *     (invoke it) — backed by an in-memory catalog. The model discovers and calls
 *     connector tools on demand instead of carrying every schema every turn.
 *   - EAGER_SERVERS (default chrome-devtools) are ALWAYS registered directly: the
 *     browser system-prompt references `mcp__chrome-devtools__*` by literal name
 *     and those calls are latency-sensitive, so they must never hide behind a search.
 *
 * Design / safety (this runs inside EVERY pi — every conversation, every Ultra
 * sub-agent, every parallel candidate — so it has to be cheap and unbreakable):
 *   - No config (`CETUS_MCP_CONFIG` unset) or zero servers → a complete no-op.
 *   - Runs in `session_start` (pi AWAITS it) so tools exist before the first turn.
 *   - Each server is connected with a timeout + try/catch — a down/misconfigured
 *     server is skipped with a stderr notice and never breaks the others.
 *   - Tool calls are bounded by a timeout and return an error result, never throw.
 *
 * Tool naming: `mcp__<server>__<tool>` (sanitised + de-duplicated) so MCP tools
 * never collide with pi's built-ins and the source server is obvious.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntime, type Runtime, type ServerToolInfo } from "mcporter";

/** Absolute path to the exported `{ mcpServers }` config (set by the host). */
const CONFIG_PATH = process.env.CETUS_MCP_CONFIG?.trim() || process.env.MCPORTER_CONFIG?.trim();
/** Per-server connect + tools/list budget. A cold `npx`/`uvx` server downloads on
 *  first run, so this is generous; a server slower than this is skipped, not fatal. */
const LIST_TIMEOUT_MS = 30_000;
/** Per tool-call budget. */
const CALL_TIMEOUT_MS = 120_000;
/** Cap on any OAuth callback wait. mcporter defaults to 5 minutes; if the model
 *  invokes a connector whose token expired, `callTool` would otherwise hang the
 *  turn that long waiting on a browser approval. Bound it so an expired connector
 *  fails fast instead (the explicit Authorize button is the real auth path). */
const OAUTH_WAIT_TIMEOUT_MS = 8_000;
/** Servers whose tools stay EAGERLY registered as `mcp__server__tool`, even when
 *  progressive disclosure kicks in. chrome-devtools is referenced by literal name
 *  in cetus's browser system-prompt and is latency-sensitive. Override (or clear)
 *  with CETUS_MCP_EAGER (comma-separated server names). */
const EAGER_SERVERS = new Set(
  (process.env.CETUS_MCP_EAGER ?? "chrome-devtools")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
/** At or below this many bridgeable (non-eager) tools, just register them all
 *  directly — progressive disclosure only earns its keep past a handful. */
const EAGER_IF_FEW = 8;
/** Cap on how many matches `mcp_search` returns, so discovery can't itself blow up. */
const SEARCH_LIMIT = 40;

/** One catalogued MCP tool. */
interface CatalogEntry {
  fqName: string; // mcp__server__tool (sanitised, unique)
  server: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

export default function mcpBridge(pi: ExtensionAPI) {
  if (!CONFIG_PATH) return; // no config → nothing to bridge

  let runtime: Runtime | null = null;
  const getRuntime = async (): Promise<Runtime> => {
    if (!runtime) {
      runtime = await createRuntime({
        configPath: CONFIG_PATH,
        clientInfo: { name: "cetus", version: "0.1.0" },
        // Bound any OAuth callback wait so an expired connector can't hang a
        // turn for mcporter's 5-minute default (see OAUTH_WAIT_TIMEOUT_MS).
        oauthTimeoutMs: OAUTH_WAIT_TIMEOUT_MS,
      });
    }
    return runtime;
  };

  pi.on("session_start", async (_event: unknown, _ctx: any) => {
    let rt: Runtime;
    let servers: string[];
    try {
      rt = await getRuntime();
      servers = rt.listServers();
    } catch {
      return; // config missing / unparseable → treat as "no MCP configured"
    }
    if (servers.length === 0) return;

    // --- Build the catalog (one entry per tool, names de-duplicated) ---------
    // Collect every (server, tool) pair first, then sort by (server, toolName)
    // BEFORE assigning fq-names. Promise.all settles in network-resolution order,
    // which varies run-to-run; this catalog feeds the tool list at position 0 of
    // every DeepSeek request, and uniqueName()'s de-dup suffixes depend on
    // encounter order — so without a deterministic sort the SAME connector set
    // yields a different tool prefix (and different colliding-tool names) across
    // spawns, defeating the prompt cache. Comparison is by UTF-16 code unit
    // (locale-independent), not localeCompare.
    const collected: { server: string; tool: ServerToolInfo }[] = [];
    await Promise.all(
      servers.map(async (server) => {
        let tools: ServerToolInfo[];
        try {
          tools = await listServerTools(rt, server);
        } catch (err) {
          // A down / misconfigured / un-authorised server (e.g. an OAuth-gated
          // remote needing sign-in) is expected and non-fatal: its tools simply
          // don't get catalogued. Log to stderr for diagnosis, but DON'T fire a
          // UI toast — session_start runs in every pi (main conversation AND
          // every Ultra sub-agent / parallel candidate), so a single bad server
          // would otherwise spam a burst of identical warning toasts on each turn.
          console.warn(`[cetus mcp-bridge] server "${server}" unavailable: ${errMsg(err)}`);
          return;
        }
        for (const tool of tools) collected.push({ server, tool });
      }),
    );
    if (collected.length === 0) return;
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    collected.sort((a, b) => cmp(a.server, b.server) || cmp(a.tool.name, b.tool.name));
    const taken = new Set<string>();
    const catalog: CatalogEntry[] = collected.map(({ server, tool }) => ({
      fqName: uniqueName(`mcp__${server}__${tool.name}`, taken),
      server,
      toolName: tool.name,
      description: tool.description?.trim() || "",
      inputSchema: tool.inputSchema,
    }));

    // --- Decide eager vs. progressive ---------------------------------------
    const bridged = catalog.filter((e) => !EAGER_SERVERS.has(e.server));
    const eager = catalog.filter((e) => EAGER_SERVERS.has(e.server));
    const useBridge = bridged.length > EAGER_IF_FEW;

    // EAGER_SERVERS' tools are always direct. When not bridging, everything is direct.
    for (const e of useBridge ? eager : catalog) registerConcrete(pi, rt, e);

    if (!useBridge) return;

    // --- Progressive disclosure: three bridge tools over the catalog ---------
    // mcp_call/mcp_describe resolve against the FULL catalog (so any tool name
    // works), while mcp_search surfaces only the bridged tools the model can't
    // already see as direct tools.
    const byName = new Map<string, CatalogEntry>(catalog.map((e) => [e.fqName, e]));
    const resolve = (name: string): CatalogEntry | undefined => {
      const want = String(name || "").trim();
      if (byName.has(want)) return byName.get(want);
      // Tolerate a bare tool name when it's unambiguous across servers.
      const hits = catalog.filter((e) => e.toolName === want);
      return hits.length === 1 ? hits[0] : undefined;
    };

    const serverNames = [...new Set(bridged.map((e) => e.server))].sort(cmp);

    pi.registerTool({
      name: "mcp_search",
      label: "MCP: search tools",
      description:
        "Discover external connector (MCP) tools by keyword. cetus has many " +
        "connector tools that are NOT listed individually to save context. " +
        "Search here first to find the right tool, then `mcp_describe` it for its " +
        "parameters, then run it with `mcp_call`. Returns matching tool names + " +
        "one-line descriptions.",
      promptSnippet:
        `${bridged.length} external connector tools (servers: ${serverNames.join(", ")}) ` +
        `are available via mcp_search → mcp_describe → mcp_call.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to match against tool names/descriptions. Omit to list all." },
          server: { type: "string", description: `Optional: restrict to one server (${serverNames.join(", ")}).` },
        },
      },
      async execute(_id: string, params: unknown) {
        const p = (params ?? {}) as { query?: string; server?: string };
        return asText(searchCatalog(bridged, p.query, p.server));
      },
    });

    pi.registerTool({
      name: "mcp_describe",
      label: "MCP: describe tool",
      description:
        "Get the full input-parameter schema for one external connector (MCP) tool " +
        "(name from mcp_search). Call this before mcp_call so you pass the right args.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The tool name, e.g. mcp__gmail__send_email." } },
        required: ["name"],
      },
      async execute(_id: string, params: unknown) {
        const name = ((params ?? {}) as { name?: string }).name ?? "";
        const e = resolve(name);
        if (!e) return asText(`Unknown MCP tool "${name}". Use mcp_search to find the exact name.`);
        const schema = JSON.stringify(normalizeSchema(e.inputSchema), null, 2);
        return asText(
          `${e.fqName} (server: ${e.server})\n` +
            `${e.description || "(no description)"}\n\nParameters (JSON Schema):\n${schema}\n\n` +
            `Call it with: mcp_call({ "name": "${e.fqName}", "args": { … } })`,
        );
      },
    });

    pi.registerTool({
      name: "mcp_call",
      label: "MCP: call tool",
      description:
        "Invoke an external connector (MCP) tool by name (from mcp_search/mcp_describe), " +
        "passing its arguments. This is how you actually run connector actions " +
        "(send an email, query a CRM, etc.).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The tool name, e.g. mcp__gmail__send_email." },
          args: { type: "object", description: "Arguments object matching the tool's schema (see mcp_describe)." },
        },
        required: ["name"],
      },
      async execute(_id: string, params: unknown) {
        const p = (params ?? {}) as { name?: string; args?: unknown };
        const e = resolve(p.name ?? "");
        if (!e) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown MCP tool "${p.name ?? ""}". Use mcp_search to find the exact name.`,
              },
            ],
            isError: true,
          };
        }
        const args = p.args && typeof p.args === "object" ? (p.args as Record<string, unknown>) : {};
        return callMcp(rt, e, args);
      },
    });
  });
}

// ---- helpers ---------------------------------------------------------------

/** Register one catalogued tool as a first-class pi tool proxying to its server. */
function registerConcrete(pi: ExtensionAPI, rt: Runtime, e: CatalogEntry) {
  try {
    pi.registerTool({
      name: e.fqName,
      label: `${e.server}: ${e.toolName}`,
      description: e.description || `MCP tool "${e.toolName}" from "${e.server}".`,
      parameters: normalizeSchema(e.inputSchema),
      async execute(_toolCallId: string, params: unknown) {
        return callMcp(rt, e, (params ?? {}) as Record<string, unknown>);
      },
    });
  } catch (err) {
    // A single bad tool (odd schema, name clash pi rejects) must not sink the
    // rest. Log only — per-spawn UI toasts would be too noisy (see session_start).
    console.warn(`[cetus mcp-bridge] tool "${e.server}.${e.toolName}" skipped: ${errMsg(err)}`);
  }
}

/** Invoke an MCP tool, bounded by a timeout, returning an error result on failure. */
async function callMcp(rt: Runtime, e: CatalogEntry, args: Record<string, unknown>): Promise<any> {
  try {
    const raw = await withTimeout(
      rt.callTool(e.server, e.toolName, { args, timeoutMs: CALL_TIMEOUT_MS }),
      CALL_TIMEOUT_MS + 5_000,
      `call ${e.server}.${e.toolName}`,
    );
    return toToolResult(raw);
  } catch (err) {
    return { content: [{ type: "text", text: `MCP tool failed: ${errMsg(err)}` }], isError: true };
  }
}

/** Rank catalog entries against a query (token-overlap; empty query lists all). */
function searchCatalog(entries: CatalogEntry[], query?: string, server?: string): string {
  let pool = entries;
  if (server && server.trim()) {
    const s = server.trim();
    pool = pool.filter((e) => e.server === s);
  }
  const q = (query ?? "").toLowerCase().trim();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const scored = pool
    .map((e) => {
      const hay = `${e.fqName} ${e.description}`.toLowerCase();
      const score = tokens.length ? tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0) : 1;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.fqName.localeCompare(b.e.fqName));

  if (scored.length === 0) {
    return q ? `No MCP tools match "${query}". Try mcp_search with no query to list all.` : "No MCP tools available.";
  }
  const shown = scored.slice(0, SEARCH_LIMIT);
  const lines = shown.map(({ e }) => `- ${e.fqName} — ${e.description || "(no description)"}`);
  const more = scored.length > shown.length ? `\n…and ${scored.length - shown.length} more — narrow your query.` : "";
  return (
    `${scored.length} matching MCP tool(s). Use mcp_describe(name) then mcp_call(name, args):\n` +
    lines.join("\n") +
    more
  );
}

const asText = (text: string): any => ({ content: [{ type: "text", text }] });

/** Sanitise to pi's tool-name charset and de-duplicate within a session. */
function uniqueName(base: string, seen: Set<string>): string {
  const name = base.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60) || "mcp_tool";
  let candidate = name;
  let n = 2;
  while (seen.has(candidate)) candidate = `${name}_${n++}`;
  seen.add(candidate);
  return candidate;
}

/** pi wants an object JSON-Schema for `parameters`. MCP gives draft-07 JSON
 *  Schema; pass it through but guarantee it's an object schema and drop the
 *  `$schema` marker (some validators choke on it). */
function normalizeSchema(schema: unknown): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const s: any = { ...(schema as Record<string, unknown>) };
  delete s.$schema;
  if (s.type !== "object") return { type: "object", properties: {} };
  if (typeof s.properties !== "object" || s.properties === null) s.properties = {};
  return s;
}

/** Map an MCP CallToolResult into a pi tool result. MCP content blocks line up
 *  with pi's (`text`, `image`); anything else is shown as fenced JSON. */
function toToolResult(raw: unknown): any {
  const r = (raw ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(r.content) ? r.content : [];
  const content = blocks.map((b: any) => {
    if (b && b.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b && b.type === "image") return { type: "image", data: b.data, mimeType: b.mimeType };
    return { type: "text", text: "```json\n" + safeJson(b) + "\n```" };
  });
  if (content.length === 0) {
    content.push({ type: "text", text: safeJson(r.structuredContent ?? r) });
  }
  return { content, isError: r.isError === true, details: r };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List a server's tools without ever opening a browser and WITHOUT disturbing
 *  cached credentials.
 *
 *  `autoAuthorize: false` attaches no OAuth provider: a valid cached token
 *  connects, while an un-authorized OR expired-token server fails fast and
 *  non-destructively (session_start runs in every pi + sub-agent, so it can't
 *  block on a browser redirect). We deliberately do NOT retry with
 *  `autoAuthorize: true` to refresh: in this mcporter version a failed connect
 *  there falls through to a fresh authorization that CLEARS the stored tokens —
 *  turning an expired-but-refreshable session into a full re-auth. Recovery is
 *  the explicit Authorize button instead. */
async function listServerTools(rt: Runtime, server: string): Promise<ServerToolInfo[]> {
  return await withTimeout(
    rt.listTools(server, { includeSchema: true, autoAuthorize: false }),
    LIST_TIMEOUT_MS,
    `connect to MCP server "${server}"`,
  );
}

/** Race a promise against a timeout so a hung server/call can't block forever. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms trying to ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
