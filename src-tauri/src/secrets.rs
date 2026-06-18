//! Per-provider API key storage backed by the OS keychain.
//!
//! **Release builds** use the OS keychain (macOS Keychain / Windows Credential
//! Manager / Linux Secret Service) via the `keyring` crate, with all keys in a
//! **single** item (one JSON blob) rather than one item per provider — macOS
//! attaches an ACL, and thus a separate "allow" prompt, to each item, so
//! one-item-per-key meant a password prompt per stored key on every launch.
//!
//! **Debug builds** skip the keychain entirely and store the same JSON blob in
//! a plaintext file under the app data dir. The keychain "Always Allow" trust
//! is keyed to the binary's code signature, which `tauri dev` re-signs ad-hoc
//! on every Rust rebuild — so in dev the prompt kept coming back on each
//! restart. A dev-only file backend means zero prompts regardless of rebuilds;
//! the keys are the developer's own and never leave their machine.
//!
//! Either way the blob is read at most once per process launch (see
//! [`load_cached`]). The pi sidecar reads provider keys from environment
//! variables at spawn time, so [`load_env`] is called when (re)spawning pi.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "cetus";
/// Account name of the single combined keychain item that holds every key.
#[cfg(not(debug_assertions))]
const ACCOUNT: &str = "providers";

/// Provider id (used as the JSON key + frontend identifier) → env var name
/// that pi expects.
pub const KNOWN_PROVIDERS: &[(&str, &str)] = &[
    ("deepseek", "DEEPSEEK_API_KEY"),
    // Powers the web-search extension's `web_search` / `web_fetch` tools (Tavily
    // API). Absent → those tools are not registered and the agent falls back to
    // the heavyweight browser_* tools for any web access.
    ("tavily", "TAVILY_API_KEY"),
    // Vision provider: the vision-bridge extension transcribes attached images
    // via Gemini (gemini-3.5-flash) so the text-only DeepSeek model can reason
    // about them. Also the only path for PDFs (read_document).
    ("gemini", "GEMINI_API_KEY"),
    // Volcano Engine (Doubao) real-time streaming ASR — the voice-dictation
    // engine (new-console `X-Api-Key`; see doubao.rs / voice.rs).
    ("doubao", "DOUBAO_API_KEY"),
    // Volcano Ark (火山方舟) LLM key — powers the fast dictation cleanup/rewrite
    // pass (Doubao flash; see titling.rs). Distinct from the `doubao` speech key.
    ("volc_ark", "ARK_API_KEY"),
];

/// In-memory cache of the decrypted blob so we touch the keychain at most once
/// per process launch. `None` until the first read.
fn cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    static CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Release backend: OS keychain.
// ---------------------------------------------------------------------------
#[cfg(not(debug_assertions))]
fn entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, ACCOUNT)?)
}

/// Read the combined item straight from the keychain (the prompting call).
#[cfg(not(debug_assertions))]
fn read_blob() -> Result<HashMap<String, String>> {
    match entry()?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(not(debug_assertions))]
fn write_blob(map: &HashMap<String, String>) -> Result<()> {
    if map.is_empty() {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        entry()?.set_password(&serde_json::to_string(map)?)?;
        Ok(())
    }
}

/// Keychain service name before the kott→cetus rename. The combined item and
/// any legacy per-provider items live under this service for users upgrading
/// across the rename; [`migrate_legacy`] folds them into the new service.
#[cfg(not(debug_assertions))]
const OLD_SERVICE: &str = "kott";

