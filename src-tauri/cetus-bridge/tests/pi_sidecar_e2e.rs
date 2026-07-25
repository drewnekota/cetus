//! End-to-end check of the BUNDLED pi sidecar through cetus's own RPC client.
//!
//! `remote_ssh.rs` drives a fake `pi` script, so it proves the plumbing but not
//! that the runtime we ship still speaks the protocol we assume. This test
//! spawns the real `src-tauri/pi-install/pi` via the production [`PiRpc::spawn`]
//! path, with the real `cetus-extensions/` overlay, and asserts the contract a
//! pi upgrade is most likely to break:
//!
//!   * the RPC handshake, `new_session`, and the `sessionFile` pointer cetus
//!     reads out of `get_state`,
//!   * `set_model` for the model the app applies on every cold conversation,
//!   * every cetus extension loading without an `extension_error`,
//!   * the run closing with `agent_end` **and** `agent_settled` (the settle
//!     signal the chat reducer keys off).
//!
//! Skipped (not failed) when the sidecar tree is absent — a fresh clone has no
//! `pi-install/` until `scripts/build-pi-sidecar.sh` runs. The model-turn half
//! additionally needs `DEEPSEEK_API_KEY`; without it the test still covers the
//! handshake/session/extension-load half.
//!
//! With a key set this spends one real (cheap, few-hundred-token) DeepSeek turn
//! per run — that is the point: a mocked pi cannot catch a protocol drift.
//!
//! Run it explicitly with:
//!   cargo test -p cetus-bridge --test pi_sidecar_e2e -- --nocapture

use cetus_bridge::bridge::{RuntimeConfig, RuntimeEvent};
use cetus_bridge::pi_rpc::{EventSink, PiRpc, TaskSpawner};
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct CollectingSink(Arc<Mutex<Vec<Value>>>);

impl EventSink for CollectingSink {
    fn emit(&self, event: RuntimeEvent) {
        if let RuntimeEvent::Protocol { event, .. } = event {
            self.0.lock().unwrap().push(event);
        }
    }
}

impl CollectingSink {
    fn types(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e.get("type").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    /// Wait until `pred` matches the collected event types, or time out.
    async fn wait_for(&self, label: &str, timeout: Duration, pred: impl Fn(&[String]) -> bool) {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if pred(&self.types()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("timed out waiting for {label}; saw: {:?}", self.types());
    }
}

#[derive(Clone)]
struct TokioSpawner;

impl TaskSpawner for TokioSpawner {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tokio::spawn(fut);
    }
}

fn sidecar_dir() -> PathBuf {
    // <repo>/src-tauri/cetus-bridge/ → <repo>/src-tauri/pi-install/
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("cetus-bridge has a parent dir")
        .join("pi-install")
}

#[tokio::test]
async fn bundled_pi_sidecar_speaks_the_protocol_cetus_assumes() {
    let pi_dir = sidecar_dir();
    let bin = pi_dir.join(if cfg!(windows) { "pi.exe" } else { "pi" });
    if !bin.exists() {
        eprintln!(
            "skipping: no sidecar at {} — run scripts/build-pi-sidecar.sh",
            bin.display()
        );
        return;
    }

    let root = std::env::temp_dir().join(format!("cetus-pi-e2e-{}", std::process::id()));
    let sessions = root.join("sessions");
    let cwd = root.join("cwd");
    let agent_dir = root.join("agent");
    // One lazy-only skill, exactly as skills.rs materializes an over-budget one:
    // hidden from the prompt, discoverable through skill_search.
    let skill_dir = agent_dir.join("skills").join("e2e-marker");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: e2e-marker\ndescription: Retrieve the cetus end-to-end marker word. \
         Use when asked for the e2e marker.\ndisable-model-invocation: true\n---\n\n\
         The marker word is: PLATYPUS\n",
    )
    .unwrap();

    let sink = CollectingSink::default();
    let pi = PiRpc::spawn(
        Arc::new(sink.clone()),
        Arc::new(TokioSpawner),
        &bin,
        &sessions,
        &cwd,
        vec![(
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().to_string(),
        )],
        Some("e2e".to_string()),
        RuntimeConfig {
            append_system_prompt: "You are cetus. Follow instructions exactly and keep replies short."
                .to_string(),
            ..Default::default()
        },
    )
    .expect("spawn bundled pi");

    // --- handshake + session -------------------------------------------------
    let session_file = pi.new_session().await.expect("new_session");
    assert!(
        Path::new(&session_file).parent().map(Path::exists).unwrap_or(false),
        "session file lives in the session dir we passed: {session_file}"
    );

    // `PiRpc::get_state` hands back the response's `data` object.
    let state = pi.get_state().await.expect("get_state");
    assert_eq!(
        state.get("sessionFile").and_then(Value::as_str),
        Some(session_file.as_str()),
        "get_state still reports the live session file: {state}"
    );
    assert!(
        state.get("model").and_then(|m| m.get("id")).is_some(),
        "get_state still carries the selected model: {state}"
    );

    // --- everything below needs a key ---------------------------------------
    // `set_model` included: pi ≥0.82 drops unauthenticated providers from its
    // registry, so without a key it answers "Model not found" for a model that
    // is very much bundled (see `set_model_without_a_credential_...` below).
    if std::env::var("DEEPSEEK_API_KEY").ok().filter(|k| !k.is_empty()).is_none() {
        eprintln!("skipping the model half: DEEPSEEK_API_KEY is not set");
        let _ = std::fs::remove_dir_all(&root);
        return;
    }

