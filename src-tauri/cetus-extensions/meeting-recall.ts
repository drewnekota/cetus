/**
 * cetus meeting-recall extension.
 *
 * cetus can transcribe meetings on-device (Settings → Meetings): the microphone
 * is the user, the system audio is everyone else, and a post-meeting pass
 * distills a title + minutes. Every transcript segment and summary is appended
 * to a local recall log (path in $CETUS_MEETING_LOG). This extension exposes a
 * `search_meeting_history` tool so the agent can recall what was said.
 *
 * Only text exists anywhere in this pipeline — no audio is ever stored.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RecallEntry {
	ts: number;
	iso: string;
	/** "segment" (one stretch of speech) or "summary" (post-meeting minutes). */
	kind: string;
	/** "mic" (the user), "system" (other participants), or "summary". */
	source: string;
	/** Bundle id of the meeting app, when auto-detected (e.g. "us.zoom.xos"). */
	app: string;
	/** Model-generated meeting title (summaries only). */
	title: string;
	text: string;
}

async function loadEntries(): Promise<RecallEntry[]> {
	const logPath = process.env.CETUS_MEETING_LOG?.trim();
	if (!logPath) return [];
	const fs = await import("node:fs/promises");
	let raw: string;
	try {
		raw = await fs.readFile(logPath, "utf8");
	} catch {
		return [];
	}
	const out: RecallEntry[] = [];
	for (const line of raw.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			out.push(JSON.parse(s) as RecallEntry);
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

const PARAMS = Type.Object({
	query: Type.String({
		description:
			"Keywords to search across meeting transcripts, summaries, and titles. " +
			"Empty string lists the most recent meeting summaries.",
	}),
	hours_back: Type.Optional(
		Type.Number({
			description: "Only consider meetings within the last N hours.",
			minimum: 1,
		}),
	),
	summaries_only: Type.Optional(
		Type.Boolean({
			description:
				"Match only post-meeting summaries (skip raw transcript segments).",
		}),
	),
	max_results: Type.Optional(
		Type.Number({
			description: "Max entries to return. Default 12, hard cap 40.",
			minimum: 1,
			maximum: 40,
		}),
	),
});

const tool = defineTool({
	name: "search_meeting_history",
	label: "Search Meeting History",
	description:
		"Recall what was said in the user's meetings. cetus transcribes meetings on-device " +
		"(mic = the user, system = other participants) and writes a summary afterwards; this " +
		"searches that local history. Use it when the user refers to something discussed in a " +
		"call or meeting — e.g. 'what did we decide about the budget', 'the action items from " +
		"this morning's standup'. An empty query lists recent meeting summaries. Returns " +
		"timestamped text only; no audio exists. Local-only.",
	parameters: PARAMS,

	async execute(_toolCallId, params) {
		const terms = params.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const max = Math.min(Math.max(params.max_results ?? 12, 1), 40);

		let entries = await loadEntries();
		if (entries.length === 0) {
			return {
				content: [
					{
						type: "text",
						text:
							"No meeting history is available. Meeting capture may be off, or no " +
							"meeting has been recorded yet. The user can enable it in cetus " +
							"Settings → Meetings.",
					},
				],
				details: { available: false },
			};
		}

		if (params.hours_back) {
			const cutoff = Date.now() - params.hours_back * 3_600_000;
			entries = entries.filter((e) => e.ts >= cutoff);
		}
		if (params.summaries_only || terms.length === 0) {
			// An empty query degrades to "what meetings happened recently" — raw
			// segments would be noise there, so list summaries either way.
			entries = entries.filter((e) => e.kind === "summary");
		}

		const scored = entries
			.map((e) => {
				const hay = `${e.title ?? ""} ${e.app ?? ""} ${e.text ?? ""}`.toLowerCase();
				const score = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
				return { e, score };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || b.e.ts - a.e.ts)
			.slice(0, max);

		if (scored.length === 0) {
			return {
				content: [
					{ type: "text", text: `No meeting history matched "${params.query}".` },
				],
				details: { available: true, matches: 0 },
			};
		}

		const body = scored
			.map(({ e }) => {
				const text = (e.text ?? "").replace(/\s+/g, " ").slice(0, 600);
				const who =
					e.kind === "summary"
						? `summary${e.title ? `: ${e.title}` : ""}`
						: e.source === "mic"
							? "the user"
							: "other participants";
				return `[${e.iso}] (${who})${e.app ? ` ${e.app}` : ""}\n${text}`;
			})
			.join("\n\n");

		return {
			content: [
				{
					type: "text",
					text: `Meeting history matches for "${params.query || "(recent summaries)"}":\n\n${body}`,
				},
			],
			details: { available: true, matches: scored.length },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(tool);
}
