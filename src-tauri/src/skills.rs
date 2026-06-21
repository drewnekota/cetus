//! User-installed **Skills** (the Agent Skills standard, agentskills.io).
//!
//! A skill is a folder holding a `SKILL.md` — YAML frontmatter (`name`,
//! `description`) plus a markdown body — and optional supporting files. The
//! model reads a skill's name/description on every turn and "invokes" the skill
//! (pulls its body into context) when the task matches.
//!
//! cetus manages skills in two layers:
//!   * **Library** — `<app_data>/skills/<id>/` is the source of truth. Every
//!     installed skill lives here whether enabled or not.
//!   * **Active set** — `<app_data>/pi-agent/skills/<id>/` is what pi actually
//!     loads. pi's agent dir is pointed at `<app_data>/pi-agent` by the
//!     `PI_CODING_AGENT_DIR` env var (exported in `lib.rs`), and pi auto-discovers
//!     + enables every `SKILL.md` under `<agentDir>/skills` on session start.
//!
//! [`resync_active_dir`] rebuilds the GLOBAL active set from the library + enabled
//! flags after any change — the template legacy conversations fall back to. New
//! conversations instead get their own frozen copy at first spawn via
//! [`materialize_skills_into`] (`AppState::pi_for`), so a skill toggle only reaches
//! conversations created afterward (hard freeze) and never disturbs an open chat.
//!
//! Metadata (name/description/enabled) is persisted as one JSON blob in the
//! `app_settings` table, mirroring [`crate::ultra`]; the markdown lives on disk.

use crate::store::{now_ms, Store};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

const SETTINGS_KEY: &str = "skills";
const CURRENT_VERSION: u32 = 1;
/// Cap installed skills so the discovery scan + injected prompt stay bounded.
const MAX_SKILLS: usize = 100;
/// Import guards — a skill is meant to be a few small text files, not a repo.
const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 400;
/// Cap a hand-written SKILL.md body so one skill can't dominate the prompt.
const MAX_BODY_CHARS: usize = 50_000;
/// Approximate default model context used only for budgeting the *skill index*
/// injected into the prompt. Bodies remain on disk and are read lazily.
const DEFAULT_CONTEXT_TOKENS: usize = 1_000_000;
/// Keep the visible skill manifest to a small fraction of the context. Override
/// with CETUS_SKILL_PROMPT_BUDGET_PCT (e.g. 0.03) or
/// CETUS_SKILL_PROMPT_BUDGET_CHARS for a hard character cap.
const DEFAULT_SKILL_PROMPT_PCT: f64 = 0.05;

fn default_true() -> bool {
    true
}
fn default_version() -> u32 {
    CURRENT_VERSION
}

/// One installed skill. The markdown lives at `<library>/<id>/SKILL.md`; this is
/// just the metadata the settings UI renders. `source` records how it arrived
/// ("import" = copied from a folder, "created" = written from the editor).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The whole skills store: a master switch plus the installed entries. When the
/// master switch is off the active set is emptied, so no skill is injected even
/// though the library is untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub entries: Vec<SkillEntry>,
}

impl Default for SkillState {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            enabled: true,
            entries: Vec::new(),
        }
    }
}

// ---- Paths -----------------------------------------------------------------

/// pi's agent dir, pointed at by `PI_CODING_AGENT_DIR`. Isolated from the user's
/// personal `~/.pi/agent` so cetus's skills never collide with standalone pi use.
pub fn agent_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pi-agent")
}

/// `<agentDir>/skills` — the dir pi scans + auto-enables on session start.
pub fn active_skills_dir(app_data_dir: &Path) -> PathBuf {
    agent_dir(app_data_dir).join("skills")
}

/// `<app_data>/skills` — the library (source of truth) for every installed skill.
fn library_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("skills")
}

fn skill_dir(app_data_dir: &Path, id: &str) -> PathBuf {
    library_dir(app_data_dir).join(id)
}

fn short_path_hash(path: &Path) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn repo_skill_roots_for_workspace(workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    if let Some(workspace) = workspace {
        add_repo_skill_root_paths_from(workspace, &mut roots, &mut seen);
    }
    roots
}

