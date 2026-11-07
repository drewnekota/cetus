//! End-to-end encrypted channel between this Mac and the Cetus iOS app.
//!
//! Transport-agnostic: the same [`Session`] runs behind the Cloudflare relay
//! (`relay.cetus.run`, see /relay) and behind the direct WebSocket on the
//! local remote server (`/v1/direct`, reachable over Tailscale). Neither the
//! relay nor anything on the path sees plaintext.
//!
//! ## Protocol (v1)
//! - Pairing QR: `cetus://pair#<base64url(JSON offer)>`, offer =
//!   `{v:1, sid, pk, relay, direct?, ps, name}` — `pk` is this Mac's static
//!   X25519 key (base64), `ps` a one-time pairing secret.
//! - Handshake: `Noise_NK_25519_ChaChaPoly_SHA256`, prologue
//!   [`PROLOGUE`]. The phone (initiator) knows `pk` from the QR, so a relay
//!   or network attacker can't stand in for the Mac. Message 1 is the phone's
//!   first binary frame, message 2 our reply; both payloads are empty.
//! - After that every frame is one Noise transport message whose plaintext is
//!   `[flags:u8][chunk]`; bit 0 set = last chunk of a JSON message (Noise caps
//!   a message at 64 KiB, history replies are larger); bit 1 set (on every
//!   chunk) = the reassembled bytes are raw DEFLATE (RFC 1951). Home uplinks
//!   are often a few dozen KB/s, so anything over [`COMPRESS_OVER`] is
//!   compressed before encryption.
//! - JSON messages: requests `{id, method, params}`, replies `{id, result}` /
//!   `{id, error}`, pushes `{event}` (the desktop's `app-event` payloads).
//! - The first request must be `hello {deviceId, deviceName, token}` (a paired
//!   phone) or `hello {deviceId, deviceName, pairingSecret}` (pairing, answered
//!   with a fresh `deviceToken`). Nothing else is served before it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use host::{AppHandle, Manager};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc};

use crate::AppState;

pub const PROLOGUE: &[u8] = b"cetus-remote-v1";
const NOISE_PARAMS: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
const NOISE_MAX: usize = 65_535;
/// Plaintext bytes per transport message: 64 KiB minus the 16-byte tag and
/// our 1-byte flags header.
const CHUNK: usize = NOISE_MAX - 16 - 1;
/// Reassembled JSON messages larger than this are dropped (abuse guard; the
/// phone sends prompts and the odd image, not bulk data).
const MAX_MESSAGE: usize = 32 << 20;
const COMPRESS_OVER: usize = 1024;
const FLAG_LAST: u8 = 1;
const FLAG_DEFLATE: u8 = 2;
const PAIRING_TTL: Duration = Duration::from_secs(15 * 60);
pub const DEFAULT_RELAY: &str = "wss://relay.cetus.run";

const KEY_SETTING: &str = "remote.e2e.static_key";
const SID_SETTING: &str = "remote.e2e.server_id";
const RELAY_KEY_SETTING: &str = "remote.e2e.relay_key";
const DEVICES_SETTING: &str = "remote.e2e.devices";
const RELAY_URL_SETTING: &str = "remote.relay_url";

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

// ── Identity, devices, pairing ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    token_hash: String,
    pub paired_at: i64,
    pub last_seen_at: i64,
}

/// What Settings shows for a paired phone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
    pub last_seen_at: i64,
    pub online: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub url: String,
    pub connected: bool,
    pub error: Option<String>,
}

pub struct SecureState {
    static_private: Vec<u8>,
    static_public: Vec<u8>,
    pub server_id: String,
    relay_key: String,
    pairing: Mutex<(String, Instant)>,
    devices: Mutex<Vec<Device>>,
    /// Device ids with a live session (for Settings' "online" dot).
    online: Mutex<HashMap<String, usize>>,
    revoked: broadcast::Sender<String>,
    pub relay: Mutex<RelayStatus>,
}

