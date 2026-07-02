/**
 * browser-use.ts — a pi extension that gives a TEXT-ONLY agent a real
 * browser-use capability, driven entirely over the raw Chrome DevTools
 * Protocol (CDP) with ZERO npm dependencies.
 *
 * ---------------------------------------------------------------------------
 * WHY RAW CDP / ZERO-DEP
 * ---------------------------------------------------------------------------
 * pi ships as a single Bun-compiled binary and loads extensions as plain .ts
 * files via `--extension`. We cannot add npm packages (no puppeteer, no
 * playwright, no `ws`). Fortunately the Bun runtime gives us everything we
 * need as globals:
 *   - global `fetch`     -> talk to Chrome's HTTP endpoint (/json/version,
 *                           /json/list) to discover the WebSocket debugger URL.
 *   - global `WebSocket` -> speak CDP directly (a JSON-RPC-ish protocol).
 *   - node:child_process -> launch a managed Chrome with a dedicated profile
 *                           and `--remote-debugging-port=9222`.
 *   - node:fs / os / path-> resolve the profile directory under the cetus app
 *                           support folder.
 * Everything in this file is built on top of those primitives. The CdpClient
 * class below is a ~200-line hand-rolled CDP client: it multiplexes request
 * ids, awaits responses, fans events out to listeners, and uses CDP "flatten"
 * mode so a single browser-level socket can drive many per-target sessions
 * via a `sessionId` on every message.
 *
 * ---------------------------------------------------------------------------
 * WHY TEXT-ONLY / INDEX-BASED
 * ---------------------------------------------------------------------------
 * The agent driving this extension has no vision — it only reads strings. So
 * instead of pixels we hand it a compact, numbered list of the *interactive*
 * DOM elements on the page:
 *
 *     [3]<button> "Save"
 *     [5]<input type=text name="Email">
 *     [9]<a> "Pricing"
 *
 * Each index is stamped onto the live DOM node as `data-cetus-index="N"` by an
 * injected walker (buildDomTree). The agent then acts purely by index
 * ("click [3]", "type 'foo' into [5]"). Indices are only valid for the most
 * recent observation, so every mutating tool re-resolves the element by its
 * `data-cetus-index` attribute immediately before acting, and returns a fresh
 * observation afterward so the agent always has current indices.
 *
 * The injected walker descends into SAME-ORIGIN iframes and OPEN shadow roots
 * (best-effort), computes visibility from getBoundingClientRect + computed
 * style, and derives an accessible name. No @mozilla/readability and no other
 * library — text extraction is a light innerText heuristic, also zero-dep.
 *
 * ---------------------------------------------------------------------------
 * HOST INTEGRATION (cetus)
 * ---------------------------------------------------------------------------
 * Two side-channels piggyback on `exCtx.ui.input` whose *title* is a sentinel
 * string, which the Rust host routes to native handlers instead of showing a
 * dialog:
 *   - "__cetus_agent_step__"  (Contract A): after every meaningful action we
 *     emit a "watch" step — a human summary + optional JPEG screenshot — so
 *     the UI can render a live activity feed of what the agent is doing. This
 *     is best-effort and must NEVER throw out of the tool.
 *   - exCtx.ui.confirm (Contract policy): destructive/sensitive actions
 *     (submitting forms, navigating to a NEW host, pressing Enter to submit,
 *     etc.) always ask for confirmation with a concrete summary. The first
 *     consequential action of a conversation is confirmed once, then
 *     remembered in a module-level Set so the user is not nagged. Pure reads
 *     (observe / extract / scroll / plain click) auto-run.
 *
 * One CDP connection + page sessionId is held per conversation in a module
 * Map, created lazily and torn down on browser_close. Every tool is wrapped in
 * try/catch and returns a *useful* error string instead of throwing — the
 * agent is expected to read the error and recover (usually by re-observing).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { errMsg } from "./bridge/protocol";

// ----------------------------------------------------------------------------
// pi extension types.
//
// The pi runtime provides these via the "pi-ai" module at load time (the
// package on disk is @earendil-works/pi-ai). To keep this file self-contained
// and zero-dep — and to compile cleanly regardless of which package name the
// build resolves — we declare the exact shapes we use locally. If you prefer
// the real types, swap this block for:  import type { Extension,
// ExtensionContext, ToolDefinition } from "pi-ai";
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
	// exec context — the one that actually carries `ui` and `conversationId` — is
	// the 5th. Declaring a 2-arg `(args, exCtx)` shape (as this file originally
	// did) silently bound `args` to the toolCallId STRING and `exCtx` to the args
	// object (which has no `.ui`), so every `exCtx.ui.*` call threw locally and
	// every `args.*` read was undefined. Keep this signature aligned with pi.
	execute(
		toolCallId: string,
		args: any,
		signal: unknown,
		onUpdate: unknown,
		exCtx: ToolExecContext,
	): Promise<string>;
}

/** The extension registration context. */
interface ExtensionContext {
	registerTool(def: ToolDefinition): void;
}

/** An extension is a function of its registration context. */
type Extension = (ctx: ExtensionContext) => void;

// ============================================================================
// Constants
// ============================================================================

const DEBUG_PORT = 9222;
const VERSION_URL = `http://127.0.0.1:${DEBUG_PORT}/json/version`;
const LIST_URL = `http://127.0.0.1:${DEBUG_PORT}/json/list`;
const PROFILE_DIR = path.join(os.homedir(), "Library/Application Support/cetus/chrome-cdp");

