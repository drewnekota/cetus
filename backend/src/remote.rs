//! Authenticated mobile companion. Two front doors share one conversation API:
//! - the Cetus iOS app, over an end-to-end encrypted channel (see
//!   `remote_secure.rs`) through the relay or the direct `/v1/direct` socket;
//! - the legacy browser page served on localhost and published through
//!   Tailscale Serve (cookie auth).
//! The remote surface intentionally exposes only conversation operations;
//! native files, terminal, secrets and settings never enter this API.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State as AxumState, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::{Html, IntoResponse, Redirect},
    routing::{get, post},
    Json, Router,
};
use host::{AppHandle, Emitter, Listener, Manager, State};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    process::Command,
    sync::{Arc, Mutex},
};

use crate::{commands, AppState};

const ENABLED_KEY: &str = "remote.enabled";
const TOKEN_KEY: &str = "remote.access_token";
const PORT: u16 = 17382;

pub struct RemoteRuntime {
    token: Arc<Mutex<String>>,
    task: Mutex<Option<host::async_runtime::JoinHandle<()>>>,
    relay_task: Mutex<Option<host::async_runtime::JoinHandle<()>>>,
    events: tokio::sync::broadcast::Sender<String>,
    pending_controls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
    live_turns: Arc<Mutex<HashMap<String, LiveTurn>>>,
}

/// The stream events of a conversation's open turn, kept so a phone that
/// opens the chat mid-run can replay them: CLI runtimes write a turn to the
/// transcript only when it ends, so the history alone shows none of the work
/// done so far. `seq` numbers every event of the conversation; the phone uses
/// it to drop events its snapshot already holds.
#[derive(Default)]
struct LiveTurn {
    seq: u64,
    events: Vec<Value>,
}

impl LiveTurn {
    fn record(&mut self, event: &Value) {
        let field = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "agent_start" => {
                self.events.clear();
                self.events.push(event.clone());
            }
            // A retrying run goes on by itself: its turn is still open.
            "agent_end" => {
                if event.get("willRetry").and_then(Value::as_bool) != Some(true) {
                    self.events.clear();
                }
            }
            "agent_settled" => self.events.clear(),
            "message_start"
            | "message_end"
            | "tool_execution_start"
            | "compaction_start"
            | "compaction_end" => self.events.push(event.clone()),
            "tool_execution_update" => {
                let mut event = event.clone();
                if let Some(content) = event.pointer_mut("/partialResult/content") {
                    trim_tool_content(content);
                }
                // Each update replaces the one before it.
                match self.events.last_mut() {
                    Some(last)
                        if field(last, "type").as_deref() == Some("tool_execution_update")
                            && last.get("toolCallId") == event.get("toolCallId") =>
                    {
                        *last = event
                    }
                    _ => self.events.push(event),
                }
            }
            "tool_execution_end" => {
                let mut event = event.clone();
                if let Some(content) = event.pointer_mut("/result/content") {
                    trim_tool_content(content);
                }
                self.events.push(event);
            }
            "message_update" => {
                let Some(inner) = event.get("assistantMessageEvent") else {
                    return;
                };
                let kind = field(inner, "type").unwrap_or_default();
                if kind == "toolcall_delta" {
                    return;
                }
                // Token deltas of one block fold into a single event.
                if kind == "text_delta" || kind == "thinking_delta" {
                    let delta = inner.get("delta").and_then(Value::as_str).unwrap_or("");
                    if let Some(last) = self
                        .events
                        .last_mut()
                        .and_then(|e| e.get_mut("assistantMessageEvent"))
                        .filter(|l| {
                            field(l, "type").as_deref() == Some(kind.as_str())
                                && l.get("contentIndex") == inner.get("contentIndex")
                        })
                    {
                        let joined = format!(
                            "{}{delta}",
                            last.get("delta").and_then(Value::as_str).unwrap_or("")
                        );
                        last["delta"] = Value::String(joined);
                        return;
                    }
                }
                self.events.push(event.clone());
            }
            _ => {}
        }
    }

    /// What a snapshot taken now is missing. pi's own history already holds
    /// every finished message of the turn, so only the open one is replayed.
    fn replay(&self, cli: bool) -> &[Value] {
        if cli {
            return &self.events;
        }
        let from = self
            .events
            .iter()
            .rposition(|e| e.get("type").and_then(Value::as_str) == Some("message_end"))
            .map_or(0, |i| i + 1);
        &self.events[from..]
    }
}

impl RemoteRuntime {
    pub fn new(store: &crate::store::Store) -> Self {
        let token = store
            .get_setting(TOKEN_KEY)
            .ok()
            .flatten()
            .filter(|v| v.len() >= 32)
            .unwrap_or_else(new_token);
        let _ = store.set_setting(TOKEN_KEY, &token);
        let (events, _) = tokio::sync::broadcast::channel(1024);
        Self {
            token: Arc::new(Mutex::new(token)),
            task: Mutex::new(None),
            relay_task: Mutex::new(None),
            events,
            pending_controls: Arc::new(Mutex::new(HashMap::new())),
            live_turns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn token(&self) -> String {
        self.token.lock().unwrap().clone()
    }

    fn start(&self, app: AppHandle) {
        let mut task = self.task.lock().unwrap();
        if task.is_some() {
            return;
        }
        let web = WebState {
            app,
            token: self.token.clone(),
            events: self.events.clone(),
            pending_controls: self.pending_controls.clone(),
            live_turns: self.live_turns.clone(),
        };
        crate::awake::set_remote_active(true);
        *self.relay_task.lock().unwrap() = Some(host::async_runtime::spawn(
            crate::remote_secure::run_relay(web.app.clone(), web.clone()),
        ));
        *task = Some(host::async_runtime::spawn(async move {
            let router = router(web);
            let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    tracing::info!("Cetus Remote listening on http://{addr}");
                    if let Err(error) = axum::serve(listener, router).await {
                        tracing::error!("Cetus Remote server stopped: {error}");
                    }
                }
                Err(error) => tracing::error!("Cetus Remote could not bind {addr}: {error}"),
            }
        }));
    }

    fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.relay_task.lock().unwrap().take() {
            task.abort();
        }
        crate::awake::set_remote_active(false);
    }
}

