//! Proactive, non-destructive refresh of mcporter's cached OAuth tokens.
//!
//! mcporter stores OAuth tokens for remote MCP servers in
//! `~/.mcporter/credentials.json` and only renews them lazily, on connect — via a
//! path that, on refresh FAILURE, calls `invalidateCredentials` and forces a full
//! interactive re-auth. Worse, the bridge's catalog path (`autoAuthorize:false`,
//! see cetus-extensions/mcp-bridge.ts) attaches no OAuth provider at all, so an
//! expired access token is simply sent stale → the server returns `invalid_token`
//! and the connector's tools silently vanish. Net effect: a connector dies ~1h
//! after authorizing (the typical access-token TTL) and the user must re-auth.
//!
//! This module closes that gap the right way: BEFORE the access token expires we
//! run the standard OAuth2 `refresh_token` grant ourselves and write the new
//! tokens back to the vault atomically. On ANY failure (network blip, dead/rotated
//! refresh token, …) we leave the existing entry untouched — degrading to
//! "re-authorize when you next need it", never to "we deleted your credentials".
//!
//! Run by the host only (single writer → no cross-pi races on the vault): a
//! periodic sweep keeps tokens warm while the app runs, and a gated refresh
//! before each cold pi spawn covers the just-woke-from-sleep window.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// Refresh a token once its access token is within this window of expiring. With
/// the typical 1h TTL and the periodic sweep below, tokens are renewed well
/// before they can lapse.
pub const REFRESH_SKEW: Duration = Duration::from_secs(10 * 60);

/// How often the background sweep runs. Comfortably shorter than REFRESH_SKEW so
/// a token can't slip from "fresh" to "expired" between ticks.
const SWEEP_INTERVAL: Duration = Duration::from_secs(4 * 60);

/// Per-request network budget for discovery + the token exchange.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Some MCP edges (Notion's, behind Cloudflare) 403 a request with no
/// User-Agent. reqwest sets none by default, so we must.
const USER_AGENT: &str = concat!("cetus/", env!("CARGO_PKG_VERSION"));

/// Serializes all refresh work in-process. Notion (and any RFC 9700 server) issues
/// ROTATING refresh tokens — each refresh invalidates the previous one — so two
/// overlapping refreshes (the periodic sweep racing a pre-spawn refresh) would have
/// the loser present an already-spent token and fail. One at a time avoids that;
/// the gate re-reads the vault after acquiring, so a wait usually ends in a no-op.
fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
}

fn vault_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".mcporter").join("credentials.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Spawn the periodic vault sweep. Best-effort; never panics the runtime.
pub fn spawn_token_refresher() {
    tauri::async_runtime::spawn(async {
        // A short initial delay so we don't pile onto the startup burst.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            refresh_due_tokens(REFRESH_SKEW).await;
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}

/// Refresh every vault OAuth entry whose access token expires within `skew`.
/// Cheap when nothing is due (one small file read, no network). Best-effort and
/// non-destructive: a failure for one entry is logged and skipped, others proceed.
pub async fn refresh_due_tokens(skew: Duration) {
    let Some(path) = vault_path() else { return };
    // Serialize refreshes (rotating tokens — see refresh_lock). Acquired BEFORE the
    // read so a caller that waited behind another refresh sees the freshly-written
    // vault and finds nothing due.
    let _guard = refresh_lock().lock().await;
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return, // no vault → no OAuth connectors → nothing to do
    };
    let doc: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("oauth-refresh: vault parse failed: {e}");
            return;
        }
    };
    let Some(entries) = doc.get("entries").and_then(|e| e.as_object()) else { return };

    // Sample the entries that are due, with everything refresh_one needs. We read
    // here and write later (write_back re-reads), so the vault lock is held only
    // for the cheap snapshot, never across the network calls.
    let cutoff = now_secs().saturating_add(skew.as_secs());
    let mut due: Vec<DueEntry> = Vec::new();
    for (key, entry) in entries {
        let tokens = entry.get("tokens");
        let (Some(refresh_token), Some(expires_at)) = (
            tokens.and_then(|t| t.get("refresh_token")).and_then(|v| v.as_str()),
            tokens.and_then(|t| t.get("expires_at")).and_then(|v| v.as_u64()),
        ) else {
            continue; // static-header or not-yet-authorized entry → skip
        };
        if expires_at > cutoff {
            continue; // still fresh enough
        }
        let Some(server_url) = entry.get("serverUrl").and_then(|v| v.as_str()) else { continue };
        let client_id = entry
            .get("clientInfo")
            .and_then(|c| c.get("client_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        due.push(DueEntry {
            key: key.clone(),
            server_url: server_url.to_string(),
            client_id,
            refresh_token: refresh_token.to_string(),
        });
    }
    if due.is_empty() {
        return;
    }

    for e in due {
        match refresh_one(&e.server_url, &e.client_id, &e.refresh_token).await {
            Ok(token_resp) => match write_back(&path, &e.key, &token_resp).await {
                Ok(()) => tracing::info!("oauth-refresh: renewed token for {}", e.key),
                Err(err) => tracing::warn!("oauth-refresh: write-back failed for {}: {err}", e.key),
            },
            Err(err) => {
                tracing::warn!("oauth-refresh: refresh failed for {} (left untouched): {err}", e.key)
            }
        }
    }
}