const LAUNCH_POLL_MS = 500;
const LAUNCH_POLL_TRIES = 30; // ~15s total
const NAV_POLL_MS = 250;
const NAV_POLL_TRIES = 40; // ~10s document.readyState poll fallback
const CDP_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_ELEMENTS = 120;
const EXTRACT_CAP = 6000;
const NAME_CAP = 120;

// ============================================================================
// Confirmation policy state (Contract: confirm-once + always-confirm-destructive)
// ============================================================================

/** Conversations that have already approved their first consequential action. */
const approvedOnce = new Set<string>();

/** One live CDP session per conversation (or a singleton when no id exists). */
const sessions = new Map<string, BrowserSession>();

// ============================================================================
// CDP client — a minimal JSON-RPC client over the GLOBAL WebSocket.
// ============================================================================

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
	sessionId?: string;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

class CdpClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private listeners = new Map<string, Set<EventHandler>>();
	private closed = false;

	constructor(private readonly wsUrl: string) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const ws = new WebSocket(this.wsUrl);
			this.ws = ws;
			ws.addEventListener("open", () => {
				settled = true;
				resolve();
			});
			ws.addEventListener("error", (ev: unknown) => {
				if (!settled) {
					settled = true;
					reject(new Error(`CDP websocket error: ${describeWsError(ev)}`));
				}
			});
			ws.addEventListener("close", () => {
				this.closed = true;
				for (const [, p] of this.pending) {
					clearTimeout(p.timer);
					p.reject(new Error("CDP connection closed"));
				}
				this.pending.clear();
			});
			ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));
		});
	}

	private onMessage(ev: MessageEvent): void {
		let msg: CdpMessage;
		try {
			msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
			else p.resolve(msg.result);
			return;
		}
		// Event
		if (msg.method) {
			const set = this.listeners.get(msg.method);
			if (set) {
				for (const fn of set) {
					try {
						fn(msg.params ?? {}, msg.sessionId);
					} catch {
						/* listener errors are non-fatal */
					}
				}
			}
		}
	}

	/** Send a CDP command. When sessionId is provided the command targets that page session (flatten mode). */
	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("CDP connection is not open"));
		}
		const id = this.nextId++;
		const payload: CdpMessage = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP timeout for ${method} (${CDP_TIMEOUT_MS}ms)`));
			}, CDP_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			try {
				this.ws!.send(JSON.stringify(payload));
			} catch (e) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Subscribe to a CDP event. Returns an unsubscribe function. */
	on(method: string, fn: EventHandler): () => void {
		let set = this.listeners.get(method);
		if (!set) {
			set = new Set();
			this.listeners.set(method, set);
		}
		set.add(fn);
		return () => set!.delete(fn);
	}

	/** Wait once for a specific event (optionally scoped to a sessionId), with a timeout fallback. */
	waitFor(method: string, sessionId: string | undefined, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				off();
				resolve();
			}, timeoutMs);
			const off = this.on(method, (_p, sid) => {
				if (sessionId && sid && sid !== sessionId) return;
				clearTimeout(timer);
				off();
				resolve();
			});
		});
	}

	close(): void {
		this.closed = true;
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
	}

	get isOpen(): boolean {
		return !this.closed && !!this.ws && this.ws.readyState === WebSocket.OPEN;
	}
}

function describeWsError(ev: unknown): string {
	if (ev && typeof ev === "object" && "message" in ev) return String((ev as { message: unknown }).message);
	return "connection failed";
}

// ============================================================================
// Browser session — one CDP connection + the attached page sessionId.
// ============================================================================

interface IndexedElement {
	index: number;
	tag: string;
	role: string;
	name: string;
	type: string;
	value: string;
	rect: { x: number; y: number; w: number; h: number };
}

class BrowserSession {
	cdp: CdpClient;
	sessionId: string;
	targetId: string;
	/** The child process if WE launched Chrome (so browser_close can kill it). */
	child: ChildProcess | null = null;
	/** Last observation's elements, by index, for re-validation / step summaries. */
	lastElements: IndexedElement[] = [];
	/** Consecutive browser_scroll calls (reset by any other browser action). Used
	 *  to nudge the agent out of a runaway scroll loop on infinite/AJAX-load pages
	 *  (e.g. quotes.toscrape.com/scroll), where it would otherwise keep scrolling
	 *  to load "everything" and never stop to present results. */
	consecutiveScrolls = 0;
	/** For idle eviction — conversations rarely call browser_close, so sessions
	 *  whose socket sits unused are reaped instead of living forever. */
	lastUsedTs = Date.now();

	constructor(cdp: CdpClient, sessionId: string, targetId: string, child: ChildProcess | null) {
		this.cdp = cdp;
		this.sessionId = sessionId;
		this.targetId = targetId;
		this.child = child;
	}
}

// ============================================================================
// Managed Chrome lifecycle
// ============================================================================

/** GET Chrome's /json/version; returns the parsed object or null if Chrome isn't listening. */
async function fetchVersion(): Promise<{ webSocketDebuggerUrl?: string } | null> {
	try {
		const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return null;
		return (await res.json()) as { webSocketDebuggerUrl?: string };
	} catch {
		return null;
	}
}

/** Ensure a CDP-enabled Chrome is running; launch one with a dedicated profile if needed. Returns the browser-level ws URL + the launched child (if any). */
async function ensureBrowser(): Promise<{ wsUrl: string; child: ChildProcess | null }> {
	let info = await fetchVersion();
	let child: ChildProcess | null = null;

	if (!info?.webSocketDebuggerUrl) {
		// Launch a managed Chrome. `open -na` starts a fresh instance bound to our profile/port.
		child = spawn(
			"open",
			[
				"-na",
				"Google Chrome",
				"--args",
				`--remote-debugging-port=${DEBUG_PORT}`,
				`--user-data-dir=${PROFILE_DIR}`,
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			{ stdio: "ignore", detached: true },
		);
		child.unref?.();

		for (let i = 0; i < LAUNCH_POLL_TRIES; i++) {
			await delay(LAUNCH_POLL_MS);
			info = await fetchVersion();
			if (info?.webSocketDebuggerUrl) break;
		}
		if (!info?.webSocketDebuggerUrl) {
			throw new Error(
				`Launched Chrome but it never exposed a CDP endpoint on :${DEBUG_PORT}. ` +
					`Is Google Chrome installed? Try quitting all Chrome windows and retrying.`,
			);
		}
	}

	return { wsUrl: info.webSocketDebuggerUrl, child };
}

/** Connect to the browser socket, pick/create a page target, attach to it (flatten), and enable the domains we use. */
async function attachSession(convId: string): Promise<BrowserSession> {
	const { wsUrl, child } = await ensureBrowser();
	const cdp = new CdpClient(wsUrl);
	await cdp.connect();

	// Flatten mode: every target's traffic flows over this one socket, tagged by sessionId.
	await cdp.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });

	// Find a page target, or create one.
	const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
	let target = targetInfos.find((t) => t.type === "page");
	if (!target) {
		const created = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		target = { targetId: created.targetId, type: "page", url: "about:blank" };
	}

	const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });

	// Enable the domains we depend on, scoped to this page session.
	await cdp.send("Page.enable", {}, sessionId);
	await cdp.send("Runtime.enable", {}, sessionId);
	await cdp.send("DOM.enable", {}, sessionId);

	const session = new BrowserSession(cdp, sessionId, target.targetId, child);
	sessions.set(convId, session);
	return session;
}

/** Get the live session for this conversation, attaching one if needed (or if the old one died). */
async function getSession(convId: string, forceReattach = false): Promise<BrowserSession> {
	const existing = sessions.get(convId);
	if (existing && existing.cdp.isOpen && !forceReattach) {
		existing.lastUsedTs = Date.now();
		return existing;
	}
	if (existing) {
		// Also covers forceReattach on a live session: close the old socket so it
		// doesn't linger once the map entry is overwritten.
		existing.cdp.close();
		sessions.delete(convId);
	}
	return attachSession(convId);
}

/** Reap sessions whose socket has sat unused — most conversations never call
 *  browser_close, so without this every browser-touching conversation leaks an
 *  open WebSocket for the life of the process. Chrome itself is left running;
 *  the next tool call transparently reattaches. */
const SESSION_IDLE_MS = 30 * 60_000;
const idleSweep = setInterval(() => {
	const cutoff = Date.now() - SESSION_IDLE_MS;
	for (const [convId, session] of sessions) {
		if (session.lastUsedTs < cutoff) {
			session.cdp.close();
			sessions.delete(convId);
		}
	}
}, 5 * 60_000);
(idleSweep as { unref?: () => void }).unref?.();

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Injected DOM walker — builds the indexed, text-only element list.
// Runs in the page via Runtime.evaluate; returns a JSON array. Zero deps.
// ============================================================================

const BUILD_DOM_TREE_JS = `
(() => {
  const NAME_CAP = ${NAME_CAP};
  const out = [];
  let idx = 0;

  const isInteractive = (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (["a","button","input","select","textarea","summary"].includes(tag)) {
      if (tag === "a" && !el.hasAttribute("href")) return false;
      return true;
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (["button","link","checkbox","radio","menuitem","tab","switch","option"].includes(role)) return true;
    if (el.hasAttribute && (el.hasAttribute("onclick") || el.hasAttribute("contenteditable") || el.hasAttribute("tabindex"))) return true;
    // table rows/cells that look clickable
    if ((tag === "tr" || tag === "td" || tag === "th") && el.onclick) return true;
    return false;
  };

  const isVisible = (el) => {
    try {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      // fully offscreen above/left
      if (r.bottom < 0 || r.right < 0) return false;
      const vw = el.ownerDocument.defaultView.innerWidth || 100000;
      const vh = el.ownerDocument.defaultView.innerHeight || 100000;
      if (r.top > vh || r.left > vw) return false;
      return true;
    } catch (e) { return false; }
  };

  const accessibleName = (el) => {
    const pick = (s) => (s || "").replace(/\\s+/g, " ").trim();
    let name = pick(el.getAttribute && el.getAttribute("aria-label"));
    if (!name) name = pick(el.innerText);
    if (!name) name = pick(el.getAttribute && el.getAttribute("placeholder"));
    if (!name) name = pick(el.value);
    if (!name) name = pick(el.getAttribute && el.getAttribute("alt"));
    if (!name) name = pick(el.getAttribute && el.getAttribute("title"));
    return name.slice(0, NAME_CAP);
  };

  const collect = (root, frameOffset) => {
    let nodes;
    try { nodes = root.querySelectorAll("*"); } catch (e) { return; }
    for (const el of nodes) {
      try {
        // open shadow roots
        if (el.shadowRoot) collect(el.shadowRoot, frameOffset);
        if (!isInteractive(el)) continue;
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        el.setAttribute("data-cetus-index", String(idx));
        out.push({
          index: idx,
          tag,
          role: (el.getAttribute && el.getAttribute("role")) || "",
          name: accessibleName(el),
          type: (el.getAttribute && el.getAttribute("type")) || "",
          value: typeof el.value === "string" ? el.value.slice(0, NAME_CAP) : "",
          rect: {
            x: Math.round(r.left + frameOffset.x),
            y: Math.round(r.top + frameOffset.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
        });
        idx++;
      } catch (e) { /* skip bad node */ }
    }
  };

  collect(document, { x: 0, y: 0 });

  // same-origin iframes (best-effort)
  try {
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue; // cross-origin -> null
        const fr = frame.getBoundingClientRect();
        collect(doc, { x: fr.left, y: fr.top });
      } catch (e) { /* cross-origin */ }
    }
  } catch (e) { /* ignore */ }

  return JSON.stringify(out);
})()
`;

/** Run the walker and return the parsed indexed elements (capped to maxElements). */
async function buildDomTree(session: BrowserSession, maxElements: number): Promise<IndexedElement[]> {
	const res = await session.cdp.send<{ result?: { value?: string }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{ expression: BUILD_DOM_TREE_JS, returnByValue: true, awaitPromise: false },
		session.sessionId,
	);
	const raw = res.result?.value;
	if (typeof raw !== "string") return [];
	let parsed: IndexedElement[];
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const capped = parsed.slice(0, maxElements);
	session.lastElements = capped;
	return capped;
}

/** Serialize elements to compact, model-friendly lines: `[3]<button> "Save"`. */
function serializeElements(elements: IndexedElement[]): string {
	if (elements.length === 0) return "(no interactive elements found — try browser_scroll or browser_observe again)";
	const lines: string[] = [];
	for (const el of elements) {
		const attrs: string[] = [];
		if (el.type) attrs.push(`type=${el.type}`);
		const nameAttr = el.tag === "input" || el.tag === "textarea" || el.tag === "select";
		// include a name="" hint for form fields when there's no visible label
		if (nameAttr && el.value && !el.name) attrs.push(`value=${JSON.stringify(el.value.slice(0, 40))}`);
		const attrStr = attrs.length ? " " + attrs.join(" ") : "";
		const label = el.name ? ` ${JSON.stringify(el.name)}` : "";
		lines.push(`[${el.index}]<${el.tag}${attrStr}>${label}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Page helpers (title/url, screenshot, navigation wait, text extraction).
// ============================================================================

async function getPageInfo(session: BrowserSession): Promise<{ title: string; url: string }> {
	try {
		const res = await session.cdp.send<{ result?: { value?: string } }>(
			"Runtime.evaluate",
			{ expression: "JSON.stringify({title:document.title,url:location.href})", returnByValue: true },
			session.sessionId,
		);
		const v = res.result?.value;
		if (typeof v === "string") return JSON.parse(v);
	} catch {
		/* ignore */
	}
	return { title: "", url: "" };
}

async function captureScreenshot(session: BrowserSession): Promise<string | undefined> {
	try {
		const res = await session.cdp.send<{ data?: string }>(
			"Page.captureScreenshot",
			{ format: "jpeg", quality: 60 },
			session.sessionId,
		);
		return res.data || undefined;
	} catch {
		return undefined;
	}
}

/** Wait for the page to finish loading: prefer Page.loadEventFired, fall back to polling readyState. */
async function waitForLoad(session: BrowserSession): Promise<void> {
	const loadPromise = session.cdp.waitFor("Page.loadEventFired", session.sessionId, NAV_POLL_MS * NAV_POLL_TRIES);
	await loadPromise;
	// Belt-and-suspenders: poll readyState in case the load event was missed.
	for (let i = 0; i < NAV_POLL_TRIES; i++) {
		try {
			const res = await session.cdp.send<{ result?: { value?: string } }>(
				"Runtime.evaluate",
				{ expression: "document.readyState", returnByValue: true },
				session.sessionId,
			);
			if (res.result?.value === "complete") return;
		} catch {
			/* ignore transient nav errors */
		}
		await delay(NAV_POLL_MS);
	}
}

const EXTRACT_JS = (cap: number) => `
(() => {
  // Light heuristic: clone body, strip non-content nodes, take innerText.
  try {
    const drop = ["script","style","noscript","nav","header","footer","aside","svg","iframe","form"];
    const clone = document.body.cloneNode(true);
    for (const sel of drop) {
      for (const n of clone.querySelectorAll(sel)) {
        // keep <form> text if it's the bulk of the page? simplest: drop nav-ish chrome only
        if (["script","style","noscript","svg","iframe"].includes(sel)) n.remove();
      }
    }
    let text = (clone.innerText || document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
    return text.slice(0, ${cap});
  } catch (e) {
    return (document.body && document.body.innerText ? document.body.innerText : "").slice(0, ${cap});
  }
})()
`;

async function extractText(session: BrowserSession, cap: number): Promise<string> {
	try {
		const res = await session.cdp.send<{ result?: { value?: string } }>(
			"Runtime.evaluate",
			{ expression: EXTRACT_JS(cap), returnByValue: true },
			session.sessionId,
		);
		return typeof res.result?.value === "string" ? res.result.value : "";
	} catch {
		return "";
	}
}

/** Evaluate arbitrary JS in the page and return the JSON-able value. */
async function evalInPage<T = unknown>(session: BrowserSession, expression: string): Promise<{ value?: T; error?: string }> {
	try {
		const res = await session.cdp.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
			session.sessionId,
		);
		if (res.exceptionDetails) {
			return { error: res.exceptionDetails.exception?.description || res.exceptionDetails.text || "page evaluation error" };
		}
		return { value: res.result?.value };
	} catch (e) {
		return { error: errMsg(e) };
	}
}

