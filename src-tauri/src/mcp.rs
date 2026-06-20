//! User-configured **MCP servers** ("Connectors").
//!
//! pi ships with no built-in MCP client, so cetus manages connectors here and
//! makes them visible: each server is persisted (one JSON blob in `app_settings`)
//! and the enabled set is exported to a standard `<app_data>/mcp.json`
//! (`{ "mcpServers": { … } }`), whose path is published as `CETUS_MCP_CONFIG` so a
//! future bridge extension can pick them up. This mirrors how Codex surfaces
//! connectors: you add, edit, enable, and validate them in one place.
//!
//! [`test_connector`] performs a *real* MCP handshake on demand — `initialize`
//! then `tools/list` — over the configured transport, so the user can confirm a
//! server actually launches and see the tools it offers, without cetus wiring an
//! unverified server into every conversation.

use crate::store::{now_ms, Store};
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

const SETTINGS_KEY: &str = "mcp_connectors";
const CURRENT_VERSION: u32 = 1;
const MAX_CONNECTORS: usize = 50;
/// Overall budget for a handshake — generous enough for an `npx`/`uvx` cold start
/// that downloads a server, short enough that a hung server doesn't wedge the UI.
const TEST_TIMEOUT: Duration = Duration::from_secs(20);
/// OAuth authorize budget — generous, since it waits on the user completing the
/// browser login + consent before mcporter captures the callback.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);
/// The protocol revision we advertise on `initialize`. Servers negotiate down.
const PROTOCOL_VERSION: &str = "2025-06-18";

fn default_true() -> bool {
    true
}
fn default_version() -> u32 {
    CURRENT_VERSION
}
fn default_transport() -> String {
    "stdio".to_string()
}

/// One configured connector. `transport` is `"stdio"` (a local command) or
/// `"http"` (a remote Streamable-HTTP/SSE URL); the irrelevant fields are simply
/// left empty for the other transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnector {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    // stdio
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    // http
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    // http auth: "" (static headers only) or "oauth" (mcporter runs the OAuth 2.1
    // flow and caches tokens in its vault). `oauth_client_id`/`oauth_scope` are
    // optional — most servers support dynamic client registration.
    #[serde(default)]
    pub auth: String,
    #[serde(default)]
    pub oauth_client_id: String,
    #[serde(default)]
    pub oauth_scope: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Create/update payload from the settings form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectorInput {
    pub name: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub auth: String,
    #[serde(default)]
    pub oauth_client_id: String,
    #[serde(default)]
    pub oauth_scope: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpState {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: Vec<McpConnector>,
}

/// One tool a server exposes, as surfaced in the connector details view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
}

/// Outcome of a handshake. `ok` is the bottom line; the rest is detail the UI
/// shows when it succeeds (server identity + the tools it exposes) or fails.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---- State + config export -------------------------------------------------

fn load_state(store: &Store) -> McpState {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(store: &Store, s: &McpState) -> CmdResult<()> {
    store
        .set_setting(SETTINGS_KEY, &serde_json::to_string(s).map_err(err)?)
        .map_err(err)
}

/// Absolute path of the exported MCP config. Mirrors `CETUS_MCP_CONFIG`.
pub fn config_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join("mcp.json")
}

/// Spec for one http server, including OAuth fields when configured. mcporter
/// runs the full OAuth 2.1 flow itself when `auth: "oauth"` is present.
fn http_spec(c: &McpConnector) -> Value {
    // mcporter infers a remote server from `url`; it has no `type` field.
    let mut m = json!({ "url": c.url });
    if !c.headers.is_empty() {
        m["headers"] = json!(c.headers);
    }
    if c.auth == "oauth" {
        m["auth"] = json!("oauth");
        if !c.oauth_client_id.trim().is_empty() {
            m["oauthClientId"] = json!(c.oauth_client_id.trim());
        }
        if !c.oauth_scope.trim().is_empty() {
            m["oauthScope"] = json!(c.oauth_scope.trim());
        }
    }
    m
}