fn random_hex(bytes: usize) -> String {
    let mut s = String::new();
    while s.len() < bytes * 2 {
        s.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    s.truncate(bytes * 2);
    s
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time-ish string compare for secrets.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

impl SecureState {
    pub fn load(store: &crate::store::Store) -> Self {
        let get = |k: &str| {
            store
                .get_setting(k)
                .ok()
                .flatten()
                .filter(|v| !v.is_empty())
        };
        let (static_private, static_public) = get(KEY_SETTING)
            .and_then(|v| B64.decode(v).ok())
            .filter(|k| k.len() == 32)
            .and_then(|private| public_key(&private).map(|public| (private, public)))
            .unwrap_or_else(|| {
                let kp = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
                    .generate_keypair()
                    .expect("generate Noise keypair");
                let _ = store.set_setting(KEY_SETTING, &B64.encode(&kp.private));
                (kp.private, kp.public)
            });
        let server_id = get(SID_SETTING)
            .filter(|v| v.len() == 32)
            .unwrap_or_else(|| {
                let v = random_hex(16);
                let _ = store.set_setting(SID_SETTING, &v);
                v
            });
        let relay_key = get(RELAY_KEY_SETTING)
            .filter(|v| v.len() >= 32)
            .unwrap_or_else(|| {
                let v = random_hex(32);
                let _ = store.set_setting(RELAY_KEY_SETTING, &v);
                v
            });
        let devices: Vec<Device> = get(DEVICES_SETTING)
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        Self {
            static_private,
            static_public,
            server_id,
            relay_key,
            pairing: Mutex::new((random_hex(16), Instant::now())),
            devices: Mutex::new(devices),
            online: Mutex::new(HashMap::new()),
            revoked: broadcast::channel(16).0,
            relay: Mutex::new(RelayStatus::default()),
        }
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(&self.static_public)
    }

    /// Current one-time pairing secret, rotated when it has aged out.
    pub fn pairing_secret(&self) -> String {
        let mut p = self.pairing.lock().unwrap();
        if p.1.elapsed() > PAIRING_TTL {
            *p = (random_hex(16), Instant::now());
        }
        p.0.clone()
    }

    fn rotate_pairing(&self) {
        *self.pairing.lock().unwrap() = (random_hex(16), Instant::now());
    }

    pub fn devices(&self) -> Vec<DeviceInfo> {
        let online = self.online.lock().unwrap();
        self.devices
            .lock()
            .unwrap()
            .iter()
            .map(|d| DeviceInfo {
                id: d.id.clone(),
                name: d.name.clone(),
                paired_at: d.paired_at,
                last_seen_at: d.last_seen_at,
                online: online.get(&d.id).is_some_and(|n| *n > 0),
            })
            .collect()
    }

    fn save_devices(&self, store: &crate::store::Store) {
        let json = serde_json::to_string(&*self.devices.lock().unwrap()).unwrap_or_default();
        let _ = store.set_setting(DEVICES_SETTING, &json);
    }

    pub fn revoke(&self, store: &crate::store::Store, id: &str) {
        self.devices.lock().unwrap().retain(|d| d.id != id);
        self.save_devices(store);
        let _ = self.revoked.send(id.to_string());
    }

    pub fn relay_url(&self, store: &crate::store::Store) -> String {
        std::env::var("CETUS_RELAY_URL")
            .ok()
            .or_else(|| store.get_setting(RELAY_URL_SETTING).ok().flatten())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_RELAY.to_string())
            .trim_end_matches('/')
            .to_string()
    }

    /// The `cetus://pair#…` link the QR encodes.
    pub fn pairing_link(&self, relay: &str, direct: Option<&str>, name: &str) -> String {
        let mut offer = json!({
            "v": 1,
            "sid": self.server_id,
            "pk": self.public_key_b64(),
            "relay": relay,
            "ps": self.pairing_secret(),
            "name": name,
        });
        if let Some(d) = direct {
            offer["direct"] = json!(d);
        }
        format!("cetus://pair#{}", B64URL.encode(offer.to_string()))
    }

    /// Checks a `hello`; returns the device id and, when pairing, its new token.
    fn authenticate(
        &self,
        store: &crate::store::Store,
        params: &Value,
    ) -> Result<(String, Option<String>), String> {
        let device_id = params["deviceId"].as_str().unwrap_or("").trim().to_string();
        if device_id.is_empty() || device_id.len() > 128 {
            return Err("missing deviceId".into());
        }
        let name = params["deviceName"]
            .as_str()
            .unwrap_or("iPhone")
            .chars()
            .take(80)
            .collect::<String>();
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(token) = params["token"].as_str() {
            let hash = sha256_hex(token);
            let mut devices = self.devices.lock().unwrap();
            let Some(d) = devices
                .iter_mut()
                .find(|d| d.id == device_id && same(&d.token_hash, &hash))
            else {
                return Err("unpaired".into());
            };
            d.last_seen_at = now;
            if !name.is_empty() {
                d.name = name;
            }
            drop(devices);
            self.save_devices(store);
            return Ok((device_id, None));
        }
        let secret = params["pairingSecret"].as_str().unwrap_or("");
        let current = self.pairing_secret();
        if secret.is_empty() || !same(secret, &current) {
            return Err(
                "This pairing code has expired. Scan the QR code in Cetus Settings again.".into(),
            );
        }
        // One-time: the next phone needs a freshly shown QR.
        self.rotate_pairing();
        let token = random_hex(32);
        {
            let mut devices = self.devices.lock().unwrap();
            devices.retain(|d| d.id != device_id);
            devices.push(Device {
                id: device_id.clone(),
                name,
                token_hash: sha256_hex(&token),
                paired_at: now,
                last_seen_at: now,
            });
        }
        self.save_devices(store);
        Ok((device_id, Some(token)))
    }
}

fn public_key(private: &[u8]) -> Option<Vec<u8>> {
    use snow::params::DHChoice;
    use snow::resolvers::{CryptoResolver, DefaultResolver};
    let mut dh = DefaultResolver.resolve_dh(&DHChoice::Curve25519)?;
    dh.set(private);
    Some(dh.pubkey().to_vec())
}

// ── Session ────────────────────────────────────────────────────────────────

/// One phone connection. Feed it inbound frames; it writes outbound frames to
/// `out`. Dropping the inbound sender ends it.
pub fn spawn_session(
    app: AppHandle,
    web: crate::remote::WebState,
    mut inbound: mpsc::Receiver<Vec<u8>>,
    out: mpsc::Sender<Vec<u8>>,
) {
    host::async_runtime::spawn(async move {
        let secure = app.state::<Arc<SecureState>>().inner().clone();
        let hs = match snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .local_private_key(&secure.static_private)
            .and_then(|b| b.prologue(PROLOGUE))
            .and_then(|b| b.build_responder())
        {
            Ok(hs) => hs,
            Err(e) => {
                tracing::error!("remote: noise init failed: {e}");
                return;
            }
        };
        // Handshake until the first exchange completes, transport after.
        let mut handshake = Some(hs);
        let mut transport: Option<snow::TransportState> = None;
        let mut partial: Vec<u8> = Vec::new();
        let mut device: Option<String> = None;
        let mut events = web.events.subscribe();
        let mut revoked = secure.revoked.subscribe();
        // Replies are produced off the read loop so a slow command (send_prompt
        // can take a moment) never stalls event delivery or other requests.
        let (reply_tx, mut reply_rx) = mpsc::channel::<Value>(64);

        loop {
            tokio::select! {
                frame = inbound.recv() => {
                    let Some(frame) = frame else { break };
                    if let Some(mut hs) = handshake.take() {
                        let mut buf = vec![0u8; NOISE_MAX];
                        if hs.read_message(&frame, &mut buf).is_err() {
                            break;
                        }
                        let Ok(n) = hs.write_message(&[], &mut buf) else { break };
                        if out.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                        match hs.into_transport_mode() {
                            Ok(t) => transport = Some(t),
                            Err(_) => break,
                        }
                        continue;
                    }
                    let Some(t) = transport.as_mut() else { break };
                    {
                        {
                            let mut buf = vec![0u8; frame.len()];
                            let Ok(n) = t.read_message(&frame, &mut buf) else { break };
                            if n == 0 { continue; }
                            partial.extend_from_slice(&buf[1..n]);
                            if partial.len() > MAX_MESSAGE { break; }
                            if buf[0] & FLAG_LAST == 0 { continue; }
                            let mut msg = std::mem::take(&mut partial);
                            if buf[0] & FLAG_DEFLATE != 0 {
                                let Some(plain) = inflate(&msg) else { break };
                                msg = plain;
                            }
                            let Ok(req) = serde_json::from_slice::<Value>(&msg) else { continue };
                            let id = req["id"].clone();
                            let method = req["method"].as_str().unwrap_or("").to_string();
                            let params = req["params"].clone();
                            if method == "hello" {
                                let state = app.state::<AppState>();
                                let reply = match secure.authenticate(&state.store, &params) {
                                    Ok((dev, token)) => {
                                        if device.is_none() {
                                            *secure.online.lock().unwrap().entry(dev.clone()).or_default() += 1;
                                        }
                                        device = Some(dev);
                                        json!({"id": id, "result": {
                                            "deviceToken": token,
                                            "macName": mac_name(),
                                            "protocol": 1,
                                        }})
                                    }
                                    Err(e) => json!({"id": id, "error": e}),
                                };
                                if send_json(t, &out, &reply).await.is_err() { break; }
                                continue;
                            }
                            if device.is_none() {
                                let reply = json!({"id": id, "error": "unauthenticated"});
                                if send_json(t, &out, &reply).await.is_err() { break; }
                                continue;
                            }
                            let web = web.clone();
                            let tx = reply_tx.clone();
                            host::async_runtime::spawn(async move {
                                let reply = match crate::remote::rpc(&web, &method, params).await {
                                    Ok(result) => json!({"id": id, "result": result}),
                                    Err(error) => json!({"id": id, "error": error}),
                                };
                                let _ = tx.send(reply).await;
                            });
                        }
                    }
                }
                Some(reply) = reply_rx.recv() => {
                    if let Some(t) = transport.as_mut() {
                        if send_json(t, &out, &reply).await.is_err() { break; }
                    }
                }
                ev = events.recv(), if device.is_some() => {
                    let payload = match ev {
                        Ok(p) => p,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Missed deltas: tell the phone to refetch.
                            json!({"type": "resync"}).to_string()
                        }
                        Err(_) => break,
                    };
                    if let Some(t) = transport.as_mut() {
                        let event: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                        if !forwardable(&event) { continue; }
                        if send_json(t, &out, &json!({"event": event})).await.is_err() { break; }
                    }
                }
                Ok(id) = revoked.recv() => {
                    if device.as_deref() == Some(id.as_str()) { break; }
                }
            }
        }
        if let Some(dev) = device {
            let mut online = secure.online.lock().unwrap();
            if let Some(n) = online.get_mut(&dev) {
                *n = n.saturating_sub(1);
            }
        }
    });
}

