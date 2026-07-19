//! Authenticated mobile companion served on localhost and published through
//! Tailscale Serve. The remote surface intentionally exposes only conversation
//! operations; native files, terminal, secrets and settings never enter this API.

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
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Listener, Manager, State};

use crate::{commands, AppState};

const ENABLED_KEY: &str = "remote.enabled";
const TOKEN_KEY: &str = "remote.access_token";
const PORT: u16 = 17382;

pub struct RemoteRuntime {
    token: Arc<Mutex<String>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    events: tokio::sync::broadcast::Sender<String>,
    pending_controls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
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
            events,
            pending_controls: Arc::new(Mutex::new(HashMap::new())),
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
        };
        *task = Some(tauri::async_runtime::spawn(async move {
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
    }
}

#[derive(Clone)]
struct WebState {
    app: AppHandle,
    token: Arc<Mutex<String>>,
    events: tokio::sync::broadcast::Sender<String>,
    pending_controls: Arc<Mutex<HashMap<String, Vec<Value>>>>,
}

pub fn initialize(app: AppHandle) {
    let runtime = app.state::<RemoteRuntime>();
    let tx = runtime.events.clone();
    let pending = runtime.pending_controls.clone();
    app.listen("app-event", move |event| {
        let payload = event.payload().to_string();
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            let conv = value.get("conversationId").and_then(Value::as_str);
            let inner = value.get("event");
            if let (Some(conv), Some(inner)) = (conv, inner) {
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
    port: u16,
    access_url: String,
    pairing_url: String,
    pairing_qr_svg: String,
    tailscale_ready: bool,
    tailscale_message: String,
}

#[tauri::command]
pub async fn get_remote_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RemoteRuntime>,
) -> Result<RemoteSettings, String> {
    Ok(settings(&app, &state, &runtime))
}

#[tauri::command]
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
        let configured = tauri::async_runtime::spawn_blocking(configure_tailscale)
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

#[tauri::command]
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
    let (access_url, tailscale_ready, tailscale_message) = tailscale_url();
    let pairing_url = format!("{access_url}/pair?token={}", runtime.token());
    let pairing_qr_svg = QrCode::new(pairing_url.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(256, 256)
                .dark_color(svg::Color("#171717"))
                .light_color(svg::Color("#ffffff"))
                .build()
        })
        .unwrap_or_default();
    RemoteSettings {
        enabled,
        port: PORT,
        access_url,
        pairing_url,
        pairing_qr_svg,
        tailscale_ready,
        tailscale_message,
    }
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
    let conversation = commands::new_conversation(web.app.state(), body.workspace_dir, None)
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

#[cfg(test)]
mod tests {
    use super::*;
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