/// Build the mcporter config document from the enabled connectors + the browser
/// built-in + the user's discovered-import sources. The de-facto standard
/// `{ "mcpServers": { name: spec } }` shape `mcporter` reads — a stdio server is
/// `{ command, args, env }`, a remote one is `{ url, headers, auth? }`.
fn build_mcp_doc(store: &Store) -> Value {
    let state = load_state(store);
    let mut servers = serde_json::Map::new();
    for c in state.entries.iter().filter(|c| c.enabled) {
        // De-dupe keys so two connectors named the same don't clobber each other.
        let mut key = if c.name.trim().is_empty() {
            c.id.clone()
        } else {
            c.name.trim().to_string()
        };
        let mut n = 2;
        while servers.contains_key(&key) {
            key = format!("{}-{}", c.name.trim(), n);
            n += 1;
        }
        let spec = if c.transport == "http" {
            http_spec(c)
        } else {
            let mut m = json!({ "command": c.command, "args": c.args });
            if !c.env.is_empty() {
                m["env"] = json!(c.env);
            }
            m
        };
        servers.insert(key, spec);
    }
    // Built-in and user plugins may contribute MCP servers. Skipped if a user
    // connector already claims the same key, so an explicit connector override
    // wins over plugin defaults.
    for (name, spec) in crate::plugins::enabled_mcp_servers(store) {
        servers.entry(name).or_insert(spec);
    }
    // `imports` controls mcporter's editor-config auto-import. Default empty so
    // cetus never silently inherits another tool's MCP servers; the user opts in
    // per source via Settings → Connectors (Discovery settings). Empty also
    // suppresses mcporter's DEFAULT_IMPORTS fallback.
    let imports = crate::discovery::load_settings(store).mcp_imports;
    json!({ "mcpServers": servers, "imports": imports })
}

/// Serialize + write a built doc to `path`. Best-effort: a write failure is
/// logged, never surfaced.
fn write_mcp_doc(path: &std::path::Path, doc: &Value) {
    match serde_json::to_string_pretty(doc) {
        Ok(s) => {
            if let Err(e) = std::fs::write(path, s) {
                tracing::warn!("mcp: write {} failed: {e}", path.display());
            }
        }
        Err(e) => tracing::warn!("mcp: serialize config failed: {e}"),
    }
}

/// (Re)write the GLOBAL `<app_data>/mcp.json` — the template legacy conversations
/// use and the source the per-conversation freeze copies from.
pub fn export_config(app_data_dir: &std::path::Path, store: &Store) {
    write_mcp_doc(&config_path(app_data_dir), &build_mcp_doc(store));
}

/// Write a frozen per-conversation `mcp.json` to `path`, snapshotting the current
/// connector + discovery config so later toggles never disturb this conversation.
pub fn write_conv_config(path: &std::path::Path, store: &Store) {
    write_mcp_doc(path, &build_mcp_doc(store));
}

/// Trim + sanity-check a payload, returning a normalized copy or a user-facing
/// error. Shared by add/update/test so the rules are stated once.
fn validate(input: &McpConnectorInput) -> CmdResult<McpConnectorInput> {
    let mut input = input.clone();
    input.name = input.name.trim().to_string();
    if input.name.is_empty() {
        return Err("give the connector a name".into());
    }
    input.transport = match input.transport.as_str() {
        "http" => "http".to_string(),
        _ => "stdio".to_string(),
    };
    if input.transport == "stdio" {
        input.command = input.command.trim().to_string();
        if input.command.is_empty() {
            return Err("a stdio connector needs a command (e.g. npx)".into());
        }
    } else {
        input.url = input.url.trim().to_string();
        if !(input.url.starts_with("http://") || input.url.starts_with("https://")) {
            return Err("an HTTP connector needs an http(s):// URL".into());
        }
        // Only "oauth" is a recognized auth mode; anything else means static
        // headers (or none).
        input.auth = if input.auth.trim() == "oauth" {
            "oauth".to_string()
        } else {
            String::new()
        };
    }
    Ok(input)
}

