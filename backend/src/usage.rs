//! Subscription usage for the CLI runtimes the user is signed into: Claude
//! (Pro/Max) and Codex (ChatGPT plans). Read-only: we borrow the login each CLI
//! already stores on disk and ask the vendor's own usage endpoint — the same
//! numbers `/usage` shows inside the CLI. The CLIs own token refresh; an
//! expired token is reported, never refreshed here.
//!
//! - Claude: OAuth token from the Keychain item "Claude Code-credentials"
//!   (written via /usr/bin/security, so reading it the same way raises no
//!   prompt), falling back to ~/.claude/.credentials.json; then
//!   GET api.anthropic.com/api/oauth/usage (+ /profile for the email).
//! - Codex: ~/.codex/auth.json (or $CODEX_HOME); then
//!   GET chatgpt.com/backend-api/wham/usage.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// A snapshot younger than this is served as-is unless the caller forces it.
const CACHE_TTL: Duration = Duration::from_secs(120);
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    /// 0–100, None when the vendor omitted it.
    pub used_pct: Option<f64>,
    /// ISO-8601.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDetail {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// "claude" | "codex".
    pub provider: &'static str,
    /// "ok" | "signedOut" | "expired" | "error".
    pub status: &'static str,
    pub plan: Option<String>,
    pub account: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub details: Vec<UsageDetail>,
    pub error: Option<String>,
}

