/**
 * cetus memory extension.
 *
 * Gives the agent a persistent, cross-conversation memory: a small set of
 * durable notes about the user (identity, preferences, ongoing projects,
 * decisions). Two responsibilities:
 *
 *   1. Inject — on `before_agent_start`, read the store and append the enabled
 *      entries to the system prompt, so the agent "remembers" them every turn.
 *   2. Edit — register the `manage_memory` tool so the agent can add / update /
 *      remove entries as it learns durable facts.
 *
 * The store is a JSON file cetus points us at via the `CETUS_MEMORY_PATH` env var
 * (`<app_data>/memory.json`). The cetus Memory settings page reads and writes the
 * SAME file (see src-tauri/src/memory.rs), so the user and the agent share one
 * memory — either can add, edit, mute, or delete an entry. Because we re-read on
 * every turn, edits from either side take effect immediately.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt the
 * store; cetus serialises its own writes with a mutex. The schema (camelCase keys
 * `createdAt`/`updatedAt`, top-level `version`/`enabled`/`entries`) MUST stay in
 * sync with the Rust `MemoryState`/`MemoryEntry` structs.
 */

import { promises as fs } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errMsg } from "./bridge/protocol";

interface MemoryEntry {
	id: string;
	content: string;
	category?: string | null;
	source: "user" | "agent";
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

interface MemoryState {
	version: number;
	enabled: boolean;
	entries: MemoryEntry[];
}

const CURRENT_VERSION = 1;
// Keep these in lockstep with memory.rs (MAX_ENTRIES / MAX_CONTENT_CHARS).
const MAX_ENTRIES = 200;
const MAX_CONTENT_CHARS = 2000;
// Cap how much memory we pour into the system prompt, regardless of store size.
// This text is appended every turn; an interactive chat amortises it through the
// prompt cache, but every NEW conversation — and the many short-lived background
// ones (automations, parallel solutions, sub-agents) that often run a single
// turn — pays the full block uncached. So keep the default budget tight (~1k
// tokens); the freshest memories still clear it and the rest collapse into the
// "…and N more" line. Tunable if recall ever feels too shallow.
const MAX_INJECTED_ENTRIES = 80;
const MAX_INJECTED_CHARS = 4000;

function storePath(): string | null {
	const p = process.env.CETUS_MEMORY_PATH?.trim();
	return p && p.length > 0 ? p : null;
}

function emptyState(): MemoryState {
	return { version: CURRENT_VERSION, enabled: true, entries: [] };
}

/** Read + normalise the store. Missing/corrupt → an empty, enabled state.
 *
 * Each entry is rebuilt into a fully-populated MemoryEntry with the SAME field
 * defaults the Rust side uses (source→"user", enabled→true unless explicitly
 * false, timestamps→0, category→null). This keeps the two layers symmetric: an
 * entry we accept (and re-write) always has every camelCase key Rust's strict
 * struct expects, and a missing per-entry `enabled` means "enabled" on both
 * sides rather than silently muted here. Entries without a usable id+content are
 * dropped individually, never sinking the whole store. */
async function readState(path: string): Promise<MemoryState> {
	let raw: string;
	try {
		raw = await fs.readFile(path, "utf8");
	} catch {
		return emptyState();
	}
	let parsed: Record<string, unknown>;
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object") return emptyState();
		parsed = v as Record<string, unknown>;
	} catch {
		return emptyState();
	}
	const rawEntries = Array.isArray(parsed.entries) ? (parsed.entries as unknown[]) : [];
	const entries: MemoryEntry[] = [];
	for (const item of rawEntries) {
		const e = item as Record<string, unknown>;
		if (!e || typeof e.id !== "string" || typeof e.content !== "string") continue;
		if (!e.id || !e.content.trim()) continue;
		entries.push({
			id: e.id,
			content: e.content,
			category: typeof e.category === "string" && e.category.trim() ? e.category : null,
			source: e.source === "agent" ? "agent" : "user",
			enabled: e.enabled !== false, // default true, matching Rust
			createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
			updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
		});
	}
	return {
		version: typeof parsed.version === "number" ? parsed.version : CURRENT_VERSION,
		enabled: parsed.enabled !== false, // default true
		entries,
	};
}

