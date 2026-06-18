/**
 * heal-tool-calls.ts — let the user always send a new message, no matter how the
 * previous run ended (Claude-Code-style resilience).
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * When a run is interrupted mid-tool-call (the user hits Stop, the pi process
 * dies, the window is closed) the session can be left with an assistant message
 * that emitted a `toolCall` but never got a matching `toolResult`. The model
 * APIs cetus talks to (DeepSeek / any OpenAI-compatible provider, Anthropic, …)
 * REQUIRE every tool call to be answered by a tool result before the next user
 * turn. So on resume, the very next prompt would build an invalid request and
 * the provider rejects it — the user is stuck and has to "Regenerate" or start a
 * new chat just to get unwedged.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 * The `context` hook fires right before each provider request with the full
 * message list and lets us return a replacement. We scan for any `toolCall`
 * whose id has no corresponding `toolResult` and splice a synthetic
 * "interrupted" result in right after the assistant message that made the call.
 * That makes the request well-formed, so a fresh prompt on top of an interrupted
 * turn just works.
 *
 * This is applied to the REQUEST CONTEXT only — we never write the synthetic
 * result back into the stored session, so history stays honest (the dangling
 * call still renders as "interrupted" in the UI). The hook is idempotent: once a
 * real result exists the call is "satisfied" and we leave it alone, and an
 * already-healed transcript re-heals identically every turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shown to the model in place of the missing tool output. */
const INTERRUPTED_RESULT =
	"[Tool call interrupted — no result was produced. The previous run was " +
	"stopped before this tool returned. Continue based on the user's next " +
	"message; re-run the tool if you still need its output.]";

// The context event hands us messages in pi-ai shape. We only need a few fields,
// so type them structurally rather than importing the full union (extensions are
// loaded independently and lean on loose typing — see web-search.ts).
interface ToolCallBlock {
	type: "toolCall";
	id?: string;
	name?: string;
}
interface Message {
	role?: string;
	content?: unknown;
	toolCallId?: string;
}

function isToolCallBlock(b: unknown): b is ToolCallBlock {
	return (
		typeof b === "object" &&
		b !== null &&
		(b as { type?: unknown }).type === "toolCall"
	);
}

export default function healToolCalls(pi: ExtensionAPI) {
	pi.on("context", async (event: { messages: Message[] }) => {
		const messages = event.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;

		// First pass: every tool-call id that already has a result anywhere.
		const satisfied = new Set<string>();
		for (const m of messages) {
			if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
				satisfied.add(m.toolCallId);
			}
		}

		// Second pass: rebuild, inserting a synthetic result directly after the
		// assistant message holding any unsatisfied call (the provider requires the
		// result to immediately follow the call, before any other role).
		let changed = false;
		const out: Message[] = [];
		for (const m of messages) {
			out.push(m);
			if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const block of m.content) {
				if (!isToolCallBlock(block) || typeof block.id !== "string") continue;
				if (satisfied.has(block.id)) continue;
				satisfied.add(block.id); // guard against a second insert for the same id
				out.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name ?? "",
					content: [{ type: "text", text: INTERRUPTED_RESULT }],
					isError: true,
					timestamp: Date.now(),
				} as Message);
				changed = true;
			}
		}

		if (!changed) return;
		return { messages: out };
	});
}