// ============================================================================
// Contract A — live "watch" step stream (best-effort; never throws).
// ============================================================================

interface AgentStep {
	surface: "browser" | "computer";
	action: string;
	observationId?: string;
	highlightedIndex?: number;
	screenshotJpeg?: string;
}

async function emitStep(exCtx: ToolExecContext, step: AgentStep): Promise<void> {
	try {
		// Null-guard the UI channel: in some contexts exCtx may lack a usable
		// `ui` (or `ui.input`). Touching it unguarded would throw a local
		// TypeError that the agent loop mis-surfaces; the watch stream is
		// best-effort and must NEVER break a tool.
		if (typeof exCtx?.ui?.input !== "function") return;
		await exCtx.ui.input("__cetus_agent_step__", JSON.stringify(step));
	} catch {
		/* best-effort: the watch stream must never break a tool */
	}
}

/** Convenience: emit a browser step with a screenshot, swallowing all errors. */
async function emitBrowserStep(exCtx: ToolExecContext, session: BrowserSession, action: string, highlightedIndex?: number): Promise<void> {
	const screenshotJpeg = await captureScreenshot(session);
	await emitStep(exCtx, { surface: "browser", action, highlightedIndex, screenshotJpeg });
}

// ============================================================================
// Confirmation policy helpers (Contract policy).
// ============================================================================