#[derive(Clone)]
pub(crate) struct WebState {
    pub(crate) app: AppHandle,
    token: Arc<Mutex<String>>,
    pub(crate) events: tokio::sync::broadcast::Sender<String>,
    pending_controls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
    live_turns: Arc<Mutex<HashMap<String, LiveTurn>>>,
}

pub fn initialize(app: AppHandle) {
    let runtime = app.state::<RemoteRuntime>();
    let tx = runtime.events.clone();
    let pending = runtime.pending_controls.clone();
    let live = runtime.live_turns.clone();
    app.listen("app-event", move |event| {
        let mut payload = event.payload().to_string();
        if let Ok(mut value) = serde_json::from_str::<Value>(&payload) {
            let conv = value.get("conversationId").and_then(Value::as_str);
            let inner = value.get("event");
            let mut seq = None;
            if let (Some(conv), Some(inner)) = (conv, inner) {
                if value.get("type").and_then(Value::as_str) == Some("pi_event") {
                    let mut live = live.lock().unwrap();
                    let turn = live.entry(conv.to_string()).or_default();
                    turn.seq += 1;
                    turn.record(inner);
                    seq = Some(turn.seq);
                }
                match inner.get("type").and_then(Value::as_str) {
                    Some("cli_control_request") => pending
                        .lock()
                        .unwrap()
                        .entry(conv.to_string())
                        .or_default()
                        .push(inner.clone()),
                    Some("agent_end") => {
                        pending.lock().unwrap().remove(conv);
                    }
                    Some("cli_control_resolved") => {
                        let request_id = inner.get("requestId");
                        if let Some(queue) = pending.lock().unwrap().get_mut(conv) {
                            queue.retain(|item| item.get("requestId") != request_id);
                        }
                    }
                    _ => {}
                }
            }
            if let Some(seq) = seq {
                value["seq"] = json!(seq);
                payload = value.to_string();
            }
        }
        let _ = tx.send(payload);
    });
    let enabled = app
        .state::<AppState>()
        .store
        .get_setting(ENABLED_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if enabled {
        app.state::<RemoteRuntime>().start(app.clone());
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    enabled: bool,
    /// Hold off system idle sleep while remote access is enabled so the phone
    /// can always reach this Mac. Display sleep and the lock screen are
    /// unaffected.
    keep_awake: bool,
    port: u16,
    access_url: String,
    pairing_url: String,
    pairing_qr_svg: String,
    tailscale_ready: bool,
    tailscale_message: String,
    /// `cetus://pair#…` for the iOS app, and its QR.
    app_pairing_link: String,
    app_pairing_qr_svg: String,
    devices: Vec<crate::remote_secure::DeviceInfo>,
    relay: crate::remote_secure::RelayStatus,
}

#[host::command]
pub async fn get_remote_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
) -> Result<RemoteSettings, String> {
    Ok(settings(&app, &state, &runtime))
}

#[host::command]
pub async fn set_remote_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
    enabled: bool,
) -> Result<RemoteSettings, String> {
    state
        .store
        .set_setting(ENABLED_KEY, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    if enabled {
        runtime.start(app.clone());
        let configured = host::async_runtime::spawn_blocking(configure_tailscale)
            .await
            .map_err(|e| e.to_string())?;
        let mut snapshot = settings(&app, &state, &runtime);
        if let Err(error) = configured {
            snapshot.tailscale_ready = false;
            snapshot.tailscale_message = format!("Tailscale Serve needs attention: {error}");
        }
        return Ok(snapshot);
    } else {
        runtime.stop();
    }
    Ok(settings(&app, &state, &runtime))
}

#[host::command]
pub async fn set_remote_keep_awake(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
    enabled: bool,
) -> Result<RemoteSettings, String> {
    state
        .store
        .set_setting(
            crate::awake::REMOTE_KEEP_AWAKE_KEY,
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())?;
    crate::awake::set_remote_pref(enabled);
    Ok(settings(&app, &state, &runtime))
}

#[host::command]
pub async fn rotate_remote_access(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
) -> Result<RemoteSettings, String> {
    let token = new_token();
    state
        .store
        .set_setting(TOKEN_KEY, &token)
        .map_err(|e| e.to_string())?;
    *runtime.token.lock().unwrap() = token;
    // WebState shares this mutex, so existing HTTP and WebSocket handshakes
    // reject the old credential immediately without racing a listener restart.
    Ok(settings(&app, &state, &runtime))
}

fn settings(_app: &AppHandle, state: &AppState, runtime: &RemoteRuntime) -> RemoteSettings {
    let enabled = state
        .store
        .get_setting(ENABLED_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    let keep_awake = state
        .store
        .get_setting(crate::awake::REMOTE_KEEP_AWAKE_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    let (access_url, tailscale_ready, tailscale_message) = tailscale_url();
    let pairing_url = format!("{access_url}/pair?token={}", runtime.token());
    let pairing_qr_svg = qr_svg(&pairing_url);
    let secure = _app.state::<Arc<crate::remote_secure::SecureState>>();
    let relay_url = secure.relay_url(&state.store);
    let direct = tailscale_ready
        .then(|| format!("{}/v1/direct", access_url.replacen("https://", "wss://", 1)));
    let app_pairing_link = secure.pairing_link(
        &relay_url,
        direct.as_deref(),
        &crate::remote_secure::mac_name(),
    );
    let app_pairing_qr_svg = qr_svg(&app_pairing_link);
    let mut relay = secure.relay.lock().unwrap().clone();
    if relay.url.is_empty() {
        relay.url = relay_url;
    }
    RemoteSettings {
        app_pairing_link,
        app_pairing_qr_svg,
        devices: secure.devices(),
        relay,
        enabled,
        keep_awake,
        port: PORT,
        access_url,
        pairing_url,
        pairing_qr_svg,
        tailscale_ready,
        tailscale_message,
    }
}

fn qr_svg(text: &str) -> String {
    QrCode::new(text.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(256, 256)
                .dark_color(svg::Color("#171717"))
                .light_color(svg::Color("#ffffff"))
                .build()
        })
        .unwrap_or_default()
}

const SIDEBAR_SETTING: &str = "remote.sidebar";

/// The desktop sidebar's folder groups as drawn ({defaultWorkspace, dirs,
/// hidden}). The phone groups chats the same way, so the webview pushes it
/// whenever the order or the hidden set changes.
#[host::command]
pub async fn set_remote_sidebar(state: State<'_, AppState>, sidebar: Value) -> Result<(), String> {
    state
        .store
        .set_setting(SIDEBAR_SETTING, &sidebar.to_string())
        .map_err(|e| e.to_string())
}

fn load_sidebar(state: &AppState) -> Value {
    state
        .store
        .get_setting(SIDEBAR_SETTING)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({ "defaultWorkspace": "", "dirs": [], "hidden": [] }))
}

/// What the phone needs to know about a folder's repo icon before fetching
/// it: `v` changes whenever the picture would (other file, edited file, other
/// GitHub owner), so the phone only downloads what its cache lacks.
#[derive(Clone)]
struct PhoneIcon {
    v: String,
    path: Option<String>,
    url: Option<String>,
}

/// Looking an icon up runs git twice per folder and the phone asks on every
/// list refresh, so answers are kept for a little while.
const PHONE_ICON_TTL: std::time::Duration = std::time::Duration::from_secs(30);
/// 22pt at 3x, with a little headroom.
const PHONE_ICON_PX: u32 = 72;

type PhoneIconCache = Mutex<HashMap<String, (std::time::Instant, Option<PhoneIcon>)>>;

fn phone_icon_cache() -> &'static PhoneIconCache {
    static CACHE: std::sync::OnceLock<PhoneIconCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Blocking: runs git.
fn phone_icon(dir: &str) -> Option<PhoneIcon> {
    if let Some((at, icon)) = phone_icon_cache().lock().unwrap().get(dir) {
        if at.elapsed() < PHONE_ICON_TTL {
            return icon.clone();
        }
    }
    let icon = commands::repo_icon(dir).and_then(|icon| {
        if let Some(path) = icon.path {
            let meta = std::fs::metadata(&path).ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            Some(PhoneIcon {
                v: format!("{path}:{mtime}:{}", meta.len()),
                path: Some(path),
                url: None,
            })
        } else {
            icon.url.map(|url| PhoneIcon {
                v: url.clone(),
                path: None,
                url: Some(url),
            })
        }
    });
    phone_icon_cache()
        .lock()
        .unwrap()
        .insert(dir.to_string(), (std::time::Instant::now(), icon.clone()));
    icon
}

/// The repo's icon file as a small PNG: the phone's uplink from the Mac is
/// slow, and it can't decode SVG at all. Blocking: runs sips.
fn phone_icon_png(path: &str) -> Option<Vec<u8>> {
    let out = std::env::temp_dir().join(format!("cetus-icon-{}.png", uuid::Uuid::new_v4()));
    let px = PHONE_ICON_PX.to_string();
    let done = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-Z", &px, path, "--out"])
        .arg(&out)
        .output()
        .is_ok_and(|o| o.status.success());
    let bytes = done.then(|| std::fs::read(&out).ok()).flatten();
    let _ = std::fs::remove_file(&out);
    bytes.filter(|b| !b.is_empty())
}

/// Folders of the sidebar that show a repo icon on the desktop: listed, not
/// the default "Chat" one, and without a color / emoji of the user's own.
fn phone_icon_dirs(sidebar: &Value) -> Vec<String> {
    let default = sidebar["defaultWorkspace"].as_str().unwrap_or_default();
    let hidden: Vec<&str> = sidebar["hidden"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    sidebar["dirs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|d| {
                    *d != default && !hidden.contains(d) && sidebar["avatars"].get(*d).is_none()
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Forget a paired phone; its live session (if any) is dropped at once.
#[host::command]
pub async fn revoke_remote_device(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
    id: String,
) -> Result<RemoteSettings, String> {
    app.state::<Arc<crate::remote_secure::SecureState>>()
        .revoke(&state.store, &id);
    Ok(settings(&app, &state, &runtime))
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn tailscale_binary() -> String {
    [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ]
    .into_iter()
    .find(|p| Command::new(p).arg("version").output().is_ok())
    .unwrap_or("tailscale")
    .to_string()
}

fn configure_tailscale() -> Result<(), String> {
    let output = Command::new(tailscale_binary())
        .args([
            "serve",
            "--bg",
            "--yes",
            &format!("http://127.0.0.1:{PORT}"),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn tailscale_url() -> (String, bool, String) {
    let output = Command::new(tailscale_binary())
        .args(["status", "--json"])
        .output();
    let Ok(output) = output else {
        return (
            format!("http://127.0.0.1:{PORT}"),
            false,
            "Tailscale CLI not found".into(),
        );
    };
    if !output.status.success() {
        return (
            format!("http://127.0.0.1:{PORT}"),
            false,
            "Tailscale is not connected".into(),
        );
    }
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    let dns = value
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('.');
    if dns.is_empty() {
        (
            format!("http://127.0.0.1:{PORT}"),
            false,
            "MagicDNS name unavailable".into(),
        )
    } else {
        (
            format!("https://{dns}"),
            true,
            "Available only inside your tailnet".into(),
        )
    }
}

fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.css", get(css))
        .route("/app.js", get(js))
        .route("/manifest.webmanifest", get(manifest))
        .route("/remote-icon.svg", get(icon))
        .route("/pair", get(pair))
        .route("/api/status", get(api_status))
        .route("/api/events", get(events))
        .route(
            "/api/conversations",
            get(list_conversations).post(new_conversation),
        )
        .route(
            "/api/conversations/:id",
            get(get_conversation).patch(update_conversation),
        )
        .route("/api/conversations/:id/messages", post(send_message))
        .route("/api/conversations/:id/abort", post(abort))
        .route("/api/conversations/:id/control", post(control))
        .route("/v1/direct", get(direct_socket))
        .with_state(state)
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../remote/index.html"))
}
async fn css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        format!(
            "{}\n{}",
            include_str!("../../src/styles/cetus-tokens.css"),
            include_str!("../remote/app.css")
        ),
    )
}
async fn js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../remote/app.js"),
    )
}
async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        include_str!("../remote/manifest.webmanifest"),
    )
}
async fn icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml")],
        include_str!("../remote/icon.svg"),
    )
}