struct DueEntry {
    key: String,
    server_url: String,
    client_id: String,
    refresh_token: String,
}

/// Run the OAuth2 `refresh_token` grant against the server's token endpoint and
/// return the parsed token response. Does not touch the vault.
async fn refresh_one(server_url: &str, client_id: &str, refresh_token: &str) -> anyhow::Result<Value> {
    let token_endpoint = discover_token_endpoint(server_url).await?;
    let client = http_client()?;

    // Public client (token_endpoint_auth_method "none"): client_id goes in the
    // body, no secret. `resource` echoes the RFC 8707 indicator the token was
    // issued for (the MCP server URL) — servers like Notion bind tokens to it and
    // reject a refresh that omits it.
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("resource", server_url),
    ];
    if !client_id.is_empty() {
        form.push(("client_id", client_id));
    }

    let resp = client.post(&token_endpoint).form(&form).send().await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // The cached token endpoint may be stale (server rotated it); drop it so
        // the next refresh re-discovers instead of retrying a dead URL.
        if let Ok(origin) = origin_of(server_url) {
            endpoint_cache().lock().unwrap().remove(&origin);
        }
        anyhow::bail!("token endpoint returned {status}: {}", body.trim());
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("token endpoint gave non-JSON ({e}): {}", body.trim()))?;
    if parsed.get("access_token").and_then(|v| v.as_str()).is_none() {
        anyhow::bail!("token response missing access_token: {}", body.trim());
    }
    Ok(parsed)
}

/// Process-global cache of discovered `origin -> token_endpoint`. Token endpoints
/// are stable, so caching avoids a `.well-known` metadata round-trip before every
/// ~hourly refresh (and a transient metadata fetch failure can no longer block an
/// otherwise-valid refresh). Invalidated per-origin when a refresh POST fails (see
/// `refresh_one`), so a rotated endpoint self-heals on the next attempt.
fn endpoint_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Discover the token endpoint via RFC 8414 metadata at the server's origin,
/// memoising the result per origin.
async fn discover_token_endpoint(server_url: &str) -> anyhow::Result<String> {
    let origin = origin_of(server_url)?;
    if let Some(ep) = endpoint_cache().lock().unwrap().get(&origin).cloned() {
        return Ok(ep);
    }
    let meta_url = format!("{origin}/.well-known/oauth-authorization-server");
    let client = http_client()?;
    let meta: Value = client.get(&meta_url).send().await?.json().await?;
    let endpoint = meta
        .get("token_endpoint")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("no token_endpoint in {meta_url}"))?;
    endpoint_cache().lock().unwrap().insert(origin, endpoint.clone());
    Ok(endpoint)
}

/// `scheme://host[:port]` for an absolute URL.
fn origin_of(url: &str) -> anyhow::Result<String> {
    let u = reqwest::Url::parse(url)?;
    let host = u.host_str().ok_or_else(|| anyhow::anyhow!("no host in {url}"))?;
    Ok(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

/// Merge the refreshed tokens into the vault entry and persist atomically. Re-reads
/// the vault first so a concurrent write (the Authorize CLI, another sweep) isn't
/// clobbered, and writes via a temp file + rename with owner-only permissions.
async fn write_back(path: &Path, key: &str, token_resp: &Value) -> anyhow::Result<()> {
    let raw = tokio::fs::read_to_string(path).await?;
    let mut doc: Value = serde_json::from_str(&raw)?;

    let entry = doc
        .get_mut("entries")
        .and_then(|e| e.as_object_mut())
        .and_then(|m| m.get_mut(key))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| anyhow::anyhow!("entry {key} vanished from vault"))?;

    entry.insert("updatedAt".into(), json!(iso_now()));

    let tokens = entry
        .get_mut("tokens")
        .and_then(|t| t.as_object_mut())
        .ok_or_else(|| anyhow::anyhow!("entry {key} has no tokens object"))?;

    let access = token_resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("refresh response missing access_token"))?;
    tokens.insert("access_token".into(), json!(access));
    if let Some(tt) = token_resp.get("token_type").and_then(|v| v.as_str()) {
        tokens.insert("token_type".into(), json!(tt));
    }
    if let Some(scope) = token_resp.get("scope") {
        tokens.insert("scope".into(), scope.clone());
    }
    // Rotating refresh tokens: persist the new one if the server returned it,
    // otherwise the old one stays valid.
    if let Some(rt) = token_resp.get("refresh_token").and_then(|v| v.as_str()) {
        tokens.insert("refresh_token".into(), json!(rt));
    }
    let expires_in = token_resp.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    tokens.insert("expires_in".into(), json!(expires_in));
    tokens.insert("expires_at".into(), json!(now_secs() + expires_in));

    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, serde_json::to_string_pretty(&doc)?).await?;
    owner_only(&tmp);
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

/// Restrict a freshly-written secret file to the owner (0600), matching how
/// mcporter writes credentials.json.
fn owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