/** Atomic write: temp sibling file, then rename over the target.
 *
 * The temp name is unique per writer — several pi processes (one per
 * conversation, plus N during a parallel-solutions fan-out) share this file, so
 * a fixed temp name would let two concurrent writes interleave into one garbled
 * file that then gets renamed into place. A pid+uuid suffix gives each writer
 * its own temp, restoring the atomic-rename guarantee; we clean it up if the
 * rename never happens. */
async function writeState(path: string, state: MemoryState): Promise<void> {
	const tmp = `${path}.${process.pid}.${newId()}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
		await fs.rename(tmp, path);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

function now(): number {
	return Date.now();
}

/** Count Unicode code points, matching Rust's `content.chars().count()` so the
 *  MAX_CONTENT_CHARS cap agrees across layers (JS `String.length` counts UTF-16
 *  units, which double-counts astral-plane characters like emoji). */
function charLen(s: string): number {
	return [...s].length;
}

function newId(): string {
	// Bun/Node expose a global Web Crypto; fall back to a timestamped random id.
	try {
		return crypto.randomUUID();
	} catch {
		return `m_${now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	}
}

// ---- Context injection -----------------------------------------------------

/** Format one enabled entry as a compact bullet: text, optional category, id. */
function entryLine(e: MemoryEntry): string {
	const cat = e.category?.trim() ? ` (${e.category.trim()})` : "";
	return `- ${e.content.trim()}${cat} [id: ${e.id}]`;
}

/** Choose which enabled entries to inject, honouring the count + char caps.
 *  Selection is by recency (freshest first) so that when the store exceeds a cap
 *  we keep the most recently-touched memories. The caller re-sorts the result
 *  into a STABLE order before rendering — recency must NOT drive the rendered
 *  order (see buildMemoryBlock). */
function selectInjected(enabled: MemoryEntry[]): { shown: MemoryEntry[]; omitted: number } {
	const byFreshness = [...enabled].sort((a, b) => b.updatedAt - a.updatedAt);
	const shown: MemoryEntry[] = [];
	let used = 0;
	for (const e of byFreshness) {
		if (shown.length >= MAX_INJECTED_ENTRIES) break;
		const line = entryLine(e);
		if (used + line.length > MAX_INJECTED_CHARS) break;
		shown.push(e);
		used += line.length + 1;
	}
	return { shown, omitted: enabled.length - shown.length };
}

const TOOL_GUIDANCE =
	"You can manage this memory with the `manage_memory` tool. It is NOT a scratchpad " +
	"for the current task — only persist facts that will still matter in a FUTURE, " +
	"unrelated conversation: the user's identity, stable preferences (tools, languages, " +
	"style), long-running projects, or standing decisions. Do NOT save the user's current " +
	"request or the task you're about to do, one-off details, secrets/API keys, or anything " +
	"easily re-derived. There is no need to save anything at the start of a task; wait until " +
	"a fact has clearly proven durable, and when in doubt don't save. Update or delete an " +
	"entry when it becomes stale or wrong (pass its id). Saving is silent — don't announce " +
	"routine memory writes to the user.";

