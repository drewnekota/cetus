//! Volcano Engine (Doubao) real-time streaming ASR — `大模型流式语音识别`.
//!
//! A binary WebSocket protocol: each frame is a 4-byte header (version/size,
//! message-type/flags, serialization/compression, reserved) + a 4-byte big-endian
//! payload size + a gzip'd payload (JSON config, or raw PCM, or a JSON result).
//! We stream live 16 kHz mono s16le PCM as the user speaks and get partials back
//! in real time; the final lands ~90 ms after the last audio. zh/en code-switch
//! is handled natively (no `language` field). Validated against the live API
//! (see /tmp/doubao_probe.py — this is a faithful Rust port of that reference).
//!
//! Auth (new console) is the `X-Api-Key` header + an `X-Api-Resource-Id`
//! (`volc.seedasr.sauc.duration` for 2.0 / `volc.bigasr.sauc.duration` for 1.0;
//! we default to 2.0). The request body keeps `model_name: "bigmodel"` — the
//! Resource-Id header is what selects the model tier on this v3 sauc endpoint.
//!
//! Wiring (P2): [`stream`] consumes a channel of PCM chunks (fed live by the
//! Swift mic helper) and reports partials via the callback; the dictation
//! pipeline emits those as `voice-partial` and the return as `voice-final`.
#![allow(dead_code)] // wired into voice.rs in a follow-up (Swift PCM streaming)

use anyhow::{anyhow, bail, Result};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::{SinkExt, StreamExt};
use std::io::{Read, Write};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

const URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
/// Optimized bidirectional endpoint that additionally supports
/// `enable_nonstream` — 流式+非流式二遍识别: live partials stream as usual, and
/// each VAD-complete sentence is re-recognized by the more accurate
/// non-streaming model before it turns `definite` (the docs' own accuracy
/// ladder puts this above plain streaming). Push-to-talk tries this first and
/// falls back to [`URL`] by replaying the (teed) audio if the account lacks the
/// entitlement or the session errors.
const URL_ASYNC: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

/// Default `X-Api-Resource-Id`: Doubao streaming ASR 2.0 (SeedASR),
/// pay-by-duration — higher accuracy on code-switch / long-tail terms than 1.0
/// (`volc.bigasr.sauc.duration`). Concurrency variants end in `.concurrent`.
pub const DEFAULT_RESOURCE_ID: &str = "volc.seedasr.sauc.duration";

/// Recognition biasing fed into the request's `corpus` field so Seed-ASR favors
/// the user's proper nouns (`hotwords`) and current topic (`context`). Built by
/// the caller from agent memory / a user word list / the focused app's text.
///
/// Empty → the request omits `corpus` entirely, i.e. it's byte-identical to the
/// un-biased request, so an empty corpus can never regress default recognition.
#[derive(Default, Clone)]
pub struct Corpus {
    /// Short terms to boost (each becomes `{"word": …}`). Keep this focused — a
    /// huge list dilutes the bias and can hurt accuracy.
    pub hotwords: Vec<String>,
    /// Free-text context (what the user is writing in the focused field right
    /// now), sent as the *last* `dialog_ctx` entry — nearest the caret. Keep it
    /// short: the inline corpus shares a small (~200-token) budget.
    pub context: Option<String>,
    /// The user's previous dictation (when history is on), sent as the *first*
    /// `dialog_ctx` entry so consecutive dictations carry conversational
    /// continuity (the way 豆包输入法 leans on what you just typed).
    pub recent: Option<String>,
    /// A server-side hotword table (created in the Volcano console, referenced by
    /// ID). Holds the long-tail personal dictionary that won't fit the ≤16 inline
    /// `hotwords` budget; `hotwords`/`context` (热词直传) still take priority over
    /// the table. Sent as `corpus.boosting_table_id`.
    pub boosting_table_id: Option<String>,
}

impl Corpus {
    fn is_empty(&self) -> bool {
        self.hotwords.is_empty()
            && self.context.as_deref().map(str::trim).unwrap_or("").is_empty()
            && self.recent.as_deref().map(str::trim).unwrap_or("").is_empty()
            && self
                .boosting_table_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
    }
}

// message type (high nibble of byte 1)
const FULL_CLIENT: u8 = 0b0001;
const AUDIO_ONLY: u8 = 0b0010;
const ERROR: u8 = 0b1111;
// message-type-specific flags (low nibble of byte 1)
const FLAG_NONE: u8 = 0b0000;
const FLAG_LAST: u8 = 0b0010;
// serialization (high nibble of byte 2) / compression (low nibble)
const SER_JSON: u8 = 0b0001;
const SER_RAW: u8 = 0b0000;
const GZIP: u8 = 0b0001;

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(data).read_to_end(&mut out)?;
    Ok(out)
}

