/**
 * cetus custom DeepSeek endpoint.
 *
 * Users behind a proxy, a self-host, or a region-restricted network can point
 * all DeepSeek traffic at a different OpenAI-compatible base URL. The cetus host
 * persists that override and injects it as `DEEPSEEK_BASE_URL` into pi's spawn
 * env (see `provider.rs` / `lib.rs::pi_for`). Here we override the built-in
 * `deepseek` provider's baseUrl so the main agent's model calls go there too;
 * the out-of-band helper calls (titling / dream / skill review / meeting) are
 * redirected host-side. Absent or blank → no-op, pi keeps stock api.deepseek.com.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const base = process.env.DEEPSEEK_BASE_URL?.trim();
  if (!base) return;
  // Only baseUrl → overrides the URL for the provider's existing models, leaving
  // the model catalog and the host-injected DEEPSEEK_API_KEY untouched.
  pi.registerProvider("deepseek", { baseUrl: base });
}