fn apply(connector: &mut McpConnector, input: McpConnectorInput) {
    connector.name = input.name;
    connector.transport = input.transport;
    connector.command = input.command;
    connector.args = input.args;
    connector.env = input.env;
    connector.url = input.url;
    connector.headers = input.headers;
    connector.auth = input.auth;
    connector.oauth_client_id = input.oauth_client_id;
    connector.oauth_scope = input.oauth_scope;
    connector.enabled = input.enabled;
    connector.updated_at = now_ms();
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn list_connectors(state: State<'_, AppState>) -> CmdResult<Vec<McpConnector>> {
    Ok(load_state(&state.store).entries)
}

#[tauri::command]
pub async fn add_connector(
    state: State<'_, AppState>,
    input: McpConnectorInput,
) -> CmdResult<McpConnector> {
    let input = validate(&input)?;
    let mut s = load_state(&state.store);
    if s.entries.len() >= MAX_CONNECTORS {
        return Err(format!("connector limit reached ({MAX_CONNECTORS})"));
    }
    let now = now_ms();
    let mut connector = McpConnector {
        id: Uuid::new_v4().to_string(),
        name: String::new(),
        transport: default_transport(),
        command: String::new(),
        args: Vec::new(),
        env: BTreeMap::new(),
        url: String::new(),
        headers: BTreeMap::new(),
        auth: String::new(),
        oauth_client_id: String::new(),
        oauth_scope: String::new(),
        enabled: true,
        created_at: now,
        updated_at: now,
    };
    apply(&mut connector, input);
    s.entries.push(connector.clone());
    save_state(&state.store, &s)?;
    export_config(&state.app_data_dir, &state.store);
    Ok(connector)
}

#[tauri::command]
pub async fn update_connector(
    state: State<'_, AppState>,
    id: String,
    input: McpConnectorInput,
) -> CmdResult<McpConnector> {
    let input = validate(&input)?;
    let mut s = load_state(&state.store);
    let connector = s
        .entries
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("connector not found: {id}"))?;
    apply(connector, input);
    let updated = connector.clone();
    save_state(&state.store, &s)?;
    export_config(&state.app_data_dir, &state.store);
    Ok(updated)
}

#[tauri::command]
pub async fn set_connector_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> CmdResult<McpConnector> {
    let mut s = load_state(&state.store);
    let connector = s
        .entries
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("connector not found: {id}"))?;
    connector.enabled = enabled;
    connector.updated_at = now_ms();
    let updated = connector.clone();
    save_state(&state.store, &s)?;
    export_config(&state.app_data_dir, &state.store);
    Ok(updated)
}

#[tauri::command]
pub async fn remove_connector(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut s = load_state(&state.store);
    let before = s.entries.len();
    s.entries.retain(|c| c.id != id);
    if s.entries.len() == before {
        return Ok(()); // idempotent
    }
    save_state(&state.store, &s)?;
    export_config(&state.app_data_dir, &state.store);
    Ok(())
}

/// Connect to a server (as configured in `input`, saved or not) and run an MCP
/// `initialize` + `tools/list`. Never mutates state; purely a validation probe.
/// OAuth connectors can't be probed over a bare reqwest handshake (no bearer), so
/// they go through mcporter, which uses the tokens it cached during `authorize`.
#[tauri::command]
pub async fn test_connector(
    state: State<'_, AppState>,
    input: McpConnectorInput,
) -> CmdResult<McpTestResult> {
    let input = validate(&input)?;
    if input.transport == "http" && input.auth == "oauth" {
        return Ok(mcporter_list(state.pi_bin(), &state.app_data_dir, &input).await);
    }
    let fut = async move {
        if input.transport == "http" {
            test_http(&input.url, &input.headers).await
        } else {
            test_stdio(&input.command, &input.args, &input.env).await
        }
    };
    match tokio::time::timeout(TEST_TIMEOUT, fut).await {
        Ok(result) => Ok(result),
        Err(_) => Ok(McpTestResult {
            ok: false,
            error: Some(format!("timed out after {}s", TEST_TIMEOUT.as_secs())),
            ..Default::default()
        }),
    }
}

