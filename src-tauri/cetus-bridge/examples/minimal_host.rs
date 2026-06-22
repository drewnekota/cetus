use cetus_bridge::bridge::{RuntimeConfig, RuntimeEvent};
use cetus_bridge::pi_rpc::{EventSink, PiRpc, TaskSpawner};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone)]
struct PrintSink;

impl EventSink for PrintSink {
    fn emit(&self, event: RuntimeEvent) {
        println!("runtime event: {event:?}");
    }
}

#[derive(Clone)]
struct TokioSpawner;

impl TaskSpawner for TokioSpawner {
    fn spawn(&self, fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tokio::spawn(fut);
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let Some(bin) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: cargo run --example minimal_host -- <path-to-pi-binary>");
        eprintln!("the example compiles without pi; pass a binary path to spawn a runtime");
        return Ok(());
    };

    let cwd = match bin.parent() {
        Some(parent) => parent.to_path_buf(),
        None => std::env::current_dir()?,
    };
    let sessions_dir = std::env::temp_dir().join("cetus-bridge-minimal-host-sessions");
    std::fs::create_dir_all(&sessions_dir)?;

    let config = RuntimeConfig {
        append_system_prompt: "You are running inside the minimal cetus-bridge host.".to_string(),
        ..RuntimeConfig::default()
    };

    let pi = PiRpc::spawn(
        Arc::new(PrintSink),
        Arc::new(TokioSpawner),
        &bin,
        &sessions_dir,
        &cwd,
        Vec::new(),
        Some("minimal-host".to_string()),
        config,
    )?;

    let session_file = pi.new_session().await?;
    println!("created session: {session_file}");
    Ok(())
}
