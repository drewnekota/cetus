/**
 * cetus-specific vision provider selection: turns the user's Settings choice
 * (exported by the host to `<app_data>/vision.json`, path in
 * `CETUS_VISION_CONFIG`) plus the configured API keys (env, from the keychain)
 * into an ordered VisionProviderSpec chain for vision-core.
 *
 * The config file is re-read on EVERY call — the host rewrites it when the
 * user changes the setting, so a new choice takes effect on the next turn
 * without recycling pi (same pattern as CETUS_MCP_CONFIG).
 */

import { readFile } from "node:fs/promises";
import { isLocalEndpoint, type VisionProviderSpec } from "./vision-core";

/** Preset OpenAI-compatible endpoints. Keys come from cetus Settings → API
 *  keys (injected as env at pi spawn; see secrets.rs KNOWN_PROVIDERS). Keep
 *  provider ids in sync with vision.rs SELECTABLE_PROVIDERS and the Settings
 *  dropdown. */
const PRESETS: Record<string, { baseURL: string; apiKeyEnv?: string; defaultModel: string; fallbackModels?: string[] }> = {
	// Gemini through its OpenAI-compatibility endpoint — same key as before.
	gemini: {
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		apiKeyEnv: "GEMINI_API_KEY",
		defaultModel: "gemini-3.5-flash",
	},
	// Volcano Ark (Doubao multimodal). CETUS_VISION_FALLBACK_MODEL predates the
	// vision.json config and still overrides the default model id here.
	volc_ark: {
		baseURL: "https://ark.cn-beijing.volces.com/api/v3",
		apiKeyEnv: "ARK_API_KEY",
		defaultModel: process.env.CETUS_VISION_FALLBACK_MODEL?.trim() || "doubao-seed-1-6-250615",
	},
	// Zhipu / BigModel — glm-4.6v-flash is free, but the free tier gets
	// congested (HTTP 200 body error / 429 code 1305); older free models still
	// answer, so they ride along as same-provider fallbacks (mirrors
	// dsh-vision's DEFAULT_FREE_FALLBACKS).
	zhipu: {
		baseURL: "https://open.bigmodel.cn/api/paas/v4",
		apiKeyEnv: "ZHIPUAI_API_KEY",
		defaultModel: "glm-4.6v-flash",
		fallbackModels: ["glm-4.1v-thinking-flash", "glm-4v-flash"],
	},
	// Alibaba DashScope (Qwen VL).
	dashscope: {
		baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: "DASHSCOPE_API_KEY",
		defaultModel: "qwen3-vl-flash",
	},
	// Moonshot (Kimi).
	moonshot: {
		baseURL: "https://api.moonshot.cn/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
		defaultModel: "kimi-k3",
	},
	// Local Ollama — no key. Only used when explicitly selected (auto mode
	// skips it: most users don't run a local model server).
	ollama: {
		baseURL: "http://localhost:11434/v1",
		defaultModel: "qwen3-vl:4b",
	},
};

/** Fallback order in auto mode and after the chosen provider fails. */
const AUTO_ORDER = ["gemini", "volc_ark", "zhipu", "dashscope", "moonshot"];

interface VisionConfigFile {
	provider?: string;
	model?: string;
	baseUrl?: string;
}

async function readConfigFile(): Promise<VisionConfigFile> {
	const path = process.env.CETUS_VISION_CONFIG?.trim();
	if (!path) return {};
	try {
		return JSON.parse(await readFile(path, "utf8")) as VisionConfigFile;
	} catch {
		return {}; // missing/corrupt file = auto mode
	}
}

/** Chain entries for one preset: the default (or user-overridden) model, plus
 *  same-provider fallback models — but only when the user did NOT pin a model,
 *  same policy as dsh-vision. Empty when the key is missing. */
function presetSpecs(id: string, model?: string, baseURL?: string): VisionProviderSpec[] {
	const preset = PRESETS[id];
	if (!preset) return [];
	const url = baseURL?.trim() || preset.baseURL;
	const apiKey = preset.apiKeyEnv ? process.env[preset.apiKeyEnv]?.trim() ?? "" : "";
	if (apiKey === "" && !isLocalEndpoint(url)) return [];
	const pinned = model?.trim() ?? "";
	const models = pinned !== "" ? [pinned] : [preset.defaultModel, ...preset.fallbackModels ?? []];
	return models.map((m) => ({ id, baseURL: url, model: m, apiKey }));
}

/**
 * Ordered provider chain: the user's choice first (with their model/baseURL
 * overrides), then every other preset with a configured key, in AUTO_ORDER.
 * May be empty — the caller owns the "nothing configured" message.
 */
export async function buildVisionChain(): Promise<VisionProviderSpec[]> {
	const cfg = await readConfigFile();
	const chain: VisionProviderSpec[] = [];
	const provider = cfg.provider?.trim() ?? "";

	if (provider === "custom") {
		const url = cfg.baseUrl?.trim();
		if (url) {
			// Custom endpoints reuse the generic VISION_API_KEY escape hatch.
			const apiKey = process.env.VISION_API_KEY?.trim() ?? "";
			if (apiKey !== "" || isLocalEndpoint(url)) {
				chain.push({ id: "custom", baseURL: url, model: cfg.model?.trim() || "", apiKey });
			}
		}
	} else if (provider !== "") {
		chain.push(...presetSpecs(provider, cfg.model, provider === "ollama" ? cfg.baseUrl : undefined));
	}

	for (const id of AUTO_ORDER) {
		if (id === provider) continue;
		chain.push(...presetSpecs(id));
	}
	return chain;
}

/** One user-facing sentence for "no provider worked because none is set up". */
export const NO_PROVIDER_HINT =
	"no vision provider configured — add a Gemini / Volcano Ark / Zhipu / DashScope / Moonshot API key (or pick a vision provider) in cetus Settings → API keys";