/// Only conversation traffic goes to phones — not screen-context, voice or
/// window chatter that also rides `app-event`.
fn forwardable(event: &Value) -> bool {
    event.get("conversationId").is_some()
        || matches!(
            event.get("type").and_then(Value::as_str),
            Some(
                "conversation_updated" | "conversation_created" | "conversation_deleted" | "resync"
            )
        )
}

async fn send_json(
    t: &mut snow::TransportState,
    out: &mpsc::Sender<Vec<u8>>,
    value: &Value,
) -> Result<(), ()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| ())?;
    let mut flags = 0u8;
    if bytes.len() > COMPRESS_OVER {
        if let Some(packed) = deflate(&bytes).filter(|p| p.len() < bytes.len()) {
            bytes = packed;
            flags |= FLAG_DEFLATE;
        }
    }
    let mut chunks = bytes.chunks(CHUNK).peekable();
    if chunks.peek().is_none() {
        return Ok(());
    }
    while let Some(chunk) = chunks.next() {
        let mut plain = Vec::with_capacity(chunk.len() + 1);
        plain.push(
            flags
                | if chunks.peek().is_none() {
                    FLAG_LAST
                } else {
                    0
                },
        );
        plain.extend_from_slice(chunk);
        let mut buf = vec![0u8; plain.len() + 16];
        let n = t.write_message(&plain, &mut buf).map_err(|_| ())?;
        buf.truncate(n);
        out.send(buf).await.map_err(|_| ())?;
    }
    Ok(())
}