fn header(msg_type: u8, flags: u8, serialization: u8, compression: u8) -> [u8; 4] {
    [
        0x11, // protocol version 1, header size 1 (×4 = 4 bytes)
        (msg_type << 4) | flags,
        (serialization << 4) | compression,
        0x00,
    ]
}

fn frame(msg_type: u8, flags: u8, serialization: u8, payload: Vec<u8>) -> Vec<u8> {
    let gz = gzip(&payload);
    let mut out = Vec::with_capacity(8 + gz.len());
    out.extend_from_slice(&header(msg_type, flags, serialization, GZIP));
    out.extend_from_slice(&(gz.len() as u32).to_be_bytes());
    out.extend_from_slice(&gz);
    out
}

fn full_client_request(hands_free: bool, corpus: &Corpus, two_pass: bool) -> Vec<u8> {
    // No `language` → the model auto-handles 中英文 + dialects (code-switch).
    // Push-to-talk wants the whole `full` text; hands-free wants incremental
    // `single` results + utterance `definite` markers so each sentence can be
    // inserted the moment the VAD (`end_window_size`) decides it's complete.
    let mut req = serde_json::json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
    });
    if hands_free {
        // Hands-free inserts each sentence the moment it's done, so we want the
        // low-latency path: `end_window_size` forces a stop on silence and emits
        // a `definite` utterance fast. (It disables semantic sentence splitting,
        // but for live per-sentence insertion responsiveness wins.)
        req["result_type"] = serde_json::Value::from("single");
        req["show_utterances"] = serde_json::Value::from(true);
        req["end_window_size"] = serde_json::Value::from(800); // sentence-level VAD 判停 → `definite`
        // Server-side disfluency removal (语义顺滑): hands-free inserts raw ASR
        // text with no LLM cleanup pass, so fillers/repeats must be handled here.
        req["enable_ddc"] = serde_json::Value::from(true);
    } else {
        // Push-to-talk reads the whole `full` text once, on release — it never
        // consumes per-sentence `definite` markers, so there's nothing to gain
        // from early silence-based stops. Omitting `end_window_size` keeps the
        // model on *semantic* sentence splitting (`vad_segment_duration`), which
        // segments more accurately — the accuracy-over-latency trade PTT wants.
        req["result_type"] = serde_json::Value::from("full");
        if two_pass {
            // 二遍识别 (bigmodel_async only): each VAD-complete sentence is
            // re-recognized non-streaming, so the final text is materially more
            // accurate than pure streaming at negligible extra tail latency.
            // Note this mode segments on the VAD window rather than semantic
            // splitting — the second pass re-decodes each segment with full
            // context, which is what buys the accuracy back (and more).
            req["enable_nonstream"] = serde_json::Value::from(true);
        }
    }
    // Bias toward the user's terms/topic. Only added when non-empty so the
    // un-biased request stays exactly as before (see `Corpus::is_empty`).
    //
    // `corpus` (nested under `request`) carries up to three things: a server-side
    // `boosting_table_id` (the long-tail personal dictionary) and an inline
    // `context` — itself a JSON *string* (stringified) carrying `hotwords` and/or
    // a `context_type: "dialog_ctx"` + `context_data: [{ "text": … }]`. Inline
    // 热词直传 takes priority over the table. (Inline shape confirmed against a
    // live Seed-ASR client, VoxGitHub melody0709/VoxType.)
    if !corpus.is_empty() {
        let mut corpus_obj = serde_json::Map::new();
        if let Some(id) = corpus
            .boosting_table_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            corpus_obj.insert("boosting_table_id".into(), serde_json::Value::from(id));
        }
        let mut inner = serde_json::Map::new();
        if !corpus.hotwords.is_empty() {
            let words: Vec<_> = corpus
                .hotwords
                .iter()
                .map(|w| serde_json::json!({ "word": w }))
                .collect();
            inner.insert("hotwords".into(), serde_json::Value::from(words));
        }
        // dialog_ctx, oldest→nearest: the previous dictation, then what the user
        // is writing in the focused field right now (closest to the caret).
        let mut ctx_data: Vec<serde_json::Value> = Vec::new();
        if let Some(prev) = corpus.recent.as_deref().map(str::trim) {
            if !prev.is_empty() {
                ctx_data.push(serde_json::json!({ "text": prev }));
            }
        }
        if let Some(ctx) = corpus.context.as_deref().map(str::trim) {
            if !ctx.is_empty() {
                ctx_data.push(serde_json::json!({ "text": ctx }));
            }
        }
        if !ctx_data.is_empty() {
            inner.insert("context_type".into(), serde_json::Value::from("dialog_ctx"));
            inner.insert("context_data".into(), serde_json::Value::from(ctx_data));
        }
        if !inner.is_empty() {
            // The API wants `context` as a stringified JSON object, not nested.
            let context_str = serde_json::Value::Object(inner).to_string();
            corpus_obj.insert("context".into(), serde_json::Value::from(context_str));
        }
        req["corpus"] = serde_json::Value::Object(corpus_obj);
    }
    let cfg = serde_json::json!({
        "user": { "uid": "cetus" },
        "audio": { "format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1 },
        "request": req,
    });
    // The ground truth of what the engine was given — params AND the full
    // corpus (hotwords / dialog_ctx / table). Indispensable when judging why a
    // term was or wasn't recognized.
    tracing::debug!("doubao: request config: {cfg}");
    frame(FULL_CLIENT, FLAG_NONE, SER_JSON, cfg.to_string().into_bytes())
}