fn add_repo_skill_root_paths_from(
    start: &Path,
    roots: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) {
    for ancestor in start.ancestors() {
        let root = ancestor.join(".agents").join("skills");
        if !root.is_dir() {
            continue;
        }
        let key = root
            .canonicalize()
            .unwrap_or_else(|_| root.clone())
            .to_string_lossy()
            .to_string();
        if seen.insert(key) {
            roots.push(root);
        }
    }
}

// ---- State persistence -----------------------------------------------------

pub fn load_state(store: &Store) -> SkillState {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(store: &Store, s: &SkillState) -> CmdResult<()> {
    store
        .set_setting(SETTINGS_KEY, &serde_json::to_string(s).map_err(err)?)
        .map_err(err)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---- Active-set materialisation --------------------------------------------

/// Rebuild the GLOBAL active set (`<agentDir>/skills`) from the library. This is
/// the template legacy conversations (created before per-conversation freezing)
/// fall back to; new conversations get their own frozen copy via
/// [`materialize_skills_into`] in `AppState::pi_for`.
pub fn resync_active_dir(app_data_dir: &Path, store: &Store) {
    let mut budget = SkillPromptBudget::from_env();
    materialize_skills_into_with_budget(
        app_data_dir,
        &active_skills_dir(app_data_dir),
        store,
        &mut budget,
        None,
    );
}

/// Rebuild `target` (a `<agentDir>/skills` directory) from the library + enabled
/// flags, plus discovered-folder skills when that opt-in is on. Idempotent: the
/// target is wiped and re-materialised each call, so it always reflects the
/// store exactly. Files are hard-linked from the library (see `copy_tree`), so a
/// full rebuild is cheap enough to run on every toggle and on every
/// per-conversation freeze without an incremental diff. Best-effort — a failure
/// on one skill is logged, not fatal, so a single bad skill can't strand the
/// others or break chat.
pub fn materialize_skills_into(app_data_dir: &Path, target: &Path, store: &Store) {
    let mut budget = SkillPromptBudget::from_env();
    materialize_skills_into_with_budget(app_data_dir, target, store, &mut budget, None);
}

/// Shared budget for skills that pi exposes directly in the system prompt. Once
/// exhausted, skills are still copied into the conversation snapshot but marked
/// `disable-model-invocation: true`; the `skill_search` / `skill_read` tools can
/// discover and load them lazily.
#[derive(Debug, Clone)]
pub struct SkillPromptBudget {
    max_chars: usize,
    used_chars: usize,
    visible_count: usize,
    hidden_count: usize,
}

impl SkillPromptBudget {
    pub fn from_env() -> Self {
        let max_chars = std::env::var("CETUS_SKILL_PROMPT_BUDGET_CHARS")
            .ok()
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or_else(|| {
                let context_tokens = std::env::var("CETUS_CONTEXT_WINDOW_TOKENS")
                    .ok()
                    .and_then(|s| s.trim().parse::<usize>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(DEFAULT_CONTEXT_TOKENS);
                let pct = std::env::var("CETUS_SKILL_PROMPT_BUDGET_PCT")
                    .ok()
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .filter(|p| *p > 0.0 && *p <= 0.5)
                    .unwrap_or(DEFAULT_SKILL_PROMPT_PCT);
                ((context_tokens as f64) * 4.0 * pct).round() as usize
            });
        Self {
            max_chars,
            used_chars: 0,
            visible_count: 0,
            hidden_count: 0,
        }
    }

    fn allow(&mut self, name: &str, description: &str, location: &Path) -> bool {
        // Mirrors pi's XML prompt entry closely enough to bound prompt growth
        // without depending on pi internals.
        let cost = 96 + name.len() + description.len() + location.to_string_lossy().len();
        if self.visible_count == 0 || self.used_chars + cost <= self.max_chars {
            self.used_chars += cost;
            self.visible_count += 1;
            true
        } else {
            self.hidden_count += 1;
            false
        }
    }

    pub fn log_if_truncated(&self, scope: &str) {
        if self.hidden_count > 0 {
            tracing::info!(
                "skills: {scope} visible manifest budget used {}/{} chars; {} visible, {} lazy-only",
                self.used_chars,
                self.max_chars,
                self.visible_count,
                self.hidden_count
            );
        }
    }
}

pub fn materialize_skills_into_with_budget(
    app_data_dir: &Path,
    target: &Path,
    store: &Store,
    budget: &mut SkillPromptBudget,
    workspace: Option<&Path>,
) {
    let state = load_state(store);
    // Start clean: only the materialised set should be present.
    let _ = std::fs::remove_dir_all(target);
    if let Err(e) = std::fs::create_dir_all(target) {
        tracing::warn!("skills: create active dir failed: {e}");
        return;
    }
    if !state.enabled {
        return; // master switch off → empty active set (discovered included)
    }
    for entry in state.entries.iter().filter(|e| e.enabled) {
        let src = skill_dir(app_data_dir, &entry.id);
        if !src.join("SKILL.md").exists() {
            continue; // library dir missing/corrupt — skip
        }
        let dst = target.join(&entry.id);
        if let Err(e) = materialize_one_skill(&src, &dst, &entry.name, &entry.description, budget) {
            tracing::warn!("skills: materialise {} failed: {e}", entry.id);
            let _ = std::fs::remove_dir_all(&dst);
        }
    }
    // Discovered skills (opt-in): copy every `SKILL.md` folder from the chosen
    // folder, namespaced so its id can't collide with a library id. pi dedups any
    // same-named skills by name at load time.
    let disc = crate::discovery::load_settings(store);
    if disc.skills_load_discovered {
        copy_discovered_skills(Path::new(&disc.skills_folder), target, budget, "user");
        for root in repo_skill_roots_for_workspace(workspace) {
            let ns = format!("repo-{}", short_path_hash(&root));
            copy_discovered_skills(&root, target, budget, &ns);
        }
    }
    budget.log_if_truncated("managed/discovered");
}

/// Copy each `SKILL.md` folder under `folder` into `target` with a source namespace.
fn copy_discovered_skills(
    folder: &Path,
    target: &Path,
    budget: &mut SkillPromptBudget,
    namespace: &str,
) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return; // folder missing / unreadable — nothing to load
    };
    for entry in entries.flatten() {
        let src = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !src.is_dir() || !src.join("SKILL.md").exists() {
            continue;
        }
        let dst = target.join(format!("discovered-{namespace}-{name}"));
        if dst.exists() {
            continue;
        }
        let md = std::fs::read_to_string(src.join("SKILL.md")).unwrap_or_default();
        let (fm_name, fm_desc) = parse_frontmatter(&md);
        let skill_name = fm_name.unwrap_or_else(|| name.clone());
        let skill_desc = fm_desc.unwrap_or_default();
        if let Err(e) = materialize_one_skill(&src, &dst, &skill_name, &skill_desc, budget) {
            tracing::warn!("skills: discovered {name} failed: {e}");
            let _ = std::fs::remove_dir_all(&dst);
        }
    }
}

pub fn materialize_one_skill(
    src: &Path,
    dst: &Path,
    name: &str,
    description: &str,
    budget: &mut SkillPromptBudget,
) -> std::io::Result<()> {
    copy_tree(src, dst, &mut 0, &mut 0)?;
    let visible = budget.allow(name, description, &dst.join("SKILL.md"));
    if !visible {
        mark_skill_lazy_only(&dst.join("SKILL.md"))?;
    }
    Ok(())
}

fn mark_skill_lazy_only(skill_md: &Path) -> std::io::Result<()> {
    let md = std::fs::read_to_string(skill_md)?;
    if md.contains("\ndisable-model-invocation:") || md.starts_with("disable-model-invocation:") {
        return Ok(());
    }
    let s = md.trim_start_matches('\u{feff}');
    let updated = if s.starts_with("---\n") || s.starts_with("---\r\n") {
        let mut out = String::new();
        let mut inserted = false;
        let mut lines = md.lines();
        if let Some(first) = lines.next() {
            out.push_str(first);
            out.push('\n');
        }
        for line in lines {
            if !inserted && line.trim_end() == "---" {
                out.push_str("disable-model-invocation: true\n");
                inserted = true;
            }
            out.push_str(line);
            out.push('\n');
        }
        out
    } else {
        format!(
            "---\ndescription: \"Lazy-only skill; use skill_read to inspect the original instructions.\"\ndisable-model-invocation: true\n---\n\n{}",
            md
        )
    };
    std::fs::write(skill_md, updated)
}

/// Copy a directory tree, skipping symlinks and enforcing total size/file caps so
/// an imported folder can't smuggle in a huge or cyclic tree. `bytes`/`files` are
/// running totals shared across the recursion.
fn copy_tree(src: &Path, dst: &Path, bytes: &mut u64, files: &mut usize) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            continue; // never follow symlinks out of the skill folder
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&from, &to, bytes, files)?;
        } else {
            *files += 1;
            if *files > MAX_IMPORT_FILES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("skill has too many files (max {MAX_IMPORT_FILES})"),
                ));
            }
            *bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            if *bytes > MAX_IMPORT_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "skill is too large (max {} MiB)",
                        MAX_IMPORT_BYTES / 1024 / 1024
                    ),
                ));
            }
            // Hard-link rather than byte-copy. The materialised set is a
            // read-only snapshot pi only ever reads — edits go through the
            // library dir (`skill_dir`) followed by a re-materialise — so
            // sharing inodes with the library is safe, and it turns the
            // per-conversation freeze (run on the pi-spawn critical path, up to
            // ~100 skills × 8 MiB files) from a deep copy into cheap directory
            // entries. `target` is always within app-data alongside the library
            // (same filesystem); fall back to a real copy if linking is
            // unsupported (cross-device) or otherwise fails.
            if std::fs::hard_link(&from, &to).is_err() {
                std::fs::copy(&from, &to)?;
            }
        }
    }
    Ok(())
}

