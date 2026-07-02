/**
 * cetus screen-recall extension.
 *
 * cetus can periodically capture the screen and OCR it on-device (Settings →
 * Screen context). Each captured frame's text + app + timestamp is appended to
 * a local recall log (path in $CETUS_SCREEN_LOG). This extension exposes a
 * `search_screen_history` tool so the agent can trace back to what the user
 * saw or did earlier.
 *
 * Only text is ever returned — screenshots stay on the user's machine. If
 * capture is off or the log is empty, the tool says so.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readNdjsonLog } from "./bridge/ndjson-log";

interface RecallEntry {
	ts: number;
	iso: string;
	app: string;
	text: string;
}

async function loadEntries(): Promise<RecallEntry[]> {
	const logPath = process.env.CETUS_SCREEN_LOG?.trim();
	if (!logPath) return [];
	return readNdjsonLog<RecallEntry>(logPath);
}

const PARAMS = Type.Object({
	query: Type.String({
		description: "Keywords to search across captured screen text (OCR) and app names.",
	}),
	hours_back: Type.Optional(
		Type.Number({
			description: "Only consider screen activity within the last N hours.",
			minimum: 1,
		}),
	),
	app: Type.Optional(
		Type.String({ description: "Filter to a specific application name (substring)." }),
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
	name: "search_screen_history",
	label: "Search Screen History",
	description:
		"Recall what the user has seen or done on their screen. cetus periodically captures the " +
		"screen and OCRs it on-device; this searches that local history (text + app + timestamp). " +
		"Use it when the user refers to something they saw, read, or worked on earlier — e.g. " +
		"'that error from before', 'the doc I had open', 'what was I doing this morning'. " +
		"Returns timestamped text snippets only; no images. Local-only.",
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
							"No screen history is available. Screen capture may be off, or nothing has " +
							"been captured yet. The user can enable it in cetus Settings → Screen context.",
					},
				],
				details: { available: false },
			};
		}

		if (params.hours_back) {
			const cutoff = Date.now() - params.hours_back * 3_600_000;
			entries = entries.filter((e) => e.ts >= cutoff);
		}
		if (params.app) {
			const a = params.app.toLowerCase();
			entries = entries.filter((e) => (e.app ?? "").toLowerCase().includes(a));
		}

		const scored = entries
			.map((e) => {
				const hay = `${e.app ?? ""} ${e.text ?? ""}`.toLowerCase();
				const score = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
				return { e, score };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || b.e.ts - a.e.ts)
			.slice(0, max);

		if (scored.length === 0) {
			return {
				content: [{ type: "text", text: `No screen history matched "${params.query}".` }],
				details: { available: true, matches: 0 },
			};
		}

		const body = scored
			.map(({ e }) => {
				const text = (e.text ?? "").replace(/\s+/g, " ").slice(0, 400);
				return `[${e.iso}] ${e.app || "?"}\n${text}`;
			})
			.join("\n\n");

		return {
			content: [
				{ type: "text", text: `Screen history matches for "${params.query}":\n\n${body}` },
			],
			details: { available: true, matches: scored.length },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(tool);
}
