//! Superset-style Resources panel: a live snapshot of what Cetus's own process
//! tree costs (CPU / memory), grouped by what each subtree *is* — the app, the
//! pi engine, per-conversation CLI-agent turns (claude / codex), and the speech
//! helpers.
//!
//! Scope is deliberately the process tree rooted at this app: children we
//! spawned (pi sidecar, CLI turns, helpers) and their descendants. WebKit's
//! webview XPC services are parented by launchd, not us, so they can't be
//! attributed here without private APIs — the panel is about *agent* cost, and
//! agents are all real children.
//!
//! CPU percentages are Activity-Monitor-style (100% = one core). The sysinfo
//! `System` is kept alive between calls because CPU usage is a delta between
//! refreshes — the first snapshot after launch reads 0% and corrects itself on
//! the next poll.

use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRow {
    pub pid: u32,
    /// Display label ("Cetus", "pi engine", "Claude Code", process name…).
    pub label: String,
    /// "app" | "engine" | "agent" | "helper" | "other" — drives grouping/order.
    pub kind: String,
    /// For CLI-agent rows: the conversation the turn belongs to, recovered from
    /// the child's cwd (per-conversation worktrees embed the conversation id).
    pub conversation_id: Option<String>,
    pub conversation_title: Option<String>,
    /// Percent of one core, subtree-aggregated (children folded into the row).
    pub cpu: f32,
    /// Resident memory in bytes, subtree-aggregated.
    pub memory_bytes: u64,
    /// Number of processes folded into this row (1 = just the process itself).
    pub process_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesSnapshot {
    pub rows: Vec<ResourceRow>,
    pub total_cpu: f32,
    pub total_memory_bytes: u64,
    pub cpu_cores: usize,
}

/// Persistent sysinfo state: CPU usage is a delta between two refreshes, so the
/// `System` must outlive individual snapshot calls.
fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

/// Classify a process (by executable name) into a panel row kind + label.
fn classify(name: &str) -> (&'static str, String) {
    let lower = name.to_ascii_lowercase();
    if lower == "pi" || lower.starts_with("pi-") {
        ("engine", "pi engine".to_string())
    } else if lower == "claude" {
        ("agent", "Claude Code".to_string())
    } else if lower == "codex" {
        ("agent", "Codex".to_string())
    } else if lower.contains("speech-helper") || lower.contains("spawn-disclaim") {
        ("helper", "Speech helper".to_string())
    } else {
        ("other", name.to_string())
    }
}

/// Pull the conversation id out of a CLI turn's cwd. Turns run either inside a
/// per-conversation worktree (`<repo>/.cetus/worktrees/<slug>`, slug =
/// sanitized conversation id) or directly in the workspace (no id to recover).
fn conversation_slug_from_cwd(cwd: &std::path::Path) -> Option<String> {
    let s = cwd.to_string_lossy();
    let marker = "/.cetus/worktrees/";
    let start = s.find(marker)? + marker.len();
    let rest = &s[start..];
    let slug = rest.split('/').next()?.trim();
    (!slug.is_empty()).then(|| slug.to_string())
}

#[tauri::command]
pub async fn resources_snapshot(state: State<'_, AppState>) -> Result<ResourcesSnapshot, String> {
    let self_pid = Pid::from_u32(std::process::id());

    // Snapshot the process table. spawn_blocking: the refresh does a full
    // process-table walk, no reason to hold a Tokio worker on it.
    let procs: Vec<(Pid, Option<Pid>, String, f32, u64, Option<std::path::PathBuf>)> =
        tokio::task::spawn_blocking(move || {
            let mut sys = system().lock().unwrap();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_cwd(UpdateKind::Always),
            );
            sys.processes()
                .iter()
                .map(|(pid, p)| {
                    (
                        *pid,
                        p.parent(),
                        p.name().to_string_lossy().to_string(),
                        p.cpu_usage(),
                        p.memory(),
                        p.cwd().map(|c| c.to_path_buf()),
                    )
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())?;

    // children[ppid] -> pids, plus a by-pid index.
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    let mut by_pid: HashMap<Pid, (String, f32, u64, Option<std::path::PathBuf>)> = HashMap::new();
    for (pid, parent, name, cpu, mem, cwd) in procs {
        if let Some(pp) = parent {
            children.entry(pp).or_default().push(pid);
        }
        by_pid.insert(pid, (name, cpu, mem, cwd));
    }

    // Aggregate one subtree (cpu, memory, process count) iteratively.
    let aggregate = |root: Pid| -> (f32, u64, u32) {
        let (mut cpu, mut mem, mut count) = (0f32, 0u64, 0u32);
        let mut stack = vec![root];
        while let Some(pid) = stack.pop() {
            if let Some((_, c, m, _)) = by_pid.get(&pid) {
                cpu += c;
                mem += m;
                count += 1;
            }
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        (cpu, mem, count)
    };

    let mut rows: Vec<ResourceRow> = Vec::new();

    // The app itself (own process only — every interesting child gets its own
    // row below, so folding them here would double-count).
    if let Some((_, cpu, mem, _)) = by_pid.get(&self_pid) {
        rows.push(ResourceRow {
            pid: self_pid.as_u32(),
            label: "Cetus".to_string(),
            kind: "app".to_string(),
            conversation_id: None,
            conversation_title: None,
            cpu: *cpu,
            memory_bytes: *mem,
            process_count: 1,
        });
    }

    // One row per direct child, subtree-aggregated (a claude turn's shell
    // commands and MCP servers fold into its row).
    for child in children.get(&self_pid).cloned().unwrap_or_default() {
        let Some((name, _, _, cwd)) = by_pid.get(&child) else {
            continue;
        };
        let (kind, label) = classify(name);
        let (cpu, memory_bytes, process_count) = aggregate(child);

        let (conversation_id, conversation_title) = if kind == "agent" {
            let slug = cwd.as_deref().and_then(conversation_slug_from_cwd);
            match slug {
                // Worktree slugs are sanitized conversation ids; conversation
                // ids are lowercase alphanumeric+dash, so the slug round-trips.
                Some(slug) => match state.store.get(&slug) {
                    Ok(Some(conv)) => {
                        let title = (!conv.title.is_empty()).then_some(conv.title);
                        (Some(slug), title)
                    }
                    _ => (Some(slug), None),
                },
                None => (None, None),
            }
        } else {
            (None, None)
        };

        rows.push(ResourceRow {
            pid: child.as_u32(),
            label,
            kind: kind.to_string(),
            conversation_id,
            conversation_title,
            cpu,
            memory_bytes,
            process_count,
        });
    }

    // App first, then engine / agents / helpers / other; hottest first inside
    // each group.
    let order = |k: &str| match k {
        "app" => 0,
        "engine" => 1,
        "agent" => 2,
        "helper" => 3,
        _ => 4,
    };
    rows.sort_by(|a, b| {
        order(&a.kind)
            .cmp(&order(&b.kind))
            .then(b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal))
    });

    let total_cpu = rows.iter().map(|r| r.cpu).sum();
    let total_memory_bytes = rows.iter().map(|r| r.memory_bytes).sum();
    Ok(ResourcesSnapshot {
        rows,
        total_cpu,
        total_memory_bytes,
        cpu_cores: num_cpus(),
    })
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_extraction() {
        assert_eq!(
            conversation_slug_from_cwd(std::path::Path::new(
                "/Users/x/dev/repo/.cetus/worktrees/abc-123/sub"
            )),
            Some("abc-123".to_string())
        );
        assert_eq!(
            conversation_slug_from_cwd(std::path::Path::new("/Users/x/dev/repo")),
            None
        );
    }

    #[test]
    fn classify_names() {
        assert_eq!(classify("claude").0, "agent");
        assert_eq!(classify("codex").0, "agent");
        assert_eq!(classify("pi").0, "engine");
        assert_eq!(classify("pi-aarch64-apple-darwin").0, "engine");
        assert_eq!(classify("cetus-speech-helper-v6").0, "helper");
        assert_eq!(classify("cetus-spawn-disclaim").0, "helper");
        assert_eq!(classify("node").0, "other");
    }
}
