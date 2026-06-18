/**
 * cetus send_artifact extension.
 *
 * Lets the agent deliver a file (image, video, pdf, audio, markdown, html, ...)
 * back to the cetus UI for inline rendering. The tool itself does not transport
 * file bytes — it only resolves the path, sniffs a mime type, and returns a
 * structured `details` payload that the cetus frontend recognises and renders
 * via Tauri's asset:// protocol (so even multi-GB videos stream lazily).
 *
 * The agent should call this whenever it produces an artifact the user is
 * meant to look at — generated images, downloaded videos, rendered diagrams,
 * exported PDFs, etc. — instead of just printing the path.
 */

import { promises as fs } from "node:fs";
import { extname, isAbsolute, resolve, basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PARAMS = Type.Object({
	path: Type.String({
		description:
			"Absolute path (preferred) or path relative to the session cwd. " +
			"Must point to a real, readable file.",
	}),
	caption: Type.Optional(
		Type.String({
			description:
				"Short caption shown above the artifact. Use this to explain what the user is looking at.",
		}),
	),
	mime_type: Type.Optional(
		Type.String({
			description:
				"Override the auto-detected mime type. Usually leave blank — extension-based detection is fine.",
		}),
	),
});

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".pdf": "application/pdf",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".html": "text/html",
	".htm": "text/html",
	".txt": "text/plain",
	".json": "application/json",
	".csv": "text/csv",
};

function detectMime(path: string): string {
	const ext = extname(path).toLowerCase();
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function artifactKind(mime: string): "image" | "video" | "audio" | "pdf" | "markdown" | "html" | "text" | "other" {
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime === "application/pdf") return "pdf";
	if (mime === "text/markdown") return "markdown";
	if (mime === "text/html") return "html";
	if (mime.startsWith("text/") || mime === "application/json") return "text";
	return "other";
}

const sendArtifactTool = defineTool({
	name: "send_artifact",
	label: "Send Artifact",
	description:
		"Deliver a local file to the cetus chat UI for inline display. " +
		"Use whenever you produce something the user should look at: a generated " +
		"image, a downloaded video, a rendered PDF, a diagram, a markdown report, etc. " +
		"Pass the path you just wrote to. The user sees the file rendered inline; " +
		"do not also print the path in your reply.",
	parameters: PARAMS,

	async execute(_toolCallId, params) {
		const raw = params.path.trim();
		if (!raw) {
			return {
				content: [{ type: "text", text: "send_artifact: path is empty." }],
				details: { error: "empty_path" },
				isError: true,
			};
		}
		const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
		let stat;
		try {
			stat = await fs.stat(abs);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `send_artifact: cannot read ${abs}: ${msg}` }],
				details: { error: "stat_failed", path: abs },
				isError: true,
			};
		}
		if (!stat.isFile()) {
			return {
				content: [{ type: "text", text: `send_artifact: ${abs} is not a regular file.` }],
				details: { error: "not_a_file", path: abs },
				isError: true,
			};
		}

		const mime = params.mime_type?.trim() || detectMime(abs);
		const kind = artifactKind(mime);
		const name = basename(abs);

		// The model gets a terse text confirmation; the rich payload is in details
		// so the frontend can render without parsing prose.
		const caption = params.caption?.trim();
		const human = caption ? `${caption} (${name})` : name;
		return {
			content: [
				{
					type: "text",
					text: `Artifact delivered to user: ${human}`,
				},
			],
			details: {
				kind: "artifact",
				artifactKind: kind,
				path: abs,
				name,
				mimeType: mime,
				caption: caption ?? null,
				sizeBytes: stat.size,
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(sendArtifactTool);
}
