/**
 * cetus document-bridge extension.
 *
 * DeepSeek (cetus's model) only ever sees text + images, and pi only transports
 * those two content types. So any *other* attachment the user drops — docx,
 * xlsx, pptx, pdf, csv, source files — has to be turned into text before the
 * model can use it. The cetus frontend writes each non-image attachment to disk
 * (save_attachment) and references its path in the prompt; this extension's
 * `read_document` tool is what the model calls to actually read one.
 *
 * Routing by file type (matches the "local parser vs. Gemini" split):
 *   - text / data (txt, md, json, csv, tsv, code, …) → read straight off disk
 *   - docx / pptx                                    → unzip + pull the XML text
 *   - xlsx / xls                                     → SheetJS → CSV per sheet
 *   - pdf                                            → Gemini (handles scanned)
 *   - images                                         → Gemini (like read_image)
 *
 * Parser libs (jszip, xlsx) load via dynamic import wrapped in try/catch, so a
 * missing/unbundled dependency degrades to a clear per-file error instead of
 * breaking the whole extension at load time.
 */

import { promises as fs } from "node:fs";
import { extname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 60_000;

// Cap returned text so a giant spreadsheet/PDF can't blow the model's context.
const MAX_CHARS = 120_000;
const MAX_BYTES = 40 * 1024 * 1024;

const TEXT_EXTS = new Set([
	"txt", "text", "log", "md", "markdown", "mdx", "rst",
	"json", "jsonc", "json5", "ndjson", "csv", "tsv", "psv",
	"yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
	"xml", "html", "htm", "css", "scss", "less", "svg",
	"js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
	"py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cc",
	"cs", "swift", "m", "mm", "php", "pl", "lua", "r", "scala", "clj", "ex", "exs",
	"sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "graphql", "gql", "proto",
	"dockerfile", "makefile", "gitignore", "diff", "patch",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff"]);
const IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", bmp: "image/bmp", heic: "image/heic", heif: "image/heif", tiff: "image/tiff",
};

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "read_document",
			label: "Read Document",
			description:
				"Extract the text content of a document file on disk so you can read it. " +
				"Handles pdf, docx, xlsx/xls, pptx, csv, txt, md, json, and source/code files. " +
				"Use this for any attached non-image file (the user's attachments are referenced " +
				"by absolute path in the prompt). Returns plain text; large files are truncated.",
			parameters: Type.Object({
				path: Type.String({ description: "Absolute path to the file to read." }),
				question: Type.Optional(
					Type.String({
						description:
							"Optional focus for pdf/image extraction — what you're trying to learn from it.",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const path = params.path;
				const ext = extname(path).toLowerCase().slice(1);
				let stat;
				try {
					stat = await fs.stat(path);
				} catch (err) {
					return errorResult(`cannot access ${path}: ${msg(err)}`);
				}
				if (!stat.isFile()) return errorResult(`${path} is not a file`);
				if (stat.size > MAX_BYTES) {
					return errorResult(
						`${path} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — over the ${MAX_BYTES / 1024 / 1024}MB read limit.`,
					);
				}

				try {
					const text = await extract(path, ext, params.question ?? "");
					if (!text.trim()) return errorResult(`${path}: no readable text content found.`);
					return { content: [{ type: "text", text: clip(text) }] };
				} catch (err) {
					return errorResult(`failed to read ${path}: ${msg(err)}`);
				}
			},
		}),
	);
}

async function extract(path: string, ext: string, question: string): Promise<string> {
	if (ext === "pdf") return geminiExtract(path, "application/pdf", question);
	if (IMAGE_EXTS.has(ext)) return imageExtract(path, IMAGE_MIME[ext] ?? "image/png", question);
	if (ext === "docx") return readDocx(path);
	if (ext === "pptx") return readPptx(path);
	if (ext === "xlsx" || ext === "xls" || ext === "xlsm") return readXlsx(path);
	if (TEXT_EXTS.has(ext) || ext === "") return fs.readFile(path, "utf8");
	// Unknown extension: try UTF-8; reject if it smells binary.
	const buf = await fs.readFile(path);
	if (looksBinary(buf)) {
		throw new Error(`unsupported binary file type ".${ext}" (no text extractor available)`);
	}
	return buf.toString("utf8");
}

// ---- Office formats ------------------------------------------------------

async function loadJsZip() {
	const mod = (await import("jszip").catch(() => {
		throw new Error("jszip is not installed in this pi build — cannot unzip Office files");
	})) as { default?: unknown } & Record<string, unknown>;
	const JSZip = (mod.default ?? mod) as { loadAsync(data: Buffer): Promise<JsZipArchive> };
	return JSZip;
}

interface JsZipFile {
	name: string;
	async(t: "string"): Promise<string>;
}
interface JsZipArchive {
	// JSZip overloads file(): a string name returns one entry (or null), a RegExp
	// returns every matching file entry. folder(RegExp) matches *folders*, not
	// files — so slide enumeration must go through file(RegExp).
	file(path: string): JsZipFile | null;
	file(re: RegExp): JsZipFile[];
}

async function readDocx(path: string): Promise<string> {
	const JSZip = await loadJsZip();
	const zip = await JSZip.loadAsync(await fs.readFile(path));
	const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
	if (!xml) throw new Error("no word/document.xml in docx");
	// Paragraph + line breaks → newlines; everything else stripped.
	return decodeXml(
		xml
			.replace(/<\/w:p>/g, "\n")
			.replace(/<w:br\s*\/?>/g, "\n")
			.replace(/<w:tab\s*\/?>/g, "\t")
			.replace(/<[^>]+>/g, ""),
	).replace(/\n{3,}/g, "\n\n").trim();
}

async function readPptx(path: string): Promise<string> {
	const JSZip = await loadJsZip();
	const zip = await JSZip.loadAsync(await fs.readFile(path));
	const slides = zip
		.file(/ppt\/slides\/slide\d+\.xml/)
		.sort((a, b) => slideNo(a.name) - slideNo(b.name));
	const out: string[] = [];
	for (const slide of slides) {
		const xml = await slide.async("string");
		const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
		if (runs.length) out.push(`# Slide ${slideNo(slide.name)}\n${runs.join("\n")}`);
	}
	if (!out.length) throw new Error("no slide text found in pptx");
	return out.join("\n\n");
}

async function readXlsx(path: string): Promise<string> {
	const mod = (await import("xlsx").catch(() => {
		throw new Error("xlsx (SheetJS) is not installed in this pi build — cannot read spreadsheets");
	})) as { default?: unknown } & Record<string, unknown>;
	const XLSX = ((mod as { read?: unknown }).read ? mod : mod.default) as {
		read(data: Buffer, opts: { type: "buffer" }): { SheetNames: string[]; Sheets: Record<string, unknown> };
		utils: { sheet_to_csv(ws: unknown): string };
	};
	const wb = XLSX.read(await fs.readFile(path), { type: "buffer" });
	const parts = wb.SheetNames.map((name) => {
		const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
		return csv ? `# Sheet: ${name}\n${csv}` : "";
	}).filter(Boolean);
	if (!parts.length) throw new Error("workbook has no readable sheets");
	return parts.join("\n\n");
}

// ---- Images --------------------------------------------------------------

async function imageExtract(path: string, mimeType: string, question: string): Promise<string> {
	return geminiExtract(path, mimeType, question);
}

// ---- Gemini (pdf + image) -----------------------------------------------

async function geminiExtract(path: string, mimeType: string, question: string): Promise<string> {
	const apiKey = process.env.GEMINI_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"GEMINI_API_KEY is not set — needed to read PDFs/images. Add it in cetus Settings → Gemini.",
		);
	}
	const data = (await fs.readFile(path)).toString("base64");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort("timeout"), GEMINI_TIMEOUT_MS);
	try {
		const prompt =
			mimeType === "application/pdf"
				? `Extract the full text content of this PDF as plain text, preserving reading order, headings, lists and tables (render tables as markdown). Transcribe scanned pages via OCR. ${focus(question)}`
				: `Describe this image in detail for a text-only assistant: visible text verbatim, objects, layout, and anything relevant to: ${question || "what is this?"}. Plain text only.`;
		const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: prompt }] }],
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			throw new Error(`gemini ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
		}
		const json = (await resp.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[];
		};
		const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
		if (!text) throw new Error("gemini returned an empty result");
		return text;
	} finally {
		clearTimeout(timer);
	}
}

// ---- helpers -------------------------------------------------------------

function focus(q: string): string {
	return q ? `Focus especially on: ${q}.` : "";
}

function slideNo(name: string): number {
	return Number(name.match(/slide(\d+)\.xml/)?.[1] ?? 0);
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, "&");
}

function looksBinary(buf: Buffer): boolean {
	// NUL byte in the first 8KB ⇒ almost certainly not text.
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

function clip(text: string): string {
	return text.length > MAX_CHARS
		? `${text.slice(0, MAX_CHARS)}\n\n[…truncated — ${text.length} chars total; read a specific section if you need more]`
		: text;
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text: `read_document: ${text}` }], isError: true };
}