impl ProviderUsage {
    fn new(provider: &'static str, status: &'static str) -> Self {
        Self {
            provider,
            status,
            plan: None,
            account: None,
            windows: Vec::new(),
            details: Vec::new(),
            error: None,
        }
    }
    fn failed(provider: &'static str, error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::new(provider, "error")
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub providers: Vec<ProviderUsage>,
    /// Unix ms.
    pub fetched_at: i64,
}

struct Cache {
    at: Instant,
    snapshot: UsageSnapshot,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
/// Claude's usage endpoint answers 429 with a Retry-After in the tens of
/// minutes; until it passes, report that instead of calling again.
static CLAUDE_LIMITED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

#[host::command]
pub async fn provider_usage(force: Option<bool>) -> Result<UsageSnapshot, String> {
    if !force.unwrap_or(false) {
        if let Some(c) = CACHE.lock().unwrap().as_ref() {
            if c.at.elapsed() < CACHE_TTL {
                return Ok(c.snapshot.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let (claude, codex) = tokio::join!(claude_usage(&client), codex_usage(&client));
    let snapshot = UsageSnapshot {
        providers: vec![claude, codex],
        fetched_at: chrono::Utc::now().timestamp_millis(),
    };
    *CACHE.lock().unwrap() = Some(Cache {
        at: Instant::now(),
        snapshot: snapshot.clone(),
    });
    Ok(snapshot)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ── Claude ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOauth {
    access_token: Option<String>,
    expires_at: Option<i64>,
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCredentials {
    claude_ai_oauth: Option<ClaudeOauth>,
}

fn parse_claude_credentials(raw: &str) -> Option<ClaudeOauth> {
    let creds: ClaudeCredentials = serde_json::from_str(raw).ok()?;
    let oauth = creds.claude_ai_oauth?;
    oauth.access_token.as_deref().filter(|t| !t.is_empty())?;
    Some(oauth)
}

async fn security_lookup(args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("/usr/bin/security")
            .args(args)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

async fn claude_credentials() -> Option<ClaudeOauth> {
    // Claude Code derives the Keychain account from $USER (falling back to a
    // fixed name for usernames with unusual characters).
    let user = std::env::var("USER").unwrap_or_default();
    let account = if !user.is_empty()
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        user
    } else {
        "claude-code-user".to_string()
    };
    if cfg!(target_os = "macos") {
        let lookups: [Vec<&str>; 2] = [
            vec![
                "find-generic-password",
                "-a",
                &account,
                "-w",
                "-s",
                CLAUDE_KEYCHAIN_SERVICE,
            ],
            vec!["find-generic-password", "-w", "-s", CLAUDE_KEYCHAIN_SERVICE],
        ];
        for args in lookups {
            if let Some(oauth) = security_lookup(&args)
                .await
                .as_deref()
                .and_then(parse_claude_credentials)
            {
                return Some(oauth);
            }
        }
    }
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".claude")))?;
    let raw = tokio::fs::read_to_string(dir.join(".credentials.json"))
        .await
        .ok()?;
    parse_claude_credentials(&raw)
}

/// "max" + "default_claude_max_20x" → "Max 20x".
fn claude_plan(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let sub = subscription.filter(|s| !s.is_empty())?;
    let mut label = sub[..1].to_uppercase() + &sub[1..];
    if let Some(last) = tier
        .and_then(|t| t.rsplit('_').next())
        .filter(|s| !s.is_empty())
    {
        if last.to_lowercase() != sub.to_lowercase() {
            label.push(' ');
            label.push_str(last);
        }
    }
    Some(label)
}

fn claude_window(id: &str, label: &str, v: &Value) -> Option<UsageWindow> {
    if !v.is_object() {
        return None;
    }
    Some(UsageWindow {
        id: id.to_string(),
        label: label.to_string(),
        used_pct: num(&v["utilization"]),
        resets_at: str_of(&v["resets_at"]),
    })
}

fn claude_windows(resp: &Value) -> Vec<UsageWindow> {
    let mut out: Vec<UsageWindow> = [("five_hour", "Session (5h)"), ("seven_day", "Weekly")]
        .iter()
        .filter_map(|(field, label)| claude_window(field, label, &resp[*field]))
        .collect();
    // Model/surface-scoped weekly limits: the legacy top-level keys and the
    // newer `limits[]` entries describe the same limit — merge by name, the
    // `limits[]` entry winning.
    let mut scoped: Vec<UsageWindow> = [("seven_day_opus", "Opus")]
        .iter()
        .filter_map(|(field, name)| {
            claude_window(
                &format!("weekly_{}", name.to_lowercase()),
                &format!("Weekly · {name}"),
                &resp[*field],
            )
        })
        .collect();
    for entry in resp["limits"].as_array().into_iter().flatten() {
        if entry["kind"].as_str() != Some("weekly_scoped") {
            continue;
        }
        let name = ["model", "surface"].iter().find_map(|d| {
            let s = &entry["scope"][*d];
            str_of(&s["display_name"]).or_else(|| str_of(&s["id"]))
        });
        let Some(name) = name else { continue };
        let id = format!(
            "weekly_{}",
            name.to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect::<String>()
        );
        let w = UsageWindow {
            id: id.clone(),
            label: format!("Weekly · {name}"),
            used_pct: num(&entry["percent"]),
            resets_at: str_of(&entry["resets_at"]),
        };
        match scoped.iter_mut().find(|s| s.id == id) {
            Some(prev) => {
                prev.used_pct = w.used_pct.or(prev.used_pct);
                prev.resets_at = w.resets_at.or(prev.resets_at.take());
                prev.label = w.label;
            }
            None => scoped.push(w),
        }
    }
    out.extend(scoped);
    out
}

async fn claude_get(
    client: &reqwest::Client,
    token: &str,
    path: &str,
) -> Result<reqwest::Response, String> {
    client
        .get(format!("https://api.anthropic.com/api/oauth/{path}"))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Anthropic ({e})"))
}

async fn claude_usage(client: &reqwest::Client) -> ProviderUsage {
    const P: &str = "claude";
    let Some(oauth) = claude_credentials().await else {
        return ProviderUsage::new(P, "signedOut");
    };
    let mut report = ProviderUsage::new(P, "ok");
    report.plan = claude_plan(
        oauth.subscription_type.as_deref(),
        oauth.rate_limit_tier.as_deref(),
    );
    if oauth
        .expires_at
        .is_some_and(|ms| ms <= chrono::Utc::now().timestamp_millis())
    {
        report.status = "expired";
        return report;
    }
    if let Some(until) = *CLAUDE_LIMITED_UNTIL.lock().unwrap() {
        if until > Instant::now() {
            let mins = (until - Instant::now()).as_secs().div_ceil(60).max(1);
            return ProviderUsage::failed(
                P,
                format!("Rate limited by Claude. Try again in {mins}m."),
            );
        }
    }
    let token = oauth.access_token.unwrap_or_default();
    let (usage, profile) = tokio::join!(
        claude_get(client, &token, "usage"),
        claude_get(client, &token, "profile")
    );
    let res = match usage {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(P, e),
    };
    match res.status().as_u16() {
        401 | 403 => {
            report.status = "expired";
            return report;
        }
        429 => {
            let wait = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(600);
            *CLAUDE_LIMITED_UNTIL.lock().unwrap() =
                Some(Instant::now() + Duration::from_secs(wait));
            return ProviderUsage::failed(P, "Rate limited by Claude. Try again later.".into());
        }
        s if !(200..300).contains(&s) => {
            return ProviderUsage::failed(P, format!("Claude usage API returned {s}"));
        }
        _ => {}
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return ProviderUsage::failed(P, format!("Unreadable Claude usage response ({e})"))
        }
    };
    report.windows = claude_windows(&body);
    if let Some(enabled) = body["extra_usage"]["is_enabled"].as_bool() {
        report.details.push(UsageDetail {
            label: "Extra usage".into(),
            value: if enabled { "Enabled" } else { "Disabled" }.into(),
        });
    }
    if let Ok(r) = profile {
        if r.status().is_success() {
            if let Ok(v) = r.json::<Value>().await {
                report.account = str_of(&v["account"]["email"]);
            }
        }
    }
    report
}

// ── Codex ──────────────────────────────────────────────────────────────────

fn codex_auth_path() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".codex")))
        .map(|d| d.join("auth.json"))
}

