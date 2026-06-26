/**
 * web-search.ts — a pi extension that gives a TEXT-ONLY agent a lightweight web
 * lookup capability via Exa or Tavily, with ZERO npm dependencies (global `fetch`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * cetus's only OTHER internet-capable tools are the heavyweight browser-use
 * tools (`browser_*`), which spin up a managed Chrome over CDP. For plain
 * information lookup — "what's the price of X", "who is the CEO of Y", "find
 * recent news about Z" — driving a real browser is slow, fragile, and overkill.
 * Without this extension the model has no choice: the browser is the *only* web
 * path, so it opens Chrome even for a one-line fact. This tool gives it a cheap
 * text path instead:
 *   - web_search(query) -> ranked results + concise snippets/highlights
 *   - web_fetch(url)    -> readable page text, capped, no browser
 * The agent-control system prompt (see pi_rpc.rs::agent_control_system_prompt)
 * routes read-only lookups here and reserves the browser for genuine
 * interaction (clicking, typing, login, multi-step stateful flows).
 *
 * ---------------------------------------------------------------------------
 * AUTH
 * ---------------------------------------------------------------------------
 * Requires an Exa or Tavily API key for web_search. The host injects keys at
 * spawn time from the keychain (see src-tauri/src/secrets.rs -> load_env).
 * Changing a key respawns pi, so provider selection is re-evaluated.
 */

import { lookup } from "node:dns/promises";

// ============================================================================
// Minimal pi extension types (each .ts extension is loaded independently).
// ============================================================================

/** JSON-Schema-ish tool definition registered via ctx.registerTool. */
interface ToolDefinition {
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	// pi invokes execute() POSITIONALLY: (toolCallId, args, signal, onUpdate, execContext).
	// Keep this signature aligned with pi (see browser-use.ts for the full note).
	execute(
		toolCallId: string,
		args: any,
		signal: unknown,
		onUpdate: unknown,
		exCtx: unknown,
	): Promise<ToolTextResult>;
}

/**
 * pi expects every tool's execute() to resolve to an AgentToolResult
 * ({ content: [...] }) — NOT a bare string. Returning a string leaves
 * result.content === undefined, so the toolResult is stored with no content;
 * the NEXT request build then crashes in the openai-completions provider
 * (`toolMsg.content.filter(...)` on undefined → "undefined is not an object
 * (evaluating 'content')"), the assistant turn ends with stopReason "error",
 * and the agent goes silent. Every string payload must go through asResult().
 * (Matches the shape automation-tools.ts and mcp-bridge.ts already return.)
 */
type ToolTextResult = { content: Array<{ type: "text"; text: string }> };
const asResult = (text: string): ToolTextResult => ({ content: [{ type: "text", text }] });

interface ExtensionContext {
	registerTool(def: ToolDefinition): void;
}

type Extension = (ctx: ExtensionContext) => void;

// ============================================================================
// Constants
// ============================================================================

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"; // web_fetch quality fallback
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

const MIN_USEFUL_TEXT = 200; // below this, a plain fetch is treated as "thin" → fall back

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const SNIPPET_CAP = 500; // per-result snippet, chars
const EXTRACT_CAP = 6000; // web_fetch body, chars — matches browser_extract
const FETCH_BODY_CAP = 2_000_000; // raw HTML read cap before stripping (~2MB)
const REQUEST_TIMEOUT_MS = 20_000;
// Some sites 403 a default fetch UA; present as a normal browser.
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ============================================================================
// Helpers
// ============================================================================

function errStr(prefix: string, e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return `${prefix}: ${msg}`;
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
	const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
	return Math.max(lo, Math.min(hi, v));
}

// ============================================================================
// SSRF guard
// ----------------------------------------------------------------------------
// web_fetch's URL is fully model-controlled, and the model can be steered by
// injected web/page content. Without a guard, a poisoned page could get the
// agent to fetch http://169.254.169.254/… (cloud metadata) or a host on the
// user's LAN (router admin, a Tailscale peer). We block private/loopback/
// link-local/CGNAT/metadata targets, resolve bare hostnames and check every
// resolved IP, and follow redirects MANUALLY so a public URL can't 30x into an
// internal one (the classic redirect TOCTOU). Fail closed on resolve errors.
// (Exa/Tavily extract paths are unaffected — they fetch server-side, so that
// SSRF surface is the provider's, not the user's machine/network.)
// ============================================================================