// ---- SKILL.md frontmatter --------------------------------------------------

/// Pull `name` + `description` out of a `SKILL.md` YAML frontmatter block. A
/// deliberately tiny parser (no YAML dep): it reads the `key: value` lines of the
/// leading `---`…`---` block, unquoting simple scalars. Anything fancier (folded
/// blocks, lists) just isn't surfaced — pi re-parses the file itself; this is only
/// for the settings list.
fn parse_frontmatter(md: &str) -> (Option<String>, Option<String>) {
    let trimmed = md.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    if lines.next().map(|l| l.trim_end()) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            let value = unquote(value.trim());
            if value.is_empty() {
                continue;
            }
            match key.as_str() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    (name, description)
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Escape a scalar for a double-quoted YAML value (used when writing a SKILL.md
/// from the editor). Keeps it to one line.
fn yaml_quote(s: &str) -> String {
    let one_line = s.replace(['\r', '\n'], " ");
    format!(
        "\"{}\"",
        one_line.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// Truncate to a char boundary so display strings stay sane.
fn clamp(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() > max {
        t.chars().take(max).collect()
    } else {
        t.to_string()
    }
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> CmdResult<SkillState> {
    Ok(load_state(&state.store))
}

/// Flip the master switch. Empties/repopulates the active set and recycles pis.
#[tauri::command]
pub async fn set_skills_enabled(state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    let mut s = load_state(&state.store);
    s.enabled = enabled;
    save_state(&state.store, &s)?;
    resync_active_dir(&state.app_data_dir, &state.store);
    Ok(())
}

/// Install a skill from a folder on disk. The folder must contain a `SKILL.md`
/// (we treat it as a single skill root). Its files are copied into the library;
/// name/description come from the frontmatter, falling back to the folder name.
#[tauri::command]
pub async fn import_skill(state: State<'_, AppState>, path: String) -> CmdResult<SkillEntry> {
    let src = PathBuf::from(&path);
    let meta = std::fs::metadata(&src).map_err(|e| format!("can't read folder: {e}"))?;
    if !meta.is_dir() {
        return Err("pick a folder that contains a SKILL.md".into());
    }
    let skill_md = src.join("SKILL.md");
    if !skill_md.exists() {
        return Err("that folder has no SKILL.md — not a skill".into());
    }

    let mut s = load_state(&state.store);
    if s.entries.len() >= MAX_SKILLS {
        return Err(format!(
            "skill limit reached ({MAX_SKILLS}); remove one first"
        ));
    }

    let md = std::fs::read_to_string(&skill_md).unwrap_or_default();
    let (fm_name, fm_desc) = parse_frontmatter(&md);
    let folder_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = clamp(&fm_name.unwrap_or(folder_name), 120);
    let name = if name.is_empty() {
        "Untitled skill".to_string()
    } else {
        name
    };
    let description = clamp(&fm_desc.unwrap_or_default(), 400);

    let id = Uuid::new_v4().to_string();
    let dst = skill_dir(&state.app_data_dir, &id);
    copy_tree(&src, &dst, &mut 0, &mut 0).map_err(|e| {
        let _ = std::fs::remove_dir_all(&dst);
        e.to_string()
    })?;

    let now = now_ms();
    let entry = SkillEntry {
        id,
        name,
        description,
        enabled: true,
        source: "import".to_string(),
        created_at: now,
        updated_at: now,
    };
    s.entries.push(entry.clone());
    save_state(&state.store, &s)?;
    resync_active_dir(&state.app_data_dir, &state.store);
    Ok(entry)
}

/// Create a skill from the editor: a name, a one-line description, and a markdown
/// body. We write a `SKILL.md` with the standard frontmatter into a fresh library
/// folder.
#[tauri::command]
pub async fn create_skill(
    state: State<'_, AppState>,
    name: String,
    description: String,
    body: String,
) -> CmdResult<SkillEntry> {
    let name = clamp(&name, 120);
    if name.is_empty() {
        return Err("a skill needs a name".into());
    }
    let description = clamp(&description, 400);
    let body = clamp(&body, MAX_BODY_CHARS);

    let mut s = load_state(&state.store);
    if s.entries.len() >= MAX_SKILLS {
        return Err(format!(
            "skill limit reached ({MAX_SKILLS}); remove one first"
        ));
    }

    let id = Uuid::new_v4().to_string();
    let dir = skill_dir(&state.app_data_dir, &id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let content = skill_md(&name, &description, &body);
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        e.to_string()
    })?;

    let now = now_ms();
    let entry = SkillEntry {
        id,
        name,
        description,
        enabled: true,
        source: "created".to_string(),
        created_at: now,
        updated_at: now,
    };
    s.entries.push(entry.clone());
    save_state(&state.store, &s)?;
    resync_active_dir(&state.app_data_dir, &state.store);
    Ok(entry)
}

/// Create a skill PROPOSED by the agent's background review pass. Lands in the
/// library as `source:"agent"`, `enabled:false` — a suggestion the user reviews
/// and turns on in Settings → Skills. Because it's disabled it never enters the
/// active set, so there's no resync / pi-recycle here (enabling it later, via
/// [`set_skill_enabled`], does that). Not a Tauri command: the background pass
/// ([`crate::skill_review`]) calls it directly with the app-data dir + store.
pub fn propose_skill(
    app_data_dir: &Path,
    store: &Store,
    name: &str,
    description: &str,
    body: &str,
) -> CmdResult<SkillEntry> {
    let name = clamp(name, 120);
    if name.is_empty() {
        return Err("a proposed skill needs a name".into());
    }
    let description = clamp(description, 400);
    let body = clamp(body, MAX_BODY_CHARS);
    if body.is_empty() {
        return Err("a proposed skill needs a body".into());
    }

    let mut s = load_state(store);
    if s.entries.len() >= MAX_SKILLS {
        return Err(format!("skill limit reached ({MAX_SKILLS})"));
    }

    let id = Uuid::new_v4().to_string();
    let dir = skill_dir(app_data_dir, &id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let content = skill_md(&name, &description, &body);
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        e.to_string()
    })?;

    let now = now_ms();
    let entry = SkillEntry {
        id,
        name,
        description,
        enabled: false, // proposed → off until the user approves it
        source: "agent".to_string(),
        created_at: now,
        updated_at: now,
    };
    s.entries.push(entry.clone());
    save_state(store, &s)?;
    Ok(entry)
}

/// How many agent-proposed skills are still awaiting review (disabled). The
/// review pass uses this to avoid flooding the list with pending proposals.
pub fn pending_proposal_count(store: &Store) -> usize {
    load_state(store)
        .entries
        .iter()
        .filter(|e| e.source == "agent" && !e.enabled)
        .count()
}

/// `(name, description)` of every installed skill — fed to the review prompt so
/// it doesn't re-propose something that already exists (enabled or pending).
pub fn existing_skill_digest(store: &Store) -> Vec<(String, String)> {
    load_state(store)
        .entries
        .into_iter()
        .map(|e| (e.name, e.description))
        .collect()
}

// ---- Agent-facing CRUD (host-tunnel `manage_skill` tool) --------------------
//
// These back the `skill-tools` extension: the agent can create / update / delete
// the user's skills from inside a conversation ("create a skill for X"). Unlike
// the background review pass (which proposes DISABLED suggestions), a skill the
// user asks for is created ENABLED and managed (source "agent", visible +
// toggleable in Settings → Skills with a "By agent" badge). Not Tauri commands:
// [`crate::skill_tool`] calls them with the app-data dir + store, then runs
// `resync_active_dir` so the new active set loads in the next conversation.

/// Standard SKILL.md content for a name/description/body triple.
fn skill_md(name: &str, description: &str, body: &str) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        yaml_quote(name),
        yaml_quote(description),
        body.trim()
    )
}

/// Extract the markdown body (everything after the leading `---`…`---`
/// frontmatter) from a SKILL.md, so an update that doesn't supply a new body can
/// preserve the old one.
fn skill_body_from_md(md: &str) -> String {
    let s = md.trim_start_matches('\u{feff}');
    if !s.starts_with("---") {
        return s.trim().to_string();
    }
    let mut lines = s.lines();
    let _ = lines.next(); // opening ---
    let mut in_frontmatter = true;
    let mut body = String::new();
    for line in lines {
        if in_frontmatter {
            if line.trim_end() == "---" {
                in_frontmatter = false;
            }
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    body.trim().to_string()
}

/// Create a skill the user explicitly asked the agent for: lands ENABLED, source
/// "agent". Caller runs `resync_active_dir` afterwards.
pub fn agent_create_skill(
    app_data_dir: &Path,
    store: &Store,
    name: &str,
    description: &str,
    body: &str,
) -> CmdResult<SkillEntry> {
    let name = clamp(name, 120);
    if name.is_empty() {
        return Err("a skill needs a name".into());
    }
    let description = clamp(description, 400);
    let body = clamp(body, MAX_BODY_CHARS);
    if body.is_empty() {
        return Err("a skill needs a body (the instructions it provides)".into());
    }

    let mut s = load_state(store);
    if s.entries.len() >= MAX_SKILLS {
        return Err(format!(
            "skill limit reached ({MAX_SKILLS}); remove one first"
        ));
    }

    let id = Uuid::new_v4().to_string();
    let dir = skill_dir(app_data_dir, &id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(dir.join("SKILL.md"), skill_md(&name, &description, &body)).map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        e.to_string()
    })?;

    let now = now_ms();
    let entry = SkillEntry {
        id,
        name,
        description,
        enabled: true,
        source: "agent".to_string(),
        created_at: now,
        updated_at: now,
    };
    s.entries.push(entry.clone());
    save_state(store, &s)?;
    Ok(entry)
}

/// Update an existing skill's name / description / body (only the supplied
/// fields). Works on any managed skill (the user asked); a missing body is
/// preserved from disk. Caller runs `resync_active_dir` afterwards.
pub fn agent_update_skill(
    app_data_dir: &Path,
    store: &Store,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    body: Option<&str>,
) -> CmdResult<SkillEntry> {
    let mut s = load_state(store);
    let idx = s
        .entries
        .iter()
        .position(|e| e.id == id)
        .ok_or_else(|| format!("skill not found: {id}"))?;

    let new_name = match name {
        Some(n) => {
            let n = clamp(n, 120);
            if n.is_empty() {
                return Err("name cannot be empty".into());
            }
            n
        }
        None => s.entries[idx].name.clone(),
    };
    let new_desc = match description {
        Some(d) => clamp(d, 400),
        None => s.entries[idx].description.clone(),
    };
    let dir = skill_dir(app_data_dir, id);
    let new_body = match body {
        Some(b) => {
            let b = clamp(b, MAX_BODY_CHARS);
            if b.is_empty() {
                return Err("body cannot be empty".into());
            }
            b
        }
        None => {
            skill_body_from_md(&std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default())
        }
    };

    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(
        dir.join("SKILL.md"),
        skill_md(&new_name, &new_desc, &new_body),
    )
    .map_err(err)?;

    let now = now_ms();
    let e = &mut s.entries[idx];
    e.name = new_name;
    e.description = new_desc;
    e.updated_at = now;
    let updated = e.clone();
    save_state(store, &s)?;
    Ok(updated)
}

/// Delete a managed skill by id. Returns whether it existed. Caller runs
/// `resync_active_dir` afterwards.
pub fn agent_delete_skill(app_data_dir: &Path, store: &Store, id: &str) -> CmdResult<bool> {
    let mut s = load_state(store);
    let before = s.entries.len();
    s.entries.retain(|e| e.id != id);
    if s.entries.len() == before {
        return Ok(false);
    }
    let _ = std::fs::remove_dir_all(skill_dir(app_data_dir, id));
    save_state(store, &s)?;
    Ok(true)
}

#[tauri::command]
pub async fn set_skill_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> CmdResult<SkillEntry> {
    let mut s = load_state(&state.store);
    let entry = s
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("skill not found: {id}"))?;
    entry.enabled = enabled;
    entry.updated_at = now_ms();
    let updated = entry.clone();
    save_state(&state.store, &s)?;
    resync_active_dir(&state.app_data_dir, &state.store);
    Ok(updated)
}

#[tauri::command]
pub async fn delete_skill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut s = load_state(&state.store);
    let before = s.entries.len();
    s.entries.retain(|e| e.id != id);
    if s.entries.len() == before {
        return Ok(()); // already gone — idempotent
    }
    let _ = std::fs::remove_dir_all(skill_dir(&state.app_data_dir, &id));
    save_state(&state.store, &s)?;
    resync_active_dir(&state.app_data_dir, &state.store);
    Ok(())
}