/** Ask the user to confirm a destructive action with a concrete summary. Returns true if approved. */
async function confirmDestructive(exCtx: ToolExecContext, summary: string): Promise<boolean> {
	try {
		// Null-guard the UI channel before dereferencing it (see emitStep).
		if (typeof exCtx?.ui?.confirm !== "function") return false;
		return (await exCtx.ui.confirm("Confirm browser action", summary)) === true;
	} catch {
		// If the UI channel is unavailable we err on the side of NOT acting.
		return false;
	}
}

/**
 * Gate a consequential action. Destructive actions ALWAYS confirm. The first
 * consequential (non-read) action of a conversation confirms once even if not
 * destructive, then is remembered. Returns true if the action may proceed.
 */
async function gate(exCtx: ToolExecContext, convId: string, summary: string, destructive: boolean): Promise<boolean> {
	if (destructive) {
		const ok = await confirmDestructive(exCtx, summary);
		if (ok) approvedOnce.add(convId);
		return ok;
	}
	if (approvedOnce.has(convId)) return true;
	const ok = await confirmDestructive(exCtx, summary);
	if (ok) approvedOnce.add(convId);
	return ok;
}

/** True if a URL points at a different host than the current page (=> navigation confirm). */
function isNewHost(currentUrl: string, targetUrl: string): boolean {
	try {
		const cur = currentUrl ? new URL(currentUrl).host : "";
		const next = new URL(targetUrl, currentUrl || undefined).host;
		return !!next && next !== cur;
	} catch {
		return true; // can't parse -> treat as new host (be cautious)
	}
}