    pi.set_model("deepseek", "deepseek-v4-pro")
        .await
        .expect("set_model deepseek-v4-pro — the model cetus applies on every cold conversation");

    pi.send_prompt(
        "Call the skill_search tool with query \"e2e marker\". It returns a SKILL.md path. \
         Read that exact path with the read tool. Then reply with ONLY the marker word.",
        Vec::new(),
    )
    .await
    .expect("send_prompt accepted");

    // `send_prompt` returns on ACCEPTANCE, so the turn's end is an event, not
    // the response — this is precisely the contract the reducer relies on.
    sink.wait_for("agent_settled", Duration::from_secs(180), |types| {
        types.iter().any(|t| t == "agent_settled")
    })
    .await;

    let events = sink.0.lock().unwrap().clone();
    let types = sink.types();
    let ty = |e: &Value| e.get("type").and_then(Value::as_str).unwrap_or("").to_string();

    let ext_errors: Vec<String> = events
        .iter()
        .filter(|e| ty(e) == "extension_error")
        .map(|e| e.to_string())
        .collect();
    assert!(ext_errors.is_empty(), "extensions failed to load: {ext_errors:?}");

    let tools: Vec<String> = events
        .iter()
        .filter(|e| ty(e) == "tool_execution_end")
        .filter_map(|e| e.get("toolName").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert!(tools.contains(&"skill_search".to_string()), "skill_search ran; saw {tools:?}");
    // The lazy skill is loaded with pi's BUILT-IN read tool — cetus's old
    // `skill_read` reimplementation is gone, so a regression here means the
    // migration silently stopped working.
    assert!(tools.contains(&"read".to_string()), "native read loaded the SKILL.md; saw {tools:?}");
    assert!(!tools.contains(&"skill_read".to_string()), "skill_read must not come back");

    let answer: String = events
        .iter()
        .filter(|e| ty(e) == "message_end")
        .filter(|e| e.pointer("/message/role").and_then(Value::as_str) == Some("assistant"))
        .filter_map(|e| e.pointer("/message/content").and_then(Value::as_array).cloned())
        .flatten()
        .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        answer.to_uppercase().contains("PLATYPUS"),
        "model read the marker out of the skill; got: {answer}"
    );

    let end = types.iter().rposition(|t| t == "agent_end");
    let settled = types.iter().rposition(|t| t == "agent_settled");
    assert!(end.is_some(), "agent_end emitted; saw {types:?}");
    assert!(settled > end, "agent_settled follows agent_end; saw {types:?}");

    let _ = std::fs::remove_dir_all(&root);
}

/// Pin the failure mode that produced two misdiagnosed releases.
///
/// pi ≥0.82 filters `getAvailable()` by *configured credentials*, so a sidecar
/// that ships `deepseek-v4-pro` still answers `Model not found:
/// deepseek/deepseek-v4-pro` when the child has no usable `DEEPSEEK_API_KEY`.
/// The message names the model, so it reads as "the bundled runtime is stale"
/// — which is what the build-time model-registry gate and the runtime-refresh
/// marker were built to fix, neither of which touches the real cause.
///
/// `model_bridge::apply_choice` keys its rewritten, actionable error off this
/// exact wording; this test is what tells us when pi changes it. Needs no API
/// key and makes no network request.
#[tokio::test]
async fn set_model_without_a_credential_reports_the_model_as_missing() {
    let pi_dir = sidecar_dir();
    let bin = pi_dir.join(if cfg!(windows) { "pi.exe" } else { "pi" });
    if !bin.exists() {
        eprintln!(
            "skipping: no sidecar at {} — run scripts/build-pi-sidecar.sh",
            bin.display()
        );
        return;
    }

    let root = std::env::temp_dir().join(format!("cetus-pi-nokey-{}", std::process::id()));
    let sessions = root.join("sessions");
    let cwd = root.join("cwd");
    let agent_dir = root.join("agent");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();

    let pi = PiRpc::spawn(
        Arc::new(CollectingSink::default()),
        Arc::new(TokioSpawner),
        &bin,
        &sessions,
        &cwd,
        vec![
            (
                "PI_CODING_AGENT_DIR".to_string(),
                agent_dir.to_string_lossy().to_string(),
            ),
            // Empty, not absent: the child inherits this process's env, and a
            // developer running the suite usually has a real key exported.
            // pi treats an empty value as "no credential" (falsy), which is
            // exactly the state a user with no key configured is in.
            ("DEEPSEEK_API_KEY".to_string(), String::new()),
        ],
        Some("e2e-nokey".to_string()),
        RuntimeConfig::default(),
    )
    .expect("spawn bundled pi");

    pi.new_session().await.expect("new_session");
    let error = pi
        .set_model("deepseek", "deepseek-v4-pro")
        .await
        .expect_err("an unauthenticated provider has no models to select")
        .to_string();

    assert!(
        error.contains("Model not found") && error.contains("deepseek-v4-pro"),
        "the wording model_bridge translates must not drift; got: {error}"
    );

    let _ = std::fs::remove_dir_all(&root);
}
