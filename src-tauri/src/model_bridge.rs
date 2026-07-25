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

use crate::model::ModelChoice;
use crate::pi_rpc::PiRpc;
use crate::secrets;
use anyhow::{bail, Result};

/// Provider id in [`secrets::KNOWN_PROVIDERS`] backing the main agent.
const PROVIDER: &str = "deepseek";

pub async fn apply_choice(pi: &PiRpc, choice: ModelChoice) -> Result<()> {
    let model_id = choice.model.api_id();
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
    pi.set_thinking_level(choice.reasoning.pi_level()).await?;
    Ok(())
}

/// True when pi's `set_model` failure is its credential-filtered "unknown
/// model" answer for the very model id Cetus ships — i.e. an auth problem
/// wearing a registry error's clothes.
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