function buildMemoryBlock(state: MemoryState): string {
	const enabled = state.entries.filter((e) => e.enabled);
	const { shown, omitted } = selectInjected(enabled);
	// Render the SELECTED entries in a stable creation order (id as tiebreak), NOT
	// by recency. This block is appended to the system prompt, which renders ahead
	// of the entire message history, so its bytes must stay stable across turns:
	// with a stable order, editing one memory changes only its own line (and a
	// no-op write leaves the block byte-identical), so DeepSeek's prompt-cache
	// prefix survives. Recency only decides which entries clear the injection cap
	// (in selectInjected); the agent doesn't care about their order.
	const ordered = [...shown].sort(
		(a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const lines = ordered.map(entryLine);
	if (omitted > 0) {
		lines.push(`- …and ${omitted} more memor${omitted === 1 ? "y" : "ies"} not shown here.`);
	}
	let block = "\n\n## Memory\n\n";
	if (enabled.length > 0) {
		block +=
			"Persistent notes about the user, remembered across conversations. Treat " +
			"them as current and honor them. The user can also see and edit these.\n\n" +
			lines.join("\n") +
			"\n\n";
	} else {
		block += "No memories saved yet.\n\n";
	}
	block += TOOL_GUIDANCE;
	return block;
}

// ---- The manage_memory tool ------------------------------------------------

const PARAMS = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("update"), Type.Literal("delete")],
		{
			description:
				"'add' a new memory, 'update' an existing one (by id), or 'delete' one (by id).",
		},
	),
	content: Type.Optional(
		Type.String({
			description:
				"The memory text — one durable fact, phrased so it makes sense out of context. " +
				"Required for 'add'; optional for 'update' (omit to keep the existing text).",
		}),
	),
	id: Type.Optional(
		Type.String({
			description:
				"The id of the entry to change. Required for 'update' and 'delete'. " +
				"Take it from the [id: …] tag shown next to each memory in your context.",
		}),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Optional short grouping label (e.g. 'Preferences', 'Project: cetus'). " +
				"On 'update', pass an empty string to clear it.",
		}),
	),
	enabled: Type.Optional(
		Type.Boolean({
			description:
				"On 'update', set to false to mute an entry (kept but not used) or true to re-enable it.",
		}),
	),
});

function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

/** Serialise the whole read-modify-write inside THIS process.
 *
 * pi dispatches a turn's tool calls CONCURRENTLY, so two `manage_memory` adds in
 * one turn would otherwise both `readState` the same base, each `writeState`
 * atomically, and the last rename wins — silently dropping the other entry while
 * still reporting "Saved". The atomic temp+rename in writeState prevents a
 * GARBLED file but not this lost update. A module-level promise chain forces the
 * read→mutate→write of each call to run to completion before the next begins, so
 * concurrent adds/updates/deletes in the same process compose instead of
 * clobbering. (Cross-process writes — different conversations touching the file
 * at once — are far rarer and still bounded by the atomic write; this closes the
 * common same-turn case that the agent actually hits.) */
