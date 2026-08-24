/**
 * cetus custom model providers.
 *
 * Settings → Models lets the user add OpenAI-compatible providers (base URL +
 * API key + model ids). The cetus host persists them and exports
 * `<app_data>/custom-models.json` (path in `CETUS_MODELS_CONFIG`); API keys
 * stay in the OS keychain and arrive here as env vars whose *names* the
 * config carries (`keyEnv`). This extension registers each provider with pi's
 * model registry at startup, so the conversation model picker can select
 * `<provider-id>/<model-id>` exactly like the built-in DeepSeek tiers.
 *
 * Config changes don't hot-reload: the host recycles idle pis on save (same
 * pattern as API-key changes), and the next spawn re-reads the file. Absent
 * or empty config → no-op.
 *
 * Models declaring `vision: true` register with `input: ["text", "image"]`,
 * which makes pi pass attached images through natively AND makes the
 * vision-bridge extension's transcription fallback skip itself (it checks
 * `ctx.model.input`).
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ConfigModel {
	id: string;
	name?: string;
	vision?: boolean;
	/** Model takes a reasoning-effort knob (registers a thinkingLevelMap). */
	reasoning?: boolean;
	/** Enabled thinking levels → endpoint token ("" = send the level name).
	 *  Levels absent from the map register as null = unavailable. */
	thinkingLevels?: Record<string, string>;
	/** pi compat.thinkingFormat: "" standard | "deepseek" | "openrouter" | "together". */
	thinkingFormat?: string;
	contextWindow?: number;
	maxTokens?: number;
}

/** pi's full thinking-level axis (EXTENDED_THINKING_LEVELS order). */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Registry map from the user's enabled-levels config. Rules learned from the
 *  runtime: a level mapped to null is filtered from availability; an unmapped
 *  non-off level passes through by name; "max"/"xhigh" must be explicitly
 *  mapped to be available at all; "off" is availability-only (the driver
 *  omits the effort for it), so an enabled off stays unmapped. */
function buildThinkingLevelMap(
	levels: Record<string, string> | undefined,
): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	for (const lvl of PI_LEVELS) {
		const enabled = levels != null && lvl in levels;
		if (!enabled) {
			map[lvl] = null;
			continue;
		}
		const token = levels[lvl]?.trim();
		if (lvl === "off") {
			// Omit: off's availability comes from "not null"; its behavior
			// (no effort sent / thinking disabled) is the driver's default.
			continue;
		}
		if (token) map[lvl] = token;
		else if (lvl === "xhigh" || lvl === "max") map[lvl] = lvl;
		// else omit → passthrough by level name.
	}
	return map;
}

interface ConfigProvider {
	id: string;
	name?: string;
	baseUrl: string;
	keyEnv?: string;
	models?: ConfigModel[];
}

export default function (pi: ExtensionAPI) {
	const path = process.env.CETUS_MODELS_CONFIG?.trim();
	if (!path) return;
	let providers: ConfigProvider[];
	try {
		const cfg = JSON.parse(readFileSync(path, "utf8"));
		providers = Array.isArray(cfg?.providers) ? cfg.providers : [];
	} catch {
		// Missing or malformed file → no custom providers this session.
		return;
	}
	for (const p of providers) {
		if (!p?.id || !p.baseUrl || !p.models?.length) continue;
		try {
			pi.registerProvider(p.id, {
				name: p.name || p.id,
				baseUrl: p.baseUrl,
				api: "openai-completions",
				// pi drops providers whose key doesn't resolve; local/keyless
				// endpoints get a placeholder so their models stay selectable.
				apiKey: (p.keyEnv && process.env[p.keyEnv]) || "cetus-no-key",
				models: p.models
					.filter((m) => m?.id)
					.map((m) => ({
						id: m.id,
						name: m.name || m.id,
						reasoning: Boolean(m.reasoning),
						...(m.reasoning
							? { thinkingLevelMap: buildThinkingLevelMap(m.thinkingLevels) }
							: {}),
						...(m.reasoning && m.thinkingFormat
							? { compat: { thinkingFormat: m.thinkingFormat } }
							: {}),
						input: m.vision ? ["text", "image"] : ["text"],
						contextWindow: m.contextWindow || 128_000,
						maxTokens: m.maxTokens || 8_192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
			});
		} catch (e) {
			// One bad provider must not take down the rest (or the agent).
			console.error(`custom-models: failed to register ${p.id}:`, e);
		}
	}
}