/// Run the OAuth 2.1 authorization flow for an http connector via mcporter. Writes
/// a one-server config (so the vault key — `{name, url}` — matches what the bridge
/// later connects with), runs `mcporter auth <name>`, and lets mcporter open the
/// browser + run the local callback server + persist tokens. Returns mcporter's
/// output on success. If node isn't found, the connector still authorizes lazily
/// on first use in a chat (the bridge runs the same flow), which the error notes.
#[tauri::command]
pub async fn authorize_connector(
    state: State<'_, AppState>,
    input: McpConnectorInput,
) -> CmdResult<String> {
    let input = validate(&input)?;
    if input.transport != "http" {
        return Err("only HTTP connectors use OAuth".into());
    }
    let tmp = state.app_data_dir.join("mcp-oauth-tmp.json");
    write_mcp_doc(&tmp, &one_server_oauth_doc(&input));
    let res = run_mcporter(
        state.pi_bin(),
        &["auth", &input.name, "--config", &tmp.to_string_lossy()],
        OAUTH_TIMEOUT,
    )
    .await;
    let _ = std::fs::remove_file(&tmp);
    res
}

/// One MCP server discovered in another app's config (a preview of what an
/// `imports` source would pull in). `detail` is the URL or command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportEntry {
    pub name: String,
    pub detail: String,
}

/// List the MCP servers an `imports` source (e.g. "claude-code") would pull in,
/// so the UI can show exactly what got imported. Uses mcporter's non-connecting
/// `config import <source> --json`; returns an empty list if the source's config
/// file is absent.
#[tauri::command]
pub async fn preview_mcp_import(
    state: State<'_, AppState>,
    source: String,
) -> CmdResult<Vec<McpImportEntry>> {
    if !crate::discovery::MCP_IMPORT_SOURCES.contains(&source.as_str()) {
        return Err(format!("unknown import source: {source}"));
    }
    let out = run_mcporter(
        state.pi_bin(),
        &["config", "import", &source, "--json"],
        TEST_TIMEOUT,
    )
    .await
    .unwrap_or_default();
    let Some(doc) = serde_json::from_str::<Value>(out.trim()).ok() else {
        return Ok(Vec::new());
    };
    let entries = doc
        .get("entries")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let name = e.get("name").and_then(|n| n.as_str())?.to_string();
                    let entry = e.get("entry");
                    let detail = entry
                        .and_then(|x| x.get("baseUrl").or_else(|| x.get("url")))
                        .and_then(|u| u.as_str())
                        .map(String::from)
                        .or_else(|| {
                            entry
                                .and_then(|x| x.get("command"))
                                .and_then(|c| c.as_str())
                                .map(String::from)
                        })
                        .unwrap_or_default();
                    Some(McpImportEntry { name, detail })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(entries)
}

/// `mcporter list <name> --json` for a single OAuth server → an `McpTestResult`.
async fn mcporter_list(
    pi_bin: &std::path::Path,
    app_data_dir: &std::path::Path,
    input: &McpConnectorInput,
) -> McpTestResult {
    let tmp = app_data_dir.join("mcp-list-tmp.json");
    write_mcp_doc(&tmp, &one_server_oauth_doc(input));
    let out = run_mcporter(
        pi_bin,
        &[
            "list",
            &input.name,
            "--config",
            &tmp.to_string_lossy(),
            "--json",
        ],
        TEST_TIMEOUT,
    )
    .await;
    let _ = std::fs::remove_file(&tmp);
    match out {
        Err(e) => fail(if e.is_empty() {
            "authorization required — click Authorize".into()
        } else {
            e
        }),
        Ok(stdout) => parse_mcporter_list(&stdout),
    }
}

/// One-server mcporter config with `auth: "oauth"` forced on, used for both the
/// authorize and the list probes so they share the connector's vault key.
fn one_server_oauth_doc(input: &McpConnectorInput) -> Value {
    let mut spec = json!({ "url": input.url, "auth": "oauth" });
    if !input.headers.is_empty() {
        spec["headers"] = json!(input.headers);
    }
    if !input.oauth_client_id.trim().is_empty() {
        spec["oauthClientId"] = json!(input.oauth_client_id.trim());
    }
    if !input.oauth_scope.trim().is_empty() {
        spec["oauthScope"] = json!(input.oauth_scope.trim());
    }
    let mut servers = serde_json::Map::new();
    servers.insert(input.name.clone(), spec);
    json!({ "mcpServers": servers, "imports": [] })
}