let memoryWriteChain: Promise<unknown> = Promise.resolve();
function serializeMemoryWrite<T>(fn: () => Promise<T>): Promise<T> {
	const run = memoryWriteChain.then(fn, fn);
	// Keep the chain alive regardless of this op's success/failure.
	memoryWriteChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

const manageMemoryTool = defineTool({
	name: "manage_memory",
	label: "Manage Memory",
	description:
		"Add, update, or delete a persistent memory about the user — facts to remember " +
		"across conversations (identity, preferences, long-running projects, standing decisions). " +
		"These are injected into your context every turn and are visible to the user. " +
		"Use 'add' for a new fact, 'update'/'delete' with the entry's id for an existing one. " +
		"This is NOT a scratchpad for the active task: don't store the current request, " +
		"one-off task details, or secrets, and don't save at the start of a task — wait " +
		"until a fact has proven durable.",
	parameters: PARAMS,

	async execute(_toolCallId, params) {
		const path = storePath();
		if (!path) {
			return textResult(
				"manage_memory: memory is unavailable in this environment.",
				{ kind: "memory_error", error: "no_store_path" },
				true,
			);
		}

		// Serialise read→mutate→write so concurrent same-turn calls can't clobber
		// each other (see serializeMemoryWrite).
		return serializeMemoryWrite(async () => {
		const action = params.action;
		const state = await readState(path);

		try {
			if (action === "add") {
				const content = (params.content ?? "").trim();
				if (!content) {
					return textResult(
						"manage_memory: 'content' is required to add a memory.",
						{ kind: "memory_error", error: "empty_content" },
						true,
					);
				}
				if (charLen(content) > MAX_CONTENT_CHARS) {
					return textResult(
						`manage_memory: content exceeds ${MAX_CONTENT_CHARS} characters.`,
						{ kind: "memory_error", error: "too_long" },
						true,
					);
				}
				// Dedupe on exact (case-insensitive) content so repeated saves are no-ops.
				const dup = state.entries.find(
					(e) => e.content.trim().toLowerCase() === content.toLowerCase(),
				);
				if (dup) {
					return textResult(
						`Already remembered (id: ${dup.id}).`,
						{ kind: "memory_updated", action: "add", id: dup.id, deduped: true, count: state.entries.length },
					);
				}
				if (state.entries.length >= MAX_ENTRIES) {
					return textResult(
						`manage_memory: memory is full (${MAX_ENTRIES} entries). Delete some first.`,
						{ kind: "memory_error", error: "full" },
						true,
					);
				}
				const ts = now();
				const entry: MemoryEntry = {
					id: newId(),
					content,
					category: params.category?.trim() ? params.category.trim() : null,
					source: "agent",
					enabled: true,
					createdAt: ts,
					updatedAt: ts,
				};
				state.entries.push(entry);
				await writeState(path, state);
				return textResult(
					`Saved to memory (id: ${entry.id}).`,
					{ kind: "memory_updated", action: "add", id: entry.id, count: state.entries.length },
				);
			}

			if (action === "update") {
				const id = (params.id ?? "").trim();
				if (!id) {
					return textResult(
						"manage_memory: 'id' is required to update a memory.",
						{ kind: "memory_error", error: "missing_id" },
						true,
					);
				}
				const entry = state.entries.find((e) => e.id === id);
				if (!entry) {
					return textResult(
						`manage_memory: no memory with id ${id}.`,
						{ kind: "memory_error", error: "not_found", id },
						true,
					);
				}
				if (params.content !== undefined) {
					const c = params.content.trim();
					if (!c) {
						return textResult(
							"manage_memory: 'content' can't be blank on update (use action 'delete' to remove).",
							{ kind: "memory_error", error: "empty_content", id },
							true,
						);
					}
					if (charLen(c) > MAX_CONTENT_CHARS) {
						return textResult(
							`manage_memory: content exceeds ${MAX_CONTENT_CHARS} characters.`,
							{ kind: "memory_error", error: "too_long", id },
							true,
						);
					}
					entry.content = c;
				}
				if (params.category !== undefined) {
					entry.category = params.category.trim() ? params.category.trim() : null;
				}
				if (params.enabled !== undefined) {
					entry.enabled = params.enabled;
				}
				entry.updatedAt = now();
				await writeState(path, state);
				return textResult(
					`Updated memory (id: ${id}).`,
					{ kind: "memory_updated", action: "update", id, count: state.entries.length },
				);
			}

			// delete
			const id = (params.id ?? "").trim();
			if (!id) {
				return textResult(
					"manage_memory: 'id' is required to delete a memory.",
					{ kind: "memory_error", error: "missing_id" },
					true,
				);
			}
			const before = state.entries.length;
			state.entries = state.entries.filter((e) => e.id !== id);
			if (state.entries.length === before) {
				return textResult(
					`No memory with id ${id} (already gone).`,
					{ kind: "memory_updated", action: "delete", id, count: state.entries.length },
				);
			}
			await writeState(path, state);
			return textResult(
				`Deleted memory (id: ${id}).`,
				{ kind: "memory_updated", action: "delete", id, count: state.entries.length },
			);
		} catch (err) {
			const msg = errMsg(err);
			return textResult(
				`manage_memory: failed to write memory: ${msg}`,
				{ kind: "memory_error", error: "write_failed" },
				true,
			);
		}
		});
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(manageMemoryTool);

	// Re-read the store every turn so edits from the user (settings page) or a
	// prior turn's tool call are reflected immediately.
	pi.on("before_agent_start", async (event) => {
		const path = storePath();
		if (!path) return;
		const state = await readState(path);
		if (!state.enabled) return; // master switch off → inject nothing
		return { systemPrompt: event.systemPrompt + buildMemoryBlock(state) };
	});
}