/// Reveal a skill's library folder in the OS file browser, so the user can edit
/// its `SKILL.md` and supporting files directly.
#[tauri::command]
pub async fn reveal_skill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let dir = skill_dir(&state.app_data_dir, &id);
    if !dir.exists() {
        return Err("skill folder is missing".into());
    }
    open_in_file_browser(&dir)
}

/// Open a path in the OS file browser (Finder / Explorer / xdg). Shared by the
/// library and discovered-skill reveal commands.
fn open_in_file_browser(path: &Path) -> CmdResult<()> {
    let p = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

// ---- Discovered skills (user + repo .agents/skills) ------------------------
//
// pi/Codex-style skill discovery has two read-only sources outside cetus's
// managed library: user skills (the configured `~/.agents/skills`-style folder)
// and repo skills (`.agents/skills` under a workspace ancestor). Both can be live
// in chat but cetus never wrote them, so we surface them here read-only: list
// them, render their `SKILL.md`, and reveal the folder.

/// One auto-discovered skill. `id` encodes source + root hash + folder so same
/// folder names in user/repo roots can be read/revealed unambiguously.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub root: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiscoveredScope {
    User,
    Repo,
}

impl DiscoveredScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Repo => "repo",
        }
    }
}

#[derive(Debug, Clone)]
struct DiscoveredRoot {
    scope: DiscoveredScope,
    path: PathBuf,
}