async fn pair(
    AxumState(state): AxumState<WebState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    let token = state.token.lock().unwrap().clone();
    if query.get("token") != Some(&token) {
        return (StatusCode::UNAUTHORIZED, "Invalid or expired pairing link").into_response();
    }
    let mut response = Redirect::to("/").into_response();
    let cookie = format!(
        "cetus_remote={}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000",
        token
    );
    response
        .headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    response
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("cetus_remote={token}");
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').any(|part| part.trim() == expected))
}

fn require(headers: &HeaderMap, state: &WebState) -> Result<(), (StatusCode, Json<Value>)> {
    let client_header = headers.get("x-cetus-remote").and_then(|v| v.to_str().ok()) == Some("1");
    if authorized(headers, &state.token.lock().unwrap()) && client_header {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Pair this phone from Cetus Settings first."})),
        ))
    }
}

fn json_error(error: String) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({"error": error})))
}

async fn api_status(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    Ok(Json(json!({"ok":true,"version":1})))
}

async fn list_conversations(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    let include = q.get("archived").is_some_and(|v| v == "true");
    commands::list_conversations(web.app.state(), include)
        .await
        .map(|v| Json(json!(v)))
        .map_err(json_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewConversation {
    workspace_dir: Option<String>,
    backend: Option<String>,
}
async fn new_conversation(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Json(body): Json<NewConversation>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    let conversation =
        commands::new_conversation(web.app.clone(), web.app.state(), body.workspace_dir, None)
            .await
            .map_err(json_error)?;
    if let Some(backend) = body.backend.filter(|b| b != "pi") {
        commands::set_conversation_backend(web.app.state(), conversation.id.clone(), backend)
            .await
            .map_err(json_error)?;
    }
    let conversation = commands::get_conversation(web.app.state(), conversation.id)
        .await
        .map_err(json_error)?;
    Ok(Json(json!(conversation)))
}

async fn get_conversation(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    let snapshot = commands::switch_conversation(web.app.state(), id.clone())
        .await
        .map_err(json_error)?;
    let controls = web
        .pending_controls
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_default();
    Ok(Json(
        json!({"conversation":snapshot.conversation,"messages":snapshot.messages,"pendingControls":controls}),
    ))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationPatch {
    title: Option<String>,
    backend: Option<String>,
    cli_model: Option<String>,
    cli_effort: Option<String>,
    archived: Option<bool>,
    review_state: Option<String>,
}
async fn update_conversation(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(patch): Json<ConversationPatch>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    if let Some(title) = patch.title {
        commands::rename_conversation(web.app.state(), id.clone(), title)
            .await
            .map_err(json_error)?;
    }
    if let Some(backend) = patch.backend {
        commands::set_conversation_backend(web.app.state(), id.clone(), backend)
            .await
            .map_err(json_error)?;
    }
    if patch.cli_model.is_some() || patch.cli_effort.is_some() {
        commands::set_conversation_cli_model(
            web.app.state(),
            id.clone(),
            patch.cli_model.unwrap_or_default(),
            patch.cli_effort.unwrap_or_default(),
        )
        .await
        .map_err(json_error)?;
    }
    if let Some(review) = patch.review_state {
        commands::set_review_state(web.app.state(), id.clone(), review)
            .await
            .map_err(json_error)?;
    }
    if let Some(archived) = patch.archived {
        commands::archive_conversation(web.app.state(), id.clone(), archived)
            .await
            .map_err(json_error)?;
    }
    commands::get_conversation(web.app.state(), id)
        .await
        .map(|v| Json(json!(v)))
        .map_err(json_error)
}

#[derive(Deserialize)]
struct PromptBody {
    message: String,
    images: Option<Vec<commands::ImageAttachment>>,
}
async fn send_message(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    commands::send_prompt(web.app.state(), id, body.message, body.images)
        .await
        .map(|_| StatusCode::ACCEPTED)
        .map_err(json_error)
}
async fn abort(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    commands::abort(web.app.state(), id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(json_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlBody {
    request_id: Value,
    response: Value,
    source: Option<String>,
}
async fn control(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ControlBody>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    require(&headers, &web)?;
    let request_id = body.request_id.clone();
    crate::cli_backend::cli_control_respond(
        web.app.state(),
        id.clone(),
        body.request_id,
        body.response,
        body.source,
        None,
    )
    .await
    .map_err(json_error)?;
    if let Some(queue) = web.pending_controls.lock().unwrap().get_mut(&id) {
        queue.retain(|item| item.get("requestId") != Some(&request_id));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn events(
    AxumState(web): AxumState<WebState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !authorized(&headers, &web.token.lock().unwrap()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| event_socket(socket, web.events.subscribe()))
        .into_response()
}

async fn event_socket(mut socket: WebSocket, mut rx: tokio::sync::broadcast::Receiver<String>) {
    while let Ok(payload) = rx.recv().await {
        if socket.send(Message::Text(payload)).await.is_err() {
            break;
        }
    }
}

/// Direct WebSocket for the iOS app (Tailscale / localhost). Unauthenticated
/// at the HTTP layer on purpose: the Noise handshake + `hello` inside it is
/// the authentication, exactly as over the relay.
async fn direct_socket(
    AxumState(web): AxumState<WebState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.max_message_size(1 << 20).on_upgrade(move |socket| async move {
        let (in_tx, in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        crate::remote_secure::spawn_session(web.app.clone(), web.clone(), in_rx, out_tx);
        let (mut sink, mut stream) = futures_util::StreamExt::split(socket);
        use futures_util::{SinkExt, StreamExt};
        loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Binary(b))) => { if in_tx.send(b).await.is_err() { break; } }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                out = out_rx.recv() => match out {
                    Some(b) => { if sink.send(Message::Binary(b)).await.is_err() { break; } }
                    None => break,
                },
            }
        }
    })
}

const TOOL_TEXT_MAX: usize = 4000;

/// Cuts long text inside tool results (and their image payloads) for phones.
fn trim_tool_output(message: &mut Value) {
    if message.get("role").and_then(Value::as_str) != Some("toolResult") {
        return;
    }
    if let Some(content) = message.get_mut("content") {
        trim_tool_content(content);
    }
}

fn trim_tool_content(content: &mut Value) {
    let cut = |s: &mut String| {
        if s.len() > TOOL_TEXT_MAX {
            let mut end = TOOL_TEXT_MAX;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push_str("\n… (truncated on phone)");
        }
    };
    match content {
        Value::String(s) => cut(s),
        Value::Array(blocks) => {
            blocks.retain(|b| b.get("type").and_then(Value::as_str) != Some("image"));
            for b in blocks.iter_mut() {
                if let Some(Value::String(s)) = b.get_mut("text") {
                    cut(s);
                }
            }
        }
        _ => {}
    }
}

/// A GitHub owner avatar (already 64px), or None when GitHub is out of reach.
async fn fetch_avatar(url: &str) -> Option<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    let res = client.get(url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    (!bytes.is_empty() && bytes.len() <= 512 * 1024).then(|| bytes.to_vec())
}

/// Models and reasoning efforts the phone's picker offers for one runtime:
/// `{ models: [{ id, label, efforts? }], efforts: [{ id, label }], model, effort }`.
/// `model` / `effort` are what runs when a conversation carries no override;
/// a model's own `efforts` narrows the list for that model. Runtimes without
/// tuning return empty lists. The static tables mirror the desktop picker
/// (CLI_MODELS / CLI_EFFORTS in backend-picker.tsx, model-picker.tsx for pi)
/// and live here so a phone build doesn't go stale when they change.
async fn phone_tuning(state: &AppState, backend: &str) -> Value {
    fn options(rows: &[(&str, &str)]) -> Vec<Value> {
        rows.iter()
            .map(|(id, label)| json!({ "id": id, "label": label }))
            .collect()
    }
    if backend == "pi" {
        const LEVELS: [(&str, &str); 7] = [
            ("off", "Off"),
            ("minimal", "Minimal"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "XHigh"),
            ("max", "Max"),
        ];
        let mut models = vec![json!({
            "id": "flash",
            "label": "DeepSeek V4.1 Flash",
            "efforts": ["off", "low", "high", "max"],
        })];
        for provider in crate::custom_models::load(&state.store) {
            for m in &provider.models {
                let efforts: Vec<&str> = LEVELS
                    .iter()
                    .map(|(id, _)| *id)
                    .filter(|id| m.reasoning && m.thinking_levels.contains_key(*id))
                    .collect();
                models.push(json!({
                    "id": format!("{}/{}", provider.id, m.id),
                    "label": if m.name.is_empty() { &m.id } else { &m.name },
                    "efforts": efforts,
                }));
            }
        }
        let default = crate::model::ModelChoice::default();
        return json!({
            "models": models,
            "efforts": options(&LEVELS),
            "model": default.model,
            "effort": default.reasoning,
        });
    }
    let (fallback, efforts): (&[(&str, &str)], &[(&str, &str)]) = match backend {
        "claude-code" => (
            &[
                ("fable", "Fable"),
                ("opus", "Opus"),
                ("sonnet", "Sonnet"),
                ("haiku", "Haiku"),
            ],
            &[
                ("low", "Low"),
                ("medium", "Medium"),
                ("high", "High"),
                ("xhigh", "XHigh"),
                ("max", "Max"),
            ],
        ),
        "codex" => (
            &[
                ("gpt-5.5", "GPT-5.5"),
                ("gpt-5.4", "GPT-5.4"),
                ("gpt-5.4-mini", "GPT-5.4-Mini"),
                ("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
            ],
            &[
                ("low", "Low"),
                ("medium", "Medium"),
                ("high", "High"),
                ("xhigh", "XHigh"),
            ],
        ),
        "grok" => (
            &[("grok-4.5", "Grok 4.5")],
            &[("low", "Low"), ("medium", "Medium"), ("high", "High")],
        ),
        "dsh" => (
            &[("deepseek-flash", "DeepSeek V4.1 Flash")],
            &[
                ("off", "Off"),
                ("low", "Low"),
                ("high", "High"),
                ("max", "Max"),
            ],
        ),
        _ => return json!({ "models": [], "efforts": [], "model": null, "effort": null }),
    };
    let defaults = crate::cli_backend::get_cli_defaults(backend.to_string())
        .await
        .unwrap_or_default();
    // dsh always offers the static list, as the desktop does.
    let models: Vec<(String, String)> = match defaults.models.filter(|_| backend != "dsh") {
        Some(live) if !live.is_empty() => live.into_iter().map(|m| (m.id, m.label)).collect(),
        _ => fallback
            .iter()
            .map(|(id, label)| (id.to_string(), label.to_string()))
            .collect(),
    };
    // The configured default as a catalog id: exact, else by family (claude
    // reports "claude-opus-4-8[1m]" while the catalog carries "opus[1m]").
    let model = defaults.model.as_deref().and_then(|raw| {
        models
            .iter()
            .find(|(id, _)| id == raw)
            .or_else(|| {
                models.iter().find(|(id, _)| {
                    let family = id.split('[').next().unwrap_or_default();
                    !family.is_empty() && raw.contains(family)
                })
            })
            .map(|(id, _)| id.clone())
    });
    let effort = defaults
        .effort
        .filter(|raw| efforts.iter().any(|(id, _)| id == raw));
    json!({
        "models": models
            .iter()
            .map(|(id, label)| json!({ "id": id, "label": label }))
            .collect::<Vec<_>>(),
        "efforts": options(efforts),
        "model": model,
        "effort": effort,
    })
}

/// [`phone_tuning`], remembered for a few minutes per runtime: reading a
/// CLI's catalog can mean starting the CLI, and the phone asks on every
/// screen that shows the picker.
async fn phone_tuning_cached(state: &AppState, backend: &str) -> Value {
    type Cache = Mutex<HashMap<String, (std::time::Instant, Value)>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    const TTL: std::time::Duration = std::time::Duration::from_secs(300);
    let cache = CACHE.get_or_init(Default::default);
    // pi's list is a settings read and should follow Settings → Models at once.
    if backend != "pi" {
        if let Some((at, value)) = cache.lock().unwrap().get(backend) {
            if at.elapsed() < TTL {
                return value.clone();
            }
        }
    }
    let value = phone_tuning(state, backend).await;
    cache.lock().unwrap().insert(
        backend.to_string(),
        (std::time::Instant::now(), value.clone()),
    );
    value
}

/// Apply the model / effort fields of a phone request to a conversation:
/// `model: { model, reasoning }` for the built-in runtime, `cliModel` +
/// `cliEffort` (always sent together; "" = the CLI's default) for the others.
async fn apply_phone_tuning(app: &AppHandle, id: &str, params: &Value) -> Result<(), String> {
    if let Some(choice) = params.get("model").filter(|v| !v.is_null()) {
        let choice =
            serde_json::from_value(choice.clone()).map_err(|e| format!("bad model: {e}"))?;
        commands::set_model_choice(app.state(), id.to_string(), choice).await?;
    }
    if params.get("cliModel").is_some() || params.get("cliEffort").is_some() {
        commands::set_conversation_cli_model(
            app.state(),
            id.to_string(),
            param_str(params, "cliModel").unwrap_or_default(),
            param_str(params, "cliEffort").unwrap_or_default(),
        )
        .await?;
    }
    Ok(())
}

fn param_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

fn require_str(params: &Value, key: &str) -> Result<String, String> {
    param_str(params, key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {key}"))
}

/// The conversation API behind the iOS app's encrypted channel. Mirrors the
/// HTTP routes below; the caller has already authenticated the device.
pub(crate) async fn rpc(web: &WebState, method: &str, params: Value) -> Result<Value, String> {
    let app = &web.app;
    match method {
        "conversations.list" => {
            let archived = params
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rows = commands::list_conversations(app.state(), archived).await?;
            Ok(json!(rows))
        }
        "conversations.create" => {
            let conversation = commands::new_conversation(
                app.clone(),
                app.state(),
                param_str(&params, "workspaceDir"),
                None,
            )
            .await?;
            if let Some(backend) = param_str(&params, "backend").filter(|b| b != "pi") {
                commands::set_conversation_backend(app.state(), conversation.id.clone(), backend)
                    .await?;
            }
            apply_phone_tuning(app, &conversation.id, &params).await?;
            Ok(json!(
                commands::get_conversation(app.state(), conversation.id).await?
            ))
        }
        "conversations.get" => {
            let id = require_str(&params, "id")?;
            let snapshot = commands::switch_conversation(app.state(), id.clone()).await?;
            let controls = web
                .pending_controls
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .unwrap_or_default();
            // Phones get the tail of the history with long tool output cut:
            // a full agent transcript is megabytes and the Mac's uplink may be
            // slow. `limit: 0` asks for everything.
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(120) as usize;
            let mut messages = json!(snapshot.messages);
            let total = messages.as_array().map_or(0, Vec::len);
            if let Some(list) = messages.as_array_mut() {
                if limit > 0 && list.len() > limit {
                    list.drain(..list.len() - limit);
                }
                for m in list.iter_mut() {
                    trim_tool_output(m);
                }
            }
            let cli = cetus_bridge::cli_agent::CliBackend::from_id(&snapshot.conversation.backend)
                .is_some();
            let (live_events, live_seq) = match web.live_turns.lock().unwrap().get(&id) {
                Some(turn) => (turn.replay(cli).to_vec(), turn.seq),
                None => (Vec::new(), 0),
            };
            Ok(json!({
                "conversation": snapshot.conversation,
                "messages": messages,
                "totalMessages": total,
                "pendingControls": controls,
                // The open turn, to replay on top of `messages`; stream
                // events numbered up to `liveSeq` are already in it.
                "liveEvents": live_events,
                "liveSeq": live_seq,
            }))
        }
        "conversations.update" => {
            let id = require_str(&params, "id")?;
            if let Some(title) = param_str(&params, "title") {
                commands::rename_conversation(app.state(), id.clone(), title).await?;
            }
            if let Some(backend) = param_str(&params, "backend") {
                commands::set_conversation_backend(app.state(), id.clone(), backend).await?;
            }
            apply_phone_tuning(app, &id, &params).await?;
            if let Some(archived) = params.get("archived").and_then(Value::as_bool) {
                commands::archive_conversation(app.state(), id.clone(), archived).await?;
            }
            Ok(json!(commands::get_conversation(app.state(), id).await?))
        }
        "conversations.send" => {
            let id = require_str(&params, "id")?;
            let message = param_str(&params, "message").unwrap_or_default();
            let images: Option<Vec<commands::ImageAttachment>> = params
                .get("images")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|e| format!("bad images: {e}"))?;
            commands::send_prompt(app.state(), id, message, images).await?;
            Ok(Value::Null)
        }
        "conversations.abort" => {
            commands::abort(app.state(), require_str(&params, "id")?).await?;
            Ok(Value::Null)
        }
        "conversations.control" => {
            let id = require_str(&params, "id")?;
            let request_id = params.get("requestId").cloned().unwrap_or(Value::Null);
            crate::cli_backend::cli_control_respond(
                app.state(),
                id.clone(),
                request_id.clone(),
                params.get("response").cloned().unwrap_or(Value::Null),
                param_str(&params, "source"),
                None,
            )
            .await?;
            if let Some(queue) = web.pending_controls.lock().unwrap().get_mut(&id) {
                queue.retain(|item| item.get("requestId") != Some(&request_id));
            }
            Ok(Value::Null)
        }
        "runtimes.tuning" => {
            let backend = require_str(&params, "backend")?;
            Ok(phone_tuning_cached(&app.state::<AppState>(), &backend).await)
        }
        "workspaces.list" => Ok(load_sidebar(&app.state::<AppState>())),
        // dir → { v, url? } for every folder that has a repo icon.
        "workspaces.icons" => {
            let dirs = phone_icon_dirs(&load_sidebar(&app.state::<AppState>()));
            let icons = tokio::task::spawn_blocking(move || {
                dirs.into_iter()
                    .filter_map(|dir| {
                        let icon = phone_icon(&dir)?;
                        Some((dir, json!({ "v": icon.v, "url": icon.url })))
                    })
                    .collect::<serde_json::Map<String, Value>>()
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(Value::Object(icons))
        }
        // One folder's icon as { v, data: base64 }. A GitHub avatar is fetched
        // here (the Mac is the one more likely to reach GitHub); when that
        // fails the phone still has the url to try itself.
        "workspaces.icon" => {
            let dir = require_str(&params, "dir")?;
            let lookup = dir.clone();
            let Some(icon) = tokio::task::spawn_blocking(move || phone_icon(&lookup))
                .await
                .map_err(|e| e.to_string())?
            else {
                return Ok(Value::Null);
            };
            let bytes = if let Some(path) = icon.path.clone() {
                tokio::task::spawn_blocking(move || phone_icon_png(&path))
                    .await
                    .map_err(|e| e.to_string())?
            } else if let Some(url) = &icon.url {
                fetch_avatar(url).await
            } else {
                None
            };
            use base64::Engine as _;
            Ok(json!({
                "v": icon.v,
                "url": icon.url,
                "data": bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            }))
        }
        "workspaces.add" => {
            let dir = expand_home(&require_str(&params, "dir")?);
            if !std::path::Path::new(&dir).is_dir() {
                return Err(format!("{dir} is not a folder"));
            }
            // Record it right away so the phone's next list already has it;
            // the webview then files it into its own recent list and re-syncs.
            let state = app.state::<AppState>();
            let mut sidebar = load_sidebar(&state);
            let default = sidebar["defaultWorkspace"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if let Some(dirs) = sidebar["dirs"].as_array_mut() {
                if !dirs.iter().any(|d| d.as_str() == Some(&dir)) {
                    let at = usize::from(dirs.first().and_then(Value::as_str) == Some(&default));
                    dirs.insert(at.min(dirs.len()), json!(dir));
                }
            }
            if let Some(hidden) = sidebar["hidden"].as_array_mut() {
                hidden.retain(|d| d.as_str() != Some(&dir));
            }
            let _ = state
                .store
                .set_setting(SIDEBAR_SETTING, &sidebar.to_string());
            let _ = app.emit("remote-workspace-add", dir.clone());
            Ok(sidebar)
        }
        "fs.searchDirs" => {
            let query = param_str(&params, "query").unwrap_or_default();
            let known: Vec<String> = load_sidebar(&app.state::<AppState>())["dirs"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let found = tokio::task::spawn_blocking(move || search_dirs(&query, &known))
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!(found))
        }
        "fs.mkdir" => {
            let parent = expand_home(&require_str(&params, "parent")?);
            let name = require_str(&params, "name")?;
            if name.contains('/') || name == "." || name == ".." {
                return Err("Folder names can't contain \"/\"".into());
            }
            let path = std::path::Path::new(&parent).join(name.trim());
            std::fs::create_dir(&path)
                .map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }
        "conversations.retry" => {
            // Rolls the last turn out of the history; the phone resends `text`.
            let retry = commands::retry_last_turn(app.state(), require_str(&params, "id")?).await?;
            Ok(json!({ "text": retry.text }))
        }
        "artifacts.read" => {
            let path = expand_home(&require_str(&params, "path")?);
            let preview = params.get("preview").and_then(Value::as_bool) == Some(true);
            host::async_runtime::spawn_blocking(move || read_artifact(&path, preview))
                .await
                .map_err(|e| e.to_string())?
        }
        "usage.get" => {
            let force = params.get("force").and_then(Value::as_bool);
            Ok(json!(crate::usage::provider_usage(force).await?))
        }
        _ => Err(format!("unknown method {method}")),
    }
}

/// The most a phone may pull over the relay in one file.
const ARTIFACT_MAX: u64 = 24 * 1024 * 1024;
const ARTIFACT_PREVIEW_SIDE: u32 = 1400;

/// A file an agent handed to the user, for the phone's artifact card.
/// `preview` asks for a downscaled JPEG of an image instead of its bytes.
fn read_artifact(path: &str, preview: bool) -> Result<Value, String> {
    use base64::Engine as _;
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if preview {
        let image = image::open(path).map_err(|e| format!("Couldn't read the image: {e}"))?;
        let small = image.thumbnail(ARTIFACT_PREVIEW_SIDE, ARTIFACT_PREVIEW_SIDE);
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(small.to_rgb8())
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        return Ok(json!({ "data": encode(out.get_ref()), "mimeType": "image/jpeg" }));
    }
    if meta.len() > ARTIFACT_MAX {
        return Err("This file is too large to open on the phone.".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    Ok(json!({ "data": encode(&bytes) }))
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

fn expand_home(path: &str) -> String {
    let path = path.trim();
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{}{rest}", home()),
        _ => path.to_string(),
    }
}

fn tilde(path: &str) -> String {
    let home = home();
    match path.strip_prefix(&home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => {
            format!("~{rest}")
        }
        _ => path.to_string(),
    }
}

fn child_dirs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

/// Folder lookup for the phone's "Add folder" sheet. A path (`/…` or `~…`)
/// completes against its parent's children; plain text matches folder names
/// among the sidebar folders and the usual project roots.
fn search_dirs(query: &str, known: &[String]) -> Vec<Value> {
    const LIMIT: usize = 40;
    let query = query.trim();
    let entry = |p: &str| json!({ "path": p, "display": tilde(p) });
    if query.starts_with('/') || query.starts_with('~') {
        let full = expand_home(query);
        let path = std::path::Path::new(&full);
        let (parent, prefix) = if full.ends_with('/') {
            (path.to_path_buf(), String::new())
        } else {
            (
                path.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
                path.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default(),
            )
        };
        let mut out = Vec::new();
        if path.is_dir() && !full.ends_with('/') {
            out.push(entry(&full));
        }
        for child in child_dirs(&parent) {
            let name = child
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let p = child.to_string_lossy().to_string();
            if name.starts_with(&prefix) && p != full {
                out.push(entry(&p));
            }
            if out.len() >= LIMIT {
                break;
            }
        }
        return out;
    }
    let home = home();
    let mut candidates: Vec<String> = known.to_vec();
    let roots = [
        "",
        "Developer",
        "Documents",
        "Projects",
        "projects",
        "code",
        "Code",
        "src",
        "repos",
        "work",
        "Desktop",
    ];
    for root in roots {
        let dir = std::path::Path::new(&home).join(root);
        for child in child_dirs(&dir) {
            candidates.push(child.to_string_lossy().to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| seen.insert(c.clone()));
    let q = query.to_lowercase();
    let name_of = |p: &str| p.rsplit('/').next().unwrap_or(p).to_lowercase();
    let mut hits: Vec<(u8, String)> = candidates
        .into_iter()
        .filter_map(|p| {
            let name = name_of(&p);
            let rank = if q.is_empty() {
                if known.contains(&p) {
                    0
                } else {
                    return None;
                }
            } else if name == q {
                0
            } else if name.starts_with(&q) {
                1
            } else if name.contains(&q) {
                2
            } else if p.to_lowercase().contains(&q) {
                3
            } else {
                return None;
            };
            Some((rank, p))
        })
        .collect();
    hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.len().cmp(&b.1.len()))
            .then(a.1.cmp(&b.1))
    });
    hits.into_iter()
        .take(LIMIT)
        .map(|(_, p)| entry(&p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_icon_dirs_skip_default_hidden_and_styled() {
        let sidebar = json!({
            "defaultWorkspace": "/chat",
            "dirs": ["/chat", "/a", "/b", "/c"],
            "hidden": ["/b"],
            "avatars": { "/c": { "emoji": "🦊" } },
        });
        assert_eq!(phone_icon_dirs(&sidebar), vec!["/a".to_string()]);
    }

    #[test]
    fn phone_icon_png_rasterizes_svg() {
        let svg =
            std::env::temp_dir().join(format!("cetus-icon-test-{}.svg", uuid::Uuid::new_v4()));
        std::fs::write(
            &svg,
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>"#,
        )
        .unwrap();
        let png = phone_icon_png(&svg.to_string_lossy());
        let _ = std::fs::remove_file(&svg);
        assert_eq!(&png.unwrap()[..4], b"\x89PNG");
    }

    #[test]
    fn home_paths_round_trip() {
        let h = home();
        assert_eq!(expand_home("~/x"), format!("{h}/x"));
        assert_eq!(expand_home("~"), h);
        assert_eq!(tilde(&format!("{h}/x")), "~/x");
        assert_eq!(expand_home("~other"), "~other");
    }

    #[test]
    fn path_query_lists_children() {
        let dir =
            std::env::temp_dir().join(format!("cetus-dirs-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("alpha")).unwrap();
        std::fs::create_dir_all(dir.join("beta")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        let q = format!("{}/", dir.display());
        let names: Vec<String> = search_dirs(&q, &[])
            .iter()
            .map(|v| {
                v["path"]
                    .as_str()
                    .unwrap()
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        let q = format!("{}/al", dir.display());
        assert_eq!(search_dirs(&q, &[]).len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn tool_output_is_trimmed_on_char_boundary() {
        let mut m = json!({"role": "toolResult", "content": [
            {"type": "text", "text": "好".repeat(3000)},
            {"type": "image", "data": "xx"}
        ]});
        trim_tool_output(&mut m);
        let blocks = m["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0]["text"].as_str().unwrap().len() < TOOL_TEXT_MAX + 40);
    }
    #[test]
    fn token_has_enough_entropy() {
        assert_eq!(new_token().len(), 64);
    }
    #[test]
    fn cookie_auth_is_exact() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("x=1; cetus_remote=secret"),
        );
        assert!(authorized(&headers, "secret"));
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("cetus_remote=secret-too"),
        );
        assert!(!authorized(&headers, "secret"));
    }
}

#[cfg(test)]
mod live_turn_tests {
    use super::LiveTurn;
    use serde_json::json;

    fn delta(kind: &str, index: u64, text: &str) -> serde_json::Value {
        json!({ "type": "message_update", "assistantMessageEvent": { "type": kind, "contentIndex": index, "delta": text } })
    }

    #[test]
    fn keeps_the_open_turn_and_folds_token_deltas() {
        let mut turn = LiveTurn::default();
        turn.record(&json!({ "type": "agent_start" }));
        turn.record(&json!({ "type": "message_start", "message": { "role": "assistant" } }));
        turn.record(&delta("text_delta", 0, "Hel"));
        turn.record(&delta("text_delta", 0, "lo"));
        turn.record(&delta("text_delta", 1, "next"));
        turn.record(&json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_delta", "contentIndex": 2 } }));
        turn.record(&json!({ "type": "cli_rate_limit" }));
        assert_eq!(turn.events.len(), 4);
        assert_eq!(turn.events[2]["assistantMessageEvent"]["delta"], "Hello");

        // A retrying run stays open; a finished one has nothing to replay.
        turn.record(&json!({ "type": "agent_end", "willRetry": true }));
        assert_eq!(turn.events.len(), 4);
        turn.record(&json!({ "type": "agent_end" }));
        assert!(turn.events.is_empty());
    }

    #[test]
    fn pi_replays_only_the_unfinished_message() {
        let mut turn = LiveTurn::default();
        turn.record(&json!({ "type": "agent_start" }));
        turn.record(&json!({ "type": "message_start", "message": { "role": "assistant" } }));
        turn.record(&delta("text_delta", 0, "done"));
        turn.record(&json!({ "type": "message_end" }));
        turn.record(&json!({ "type": "message_start", "message": { "role": "assistant" } }));
        turn.record(&delta("thinking_delta", 0, "hm"));
        assert_eq!(turn.replay(true).len(), 6);
        assert_eq!(turn.replay(false).len(), 2);
    }

    #[test]
    fn progress_updates_replace_each_other_and_long_output_is_cut() {
        let mut turn = LiveTurn::default();
        let update = |text: &str| json!({ "type": "tool_execution_update", "toolCallId": "a", "partialResult": { "content": [{ "type": "text", "text": text }] } });
        turn.record(&update("one"));
        turn.record(&update("two"));
        assert_eq!(turn.events.len(), 1);
        assert_eq!(turn.events[0]["partialResult"]["content"][0]["text"], "two");
        turn.record(&json!({ "type": "tool_execution_end", "toolCallId": "a", "result": { "content": [{ "type": "text", "text": "x".repeat(9000) }] } }));
        let kept = turn.events[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(kept.len() < 4100);
    }
}
