/**
 * cetus vision bridge — lets a text-only chat model "see" attached images.
 *
 * cetus's default model is DeepSeek V4, which has **no image input**. pi's
 * provider layer (`transform-messages.js → downgradeUnsupportedImages`)
 * therefore replaces every attached image with the literal placeholder
 *   "(image omitted: model does not support images)"
 * before the request is sent, so the model is blind to any screenshot/photo the
 * user attaches. That placeholder is exactly the symptom seen in the trace.
 *
 * This extension hooks the `input` event (fired when the user submits a prompt,
 * before the agent loop runs). When the active model can't take images AND the
 * turn carries some, we transcribe each image to text via a vision model, then
 * rewrite the turn to **drop the raw images** and **append the transcriptions**,
 * so the text-only model receives a faithful textual description instead of the
 * "(image omitted)" stub.
 *
 * When a vision-capable model is active, this is a no-op — images pass through
 * untouched (same policy as pi's own downgrade check).
 *
 * Providers: an ordered OpenAI-compatible chain built by
 * `bridge/vision-config.ts` from the user's Settings choice (vision.json via
 * CETUS_VISION_CONFIG) plus whichever API keys are configured — Gemini (via
 * its OpenAI-compat endpoint), Volcano Ark/Doubao, Zhipu, DashScope, Moonshot,
 * local Ollama, or a custom endpoint. Any failure (including Gemini's 400
 * "User location is not supported" geo-block) falls through to the next
 * provider; the actual HTTP client is the shared `bridge/vision-core.ts`
 * (same file dsh-vision uses).
 * If EVERY provider fails, the turn is annotated so the agent tells the user it
 * could not read the image instead of confabulating an answer from elsewhere.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { errMsg } from "./bridge/protocol";
import { visionChain } from "./bridge/vision-core";
import { buildVisionChain, NO_PROVIDER_HINT } from "./bridge/vision-config";

/** Per-request round-trip cap. The `input` handler blocks the prompt turn,
 *  which the cetus host drives with the STALL-based timeout, not the 30s request
 *  timeout: `send_prompt` dispatches via `request_streaming`
 *  (src-tauri/src/pi_rpc.rs), which fails a turn only after pi emits NOTHING on
 *  stdout for `stall_timeout` (120s). So the real bound is 120s of silence, and
 *  this cap just needs to leave headroom under it.
 *
 *  gemini-3.5-flash is a reasoning model: a faithful transcription of a busy
 *  full-resolution screenshot is typically ~20-25s but can spike to ~50s on a
 *  slow round-trip. 45s was still too tight — a 50s response got aborted and the
 *  user saw "(could not be read: The operation was aborted.)". 80s comfortably
 *  covers the slow tail while staying well under the 120s stall window. (The
 *  typical case is far quicker; this is only the safety abort.) */
const TIMEOUT_MS = 80_000;

/** Hard ceiling on the WHOLE transcription step (all images), a final guard so
 *  the input handler returns before the host's 120s stall window even if the
 *  provider hangs past its own cap. Images run concurrently, so the normal worst
 *  case is ~one image's request budget; this only trips on a pathological hang. */
const OVERALL_BUDGET_MS = 95_000;

/** A faithful screenshot transcription measured ~1.4k tokens on Gemini; leave
 *  generous headroom for dense UIs and thinking-mode VLMs that burn budget on
 *  reasoning before the answer. */
const MAX_TOKENS = 4096;

/** Instruction given to the vision model. Kept terse + faithful: we want a
 *  description the downstream text model can reason about, not a summary. */
const TRANSCRIBE_PROMPT =
	"Describe this image in full, faithful detail so someone who cannot see it " +
	"can understand and reason about it. Transcribe ALL visible text verbatim " +
	"(UI labels, code, errors, captions). Note layout, diagrams, charts, colors, " +
	"and anything that carries meaning. Do not add commentary or speculation.";

// ---- UI helper -------------------------------------------------------------

/** Notify the user, but only when a UI is actually attached. cetus runs pi in
 *  RPC mode (`ctx.hasUI === false`), where `ctx.ui.notify` may be unavailable and
 *  calling it can throw — which would abort the whole input handler and silently
 *  drop the transcription. Guard every UI call through here. */