/// Reject anything that isn't a single, plain folder name so an `id` from the UI
/// can never escape the discovered-skills folder (no separators, no `.`/`..`).
fn safe_component(id: &str) -> Option<&str> {
    if id.is_empty() || id == "." || id == ".." {
        return None;
    }
    if id.contains('/') || id.contains('\\') || id.contains('\0') {
        return None;
    }
    Some(id)
}

fn discovered_skill_id(scope: DiscoveredScope, root: &Path, folder: &str) -> String {
    format!("{}:{}:{folder}", scope.as_str(), short_path_hash(root))
}

fn parse_discovered_skill_id(id: &str) -> Option<(Option<DiscoveredScope>, Option<String>, &str)> {
    let mut parts = id.splitn(3, ':');
    let first = parts.next()?;
    let second = parts.next();
    let third = parts.next();
    match (first, second, third) {
        ("user", Some(hash), Some(folder)) => {
            Some((Some(DiscoveredScope::User), Some(hash.to_string()), folder))
        }
        ("repo", Some(hash), Some(folder)) => {
            Some((Some(DiscoveredScope::Repo), Some(hash.to_string()), folder))
        }
        _ => Some((None, None, id)), // Back-compat for old folder-only ids.
    }
}

fn discovered_roots(state: &AppState) -> Vec<DiscoveredRoot> {
    let disc = crate::discovery::load_settings(&state.store);
    let user_root = PathBuf::from(disc.skills_folder);
    let user_key = user_root
        .canonicalize()
        .unwrap_or_else(|_| user_root.clone())
        .to_string_lossy()
        .to_string();

    let mut roots = vec![DiscoveredRoot {
        scope: DiscoveredScope::User,
        path: user_root,
    }];
    let mut seen = HashSet::from([user_key]);

    if let Ok(cwd) = std::env::current_dir() {
        add_repo_skill_roots_from(&cwd, &mut roots, &mut seen);
    }
    add_repo_skill_roots_from(&state.default_workspace, &mut roots, &mut seen);
    if let Ok(convs) = state.store.list(false) {
        for conv in convs.into_iter().take(50) {
            add_repo_skill_roots_from(Path::new(&conv.workspace_dir), &mut roots, &mut seen);
        }
    }

    roots
}

