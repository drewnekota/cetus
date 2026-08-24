//! Applying a conversation's model choice to a live pi sidecar.
//!
//! ## Why this file owns an error-message translation
//!
//! pi ≥0.82 filters its model registry by *configured credentials*: a provider
//! with no resolvable API key is dropped from `getAvailable()` entirely, so
//! `set_model` answers `Model not found: deepseek/deepseek-v4-pro` — the exact
//! same wording it uses for a model id that genuinely doesn't exist. Cetus
//! hands the key to pi through the child's environment (`DEEPSEEK_API_KEY`,
//! see `secrets::load_env`), so the real meaning of that error is almost always
//! "the agent started without a DeepSeek key", not "the bundled runtime is out
//! of date". Two releases were spent chasing the wrong half of that ambiguity
//! (a model-registry gate in scripts/build-pi-sidecar.sh, a runtime-refresh
//! marker in lib.rs) because the raw message pointed at the runtime.
//!
//! So: check the credential store before we ask, and rewrite pi's message when
//! the model it can't find is the one we ship.
//!
//! Custom providers (Settings → Models) register through the
//! `custom-models.ts` extension at pi startup; their `Model not found` has a
//! third meaning — the provider/model was deleted from settings after this
//! conversation picked it — which gets its own message.

use crate::custom_models;
use crate::model::{ModelChoice, ModelRef};
use crate::pi_rpc::PiRpc;
use crate::secrets;
use crate::store::Store;
use anyhow::{bail, Result};

/// Provider id in [`secrets::KNOWN_PROVIDERS`] backing the built-in models.
const PROVIDER: &str = "deepseek";

pub async fn apply_choice(pi: &PiRpc, store: &Store, choice: &ModelChoice) -> Result<()> {
    match &choice.model {
        ModelRef::Builtin(tier) => {
            let model_id = tier.api_id();
            if !secrets::has(PROVIDER) {
                bail!("{}", missing_key_message());
            }
            if let Err(e) = pi.set_model(PROVIDER, model_id).await {
                let raw = e.to_string();
                if is_model_not_found(&raw, model_id) {
                    // The key is in our store but pi didn't see it — a keychain read
                    // that failed after the cached snapshot, or an env that never
                    // reached the child. Say that, instead of blaming the model id.
                    bail!("{} (pi reported: {raw})", missing_key_message());
                }
                return Err(e);
            }
            // The DeepSeek built-ins' thinkingLevelMap accepts exactly
            // off/high/max — clamp the seven-level axis onto those.
            pi.set_thinking_level(choice.reasoning.builtin_pi_level())
                .await?;
            Ok(())
        }
        ModelRef::Custom { provider, model } => {
            let Some(cfg) = custom_models::find_custom_model(store, provider, model) else {
                bail!(
                    "Model {model} is no longer configured. Pick another model, or re-add \
                     it under Settings → Models."
                );
            };
            if let Err(e) = pi.set_model(provider, model).await {
                let raw = e.to_string();
                if is_model_not_found(&raw, model) {
                    bail!(
                        "The agent started without the custom provider \"{provider}\". \
                         Check its base URL and API key under Settings → Models. \
                         (pi reported: {raw})"
                    );
                }
                return Err(e);
            }
            // Reasoning-capable custom models registered a thinkingLevelMap
            // built from `thinking_levels` (see custom-models.ts): enabled
            // levels resolve, everything else is null = filtered by pi. Clamp
            // the conversation's level to the nearest enabled one (same
            // walk-up-then-down order as pi's clampThinkingLevel) so
            // set_thinking_level can't fail on a filtered level. Non-reasoning
            // models take no level at all.
            if cfg.reasoning {
                let level = clamp_to_enabled(choice.reasoning, &cfg.thinking_levels);
                pi.set_thinking_level(level.pi_level()).await?;
            }
            Ok(())
        }
    }
}

/// Nearest enabled thinking level: the requested one when enabled, else the
/// closest enabled level above it, else the closest below (pi's own
/// clampThinkingLevel order). `enabled` is `CustomModel::thinking_levels`,
/// guaranteed non-empty for reasoning models by the upsert sanitizer.
fn clamp_to_enabled(
    requested: crate::model::ReasoningLevel,
    enabled: &std::collections::BTreeMap<String, String>,
) -> crate::model::ReasoningLevel {
    use crate::model::ReasoningLevel;
    let on = |l: ReasoningLevel| enabled.contains_key(l.pi_level());
    if on(requested) {
        return requested;
    }
    let idx = ReasoningLevel::ALL
        .iter()
        .position(|l| *l == requested)
        .unwrap_or(0);
    ReasoningLevel::ALL[idx..]
        .iter()
        .chain(ReasoningLevel::ALL[..idx].iter().rev())
        .copied()
        .find(|l| on(*l))
        .unwrap_or(ReasoningLevel::Off)
}

/// True when pi's `set_model` failure is its credential-filtered "unknown
/// model" answer for a model id we expected to exist — i.e. an auth/registry
/// problem wearing a registry error's clothes.
fn is_model_not_found(error: &str, model_id: &str) -> bool {
    error.contains("Model not found") && error.contains(model_id)
}

/// One message for both halves of the ambiguity, including whatever the OS
/// credential store last complained about (Windows Credential Manager /
/// macOS Keychain failures are otherwise swallowed — see [`secrets`]).
fn missing_key_message() -> String {
    let base = "No DeepSeek API key reached the agent. Open Settings → API keys and save your DeepSeek key.";
    match secrets::store_error() {
        Some(e) => format!("{base} The OS credential store could not be read: {e}"),
        None => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_filtered_model_error_is_recognised() {
        // Verbatim shape of pi 0.82's reply, wrapped by pi_rpc::check_success.
        assert!(is_model_not_found(
            "pi set_model failed: Model not found: deepseek/deepseek-v4-pro",
            "deepseek-v4-pro"
        ));
    }

    #[test]
    fn clamping_walks_up_then_down_the_level_axis() {
        use crate::model::ReasoningLevel as L;
        let enabled: std::collections::BTreeMap<String, String> =
            [("off", ""), ("low", "low"), ("high", "medium")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        // Enabled levels pass through.
        assert_eq!(clamp_to_enabled(L::Low, &enabled), L::Low);
        // Disabled walks up first (minimal → low), max walks down (max → high).
        assert_eq!(clamp_to_enabled(L::Minimal, &enabled), L::Low);
        assert_eq!(clamp_to_enabled(L::Max, &enabled), L::High);
        assert_eq!(clamp_to_enabled(L::Medium, &enabled), L::High);
    }

    #[test]
    fn other_failures_are_passed_through_untouched() {
        assert!(!is_model_not_found(
            "pi set_model failed: Model not found: deepseek/deepseek-v9-imaginary",
            "deepseek-v4-pro"
        ));
        assert!(!is_model_not_found(
            "pi process exited with status 1",
            "deepseek-v4-pro"
        ));
    }
}