const MAX_REDIRECTS = 5;
/** Hostnames blocked regardless of how they resolve (cloud metadata aliases). */
const ALWAYS_BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

/** Dotted-quad → 32-bit int, or null if not a clean IPv4 literal. */
function ipv4ToInt(ip: string): number | null {
	const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	let n = 0;
	for (let i = 1; i <= 4; i++) {
		const o = Number(m[i]);
		if (o > 255) return null;
		n = (n << 8) | o;
	}
	return n >>> 0;
}

/** True if an IPv4 literal falls in a range we must never fetch from. */
function isBlockedIpv4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === null) return false;
	const inRange = (base: string, bits: number) => {
		const b = ipv4ToInt(base);
		if (b === null) return false;
		const shift = 32 - bits;
		return n >>> shift === b >>> shift;
	};
	return (
		inRange("0.0.0.0", 8) || // "this" network / unspecified
		inRange("10.0.0.0", 8) || // private
		inRange("100.64.0.0", 10) || // CGNAT
		inRange("127.0.0.0", 8) || // loopback
		inRange("169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
		inRange("172.16.0.0", 12) || // private
		inRange("192.0.0.0", 24) || // IETF protocol assignments
		inRange("192.168.0.0", 16) || // private
		inRange("198.18.0.0", 15) // benchmarking
	);
}

/** True if an IPv6 literal is loopback / unspecified / link-local / ULA, or an
 * IPv4-mapped address whose embedded v4 is itself blocked. */
function isBlockedIpv6(ip: string): boolean {
	const h = ip.toLowerCase().split("%")[0]; // strip zone id
	if (h === "::1" || h === "::") return true;
	if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
	if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
	const mapped = h.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isBlockedIpv4(mapped[1]);
	return false;
}

function ipLiteralKind(host: string): "v4" | "v6" | null {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "v4";
	if (host.includes(":")) return "v6";
	return null;
}

/** Validate that a URL is safe to fetch from the user's machine. */
async function isSafeUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		return { ok: false, reason: `unsupported scheme '${u.protocol}'` };
	}
	const host = u.hostname.toLowerCase();
	if (ALWAYS_BLOCKED_HOSTS.has(host)) return { ok: false, reason: "cloud-metadata host blocked" };
	const kind = ipLiteralKind(host);
	if (kind === "v4") {
		return isBlockedIpv4(host) ? { ok: false, reason: `blocked IP ${host}` } : { ok: true };
	}
	if (kind === "v6") {
		return isBlockedIpv6(host) ? { ok: false, reason: `blocked IP ${host}` } : { ok: true };
	}
	// Bare hostname: resolve and reject if ANY address is in a blocked range.
	try {
		const addrs = await lookup(host, { all: true });
		for (const a of addrs) {
			const blocked = a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address);
			if (blocked) return { ok: false, reason: `${host} resolves to blocked ${a.address}` };
		}
	} catch {
		return { ok: false, reason: `could not resolve ${host}` }; // fail closed
	}
	return { ok: true };
}