fn deflate(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Write;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(bytes).ok()?;
    enc.finish().ok()
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(bytes)
        .take(MAX_MESSAGE as u64)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

pub fn mac_name() -> String {
    std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".into())
}

// ── Relay client ───────────────────────────────────────────────────────────

const RELAY_OPEN: u8 = 1;
const RELAY_DATA: u8 = 2;
const RELAY_CLOSE: u8 = 3;
const CID_LEN: usize = 16;

/// Holds this Mac's room on the relay open, reconnecting with backoff, and
/// runs one [`Session`] per phone the relay announces.
pub async fn run_relay(app: AppHandle, web: crate::remote::WebState) {
    let secure = app.state::<Arc<SecureState>>().inner().clone();
    let mut backoff = Duration::from_secs(1);
    loop {
        let url = {
            let state = app.state::<AppState>();
            secure.relay_url(&state.store)
        };
        let full = format!(
            "{url}/v1/server?sid={}&key={}",
            secure.server_id, secure.relay_key
        );
        *secure.relay.lock().unwrap() = RelayStatus {
            url: url.clone(),
            connected: false,
            error: None,
        };
        match tokio_tungstenite::connect_async(full.as_str()).await {
            Ok((ws, _)) => {
                tracing::info!("remote: relay connected ({url})");
                secure.relay.lock().unwrap().connected = true;
                backoff = Duration::from_secs(1);
                let reason = relay_loop(&app, &web, ws).await;
                tracing::info!("remote: relay disconnected: {reason}");
                *secure.relay.lock().unwrap() = RelayStatus {
                    url,
                    connected: false,
                    error: Some(reason),
                };
            }
            Err(e) => {
                tracing::warn!("remote: relay connect failed: {e}");
                *secure.relay.lock().unwrap() = RelayStatus {
                    url,
                    connected: false,
                    error: Some(e.to_string()),
                };
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn relay_loop(
    app: &AppHandle,
    web: &crate::remote::WebState,
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    use tokio_tungstenite::tungstenite::Message;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(256);
    let mut sessions: HashMap<[u8; CID_LEN], mpsc::Sender<Vec<u8>>> = HashMap::new();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            msg = stream.next() => {
                let bytes = match msg {
                    Some(Ok(Message::Binary(b))) => b,
                    Some(Ok(Message::Close(f))) => return format!("closed {:?}", f.map(|f| f.code)),
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return e.to_string(),
                    None => return "stream ended".into(),
                };
                if bytes.len() < 1 + CID_LEN { continue; }
                let mut cid = [0u8; CID_LEN];
                cid.copy_from_slice(&bytes[1..1 + CID_LEN]);
                match bytes[0] {
                    RELAY_OPEN => {
                        let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(64);
                        let (sess_out, mut sess_rx) = mpsc::channel::<Vec<u8>>(64);
                        sessions.insert(cid, in_tx);
                        spawn_session(app.clone(), web.clone(), in_rx, sess_out);
                        // Tag the session's outbound frames with its client id.
                        let out = out_tx.clone();
                        host::async_runtime::spawn(async move {
                            while let Some(payload) = sess_rx.recv().await {
                                let mut f = Vec::with_capacity(1 + CID_LEN + payload.len());
                                f.push(RELAY_DATA);
                                f.extend_from_slice(&cid);
                                f.extend_from_slice(&payload);
                                if out.send(f).await.is_err() { return; }
                            }
                            // Session ended on our side: hang up that phone.
                            let mut f = vec![RELAY_CLOSE];
                            f.extend_from_slice(&cid);
                            let _ = out.send(f).await;
                        });
                    }
                    RELAY_DATA => {
                        if let Some(tx) = sessions.get(&cid) {
                            if tx.send(bytes[1 + CID_LEN..].to_vec()).await.is_err() {
                                sessions.remove(&cid);
                            }
                        }
                    }
                    RELAY_CLOSE => { sessions.remove(&cid); }
                    _ => {}
                }
            }
            Some(frame) = out_rx.recv() => {
                if let Err(e) = sink.send(Message::Binary(frame)).await {
                    return e.to_string();
                }
            }
            _ = ping.tick() => {
                if let Err(e) = sink.send(Message::Ping(Vec::new())).await {
                    return e.to_string();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_matches_generated() {
        let kp = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .generate_keypair()
            .unwrap();
        assert_eq!(public_key(&kp.private).unwrap(), kp.public);
    }

    #[test]
    fn nk_handshake_and_chunking() {
        let kp = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let mut init = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .remote_public_key(&kp.public)
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut resp = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .local_private_key(&kp.private)
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .build_responder()
            .unwrap();
        let mut a = vec![0u8; NOISE_MAX];
        let mut b = vec![0u8; NOISE_MAX];
        let n = init.write_message(&[], &mut a).unwrap();
        resp.read_message(&a[..n], &mut b).unwrap();
        let n = resp.write_message(&[], &mut a).unwrap();
        init.read_message(&a[..n], &mut b).unwrap();
        let mut ti = init.into_transport_mode().unwrap();
        let mut tr = resp.into_transport_mode().unwrap();

        let big = json!({"x": "y".repeat(200_000)});
        let (tx, mut rx) = mpsc::channel(16);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async { send_json(&mut tr, &tx, &big).await.unwrap() });
        drop(tx);
        let mut whole = Vec::new();
        let mut frames = 0;
        while let Ok(f) = rx.try_recv() {
            frames += 1;
            let mut buf = vec![0u8; f.len()];
            let n = ti.read_message(&f, &mut buf).unwrap();
            whole.extend_from_slice(&buf[1..n]);
            if buf[0] & FLAG_LAST != 0 {
                assert!(buf[0] & FLAG_DEFLATE != 0);
                break;
            }
        }
        // 200 KB of one repeated letter deflates to a single frame.
        assert_eq!(frames, 1);
        let whole = inflate(&whole).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&whole).unwrap(), big);
    }

    #[test]
    fn secret_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}