function safeNotify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		/* UI not available in this mode — ignore. */
	}
}

// ---- Vision provider -------------------------------------------------------

/** Transcribe one image through the configured provider chain. */
async function transcribeImage(img: ImageContent): Promise<string> {
	const chain = await buildVisionChain();
	if (chain.length === 0) throw new Error(NO_PROVIDER_HINT);
	const source = `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
	const { text } = await visionChain(chain, {
		source,
		question: TRANSCRIBE_PROMPT,
		maxTokens: MAX_TOKENS,
		timeoutMs: TIMEOUT_MS,
		label: "vision",
	});
	return text;
}

// ---- Extension entry -------------------------------------------------------

export default function visionBridge(pi: ExtensionAPI) {
	pi.on("input", async (event, ctx: ExtensionContext) => {
		// Don't touch extension-injected messages (e.g. our own transformed turn,
		// or other extensions' messages) — only real user input carries images.
		if (event.source === "extension") return { action: "continue" };

		const images = event.images ?? [];
		if (images.length === 0) return { action: "continue" };

		// If the active model can take images, let them through untouched. When
		// the model is unknown (RPC startup race), assume text-only — cetus's
		// default DeepSeek has no vision, so transcribing is the safe choice.
		const supportsImages = ctx.model?.input?.includes("image") ?? false;
		if (supportsImages) return { action: "continue" };

		// Transcribe all images CONCURRENTLY. The `input` event blocks the prompt
		// turn, which the cetus host drives with a 120s STALL window
		// (src-tauri/src/pi_rpc.rs request_streaming) — running images in parallel
		// keeps the worst case at roughly one image's budget instead of summing
		// them. (No "reading…" toast — the transform speaks for itself.)
		const labelFor = (i: number) =>
			images.length > 1 ? `[Image ${i + 1}]` : "[Image]";
		const transcribeAll = Promise.all(
			images.map((img, i) =>
				transcribeImage(img)
					.then((desc) => ({ ok: true, block: `${labelFor(i)}\n${desc}` }))
					.catch((e) => ({
						ok: false,
						block: `${labelFor(i)} (could not be read: ${errMsg(e)})`,
					})),
			),
		);

		// Final guard: never let this handler block the host's prompt-ack past
		// its timeout, even if the provider hangs beyond its own per-request cap.
		const budget = new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), OVERALL_BUDGET_MS),
		);
		const settled = await Promise.race([transcribeAll, budget]);

		let blocks: string[];
		let anyOk: boolean;
		if (settled === null) {
			blocks = images.map(
				(_, i) =>
					`${labelFor(i)} (could not be read: vision transcription timed out)`,
			);
			anyOk = false;
		} else {
			blocks = settled.map((r) => r.block);
			anyOk = settled.some((r) => r.ok);
		}

		if (!anyOk) {
			safeNotify(ctx, "Could not read attached image(s)", "error");
		}

		// When NOT a single image could be read, the model would otherwise be blind
		// but still under pressure to answer — and may confabulate (e.g. pull an
		// unrelated error from screen history and present it as "your" error). Steer
		// it to be honest instead: own the failure, don't invent.
		const honesty = anyOk
			? ""
			: "\n\nNOTE TO ASSISTANT: the attached image(s) could not be read (vision " +
			  "transcription failed for all of them). Do NOT guess what the image showed, " +
			  "and do NOT substitute information from screen history, OCR, or other sources " +
			  "as if it were the attached image. Tell the user plainly that you couldn't read " +
			  "the screenshot, and ask them to paste the text/error directly or re-attach it.";

		const appendix =
			"--- Attached image(s), transcribed for a text-only model ---\n" +
			blocks.join("\n\n") +
			honesty;
		const base = event.text.trim();
		const text = base ? `${base}\n\n${appendix}` : appendix;

		// Drop the raw images: the model can't use them, and leaving them in only
		// triggers pi's "(image omitted)" placeholder. The transcription replaces
		// them.
		return { action: "transform", text, images: [] };
	});
}