// ============================================================================
// Conversation-id resolution.
// ============================================================================

/** Best-effort conversation id from the exec context; falls back to a singleton key. */
function convIdOf(exCtx: ToolExecContext): string {
	return (exCtx?.conversationId as string) || (exCtx?.conversation?.id as string) || "__singleton__";
}

// ============================================================================
// Minimal local typings for the pi exec context (kept loose on purpose).
// ============================================================================

interface ToolExecContext {
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

// ============================================================================
// Result-building helpers.
// ============================================================================

async function observationBlock(session: BrowserSession, maxElements: number, includeText: boolean): Promise<string> {
	const elements = await buildDomTree(session, maxElements);
	const info = await getPageInfo(session);
	const parts = [`Page: ${info.title || "(untitled)"}`, `URL: ${info.url}`, "", "Interactive elements:", serializeElements(elements)];
	if (includeText) {
		const text = await extractText(session, 1500);
		if (text) parts.push("", "Page text (truncated):", text.slice(0, 1500));
	}
	return parts.join("\n");
}

function errStr(prefix: string, e: unknown): string {
	return `${prefix}: ${errMsg(e)}`;
}

// ============================================================================
// Extension entry point — register all tools.
// ============================================================================

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
	// Only register the browser-use tools when the capability is enabled in
	// settings (the host publishes CETUS_BROWSER_USE=1). Otherwise no-op so a
	// disabled agent never even sees these tools.
	if (process.env.CETUS_BROWSER_USE !== "1") return;

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

