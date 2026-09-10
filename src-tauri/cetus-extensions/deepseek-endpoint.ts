/** Built-in DeepSeek Flash provider. Keep native image support independent of
 * the model catalog bundled with pi; custom endpoints still apply. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("deepseek", {
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
    api: "openai-completions",
    apiKey: process.env.DEEPSEEK_API_KEY,
    models: [{
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      // Off-peak USD estimates; actual billing is determined by DeepSeek.
      cost: { input: 0.14, output: 0.56, cacheRead: 0.0028, cacheWrite: 0 },
    }],
  });
}
