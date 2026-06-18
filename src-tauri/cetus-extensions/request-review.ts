/**
 * cetus request_review extension.
 *
 * The agent's human-in-the-loop handoff. When the agent has produced work the
 * user should look over before it counts as done — or needs the user to make a
 * decision before it continues — it calls this tool with a short summary (and
 * optionally a few specific questions). cetus parks the conversation in the
 * board's "Needs review" column where the user can approve it or send it back
 * with feedback.
 *
 * Like send_artifact, the tool transports nothing heavy: it just returns a
 * structured `details` payload the cetus frontend recognises (`kind:
 * "review_request"`) and reacts to by flipping the conversation's persisted
 * review state to "pending". This is intentionally non-blocking — the tool
 * resolves immediately and the agent should then wrap up its turn rather than
 * spin waiting for an answer; the user's reply arrives as a fresh prompt.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PARAMS = Type.Object({
	summary: Type.String({
		description:
			"A short, user-facing summary of what you did and what you want the " +
			"user to review or decide. One or two sentences.",
	}),
	questions: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional specific questions or decision points for the user, one " +
				"string each. Use when you need explicit choices made before continuing.",
		}),
	),
});

const requestReviewTool = defineTool({
	name: "request_review",
	label: "Request Review",
	description:
		"Hand the task to the user for review or a decision. Call this when you've " +
		"finished something the user should approve before it's considered done, or " +
		"when you need the user to choose between options before you can continue. " +
		"Pass a short `summary` of what you want reviewed and, optionally, specific " +
		"`questions`. cetus moves this task into the 'Needs review' column; do not " +
		"keep working or block waiting — end your turn after calling this.",
	parameters: PARAMS,

	async execute(_toolCallId, params) {
		const summary = params.summary.trim();
		if (!summary) {
			return {
				content: [{ type: "text", text: "request_review: summary is empty." }],
				details: { error: "empty_summary" },
				isError: true,
			};
		}
		const questions = (params.questions ?? [])
			.map((q) => q.trim())
			.filter((q) => q.length > 0);

		const lines = [`Sent to the user for review: ${summary}`];
		if (questions.length > 0) {
			lines.push("Questions:");
			for (const q of questions) lines.push(`- ${q}`);
		}
		// The model gets a terse text confirmation; the rich payload is in details
		// so the cetus frontend can render the review prompt + actions without
		// parsing prose.
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				kind: "review_request",
				summary,
				questions: questions.length > 0 ? questions : null,
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(requestReviewTool);
}