	// ------------------------------------------------------------------ open
	ctx.registerTool({
		name: "browser_open",
		description:
			"Open / attach the managed Chrome browser and (optionally) navigate to a URL. " +
			"Returns the page title, URL, and a numbered list of interactive elements you can act on by index. " +
			"Always call this before other browser_* tools. Indices are only valid for the most recent observation.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Optional URL to navigate to after attaching." },
				reuseSession: { type: "boolean", description: "Reuse an existing browser session if one is open (default true)." },
			},
			required: [],
		},
		async execute(_toolCallId: string, args: { url?: string; reuseSession?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const reuse = args.reuseSession !== false;
				const session = await getSession(convId, !reuse);

				if (args.url) {
					const info = await getPageInfo(session);
					// Navigating as part of "open" to a brand-new host is consequential.
					if (isNewHost(info.url, args.url)) {
						const ok = await gate(exCtx, convId, `Open and navigate to: ${args.url}`, true);
						if (!ok) return "Cancelled by user: navigation not approved.";
					}
					await session.cdp.send("Page.navigate", { url: args.url }, session.sessionId);
					await waitForLoad(session);
				}

				const block = await observationBlock(session, DEFAULT_MAX_ELEMENTS, false);
				const info = await getPageInfo(session);
				await emitBrowserStep(exCtx, session, args.url ? `open ${args.url}` : `open browser (${info.url || "blank"})`);
				return block;
			} catch (e) {
				return errStr("browser_open failed", e);
			}
		},
	} as ToolDefinition);

	// --------------------------------------------------------------- observe
	ctx.registerTool({
		name: "browser_observe",
		description:
			"Re-scan the current page and return the up-to-date numbered list of interactive elements. " +
			"Call this whenever indices may be stale (after scrolling, navigation, or any page change). " +
			"Optionally include a short snippet of page text.",
		parameters: {
			type: "object",
			properties: {
				maxElements: { type: "number", description: `Cap on elements returned (default ${DEFAULT_MAX_ELEMENTS}).` },
				includeText: { type: "boolean", description: "Also include a short page-text snippet (default false)." },
			},
			required: [],
		},
		async execute(_toolCallId: string, args: { maxElements?: number; includeText?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				const max = typeof args.maxElements === "number" ? args.maxElements : DEFAULT_MAX_ELEMENTS;
				const block = await observationBlock(session, max, !!args.includeText);
				await emitBrowserStep(exCtx, session, "observe page");
				return block;
			} catch (e) {
				return errStr("browser_observe failed", e);
			}
		},
	} as ToolDefinition);

	// -------------------------------------------------------------- navigate
	ctx.registerTool({
		name: "browser_navigate",
		description:
			"Navigate the current page to a URL and wait for it to load. Navigating to a NEW host is confirmed with the user first. " +
			"Returns the new title/URL and a fresh numbered element list.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute or relative URL to navigate to." },
				wait: { type: "boolean", description: "Wait for the load event before returning (default true)." },
			},
			required: ["url"],
		},
		async execute(_toolCallId: string, args: { url: string; wait?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				if (!args.url) return "browser_navigate failed: 'url' is required.";
				const session = await getSession(convId);
				const info = await getPageInfo(session);
				const destructive = isNewHost(info.url, args.url);
				const ok = await gate(exCtx, convId, `Navigate to: ${args.url}`, destructive);
				if (!ok) return "Cancelled by user: navigation not approved.";

				await session.cdp.send("Page.navigate", { url: args.url }, session.sessionId);
				if (args.wait !== false) await waitForLoad(session);
				session.consecutiveScrolls = 0; // fresh page → fresh scroll budget

				const block = await observationBlock(session, DEFAULT_MAX_ELEMENTS, false);
				await emitBrowserStep(exCtx, session, `navigate ${args.url}`);
				return block;
			} catch (e) {
				return errStr("browser_navigate failed", e);
			}
		},
	} as ToolDefinition);

	// ------------------------------------------------------- click_by_index
	ctx.registerTool({
		name: "browser_click_by_index",
		description:
			"Click the interactive element with the given index (from the latest observation). " +
			"The element is re-validated by its data-cetus-index right before clicking; if it's gone you'll be told to observe again. " +
			"Returns the click result followed by a fresh element list.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "number", description: "Index of the element to click (from the latest observation)." },
				newTab: { type: "boolean", description: "Hint that this click may open a new tab (use browser_tabs to switch)." },
			},
			required: ["index"],
		},
		async execute(_toolCallId: string, args: { index: number; newTab?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				session.consecutiveScrolls = 0; // a real interaction breaks a scroll loop
				const el = session.lastElements.find((e) => e.index === args.index);
				const label = el ? `${el.tag} "${el.name}"` : `element [${args.index}]`;

				// A plain click is a pure interaction, BUT the first consequential
				// action of a conversation is confirmed once per policy.
				const ok = await gate(exCtx, convId, `Click [${args.index}] ${label}`, false);
				if (!ok) return "Cancelled by user: click not approved.";

				const expr = `
(() => {
  const el = document.querySelector('[data-cetus-index="${args.index}"]');
  if (!el) return JSON.stringify({ ok:false, missing:true });
  try { el.scrollIntoView({block:"center",inline:"center"}); } catch(e){}
  const desc = (el.tagName||"").toLowerCase() + (el.innerText ? ' "'+el.innerText.replace(/\\s+/g," ").trim().slice(0,60)+'"' : "");
  el.click();
  return JSON.stringify({ ok:true, desc });
})()`;
				const r = await evalInPage<string>(session, expr);
				if (r.error) return `browser_click_by_index failed: ${r.error}. Try browser_observe to refresh indices.`;
				let parsed: { ok: boolean; missing?: boolean; desc?: string };
				try {
					parsed = JSON.parse(r.value ?? "{}");
				} catch {
					parsed = { ok: false };
				}
				if (parsed.missing) {
					return `Element [${args.index}] no longer exists (page changed). Call browser_observe to get current indices.`;
				}

				await waitForLoad(session).catch(() => {}); // some clicks navigate; don't hang if not
				const block = await observationBlock(session, DEFAULT_MAX_ELEMENTS, false);
				await emitBrowserStep(exCtx, session, `click [${args.index}] ${parsed.desc || label}`, args.index);
				return `Clicked [${args.index}] ${parsed.desc || label}\n\n${block}`;
			} catch (e) {
				return errStr("browser_click_by_index failed", e);
			}
		},
	} as ToolDefinition);

	// -------------------------------------------------------- type_by_index
	ctx.registerTool({
		name: "browser_type_by_index",
		description:
			"Type text into the input/textarea/contenteditable element with the given index. " +
			"Dispatches input/change events so frameworks notice. If submit=true it presses Enter afterward (this is treated as a submit and is confirmed). " +
			"Typing into a password field is also confirmed. Returns a fresh element list.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "number", description: "Index of the field to type into." },
				text: { type: "string", description: "Text to type." },
				submit: { type: "boolean", description: "Press Enter after typing to submit (DESTRUCTIVE — will confirm)." },
			},
			required: ["index", "text"],
		},
		async execute(_toolCallId: string, args: { index: number; text: string; submit?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				const el = session.lastElements.find((e) => e.index === args.index);
				const isPassword = el?.type === "password";
				const destructive = !!args.submit || isPassword;
				const summary = args.submit
					? `Type into [${args.index}] and SUBMIT (press Enter)`
					: isPassword
						? `Type into password field [${args.index}]`
						: `Type into [${args.index}] "${el?.name || ""}"`;
				const ok = await gate(exCtx, convId, summary, destructive);
				if (!ok) return "Cancelled by user: typing not approved.";

				const jsText = JSON.stringify(args.text);
				const expr = `
(() => {
  const el = document.querySelector('[data-cetus-index="${args.index}"]');
  if (!el) return JSON.stringify({ ok:false, missing:true });
  try { el.scrollIntoView({block:"center"}); } catch(e){}
  try { el.focus(); } catch(e){}
  const text = ${jsText};
  if (el.isContentEditable) {
    el.textContent = text;
  } else if ("value" in el) {
    el.value = text;
  } else {
    el.textContent = text;
  }
  try { el.dispatchEvent(new Event("input", { bubbles:true })); } catch(e){}
  try { el.dispatchEvent(new Event("change", { bubbles:true })); } catch(e){}
  return JSON.stringify({ ok:true });
})()`;
				const r = await evalInPage<string>(session, expr);
				if (r.error) return `browser_type_by_index failed: ${r.error}. Try browser_observe to refresh indices.`;
				let parsed: { ok: boolean; missing?: boolean };
				try {
					parsed = JSON.parse(r.value ?? "{}");
				} catch {
					parsed = { ok: false };
				}
				if (parsed.missing) {
					return `Element [${args.index}] no longer exists (page changed). Call browser_observe to get current indices.`;
				}

				if (args.submit) {
					// Synthesize an Enter key press to submit.
					await session.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, session.sessionId).catch(() => {});
					await session.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, session.sessionId).catch(() => {});
					await waitForLoad(session).catch(() => {});
				}

				const block = await observationBlock(session, DEFAULT_MAX_ELEMENTS, false);
				const display = isPassword ? "********" : args.text.slice(0, 60);
				await emitBrowserStep(exCtx, session, `type "${display}"${args.submit ? " + Enter" : ""} into [${args.index}]`, args.index);
				return `Typed into [${args.index}]${args.submit ? " and submitted" : ""}.\n\n${block}`;
			} catch (e) {
				return errStr("browser_type_by_index failed", e);
			}
		},
	} as ToolDefinition);

	// --------------------------------------------------------------- scroll
	ctx.registerTool({
		name: "browser_scroll",
		description:
			"Scroll the page (or a specific scrollable element) up or down. New elements may appear; call browser_observe afterward to see them.",
		parameters: {
			type: "object",
			properties: {
				direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
				amount: { type: "number", description: "Pixels to scroll (default ~ one viewport)." },
				index: { type: "number", description: "Optional element index to scroll within instead of the window." },
			},
			required: ["direction"],
		},
		async execute(_toolCallId: string, args: { direction: "up" | "down"; amount?: number; index?: number }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				const sign = args.direction === "up" ? -1 : 1;
				const expr =
					typeof args.index === "number"
						? `
(() => {
  const el = document.querySelector('[data-cetus-index="${args.index}"]');
  if (!el) return JSON.stringify({ missing:true });
  const amt = ${typeof args.amount === "number" ? args.amount : "Math.round(el.clientHeight*0.8)||400"};
  el.scrollBy(0, ${sign} * amt);
  return JSON.stringify({ ok:true });
})()`
						: `
(() => {
  const amt = ${typeof args.amount === "number" ? args.amount : "Math.round(window.innerHeight*0.85)||600"};
  window.scrollBy(0, ${sign} * amt);
  return JSON.stringify({ ok:true });
})()`;
				const r = await evalInPage<string>(session, expr);
				if (r.error) return `browser_scroll failed: ${r.error}`;
				let parsed: { ok?: boolean; missing?: boolean } = {};
				try {
					parsed = JSON.parse(r.value ?? "{}");
				} catch {
					/* ignore */
				}
				if (parsed.missing) return `Element [${args.index}] not found; scroll the window instead (omit 'index').`;
				await emitBrowserStep(exCtx, session, `scroll ${args.direction}`);
				session.consecutiveScrolls += 1;
				// Runaway-scroll guard: on infinite/AJAX-load pages the agent can keep
				// scrolling to load "everything" and never stop to present results.
				// After enough consecutive scrolls, tell it to wrap up. Escalates so a
				// genuinely long page still gets a couple of extra scrolls first.
				let nudge = "";
				if (session.consecutiveScrolls >= 8) {
					nudge =
						"\n\n⚠️ You have scrolled " + session.consecutiveScrolls +
						" times in a row. STOP scrolling now and present the items you have already" +
						" collected to the user as your answer. Do not try to load the entire page.";
				} else if (session.consecutiveScrolls >= 5) {
					nudge =
						"\n\n(You have scrolled " + session.consecutiveScrolls +
						" times. A reasonable sample is usually enough — if you already have the" +
						" items the user needs, stop scrolling and present them rather than loading everything.)";
				}
				return `Scrolled ${args.direction}. New elements may now be visible — call browser_observe to refresh the list.${nudge}`;
			} catch (e) {
				return errStr("browser_scroll failed", e);
			}
		},
	} as ToolDefinition);

	// -------------------------------------------------------------- extract
	ctx.registerTool({
		name: "browser_extract",
		description:
			"Extract the readable text content of the current page (zero-dep heuristic; nav/script chrome stripped). " +
			"Use this to read articles, search results, or any page content. Output is capped to ~6000 characters.",
		parameters: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["markdown", "text"], description: "Output format hint (text is returned either way; markdown is best-effort)." },
				query: { type: "string", description: "Optional focus hint (the full text is returned regardless; use it to guide your reading)." },
			},
			required: [],
		},
		async execute(_toolCallId: string, args: { format?: "markdown" | "text"; query?: string }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				const info = await getPageInfo(session);
				const text = await extractText(session, EXTRACT_CAP);
				await emitBrowserStep(exCtx, session, "extract page text");
				if (!text) return `No extractable text found on ${info.url || "the current page"}.`;
				const header = `# ${info.title || info.url}\n${info.url}\n`;
				return `${header}\n${text}`;
			} catch (e) {
				return errStr("browser_extract failed", e);
			}
		},
	} as ToolDefinition);

	// ----------------------------------------------------------------- tabs
	ctx.registerTool({
		name: "browser_tabs",
		description:
			"List the open page tabs, or switch the active tab. Use op='list' to see tabs (with indices), op='switch' with tabIndex to attach to another tab.",
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", enum: ["list", "switch"], description: "'list' to enumerate tabs, 'switch' to change the active tab." },
				tabIndex: { type: "number", description: "Index (from op='list') of the tab to switch to." },
			},
			required: ["op"],
		},
		async execute(_toolCallId: string, args: { op: "list" | "switch"; tabIndex?: number }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = await getSession(convId);
				const { targetInfos } = await session.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>(
					"Target.getTargets",
				);
				const pages = targetInfos.filter((t) => t.type === "page");

				if (args.op === "list") {
					const lines = pages.map((p, i) => `[${i}]${p.targetId === session.targetId ? " *" : ""} ${p.title || "(untitled)"} — ${p.url}`);
					return `Open tabs (* = active):\n${lines.join("\n") || "(none)"}`;
				}

				// switch
				if (typeof args.tabIndex !== "number" || args.tabIndex < 0 || args.tabIndex >= pages.length) {
					return `browser_tabs failed: tabIndex out of range. Use op='list' first (0..${pages.length - 1}).`;
				}
				const target = pages[args.tabIndex];
				const { sessionId } = await session.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
				session.sessionId = sessionId;
				session.targetId = target.targetId;
				await session.cdp.send("Page.enable", {}, sessionId).catch(() => {});
				await session.cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
				await session.cdp.send("DOM.enable", {}, sessionId).catch(() => {});
				const block = await observationBlock(session, DEFAULT_MAX_ELEMENTS, false);
				await emitBrowserStep(exCtx, session, `switch to tab [${args.tabIndex}]`);
				return `Switched to tab [${args.tabIndex}].\n\n${block}`;
			} catch (e) {
				return errStr("browser_tabs failed", e);
			}
		},
	} as ToolDefinition);

	// ---------------------------------------------------------------- close
	ctx.registerTool({
		name: "browser_close",
		description:
			"Detach from the browser session. By default this also closes the managed Chrome we launched. Set keepSession=true to leave Chrome running for later reuse.",
		parameters: {
			type: "object",
			properties: {
				keepSession: { type: "boolean", description: "Keep the managed Chrome running (default false closes it)." },
			},
			required: [],
		},
		async execute(_toolCallId: string, args: { keepSession?: boolean }, _signal: unknown, _onUpdate: unknown, exCtx: ToolExecContext): Promise<string> {
			const convId = convIdOf(exCtx);
			try {
				const session = sessions.get(convId);
				if (!session) return "No browser session was open.";

				if (!args.keepSession) {
					// Best-effort graceful browser close, then kill the child if we launched it.
					try {
						await session.cdp.send("Browser.close", {});
					} catch {
						/* ignore */
					}
					try {
						session.child?.kill();
					} catch {
						/* ignore */
					}
				}
				session.cdp.close();
				sessions.delete(convId);
				return args.keepSession ? "Detached from browser (Chrome left running)." : "Closed the browser session.";
			} catch (e) {
				return errStr("browser_close failed", e);
			}
		},
	} as ToolDefinition);
};

export default ext;