fn add_repo_skill_roots_from(
    start: &Path,
    roots: &mut Vec<DiscoveredRoot>,
    seen: &mut HashSet<String>,
) {
    let mut path_roots = Vec::new();
    let mut path_seen = HashSet::new();
    add_repo_skill_roots_from_path(start, &mut path_roots, &mut path_seen);
    for path in path_roots {
        let key = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .to_string();
        if seen.insert(key) {
            roots.push(DiscoveredRoot {
                scope: DiscoveredScope::Repo,
                path,
            });
        }
    }
}

fn add_repo_skill_roots_from_path(
    start: &Path,
    roots: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) {
    for ancestor in start.ancestors() {
        let root = ancestor.join(".agents").join("skills");
        if !root.is_dir() {
            continue;
        }
        let key = root
            .canonicalize()
            .unwrap_or_else(|_| root.clone())
            .to_string_lossy()
            .to_string();
        if seen.insert(key) {
            roots.push(root);
        }
    }
}

fn resolve_discovered_skill_md(state: &AppState, id: &str) -> CmdResult<PathBuf> {
    let (scope, hash, folder) = parse_discovered_skill_id(id).ok_or("invalid skill id")?;
    let comp = safe_component(folder).ok_or("invalid skill id")?;
    let roots = discovered_roots(state);
    for root in roots {
        if let Some(want_scope) = scope {
            if root.scope != want_scope {
                continue;
            }
        }
        if let Some(want_hash) = hash.as_deref() {
            if short_path_hash(&root.path) != want_hash {
                continue;
            }
        }
        let md = root.path.join(comp).join("SKILL.md");
        if md.exists() {
            return Ok(md);
        }
    }
    Err("skill folder is missing".into())
}

