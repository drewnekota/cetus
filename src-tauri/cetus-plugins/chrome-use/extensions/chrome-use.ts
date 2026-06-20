/**
 * chrome-use.ts — agent tools for the user's real Chrome profile.
 *
 * The Chrome extension sends tab/page context to Cetus through the Native
 * Messaging host. This pi extension reads that local JSONL inbox and exposes it
 * to the agent as explicit `chrome_*` tools. It is intentionally read-oriented:
 * actions that submit, send, purchase, or change account state must stay in the
 * user's hands until the trusted command channel is implemented.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface NativeEnvelope {
	receivedAt?: number;
	message?: {
		type?: string;
		commandId?: string;
		command?: string;
		ok?: boolean;
		result?: unknown;
		error?: string;
		createdAt?: number;
		snapshot?: unknown;
		tabs?: unknown;
		payload?: unknown;
		[key: string]: unknown;
	};
}

async function readMessages(limit = 40): Promise<NativeEnvelope[]> {
	const path = process.env.CETUS_CHROME_USE_MESSAGES?.trim();
	if (!path) return [];
	const fs = await import("node:fs/promises");
	let raw = "";
	try {
		raw = await fs.readFile(path, "utf8");
	} catch {
		return [];
	}
	const out: NativeEnvelope[] = [];
	for (const line of raw.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			out.push(JSON.parse(s) as NativeEnvelope);
		} catch {
			// skip malformed lines
		}
	}
	return out.slice(-Math.max(1, Math.min(limit, 200)));
}

async function appendCommand(command: string, params: Record<string, unknown> = {}): Promise<string> {
	const path = process.env.CETUS_CHROME_USE_COMMANDS?.trim();
	if (!path) throw new Error("CETUS_CHROME_USE_COMMANDS is not configured");
	const fs = await import("node:fs/promises");
	const nodePath = await import("node:path");
	await fs.mkdir(nodePath.dirname(path), { recursive: true });
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await fs.appendFile(
		path,
		JSON.stringify({ type: "command", id, command, params, createdAt: Date.now() }) + "\n",
		"utf8",
	);
	return id;
}

async function waitForCommandResult(commandId: string, timeoutMs: number): Promise<NativeEnvelope | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const messages = await readMessages(200);
		const match = newestOfCommand(messages, commandId);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return null;
}

function newestOf(messages: NativeEnvelope[], type: string): NativeEnvelope | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.message?.type === type) return messages[i];
	}
	return null;
}

function newestOfCommand(messages: NativeEnvelope[], commandId: string): NativeEnvelope | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.message;
		if (msg?.type === "command_result" && msg.commandId === commandId) return messages[i];
	}
	return null;
}

function text(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function noChromeData(): string {
	return [
		"No Chrome Use data is available yet.",
		"",
		"To provide Chrome context, the user needs to:",
		"1. Install the Chrome native host from Plugins > Chrome Use.",
		"2. Load the Cetus Chrome Use extension in chrome://extensions.",
		"3. Open the extension popup and click Connect, or keep the popup open briefly after enabling Chrome Use.",
	].join("\n");
}

function normalizeUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("url is required");
	if (/^(https?:|about:)/i.test(trimmed)) return trimmed;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
		return `http://${trimmed}`;
	}
	return `https://${trimmed}`;
}

function commandBody(envelope: NativeEnvelope): unknown {
	return envelope.message?.type === "command_result" ? envelope.message.result : envelope.message;
}

function commandError(envelope: NativeEnvelope | null): string | null {
	if (!envelope) return "Chrome extension did not return a result before timeout.";
	if (envelope.message?.type === "command_result" && envelope.message.ok === false) {
		return envelope.message.error || "Chrome command failed.";
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "chrome_use_status",
			label: "Chrome Use status",
			description:
				"Check whether the user's real Chrome profile has sent any context to Cetus through the Chrome Use extension.",
			parameters: Type.Object({}),
			async execute() {
				const messages = await readMessages(1);
				const path = process.env.CETUS_CHROME_USE_MESSAGES?.trim() || "";
				return {
					content: [
						{
							type: "text",
							text: messages.length
								? `Chrome Use inbox is available at ${path}. Last message:\n\n${text(messages[messages.length - 1])}`
								: noChromeData(),
						},
					],
					details: { available: messages.length > 0, path },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_recent_messages",
			label: "Recent Chrome messages",
			description:
				"Read recent messages sent by the Cetus Chrome extension from the user's real Chrome profile. Use this for debugging the Chrome Use bridge.",
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Number({ description: "Max messages to return. Default 10, max 50.", minimum: 1 }),
				),
			}),
			async execute(_toolCallId, params) {
				const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
				const messages = await readMessages(limit);
				if (messages.length === 0) {
					return { content: [{ type: "text", text: noChromeData() }] };
				}
				return {
					content: [{ type: "text", text: text(messages) }],
					details: { count: messages.length },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_active_tab_snapshot",
			label: "Chrome active tab snapshot",
			description:
				"Read the latest active-tab snapshot sent by the Cetus Chrome extension. This is the user's real Chrome tab, including logged-in page context the managed Browser surface cannot see.",
			parameters: Type.Object({}),
			async execute() {
				const messages = await readMessages(100);
				let latest = newestOf(messages, "active_tab_snapshot") ?? newestOf(messages, "content_context");
				try {
					const commandId = await appendCommand("active_tab_snapshot");
					const result = await waitForCommandResult(commandId, 5000);
					if (result?.message?.ok) latest = result;
				} catch {
					// Fall back to the newest cached extension message.
				}
				if (!latest) {
					return { content: [{ type: "text", text: noChromeData() }] };
				}
				return {
					content: [{ type: "text", text: text(commandBody(latest)) }],
					details: { receivedAt: latest.receivedAt, type: latest.message?.type },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_list_tabs",
			label: "Chrome tab list",
			description:
				"Read the latest tab list sent by the Cetus Chrome extension from the user's current Chrome window.",
			parameters: Type.Object({}),
			async execute() {
				const messages = await readMessages(100);
				let latest = newestOf(messages, "list_tabs");
				try {
					const commandId = await appendCommand("list_tabs");
					const result = await waitForCommandResult(commandId, 5000);
					if (result?.message?.ok) latest = result;
				} catch {
					// Fall back to the newest cached extension message.
				}
				if (!latest) {
					return { content: [{ type: "text", text: noChromeData() }] };
				}
				return {
					content: [{ type: "text", text: text(commandBody(latest) ?? latest.message?.tabs ?? latest.message) }],
					details: { receivedAt: latest.receivedAt },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_page_snapshot",
			label: "Chrome page snapshot",
			description:
				"Request a fresh list of visible interactive elements from the user's real Chrome page. Use the returned element uid with chrome_click or chrome_fill.",
			parameters: Type.Object({
				tabId: Type.Optional(
					Type.Number({ description: "Optional Chrome tab id. Defaults to the active tab.", minimum: 1 }),
				),
				maxElements: Type.Optional(
					Type.Number({ description: "Maximum elements to return. Default 80, max 200.", minimum: 1 }),
				),
			}),
			async execute(_toolCallId, params) {
				const commandId = await appendCommand("page_snapshot", {
					tabId: params.tabId,
					maxElements: Math.min(Math.max(params.maxElements ?? 80, 1), 200),
				});
				const result = await waitForCommandResult(commandId, 5000);
				const err = commandError(result);
				if (err) return { content: [{ type: "text", text: err }] };
				return {
					content: [{ type: "text", text: text(commandBody(result as NativeEnvelope)) }],
					details: { receivedAt: result?.receivedAt },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_select_tab",
			label: "Select Chrome tab",
			description:
				"Select an existing tab in the user's real Chrome by tab id, then return a fresh snapshot. Use chrome_list_tabs first to find tab ids.",
			parameters: Type.Object({
				tabId: Type.Number({ description: "Chrome tab id returned by chrome_list_tabs.", minimum: 1 }),
			}),
			async execute(_toolCallId, params) {
				const commandId = await appendCommand("select_tab", { tabId: params.tabId });
				const result = await waitForCommandResult(commandId, 5000);
				const err = commandError(result);
				if (err) return { content: [{ type: "text", text: err }] };
				return {
					content: [{ type: "text", text: text(commandBody(result as NativeEnvelope)) }],
					details: { receivedAt: result?.receivedAt },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_click",
			label: "Click Chrome element",
			description:
				"Click a visible page element in the user's real Chrome by uid from chrome_page_snapshot. Requires user confirmation. Do not use for submit/send/purchase/delete/login/account/security actions unless the user explicitly confirms the exact action.",
			parameters: Type.Object({
				uid: Type.String({ description: "Element uid from chrome_page_snapshot, e.g. e3." }),
				tabId: Type.Optional(
					Type.Number({ description: "Optional Chrome tab id. Defaults to the active tab.", minimum: 1 }),
				),
				reason: Type.Optional(
					Type.String({ description: "Short user-facing reason for this click." }),
				),
				allowConsequential: Type.Optional(
					Type.Boolean({
						description:
							"Set true only after the user explicitly confirms a consequential click such as submit, send, publish, delete, purchase, login, save, or account/security changes.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (typeof ctx?.ui?.confirm !== "function") {
					return {
						content: [
							{ type: "text", text: "chrome_click requires user confirmation, but confirmation UI is unavailable." },
						],
					};
				}
				const ok = await ctx.ui.confirm(
					params.allowConsequential ? "Confirm consequential Chrome click" : "Confirm Chrome click",
					[
						`Click element ${params.uid}${params.tabId ? ` in tab ${params.tabId}` : ""}?`,
						params.allowConsequential
							? "This is marked as consequential. Only approve if you intend the exact final action."
							: "",
						params.reason || "",
					].filter(Boolean).join("\n"),
				);
				if (!ok) return { content: [{ type: "text", text: "Cancelled by user." }] };
				const commandId = await appendCommand("click", {
					uid: params.uid,
					tabId: params.tabId,
					allowConsequential: params.allowConsequential === true,
				});
				const result = await waitForCommandResult(commandId, 5000);
				const err = commandError(result);
				if (err) return { content: [{ type: "text", text: err }] };
				return {
					content: [{ type: "text", text: text(commandBody(result as NativeEnvelope)) }],
					details: { receivedAt: result?.receivedAt },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_fill",
			label: "Fill Chrome element",
			description:
				"Fill a visible input/textarea/contenteditable element in the user's real Chrome by uid from chrome_page_snapshot. Requires user confirmation. The extension refuses password, file, and hidden inputs.",
			parameters: Type.Object({
				uid: Type.String({ description: "Element uid from chrome_page_snapshot, e.g. e5." }),
				text: Type.String({ description: "Text to put into the field. Do not provide passwords, tokens, payment details, or secrets." }),
				tabId: Type.Optional(
					Type.Number({ description: "Optional Chrome tab id. Defaults to the active tab.", minimum: 1 }),
				),
				reason: Type.Optional(
					Type.String({ description: "Short user-facing reason for this fill." }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (typeof ctx?.ui?.confirm !== "function") {
					return {
						content: [
							{ type: "text", text: "chrome_fill requires user confirmation, but confirmation UI is unavailable." },
						],
					};
				}
				const preview = params.text.length > 120 ? `${params.text.slice(0, 120)}...` : params.text;
				const ok = await ctx.ui.confirm(
					"Confirm Chrome fill",
					`Fill element ${params.uid}${params.tabId ? ` in tab ${params.tabId}` : ""} with:\n${preview}\n\n${params.reason || ""}`.trim(),
				);
				if (!ok) return { content: [{ type: "text", text: "Cancelled by user." }] };
				const commandId = await appendCommand("fill", { uid: params.uid, text: params.text, tabId: params.tabId });
				const result = await waitForCommandResult(commandId, 5000);
				const err = commandError(result);
				if (err) return { content: [{ type: "text", text: err }] };
				return {
					content: [{ type: "text", text: text(commandBody(result as NativeEnvelope)) }],
					details: { receivedAt: result?.receivedAt },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "chrome_navigate",
			label: "Navigate Chrome tab",
			description:
				"Navigate the active tab, or a specific tab id, in the user's real Chrome. Requires user confirmation. Do not use for submitting forms, sending messages, purchases, account/security settings, or authentication.",
			parameters: Type.Object({
				url: Type.String({ description: "URL to open. Bare domains are normalized to https://." }),
				tabId: Type.Optional(
					Type.Number({ description: "Optional Chrome tab id. Defaults to the active tab.", minimum: 1 }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const url = normalizeUrl(params.url);
				if (typeof ctx?.ui?.confirm !== "function") {
					return {
						content: [
							{
								type: "text",
								text: "chrome_navigate requires user confirmation, but confirmation UI is unavailable.",
							},
						],
					};
				}
				const ok = await ctx.ui.confirm(
					"Confirm Chrome navigation",
					`Navigate ${params.tabId ? `tab ${params.tabId}` : "the active tab"} to:\n${url}`,
				);
				if (!ok) return { content: [{ type: "text", text: "Cancelled by user." }] };
				const commandId = await appendCommand("navigate", { url, tabId: params.tabId });
				const result = await waitForCommandResult(commandId, 8000);
				const err = commandError(result);
				if (err) return { content: [{ type: "text", text: err }] };
				return {
					content: [{ type: "text", text: text(commandBody(result as NativeEnvelope)) }],
					details: { receivedAt: result?.receivedAt },
				};
			},
		}),
	);
}