fn duration_label(secs: Option<f64>, fallback: &str) -> (String, String) {
    match secs.map(|s| s as i64) {
        Some(604_800) => ("weekly".into(), "Weekly".into()),
        Some(18_000) => ("five_hour".into(), "Session (5h)".into()),
        Some(s) if s > 0 && s % 86_400 == 0 => (format!("{s}s"), format!("{}-day", s / 86_400)),
        Some(s) if s > 0 && s % 3_600 == 0 => (format!("{s}s"), format!("{}-hour", s / 3_600)),
        _ => (
            fallback.to_lowercase().replace(' ', "_"),
            fallback.to_string(),
        ),
    }
}

fn codex_windows(rate_limit: &Value, scope: Option<&str>) -> Vec<UsageWindow> {
    [
        ("primary_window", "Primary limit"),
        ("secondary_window", "Secondary limit"),
    ]
    .iter()
    .filter_map(|(slot, fallback)| {
        let w = &rate_limit[*slot];
        if !w.is_object() {
            return None;
        }
        let (id, label) = duration_label(num(&w["limit_window_seconds"]), fallback);
        let resets_at = num(&w["reset_at"])
            .and_then(|s| chrono::DateTime::from_timestamp(s as i64, 0))
            .map(|d| d.to_rfc3339());
        Some(UsageWindow {
            id: scope.map_or(id.clone(), |s| format!("{s}:{id}")),
            label: scope.map_or(label.clone(), |s| format!("{s} · {label}")),
            used_pct: num(&w["used_percent"]),
            resets_at,
        })
    })
    .collect()
}