/** POST a JSON body to Tavily with bearer auth and a hard timeout. */
async function tavily(url: string, key: string, body: Record<string, unknown>): Promise<any> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			// Tavily returns a JSON { detail } or plain text on error; surface a short slice.
			throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 300)}`);
		}
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

/** POST a JSON body to Exa with x-api-key auth and a hard timeout. */
async function exa(url: string, key: string, body: Record<string, unknown>): Promise<any> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": key },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`Exa HTTP ${res.status}: ${text.slice(0, 300)}`);
		}
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

function resultSnippet(r: any): string {
	if (typeof r?.content === "string" && r.content.trim()) return r.content;
	if (typeof r?.summary === "string" && r.summary.trim()) return r.summary;
	if (Array.isArray(r?.highlights) && r.highlights.length > 0) {
		return r.highlights.map((h: unknown) => String(h).trim()).filter(Boolean).join(" ");
	}
	if (typeof r?.text === "string" && r.text.trim()) return r.text;
	return "";
}

/** A few common HTML entities; enough for readable prose. */
function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Naive HTML → readable text: drop script/style/nav chrome, strip tags. */
function htmlToText(html: string): string {
	const noScript = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(nav|header|footer|aside|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	const spaced = noScript
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(spaced)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.replace(/^[ \t]+|[ \t]+$/gm, "")
		.trim();
}

/** GET a URL with a browser UA and a hard timeout; return raw body (capped).
 * Validates every hop with the SSRF guard and follows redirects MANUALLY, so a
 * public URL can't 30x into a private/metadata target between check and connect. */
async function httpGet(url: string): Promise<{ body: string; contentType: string }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		let current = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const safe = await isSafeUrl(current);
			if (safe.ok === false) throw new Error(`refused by SSRF guard — ${safe.reason}`);
			const res = await fetch(current, {
				redirect: "manual",
				headers: { "User-Agent": BROWSER_UA, Accept: "text/html,*/*" },
				signal: ctrl.signal,
			});
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (!loc) throw new Error(`HTTP ${res.status} with no Location header`);
				current = new URL(loc, current).toString(); // resolve relative redirects
				continue;
			}
			const contentType = res.headers.get("content-type") || "";
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const raw = await res.text();
			return { body: raw.slice(0, FETCH_BODY_CAP), contentType };
		}
		throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
	} finally {
		clearTimeout(timer);
	}
}

// ============================================================================
// Extension entry point — register web_search + web_fetch.
// ============================================================================

const ext: Extension = (ctx: ExtensionContext) => {
	const tavilyKey = process.env.TAVILY_API_KEY;
	const exaKey = process.env.EXA_API_KEY;
	// Register UNCONDITIONALLY so the tools are always discoverable. Gating
	// registration on the key meant that without a key the tool silently did not
	// exist — indistinguishable from "the extension failed to load". Instead,
	// when the key is absent, execute() returns this actionable message.
	const NO_KEY =
		'web_search needs an Exa or Tavily API key. Add one in cetus Settings → ' +
		'API Keys (provider "exa" or "tavily"); the agent restarts and the tools activate.';

	// --------------------------------------------------------------- search
	ctx.registerTool({
		name: "web_search",
		description:
			"Search the web and get ranked results plus a synthesized answer. " +
			"Use this for ANY information lookup — current facts, prices, news, " +
			"who/what/when questions, research — INSTEAD of opening a browser. " +
			"Fast, text-only, no page interaction. Returns a short answer (when " +
			"available) and a numbered list of results (title, URL, snippet).",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The search query." },
				count: { type: "number", description: `How many results to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).` },
			},
			required: ["query"],
		},
		async execute(_toolCallId, args: { query?: string; count?: number }): Promise<ToolTextResult> {
			const run = async (): Promise<string> => {
				if (!exaKey && !tavilyKey) return NO_KEY;
				const query = (args?.query ?? "").trim();
				if (!query) return "web_search error: 'query' is required.";
				const count = clamp(args?.count, 1, MAX_COUNT, DEFAULT_COUNT);
				let exaErr = "";
				if (exaKey) {
					try {
						const data = await exa(EXA_SEARCH_URL, exaKey, {
							query,
							type: "auto",
							numResults: count,
							contents: { highlights: true },
						});
						const results: any[] = Array.isArray(data?.results) ? data.results : [];
						const output = typeof data?.output?.content === "string" ? data.output.content.trim() : "";
						if (!results.length && !output) return `No results for "${query}".`;

						const parts: string[] = [];
						if (output) parts.push(`Answer: ${output}`, "");
						parts.push(`Results for "${query}" (via Exa):`);
						results.forEach((r, i) => {
							const title = String(r?.title || "(untitled)").trim();
							const url = String(r?.url || "");
							const published = typeof r?.publishedDate === "string" ? `\nPublished: ${r.publishedDate}` : "";
							const snippet = resultSnippet(r).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CAP);
							parts.push(`\n[${i + 1}] ${title}\n${url}${published}${snippet ? `\n${snippet}` : ""}`);
						});
						return parts.join("\n");
					} catch (e) {
						if (!tavilyKey) return errStr("web_search failed", e);
						exaErr = e instanceof Error ? e.message : String(e);
					}
				}

				try {
					const data = await tavily(TAVILY_SEARCH_URL, tavilyKey!, {
						query,
						max_results: count,
						search_depth: "basic",
						include_answer: true,
					});
					const results: any[] = Array.isArray(data?.results) ? data.results : [];
					const answer: string = typeof data?.answer === "string" ? data.answer.trim() : "";
					if (!results.length && !answer) return `No results for "${query}".`;

					const parts: string[] = [];
					if (exaErr) parts.push(`Note: Exa failed (${exaErr.slice(0, 200)}); fell back to Tavily.`, "");
					if (answer) parts.push(`Answer: ${answer}`, "");
					parts.push(`Results for "${query}" (via Tavily):`);
					results.forEach((r, i) => {
						const title = String(r?.title || "(untitled)").trim();
						const url = String(r?.url || "");
						const snippet = resultSnippet(r)
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, SNIPPET_CAP);
						parts.push(`\n[${i + 1}] ${title}\n${url}${snippet ? `\n${snippet}` : ""}`);
					});
					return parts.join("\n");
				} catch (e) {
					return errStr("web_search failed", e);
				}
			};
			return asResult(await run());
		},
	} as ToolDefinition);

	// ---------------------------------------------------------------- fetch
	ctx.registerTool({
		name: "web_fetch",
		description:
			"Fetch a single web page and return its main text content (capped to " +
			`~${EXTRACT_CAP} characters). No API key required. Use this to READ an ` +
			"article or a specific URL's content without opening a browser. For pages " +
			"that need interaction (clicking, forms, login, multi-step flows), use the " +
			"browser_* tools instead.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute URL of the page to read." },
			},
			required: ["url"],
		},
		// Strategy: try a plain (free, keyless) HTTP GET + HTML→text first. Only
		// when that fails or yields too little text (JS-rendered SPA, soft block,
		// non-HTML) do we fall back to Exa/Tavily extraction — and only if
		// configured. This keeps the common case key-free and fast.
		async execute(_toolCallId, args: { url?: string }): Promise<ToolTextResult> {
			const run = async (): Promise<string> => {
				const url = (args?.url ?? "").trim();
				if (!url) return "web_fetch error: 'url' is required.";

				let plainText = "";
				let plainErr = "";
				try {
					const { body, contentType } = await httpGet(url);
					plainText = /html/i.test(contentType) ? htmlToText(body) : body.trim();
				} catch (e) {
					plainErr = e instanceof Error ? e.message : String(e);
				}

				if (plainText.length >= MIN_USEFUL_TEXT) {
					return `Fetched ${url}:\n\n${plainText.slice(0, EXTRACT_CAP)}`;
				}

				// Plain fetch was thin or failed — try Exa/Tavily extract if configured.
				if (exaKey) {
					try {
						const data = await exa(EXA_CONTENTS_URL, exaKey, {
							urls: [url],
							text: { maxCharacters: EXTRACT_CAP },
						});
						const results: any[] = Array.isArray(data?.results) ? data.results : [];
						const status = Array.isArray(data?.statuses) ? data.statuses[0] : null;
						const raw = resultSnippet(results[0]);
						if (raw) return `Fetched ${url} (via Exa):\n\n${String(raw).slice(0, EXTRACT_CAP)}`;
						if (status?.status === "error") {
							const tag = status?.error?.tag ? ` — ${status.error.tag}` : "";
							plainErr = plainErr || `Exa could not extract content${tag}`;
						}
					} catch (e) {
						plainErr = plainErr || (e instanceof Error ? e.message : String(e));
					}
				}

				if (tavilyKey) {
					try {
						const data = await tavily(TAVILY_EXTRACT_URL, tavilyKey, { urls: [url] });
						const results: any[] = Array.isArray(data?.results) ? data.results : [];
						const raw = results[0]?.raw_content ?? results[0]?.content;
						if (raw) return `Fetched ${url} (via Tavily):\n\n${String(raw).slice(0, EXTRACT_CAP)}`;
					} catch (e) {
						plainErr = plainErr || (e instanceof Error ? e.message : String(e));
					}
				}

				// Last resort: return whatever thin text we got, or a clear error.
				if (plainText) return `Fetched ${url} (thin content):\n\n${plainText.slice(0, EXTRACT_CAP)}`;
				const hint = exaKey || tavilyKey ? "" : " (no Exa/Tavily key configured for a richer fallback)";
				return `web_fetch: could not read ${url}${plainErr ? ` — ${plainErr}` : ""}${hint}.`;
			};
			return asResult(await run());
		},
	} as ToolDefinition);
};

export default ext;
