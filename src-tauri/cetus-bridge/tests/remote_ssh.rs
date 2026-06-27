use cetus_bridge::bridge::RuntimeEvent;
use cetus_bridge::pi_rpc::{EventSink, PiRpc, TaskSpawner};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone)]
struct NoopSink;

impl EventSink for NoopSink {
    fn emit(&self, _event: RuntimeEvent) {}
}

#[derive(Clone)]
struct TokioSpawner;

impl TaskSpawner for TokioSpawner {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tokio::spawn(fut);
    }
}

#[tokio::test]
async fn remote_ssh_pi_rpc_runs_and_syncs_session() {
    let root = unique_temp_dir("cetus-remote-ssh-test");
    let fake_bin = root.join("bin");
    let local_pi = root.join("pi-install");
    let remote_root = root.join("remote-root");
    let sessions = root.join("sessions");
    let workspace = root.join("remote-workspace");
    std::fs::create_dir_all(&fake_bin).unwrap();
    std::fs::create_dir_all(local_pi.join("cetus-extensions")).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();

    write_executable(&fake_bin.join("ssh"), &fake_ssh_script());
    write_executable(&local_pi.join("pi"), &fake_pi_script());
    std::fs::write(
        local_pi.join("cetus-extensions").join("memory.ts"),
        "export {};",
    )
    .unwrap();

    let old_path = std::env::var("PATH").unwrap_or_default();
    let old_root = std::env::var("CETUS_REMOTE_ROOT").ok();
    std::env::set_var(
        "PATH",
        format!("{}:{old_path}", fake_bin.to_string_lossy()),
    );
    std::env::set_var("CETUS_REMOTE_ROOT", remote_root.to_string_lossy().to_string());

    let remote_workspace = format!("devbox:{}", workspace.to_string_lossy());
    let pi = PiRpc::spawn(
        Arc::new(NoopSink),
        Arc::new(TokioSpawner),
        &local_pi.join("pi"),
        &sessions,
        Path::new(&remote_workspace),
        Vec::new(),
        Some("conv-remote".to_string()),
        Default::default(),
    )
    .unwrap();

    let local_session = pi.new_session().await.unwrap();
    assert!(local_session.starts_with(&sessions.to_string_lossy().to_string()));

    pi.send_prompt("hello over ssh", Vec::new()).await.unwrap();
    let synced = std::fs::read_to_string(&local_session).unwrap();
    assert!(synced.contains("hello over ssh"));
    assert!(synced.contains("remote ack"));

    let messages = pi.get_messages().await.unwrap();
    assert_eq!(messages.len(), 2);

    drop(pi);
    std::env::set_var("PATH", old_path);
    match old_root {
        Some(v) => std::env::set_var("CETUS_REMOTE_ROOT", v),
        None => std::env::remove_var("CETUS_REMOTE_ROOT"),
    }
    let _ = std::fs::remove_dir_all(root);
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_executable(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }
}

fn fake_ssh_script() -> String {
    r#"#!/bin/sh
set -eu
if [ "${1:-}" = "-p" ]; then
  shift 2
fi
target="${1:-}"
shift || true
if [ -z "$target" ]; then
  exit 2
fi
exec /bin/sh -c "$*"
"#
    .to_string()
}

fn fake_pi_script() -> String {
    r#"#!/bin/sh
set -eu
session_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-dir)
      session_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$session_dir"
session_file=""
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  type=$(printf '%s' "$line" | sed -n 's/.*"type":"\([^"]*\)".*/\1/p')
  case "$type" in
    new_session)
      session_file="$session_dir/session-remote.jsonl"
      : > "$session_file"
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
    get_state)
      printf '{"type":"response","id":"%s","success":true,"data":{"sessionFile":"%s"}}\n' "$id" "$session_file"
      ;;
    switch_session)
      session_file=$(printf '%s' "$line" | sed -n 's/.*"sessionPath":"\([^"]*\)".*/\1/p')
      touch "$session_file"
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
    prompt)
      msg=$(printf '%s' "$line" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
      printf '{"role":"user","content":"%s"}\n' "$msg" >> "$session_file"
      printf '{"role":"assistant","content":"remote ack"}\n' >> "$session_file"
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
    get_messages)
      printf '{"type":"response","id":"%s","success":true,"data":{"messages":[{"role":"user","content":"hello over ssh"},{"role":"assistant","content":"remote ack"}]}}\n' "$id"
      ;;
    get_fork_messages)
      printf '{"type":"response","id":"%s","success":true,"data":{"messages":[]}}\n' "$id"
      ;;
    abort)
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
    *)
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
  esac
done
"#
    .to_string()
}