/// Pull `{ servers: [{ name, tools: [{name, description}] }] }` out of mcporter's
/// `list --json` output into our result shape.
fn parse_mcporter_list(stdout: &str) -> McpTestResult {
    let Some(doc) = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .or_else(|| serde_json::from_str::<Value>(stdout.trim()).ok())
    else {
        return fail("couldn't parse mcporter output");
    };
    let server = doc.pointer("/servers/0");
    let tools = server
        .and_then(|s| s.get("tools"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name").and_then(|n| n.as_str())?.to_string();
                    let description = t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    Some(McpToolInfo { name, description })
                })
                .collect()
        })
        .unwrap_or_default();
    McpTestResult {
        ok: true,
        server_name: server
            .and_then(|s| s.get("name"))
            .and_then(|n| n.as_str())
            .map(String::from),
        tools,
        ..Default::default()
    }
}

/// Run the vendored mcporter CLI under a resolved node. The CLI ships as
/// `node_modules/mcporter/dist/cli.js` (a `#!/usr/bin/env node` script) next to
/// the pi binary.
async fn run_mcporter(
    pi_bin: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> CmdResult<String> {
    let cli = pi_bin
        .parent()
        .map(|d| d.join("node_modules/mcporter/dist/cli.js"))
        .filter(|p| p.exists())
        .ok_or("mcporter CLI not found in the pi install")?;
    let node = resolve_node().ok_or(
        "Node.js not found on PATH — install Node to authorize OAuth connectors here \
         (otherwise the connector authorizes on first use inside a chat).",
    )?;
    let mut cmd = tokio::process::Command::new(node);
    cmd.arg(&cli)
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch mcporter: {e}"))?;
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => return Err(format!("timed out after {}s", timeout.as_secs())),
        Ok(Err(e)) => return Err(format!("mcporter error: {e}")),
        Ok(Ok(o)) => o,
    };
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(if stdout.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout
        })
    } else {
        Err(format!("{}\n{}", stderr.trim(), stdout.trim())
            .trim()
            .to_string())
    }
}

/// Best-effort `node` resolution. GUI-launched apps get a minimal PATH, so we
/// also probe the common install locations. cetus already relies on a system node
/// for `npx`-based stdio connectors (e.g. chrome-devtools).
fn resolve_node() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Some(p) = std::env::var_os("CETUS_NODE")
        .map(PathBuf::from)
        .filter(|p| p.exists())
    {
        return Some(p);
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("node");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

// ---- Handshake: stdio ------------------------------------------------------

fn fail(msg: impl Into<String>) -> McpTestResult {
    McpTestResult {
        ok: false,
        error: Some(msg.into()),
        ..Default::default()
    }
}

/// Spawn a stdio MCP server and speak newline-delimited JSON-RPC to it: send
/// `initialize`, read the response, send the `notifications/initialized` ack,
/// then `tools/list`. The child is killed on drop, so an early return reaps it.
async fn test_stdio(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> McpTestResult {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("couldn't launch `{command}`: {e}")),
    };
    let Some(mut stdin) = child.stdin.take() else {
        return fail("no stdin on server process");
    };
    let Some(stdout) = child.stdout.take() else {
        return fail("no stdout on server process");
    };
    let mut lines = BufReader::new(stdout).lines();

    // initialize
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "cetus", "version": "0.1.0" }
        }
    });
    if let Err(e) = write_msg(&mut stdin, &init).await {
        return fail(format!("write failed: {e}"));
    }
    let init_resp = match read_response(&mut lines, 1).await {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    if let Some(err) = init_resp.get("error") {
        return fail(format!("server rejected initialize: {err}"));
    }
    let result = init_resp.get("result").cloned().unwrap_or(Value::Null);
    let mut out = McpTestResult {
        ok: true,
        server_name: result
            .pointer("/serverInfo/name")
            .and_then(|v| v.as_str())
            .map(String::from),
        server_version: result
            .pointer("/serverInfo/version")
            .and_then(|v| v.as_str())
            .map(String::from),
        protocol_version: result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .map(String::from),
        ..Default::default()
    };

    // ack + list tools (best-effort; a server with no tools is still a pass)
    let _ = write_msg(
        &mut stdin,
        &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    let _ = write_msg(
        &mut stdin,
        &json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await;
    if let Ok(v) = read_response(&mut lines, 2).await {
        out.tools = collect_tools(&v);
    }

    let _ = child.start_kill();
    out
}

async fn write_msg(stdin: &mut tokio::process::ChildStdin, v: &Value) -> std::io::Result<()> {
    let mut line = v.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// Read newline-delimited JSON from the server until a message whose `id` matches
/// `want` arrives (skipping notifications/log lines and non-JSON noise).
async fn read_response<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    want: i64,
) -> Result<Value, String> {
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue; // server log noise on stdout — ignore
                };
                if v.get("id").and_then(|i| i.as_i64()) == Some(want) {
                    return Ok(v);
                }
            }
            Ok(None) => return Err("server closed the connection before responding".into()),
            Err(e) => return Err(format!("read error: {e}")),
        }
    }
}