/// One-time migration into the current combined item. Folds in, in order:
/// the pre-rename (kott) combined item, then any legacy one-item-per-provider
/// entries under either the current or the pre-rename service. Deletes the old
/// entries afterward. Runs only when the current combined item is still absent,
/// so it costs a burst of prompts on the first upgraded launch and never again.
#[cfg(not(debug_assertions))]
fn migrate_legacy(map: &mut HashMap<String, String>) {
    let mut found = false;
    // Pre-rename combined item (service "kott", account "providers").
    if let Ok(e) = keyring::Entry::new(OLD_SERVICE, ACCOUNT) {
        if let Ok(json) = e.get_password() {
            if let Ok(old) = serde_json::from_str::<HashMap<String, String>>(&json) {
                for (k, v) in old {
                    map.entry(k).or_insert(v);
                }
            }
            let _ = e.delete_credential();
            found = true;
        }
    }
    // Legacy per-provider items under the current and pre-rename services.
    for (prov, _) in KNOWN_PROVIDERS {
        for svc in [SERVICE, OLD_SERVICE] {
            if let Ok(e) = keyring::Entry::new(svc, prov) {
                if let Ok(val) = e.get_password() {
                    map.entry((*prov).to_string()).or_insert(val);
                    let _ = e.delete_credential();
                    found = true;
                }
            }
        }
    }
    if found {
        let _ = write_blob(map);
    }
}

// ---------------------------------------------------------------------------
// Debug backend: plaintext file under the app data dir, never the keychain.
// ---------------------------------------------------------------------------
#[cfg(debug_assertions)]
fn dev_secrets_path() -> std::path::PathBuf {
    let base = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Library/Application Support")
        .join("dev.cetus.app")
        .join("dev-secrets.json")
}

#[cfg(debug_assertions)]
fn read_blob() -> Result<HashMap<String, String>> {
    match std::fs::read_to_string(dev_secrets_path()) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(debug_assertions)]
fn write_blob(map: &HashMap<String, String>) -> Result<()> {
    let path = dev_secrets_path();
    if map.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(map)?)?;
        Ok(())
    }
}

/// No legacy keychain migration in debug — reading the old per-provider items
/// would trigger the very prompts the file backend exists to avoid.
#[cfg(debug_assertions)]
fn migrate_legacy(_map: &mut HashMap<String, String>) {}

/// Load the blob through the in-memory cache, hitting the keychain (and thus
/// prompting) at most once per launch.
fn load_cached() -> Result<HashMap<String, String>> {
    let mut guard = cache().lock().unwrap();
    if let Some(map) = guard.as_ref() {
        return Ok(map.clone());
    }
    let mut map = read_blob()?;
    if map.is_empty() {
        migrate_legacy(&mut map);
    }
    *guard = Some(map.clone());
    Ok(map)
}

fn store_cache(map: HashMap<String, String>) {
    *cache().lock().unwrap() = Some(map);
}

pub fn set(provider: &str, key: &str) -> Result<()> {
    let mut map = load_cached()?;
    map.insert(provider.to_string(), key.to_string());
    write_blob(&map)?;
    store_cache(map);
    Ok(())
}

pub fn has(provider: &str) -> bool {
    load_cached()
        .map(|m| m.contains_key(provider))
        .unwrap_or(false)
}

/// Read the raw stored key. Only ever reaches the renderer process as a
/// fully-masked preview (see `commands::list_api_keys_masked`) — we never ship
/// the real value over IPC.
pub fn get(provider: &str) -> Result<Option<String>> {
    Ok(load_cached()?.get(provider).cloned())
}

/// Hide all but the first and last few chars so the renderer can give the
/// user a "this is the one I have" cue without leaking the secret.
/// Short keys (< 10 chars) are fully masked to avoid revealing most of them.
pub fn mask(secret: &str) -> String {
    let len = secret.chars().count();
    if len <= 10 {
        return "•".repeat(len.max(8));
    }
    let head: String = secret.chars().take(4).collect();
    let tail: String = secret.chars().skip(len - 4).collect();
    let middle = "•".repeat(8);
    format!("{head}{middle}{tail}")
}

pub fn delete(provider: &str) -> Result<()> {
    let mut map = load_cached()?;
    map.remove(provider);
    write_blob(&map)?;
    store_cache(map);
    Ok(())
}

/// Snapshot of (env_var_name, value) pairs for every provider that currently
/// has a stored key. Used when spawning pi.
pub fn load_env() -> Vec<(String, String)> {
    let map = match load_cached() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    KNOWN_PROVIDERS
        .iter()
        .filter_map(|(prov, env_name)| {
            map.get(*prov).map(|val| (env_name.to_string(), val.clone()))
        })
        .collect()
}