fn audio_request(pcm: &[u8], last: bool) -> Vec<u8> {
    frame(
        AUDIO_ONLY,
        if last { FLAG_LAST } else { FLAG_NONE },
        SER_RAW,
        pcm.to_vec(),
    )
}

/// One parsed server frame.
struct Parsed {
    error: Option<String>,
    /// Whole-audio recognized text so far (`result.text`), if present.
    text: Option<String>,
    /// Texts of `definite` utterances in this frame — a completed sentence each
    /// (only present with `show_utterances`, i.e. hands-free).
    sentences: Vec<String>,
    /// True on the final (last-packet) response.
    last: bool,
}

fn parse(data: &[u8]) -> Result<Parsed> {
    if data.len() < 4 {
        bail!("doubao: short frame ({} bytes)", data.len());
    }
    let msg_type = data[1] >> 4;
    let flags = data[1] & 0x0F;
    let compression = data[2] & 0x0F;
    let mut off = 4usize;
    // A response with a sequence number carries 4 extra bytes after the header.
    if flags == 0b0001 || flags == 0b0011 {
        off += 4;
    }
    let take_u32 = |d: &[u8], o: usize| -> Result<u32> {
        d.get(o..o + 4)
            .ok_or_else(|| anyhow!("doubao: truncated frame"))
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    if msg_type == ERROR {
        let code = take_u32(data, off)?;
        off += 4;
        let size = take_u32(data, off)? as usize;
        off += 4;
        let end = (off + size).min(data.len());
        let msg = String::from_utf8_lossy(&data[off..end]).to_string();
        return Ok(Parsed {
            error: Some(format!("{code}: {msg}")),
            text: None,
            sentences: Vec::new(),
            last: true,
        });
    }
    let size = take_u32(data, off)? as usize;
    off += 4;
    let end = (off + size).min(data.len());
    let mut payload = data[off..end].to_vec();
    if compression == GZIP {
        payload = gunzip(&payload)?;
    }
    let v: serde_json::Value = serde_json::from_slice(&payload).unwrap_or(serde_json::Value::Null);
    let text = v
        .pointer("/result/text")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let mut sentences = Vec::new();
    if let Some(utts) = v.pointer("/result/utterances").and_then(|x| x.as_array()) {
        for u in utts {
            if u.get("definite").and_then(|d| d.as_bool()).unwrap_or(false) {
                if let Some(t) = u.get("text").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        sentences.push(t.to_string());
                    }
                }
            }
        }
    }
    let last = flags == FLAG_LAST || flags == 0b0011;
    Ok(Parsed {
        error: None,
        text,
        sentences,
        last,
    })
}