fn collect_tools(resp: &Value) -> Vec<McpToolInfo> {
    resp.pointer("/result/tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name").and_then(|n| n.as_str())?.to_string();
                    let description = t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    Some(McpToolInfo { name, description })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- Handshake: HTTP -------------------------------------------------------

/// Speak JSON-RPC to a Streamable-HTTP MCP endpoint: POST `initialize`, then
/// (best-effort) the `notifications/initialized` ack and `tools/list`, threading
/// any `Mcp-Session-Id` the server hands back through the follow-up requests.
/// Each response may be a plain JSON body or an SSE stream; we accept either. A
/// non-2xx status (or an unparseable initialize body) is reported as a failure.
async fn test_http(url: &str, headers: &BTreeMap<String, String>) -> McpTestResult {
    let client = match reqwest::Client::builder().timeout(TEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return fail(format!("http client error: {e}")),
    };
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "cetus", "version": "0.1.0" }
        }
    });
    let resp = match http_rpc(&client, url, headers, None, &init).send().await {
        Ok(r) => r,
        Err(e) => return fail(format!("request failed: {e}")),
    };
    let status = resp.status();
    // Stateful servers return a session id we must echo on every follow-up call.
    let session = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = resp.text().await.unwrap_or_default();
    let Some(result) = parse_json_or_sse(&body) else {
        return fail(if status.is_success() {
            "server responded but the body wasn't MCP JSON".to_string()
        } else {
            format!("HTTP {status}")
        });
    };
    if let Some(err) = result.get("error") {
        return fail(format!("server rejected initialize: {err}"));
    }
    let inner = result.get("result").cloned().unwrap_or(Value::Null);
    let mut out = McpTestResult {
        ok: true,
        server_name: inner
            .pointer("/serverInfo/name")
            .and_then(|v| v.as_str())
            .map(String::from),
        server_version: inner
            .pointer("/serverInfo/version")
            .and_then(|v| v.as_str())
            .map(String::from),
        protocol_version: inner
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .map(String::from),
        ..Default::default()
    };

    // ack + list tools (best-effort; a server with no tools is still a pass)
    let ack = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let _ = http_rpc(&client, url, headers, session.as_deref(), &ack)
        .send()
        .await;
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
    if let Ok(r) = http_rpc(&client, url, headers, session.as_deref(), &list)
        .send()
        .await
    {
        let b = r.text().await.unwrap_or_default();
        if let Some(v) = parse_json_or_sse(&b) {
            out.tools = collect_tools(&v);
        }
    }
    out
}

/// Build a JSON-RPC POST carrying the user's headers and, when present, the
/// negotiated `Mcp-Session-Id`.
fn http_rpc(
    client: &reqwest::Client,
    url: &str,
    headers: &BTreeMap<String, String>,
    session: Option<&str>,
    body: &Value,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(s) = session {
        req = req.header("mcp-session-id", s);
    }
    req
}

/// Pull the first JSON-RPC object out of a response that's either a bare JSON
/// body or an SSE stream (`data: { … }` lines).
fn parse_json_or_sse(body: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(body.trim()) {
        return Some(v);
    }
    for line in body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("data:") {
            if let Ok(v) = serde_json::from_str::<Value>(rest.trim()) {
                return Some(v);
            }
        }
    }
    None
}