async fn codex_usage(client: &reqwest::Client) -> ProviderUsage {
    const P: &str = "codex";
    let Some(path) = codex_auth_path() else {
        return ProviderUsage::new(P, "signedOut");
    };
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return ProviderUsage::new(P, "signedOut");
    };
    let auth: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let Some(token) = str_of(&auth["tokens"]["access_token"]) else {
        // API-key-only login: there's no subscription quota to show.
        return ProviderUsage::new(P, "signedOut");
    };
    let mut req = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        );
    if let Some(id) = str_of(&auth["tokens"]["account_id"]) {
        req = req.header("ChatGPT-Account-Id", id);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(P, format!("Couldn't reach ChatGPT ({e})")),
    };
    match res.status().as_u16() {
        401 | 403 => return ProviderUsage::new(P, "expired"),
        s if !(200..300).contains(&s) => {
            return ProviderUsage::failed(P, format!("Codex usage API returned {s}"));
        }
        _ => {}
    }
    let text = res.text().await.unwrap_or_default();
    if text.trim_start().starts_with('<') {
        return ProviderUsage::failed(P, "Codex usage API returned HTML".into());
    }
    let body: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return ProviderUsage::failed(P, format!("Unreadable Codex usage response ({e})"))
        }
    };
    let mut report = ProviderUsage::new(P, "ok");
    report.plan = str_of(&body["plan_type"]);
    report.account = str_of(&body["email"]);
    report.windows = codex_windows(&body["rate_limit"], None);
    for extra in body["additional_rate_limits"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(name) =
            str_of(&extra["limit_name"]).or_else(|| str_of(&extra["metered_feature"]))
        {
            report
                .windows
                .extend(codex_windows(&extra["rate_limit"], Some(&name)));
        }
    }
    report.windows.extend(codex_windows(
        &body["code_review_rate_limit"],
        Some("Code review"),
    ));
    if let Some(balance) = num(&body["credits"]["balance"]) {
        report.details.push(UsageDetail {
            label: "Credits".into(),
            value: format!("{} left", format_number(balance)),
        });
    }
    report
}

/// 61671.934 → "61,671.93".
fn format_number(n: f64) -> String {
    let fixed = format!("{:.2}", n.abs());
    let (int, frac) = fixed.split_once('.').unwrap_or((&fixed, "00"));
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let frac = frac.trim_end_matches('0');
    let sign = if n < 0.0 { "-" } else { "" };
    if frac.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_label() {
        assert_eq!(
            claude_plan(Some("max"), Some("default_claude_max_20x")).as_deref(),
            Some("Max 20x")
        );
        assert_eq!(claude_plan(Some("pro"), None).as_deref(), Some("Pro"));
        assert_eq!(claude_plan(None, Some("x")), None);
    }

    #[test]
    fn claude_scoped_limits_merge() {
        let resp = json!({
            "five_hour": {"utilization": 12.0, "resets_at": "2026-11-06T12:00:00Z"},
            "seven_day": {"utilization": 31, "resets_at": "2026-11-09T14:59:00Z"},
            "seven_day_opus": {"utilization": 5},
            "limits": [
                {"kind": "weekly_scoped", "percent": 7, "scope": {"model": {"display_name": "Opus"}}},
                {"kind": "weekly_scoped", "percent": 0, "scope": {"model": {"display_name": "Fable"}}},
                {"kind": "other", "percent": 50}
            ]
        });
        let w = claude_windows(&resp);
        let ids: Vec<_> = w.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            ids,
            ["five_hour", "seven_day", "weekly_opus", "weekly_fable"]
        );
        assert_eq!(w[2].used_pct, Some(7.0));
        assert_eq!(w[3].label, "Weekly · Fable");
    }

    #[test]
    fn codex_windows_by_duration() {
        let rl = json!({
            "primary_window": {"used_percent": 3, "reset_at": 1_762_000_000, "limit_window_seconds": 18000},
            "secondary_window": {"used_percent": 10, "reset_at": 1_762_400_000, "limit_window_seconds": 604800}
        });
        let w = codex_windows(&rl, None);
        assert_eq!(w[0].label, "Session (5h)");
        assert_eq!(w[1].label, "Weekly");
        assert!(w[1].resets_at.is_some());
    }

    #[test]
    fn number_formatting() {
        assert_eq!(format_number(61671.934), "61,671.93");
        assert_eq!(format_number(1000.0), "1,000");
        assert_eq!(format_number(12.5), "12.5");
    }
}