/// Scan discovered roots for `<name>/SKILL.md`, returning metadata for each.
/// Best-effort and read-only: missing dir → empty list; an unreadable entry is
/// skipped. Name falls back to the folder name when frontmatter has none.
#[tauri::command]
pub async fn list_discovered_skills(state: State<'_, AppState>) -> CmdResult<Vec<DiscoveredSkill>> {
    let mut out = Vec::new();
    for root in discovered_roots(&state) {
        let Ok(read) = std::fs::read_dir(&root.path) else {
            continue;
        };
        for entry in read.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_string();
            // Skip dotfiles / lock files masquerading as entries.
            if folder.starts_with('.') {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            let Ok(md) = std::fs::read_to_string(&skill_md) else {
                continue; // not a skill folder
            };
            let (fm_name, fm_desc) = parse_frontmatter(&md);
            let name = clamp(&fm_name.unwrap_or_else(|| folder.clone()), 120);
            let name = if name.is_empty() {
                folder.clone()
            } else {
                name
            };
            out.push(DiscoveredSkill {
                id: discovered_skill_id(root.scope, &root.path, &folder),
                name,
                description: clamp(&fm_desc.unwrap_or_default(), 400),
                scope: root.scope.as_str().to_string(),
                root: root.path.to_string_lossy().to_string(),
                path: skill_md.to_string_lossy().to_string(),
            });
        }
    }
    out.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read a discovered skill's full `SKILL.md` for in-app rendering. Capped so one
/// skill can't blow up the UI; `id` is validated to stay inside the dir.
#[tauri::command]
pub async fn read_discovered_skill(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let md = resolve_discovered_skill_md(&state, &id)?;
    let body = std::fs::read_to_string(&md).map_err(|e| format!("can't read SKILL.md: {e}"))?;
    Ok(clamp(&body, MAX_BODY_CHARS))
}

/// Reveal a discovered skill's folder in the OS file browser.
#[tauri::command]
pub async fn reveal_discovered_skill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let md = resolve_discovered_skill_md(&state, &id)?;
    let dir = md
        .parent()
        .ok_or_else(|| "skill folder is missing".to_string())?
        .to_path_buf();
    if !dir.exists() {
        return Err("skill folder is missing".into());
    }
    open_in_file_browser(&dir)
}