/// Push-to-talk: stream live PCM (16 kHz mono s16le) to Doubao and return the
/// final transcript, calling `on_partial` with each interim result. `pcm_rx`
/// yields audio chunks (≈100–200 ms each); closing it signals end-of-audio.
///
/// Reliability + accuracy strategy:
/// 1. First attempt runs on [`URL_ASYNC`] with `enable_nonstream` (二遍识别) —
///    the more accurate two-pass mode.
/// 2. Every chunk is teed into a replay buffer. If the first attempt fails for
///    ANY reason (no entitlement for the async endpoint, transient network
///    drop, server error), the full audio is replayed against the plain
///    [`URL`] endpoint once the mic closes — so one hiccup can no longer
///    discard an entire utterance.
/// 3. If both attempts fail but produced partial text, the longest partial is
///    returned (with a warning) instead of an error: degraded text beats
///    total loss.
/// Whether the two-pass endpoint is believed usable. Flipped off for the rest
/// of the process when an attempt dies before producing ANY text — the
/// signature of a missing `bigmodel_async` entitlement / rejected parameter —
/// so an unentitled account pays the replay penalty once, not on every
/// dictation (which would silently turn all recognition into post-release
/// batch work with no live partials).
static TWO_PASS_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub async fn stream(
    key: &str,
    resource_id: &str,
    corpus: Corpus,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
    on_partial: impl Fn(&str) + Send + Sync + 'static,
) -> Result<String> {
    use std::sync::atomic::Ordering;

    let two_pass = TWO_PASS_OK.load(Ordering::Relaxed);
    // Pump: tee live audio into the replay buffer while forwarding to the
    // active attempt. If the attempt dies, forwarding fails silently and the
    // buffer keeps filling until the mic closes.
    let buffer: std::sync::Arc<tokio::sync::Mutex<Vec<Vec<u8>>>> = Default::default();
    let (tx1, rx1) = mpsc::channel::<Vec<u8>>(64);
    let pump_buffer = buffer.clone();
    let pump = tokio::spawn(async move {
        while let Some(chunk) = pcm_rx.recv().await {
            pump_buffer.lock().await.push(chunk.clone());
            let _ = tx1.send(chunk).await;
        }
    });

    let (text, err) = run(
        if two_pass { URL_ASYNC } else { URL },
        key,
        resource_id,
        &corpus,
        rx1,
        false,
        two_pass,
        &on_partial,
        &|_| {},
    )
    .await;
    let Some(e) = err else {
        pump.abort();
        return Ok(text);
    };
    if two_pass && text.trim().is_empty() {
        // Died before any text — almost certainly the endpoint/param being
        // rejected, not a mid-stream hiccup. Don't try two-pass again.
        TWO_PASS_OK.store(false, Ordering::Relaxed);
        tracing::warn!("doubao two-pass endpoint rejected; staying on plain streaming this run");
    }

    tracing::warn!("doubao stream failed ({e}); replaying audio on the plain endpoint");
    // Wait for the mic to close so the replay carries the complete utterance.
    let _ = pump.await;
    let chunks = buffer.lock().await.clone();
    if chunks.is_empty() {
        if text.trim().is_empty() {
            return Err(e);
        }
        return Ok(text);
    }
    let (tx2, rx2) = mpsc::channel::<Vec<u8>>(chunks.len().max(1));
    tokio::spawn(async move {
        for c in chunks {
            if tx2.send(c).await.is_err() {
                break;
            }
            // Gentle pacing: the realtime endpoint documents 100-200ms chunk
            // cadence; a zero-interval burst is undocumented territory. ~15ms
            // per 100ms chunk ≈ 6× realtime — fast replay, polite to the server.
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
    });
    let (text2, err2) = run(
        URL,
        key,
        resource_id,
        &corpus,
        rx2,
        false,
        false,
        &on_partial,
        &|_| {},
    )
    .await;
    match err2 {
        None => Ok(text2),
        Some(e2) => {
            // Both attempts failed; salvage the longer partial if there is one.
            let best = if text2.chars().count() >= text.chars().count() {
                text2
            } else {
                text
            };
            if best.trim().is_empty() {
                Err(e2)
            } else {
                tracing::warn!(
                    "doubao retry also failed ({e2}); inserting last partial ({} chars)",
                    best.chars().count()
                );
                Ok(best)
            }
        }
    }
}

/// Hands-free: stream continuously and call `on_sentence` with each completed
/// (VAD-`definite`) sentence as it lands, so the caller can insert it live. Runs
/// until `pcm_rx` closes (the session is toggled off). No replay here — the
/// sentences already inserted can't be un-typed, so a re-run would duplicate.
pub async fn stream_hands_free(
    key: &str,
    resource_id: &str,
    corpus: Corpus,
    pcm_rx: mpsc::Receiver<Vec<u8>>,
    on_sentence: impl Fn(&str) + Send + Sync + 'static,
) -> Result<()> {
    let (_, err) = run(
        URL,
        key,
        resource_id,
        &corpus,
        pcm_rx,
        true,
        false,
        &|_| {},
        &on_sentence,
    )
    .await;
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Shared session driver. `hands_free` switches the config to incremental
/// per-sentence (`single` + `show_utterances`); `on_sentence` fires for each
/// `definite` utterance, `on_partial` for the running text. Returns the
/// accumulated text alongside the terminal error (if any), so callers can
/// salvage partials from a failed session.
#[allow(clippy::too_many_arguments)]
async fn run(
    url: &str,
    key: &str,
    resource_id: &str,
    corpus: &Corpus,
    pcm_rx: mpsc::Receiver<Vec<u8>>,
    hands_free: bool,
    two_pass: bool,
    on_partial: &(impl Fn(&str) + Send + Sync),
    on_sentence: &(impl Fn(&str) + Send + Sync),
) -> (String, Option<anyhow::Error>) {
    let started = std::time::Instant::now();
    let acc = std::sync::Mutex::new(String::new());
    let err = run_session(
        url,
        key,
        resource_id,
        corpus,
        pcm_rx,
        hands_free,
        two_pass,
        &acc,
        on_partial,
        on_sentence,
    )
    .await
    .err();
    let text = acc.into_inner().unwrap_or_default();
    tracing::debug!(
        "doubao: session ended in {}ms (two_pass={two_pass}, {} chars, err={})",
        started.elapsed().as_millis(),
        text.chars().count(),
        err.as_ref().map(|e| e.to_string()).unwrap_or_else(|| "none".into())
    );
    (text, err)
}

/// One WebSocket session. The running whole-audio text is mirrored into `acc`
/// so [`run`] can hand it back even when the session ends in an error.
#[allow(clippy::too_many_arguments)]
async fn run_session(
    url: &str,
    key: &str,
    resource_id: &str,
    corpus: &Corpus,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
    hands_free: bool,
    two_pass: bool,
    acc: &std::sync::Mutex<String>,
    on_partial: &(impl Fn(&str) + Send + Sync),
    on_sentence: &(impl Fn(&str) + Send + Sync),
) -> Result<()> {
    let mut req = url.into_client_request()?;
    {
        let h = req.headers_mut();
        h.insert("X-Api-Key", key.parse()?);
        h.insert("X-Api-Resource-Id", resource_id.parse()?);
        h.insert("X-Api-Request-Id", Uuid::new_v4().to_string().parse()?);
        h.insert("X-Api-Sequence", "-1".parse()?);
        h.insert("X-Api-Connect-Id", Uuid::new_v4().to_string().parse()?);
    }
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await?;
    tracing::debug!(
        "doubao: websocket connected (url={url}, resource_id={resource_id}, hands_free={hands_free}, two_pass={two_pass})"
    );
    let (mut write, mut read) = ws.split();

    // Send the config, then stream audio. Each chunk is sent non-last except the
    // final one (flagged last) — we buffer one chunk so the real last packet
    // carries the flag rather than an empty trailer.
    write
        .send(Message::Binary(full_client_request(
            hands_free, corpus, two_pass,
        )))
        .await?;
    let send = tokio::spawn(async move {
        let mut prev: Option<Vec<u8>> = None;
        let mut total_bytes = 0usize;
        while let Some(chunk) = pcm_rx.recv().await {
            total_bytes += chunk.len();
            if let Some(p) = prev.replace(chunk) {
                write.send(Message::Binary(audio_request(&p, false))).await?;
            }
        }
        let last = prev.unwrap_or_default();
        write.send(Message::Binary(audio_request(&last, true))).await?;
        // 16 kHz mono s16le → 32000 bytes/s; handy for spotting a dead mic.
        tracing::debug!(
            "doubao: end-of-audio sent ({total_bytes} bytes ≈ {:.1}s)",
            total_bytes as f64 / 32000.0
        );
        Ok::<(), anyhow::Error>(())
    });

    let mut saw_last = false;
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Binary(data) => {
                let p = parse(&data)?;
                if let Some(err) = p.error {
                    bail!("doubao asr error: {err}");
                }
                for s in &p.sentences {
                    on_sentence(s);
                }
                if let Some(t) = p.text {
                    if !t.is_empty() {
                        on_partial(&t);
                        if let Ok(mut a) = acc.lock() {
                            *a = t;
                        }
                    }
                }
                if p.last {
                    saw_last = true;
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = send.await;
    if !saw_last {
        // A clean Close (or EOF) without the final-packet flag means the server
        // never finished the utterance — the accumulated text is a truncated
        // partial. Report it as a failure so the caller's salvage/replay path
        // engages instead of silently shipping a cut-off transcript.
        bail!("doubao session ended without a final frame");
    }
    Ok(())
}
