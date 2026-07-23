//! Tauri commands invoked by the React frontend.
//!
//! Every command that talks to a pi process takes the owning conversation id
//! explicitly — the previous "active session" model is gone now that each
//! conversation has its own dedicated pi child (see AppState::pi_for).

use crate::model::ModelChoice;
use crate::secrets;
use crate::store::{now_ms, Conversation};
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, Url,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

const BROWSER_ANNOTATION_TITLE_PREFIX: &str = "__CETUS_BROWSER_ANNOTATION__";
const BROWSER_PANEL_LABEL: &str = "browser-panel";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserAnnotationPayload {
    url: String,
    title: String,
    x_pct: Option<f64>,
    y_pct: Option<f64>,
    note: String,
    selector: Option<String>,
    element: Option<String>,
    text: Option<String>,
    rect: Option<BrowserAnnotationRect>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserAnnotationRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationLabels {
    annotate: String,
    placeholder: String,
    cancel: String,
    send: String,
}

impl Default for BrowserAnnotationLabels {
    fn default() -> Self {
        Self {
            annotate: "Annotate".to_string(),
            placeholder: "Describe what Cetus should change here".to_string(),
            cancel: "Cancel".to_string(),
            send: "Send".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    name: String,
    path: String,
    relative_path: String,
    is_dir: bool,
    is_ignored: bool,
    git_status: Option<String>,
    is_symlink: bool,
    symlink_target: Option<String>,
    size_bytes: Option<u64>,
    modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryListing {
    entries: Vec<WorkspaceFileEntry>,
    truncated: bool,
    is_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextPreview {
    text: String,
    truncated: bool,
    total_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const BROWSER_ANNOTATION_SCRIPT: &str = r###"
(function () {
  if (window.__cetusBrowserAnnotationInstalled) return;
  window.__cetusBrowserAnnotationInstalled = true;
  var PREFIX = "__CETUS_BROWSER_ANNOTATION_TOKEN__";
  var annotating = false;
  var pending = null;
  var highlighted = null;
  var root = document.createElement("div");
  root.id = "cetus-browser-annotation-root";
  root.innerHTML = [
    '<style>',
    '#cetus-browser-annotation-root{all:initial;position:fixed;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111}',
    '#cetus-browser-annotation-toggle{all:initial;position:fixed;right:18px;bottom:18px;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:8px;background:#111;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.24);cursor:pointer}',
    '#cetus-browser-annotation-root[data-on=true] #cetus-browser-annotation-toggle{background:#0f766e}',
    '#cetus-browser-annotation-highlight{all:initial;display:none;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #0f766e;background:rgba(15,118,110,.08);box-shadow:0 0 0 99999px rgba(15,23,42,.06),0 8px 22px rgba(15,118,110,.18);border-radius:4px}',
    '#cetus-browser-annotation-root[data-on=true] #cetus-browser-annotation-highlight{display:block}',
    '#cetus-browser-annotation-pop{all:initial;display:none;position:fixed;z-index:2147483647;width:310px;border:1px solid rgba(0,0,0,.16);border-radius:10px;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.25);padding:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111}',
    '#cetus-browser-annotation-pop textarea{all:initial;box-sizing:border-box;display:block;width:100%;height:110px;resize:none;border:1px solid rgba(0,0,0,.16);border-radius:7px;padding:8px;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;background:#fff;white-space:pre-wrap}',
    '#cetus-browser-annotation-pop .row{all:initial;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#666}',
    '#cetus-browser-annotation-target{all:initial;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:178px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#666}',
    '#cetus-browser-annotation-pop button{all:initial;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:7px;font:600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer}',
    '#cetus-browser-annotation-cancel{background:#f2f2f2;color:#333;margin-right:6px}',
    '#cetus-browser-annotation-send{background:#111;color:#fff}',
    '</style>',
    '<div id="cetus-browser-annotation-highlight"></div>',
    '__CETUS_BROWSER_ANNOTATION_TOGGLE__',
    '<div id="cetus-browser-annotation-pop">',
    '  <textarea id="cetus-browser-annotation-note" maxlength="2000" placeholder="__CETUS_BROWSER_ANNOTATE_PLACEHOLDER__"></textarea>',
    '  <div class="row"><span id="cetus-browser-annotation-target"></span><span><button id="cetus-browser-annotation-cancel" type="button">__CETUS_BROWSER_ANNOTATE_CANCEL__</button><button id="cetus-browser-annotation-send" type="button">__CETUS_BROWSER_ANNOTATE_SEND__</button></span></div>',
    '</div>'
  ].join("");
  function mount() {
    if (!document.documentElement || document.getElementById("cetus-browser-annotation-root")) return;
    document.documentElement.appendChild(root);
    wire();
  }
  function describeElement(el) {
    if (!el || el === document || el === window) return null;
    var parts = [];
    if (el.tagName) parts.push(String(el.tagName).toLowerCase());
    if (el.id) parts.push("#" + el.id);
    if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      if (cls) parts.push("." + cls);
    }
    return parts.join("");
  }
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }
  function selectorFor(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return String(el.tagName).toLowerCase() + "#" + cssEscape(el.id);
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && path.length < 5) {
      var name = String(cur.tagName).toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        var cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(function (c) {
          return "." + cssEscape(c);
        }).join("");
        name += cls;
      }
      var sameTag = 0;
      var index = 0;
      var child = cur.parentElement ? cur.parentElement.firstElementChild : null;
      while (child) {
        if (child.tagName === cur.tagName) {
          sameTag += 1;
          if (child === cur) index = sameTag;
        }
        child = child.nextElementSibling;
      }
      if (sameTag > 1) name += ":nth-of-type(" + index + ")";
      path.unshift(name);
      cur = cur.parentElement;
    }
    return path.join(" > ");
  }
  function clippedText(el) {
    if (!el || !el.innerText) return null;
    var s = String(el.innerText).replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 240) : null;
  }
  function isChrome(el) {
    return !!(el && (el === root || (el.closest && el.closest("#cetus-browser-annotation-root"))));
  }
  function setAnnotating(next) {
    annotating = next;
    root.setAttribute("data-on", annotating ? "true" : "false");
    if (!annotating) {
      pending = null;
      highlighted = null;
      var highlight = document.getElementById("cetus-browser-annotation-highlight");
      var pop = document.getElementById("cetus-browser-annotation-pop");
      if (highlight) highlight.style.display = "none";
      if (pop) pop.style.display = "none";
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onPick, true);
      return;
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onPick, true);
  }
  function drawHighlight(el) {
    var highlight = document.getElementById("cetus-browser-annotation-highlight");
    if (!highlight || !el || isChrome(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    highlighted = el;
    highlight.style.display = "block";
    highlight.style.left = Math.max(0, r.left) + "px";
    highlight.style.top = Math.max(0, r.top) + "px";
    highlight.style.width = Math.max(1, r.width) + "px";
    highlight.style.height = Math.max(1, r.height) + "px";
  }
  function targetFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || isChrome(el)) return highlighted;
    return el;
  }
  function onMove(e) {
    if (!annotating) return;
    drawHighlight(targetFromPoint(e.clientX, e.clientY));
  }
  function onPick(e) {
    if (!annotating) return;
    if (isChrome(e.target)) return;
    var target = targetFromPoint(e.clientX, e.clientY);
    if (!target || isChrome(target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    drawHighlight(target);
    var r = target.getBoundingClientRect();
    var selector = selectorFor(target);
    pending = {
      url: location.href,
      title: document.title || "",
      selector: selector,
      element: describeElement(target),
      text: clippedText(target),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    };
    var pop = document.getElementById("cetus-browser-annotation-pop");
    var note = document.getElementById("cetus-browser-annotation-note");
    var label = document.getElementById("cetus-browser-annotation-target");
    if (!pop || !note || !label) return;
    label.textContent = selector || describeElement(target) || "";
    pop.style.left = Math.min(window.innerWidth - 330, Math.max(12, r.right + 12)) + "px";
    pop.style.top = Math.min(window.innerHeight - 190, Math.max(12, r.top)) + "px";
    pop.style.display = "block";
    note.value = "";
    note.focus();
  }
  function wire() {
    var toggle = document.getElementById("cetus-browser-annotation-toggle");
    var pop = document.getElementById("cetus-browser-annotation-pop");
    var note = document.getElementById("cetus-browser-annotation-note");
    var cancel = document.getElementById("cetus-browser-annotation-cancel");
    var send = document.getElementById("cetus-browser-annotation-send");
    if (!pop || !note || !cancel || !send) return;
    if (toggle) {
      toggle.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setAnnotating(!annotating);
      });
    }
    cancel.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setAnnotating(false);
    });
    send.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!pending || !note.value.trim()) return;
      pending.note = note.value.trim().slice(0, 2000);
      document.title = PREFIX + JSON.stringify(pending);
      setTimeout(function () {
        document.title = pending.title || "Cetus Browser";
        setAnnotating(false);
      }, 0);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && annotating) {
        setAnnotating(false);
      }
    }, true);
  }
  window.__cetusSetBrowserAnnotationMode = setAnnotating;
  window.addEventListener("cetus-browser-annotation-mode", function (e) {
    setAnnotating(!!(e.detail && e.detail.enabled));
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
"###;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn browser_annotation_script(
    token: &str,
    labels: &BrowserAnnotationLabels,
    show_toggle: bool,
) -> String {
    let toggle = if show_toggle {
        format!(
            r#"<button id="cetus-browser-annotation-toggle" type="button">{}</button>"#,
            escape_html_attr(&labels.annotate)
        )
    } else {
        String::new()
    };
    BROWSER_ANNOTATION_SCRIPT
        .replace("__CETUS_BROWSER_ANNOTATION_TOKEN__", token)
        .replace("__CETUS_BROWSER_ANNOTATION_TOGGLE__", &toggle)
        .replace(
            "__CETUS_BROWSER_ANNOTATE_PLACEHOLDER__",
            &escape_html_attr(&labels.placeholder),
        )
        .replace(
            "__CETUS_BROWSER_ANNOTATE_CANCEL__",
            &escape_html_attr(&labels.cancel),
        )
        .replace(
            "__CETUS_BROWSER_ANNOTATE_SEND__",
            &escape_html_attr(&labels.send),
        )
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
    include_archived: bool,
) -> CmdResult<Vec<Conversation>> {
    state.store.list(include_archived).map_err(err)
}

#[tauri::command]
pub async fn new_conversation(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    model: Option<ModelChoice>,
) -> CmdResult<Conversation> {
    let workspace = workspace_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_workspace.clone());
    if cetus_bridge::remote::parse_remote_workspace(&workspace.to_string_lossy()).is_none() {
        std::fs::create_dir_all(&workspace).map_err(err)?;
    }

    // Mint the id up front; the pi is spawned lazily by `pi_for` on first use
    // (send_prompt / switch) rather than here. Spawning a pi eagerly costs a
    // subprocess launch + two RPC round-trips before this command can return,
    // which made the UI stall between Enter and the conversation appearing.
    // Deferring it lets the row land instantly so the optimistic bubble renders
    // right away; `pi_for` mints the session (empty `session_file` below) and
    // applies the model the moment the prompt actually goes out.
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let c = Conversation {
        id: id.clone(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: workspace.to_string_lossy().to_string(),
        model: model.unwrap_or_default(),
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: crate::store::default_backend(),
        cli_model: String::new(),
        cli_effort: String::new(),
    };
    state.store.insert(&c).map_err(err)?;
    Ok(c)
}

#[tauri::command]
pub async fn fork_conversation(
    state: State<'_, AppState>,
    id: String,
    message_id: Option<String>,
    message_index: Option<usize>,
) -> CmdResult<SwitchResponse> {
    let source = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;

    // CLI-backend conversations fork by cloning the persisted transcript.
    if cetus_bridge::cli_agent::CliBackend::from_id(&source.backend).is_some() {
        return fork_cli_conversation(&state, &source, message_id, message_index).await;
    }

    // Ensure a lazily-created conversation has a concrete session file before
    // cloning it. For normal chats this is already populated.
    let source_session = if source.session_file.is_empty() {
        let _ = state.pi_for(&id).await.map_err(err)?;
        state
            .store
            .get(&id)
            .map_err(err)?
            .ok_or_else(|| "conversation not found".to_string())?
            .session_file
    } else {
        source.session_file.clone()
    };
    if source_session.is_empty() {
        return Err("conversation has no session to fork".to_string());
    }

    let new_id = Uuid::new_v4().to_string();
    let ext = Path::new(&source_session)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jsonl");
    let fork_session = state
        .sessions_dir()
        .join(format!("{new_id}.{ext}"))
        .to_string_lossy()
        .to_string();
    std::fs::copy(&source_session, &fork_session).map_err(err)?;

    let now = now_ms();
    let c = Conversation {
        id: new_id.clone(),
        title: if source.title.trim().is_empty() {
            String::new()
        } else {
            format!("{} (fork)", source.title)
        },
        session_file: fork_session,
        workspace_dir: source.workspace_dir.clone(),
        model: source.model,
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: crate::store::default_backend(),
        cli_model: String::new(),
        cli_effort: String::new(),
    };
    state.store.insert(&c).map_err(err)?;

    let pi = state.pi_for(&new_id).await.map_err(err)?;
    let mut messages = pi.get_messages().await.map_err(err)?;
    if message_id.as_deref().is_some() || message_index.is_some() {
        let target_idx = find_fork_target_index(&messages, message_id.as_deref(), message_index)
            .ok_or_else(|| "fork target message not found".to_string())?;
        let forkable = pi.get_fork_messages().await.map_err(err)?;
        if let Some(entry_id) = next_user_entry_after(&messages, &forkable, target_idx)? {
            let _ = pi.fork(entry_id).await.map_err(err)?;
            messages = pi.get_messages().await.map_err(err)?;
        }
    }
    Ok(SwitchResponse {
        conversation: c,
        messages,
    })
}

/// Fork a claude-code/codex conversation: mint a sibling row (same backend and
/// workspace), copy the transcript — truncated at the next user turn after the
/// fork target, mirroring the pi fork contract — and pick the resume token the
/// fork continues from. claude's `--resume` forks server-side sessions cheaply,
/// so any row's `resume_before` token is a valid branch point; codex threads
/// are single-lined, so a codex fork keeps the visual history but starts its
/// context fresh (empty token) rather than cross-contaminating the source
/// conversation's thread.
async fn fork_cli_conversation(
    state: &State<'_, AppState>,
    source: &Conversation,
    message_id: Option<String>,
    message_index: Option<usize>,
) -> CmdResult<SwitchResponse> {
    let rows = state.store.list_cli_rows(&source.id).map_err(err)?;
    let messages: Vec<Value> = rows.iter().map(|(_, m, _)| m.clone()).collect();

    // Where to cut: the first user row after the target message (its turn and
    // everything later stay out of the fork). No target → full copy.
    let mut copy_limit: Option<usize> = None;
    let mut fork_resume = source.session_file.clone();
    if message_id.is_some() || message_index.is_some() {
        let target_idx = find_fork_target_index(&messages, message_id.as_deref(), message_index)
            .ok_or_else(|| "fork target message not found".to_string())?;
        let cut = messages
            .iter()
            .enumerate()
            .skip(target_idx + 1)
            .find(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("user"))
            .map(|(i, _)| i);
        if let Some(cut_idx) = cut {
            copy_limit = Some(cut_idx);
            // The cut user row's resume_before is the token in effect at the
            // cut point — exactly what the fork should resume from.
            fork_resume = rows[cut_idx].2.clone().unwrap_or_default();
        }
    }
    if source.backend == "codex" {
        fork_resume = String::new();
    }

    let new_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let c = Conversation {
        id: new_id.clone(),
        title: if source.title.trim().is_empty() {
            String::new()
        } else {
            format!("{} (fork)", source.title)
        },
        session_file: fork_resume,
        workspace_dir: source.workspace_dir.clone(),
        model: source.model,
        created_at: now,
        updated_at: now,
        archived_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".to_string(),
        backend: source.backend.clone(),
        cli_model: source.cli_model.clone(),
        cli_effort: source.cli_effort.clone(),
    };
    state.store.insert(&c).map_err(err)?;
    state
        .store
        .copy_cli_messages(&source.id, &new_id, copy_limit)
        .map_err(err)?;

    // Seed the fork's worktree from the source's branch when the source runs
    // isolated, so the fork continues from the source's file state instead of
    // repo HEAD. A source running directly in the workspace forks a workspace
    // run — no worktree. Best-effort either way.
    let ws = std::path::PathBuf::from(&source.workspace_dir);
    if cetus_bridge::worktree::is_git_repo(&ws)
        && cetus_bridge::worktree::worktree_path(&ws, &source.id)
            .join(".git")
            .exists()
    {
        let src_branch = cetus_bridge::worktree::branch_name(&source.id);
        let _ = cetus_bridge::worktree::ensure_worktree(&ws, &new_id, Some(&src_branch));
    }

    let messages = state.store.list_cli_messages(&new_id).map_err(err)?;
    Ok(SwitchResponse {
        conversation: c,
        messages,
    })
}

fn find_fork_target_index(
    messages: &[Value],
    message_id: Option<&str>,
    message_index: Option<usize>,
) -> Option<usize> {
    if let Some(id) = message_id {
        if let Some(idx) = messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
        {
            return Some(idx);
        }
    }

    let target_display_idx = message_index?;
    let mut display_idx = 0usize;
    for (raw_idx, msg) in messages.iter().enumerate() {
        if msg.get("role").and_then(|v| v.as_str()) == Some("toolResult") {
            continue;
        }
        if display_idx == target_display_idx {
            return Some(raw_idx);
        }
        display_idx += 1;
    }
    None
}

fn next_user_entry_after<'a>(
    messages: &[Value],
    forkable: &'a [Value],
    target_idx: usize,
) -> CmdResult<Option<&'a str>> {
    let mut user_ordinal = 0usize;
    for (idx, msg) in messages.iter().enumerate() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        if idx > target_idx {
            return forkable
                .get(user_ordinal)
                .and_then(|v| v.get("entryId"))
                .and_then(|v| v.as_str())
                .map(Some)
                .ok_or_else(|| "fork entry missing id".to_string());
        }
        user_ordinal += 1;
    }
    Ok(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResponse {
    pub conversation: Conversation,
    pub messages: Vec<Value>,
}

#[tauri::command]
pub async fn switch_conversation(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<SwitchResponse> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // CLI-backend conversations replay from the persisted transcript — their
    // session_file is a resume token, not a pi session, so a pi must never be
    // spawned against it.
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        let messages = state.store.list_cli_messages(&id).map_err(err)?;
        return Ok(SwitchResponse {
            conversation: conv,
            messages,
        });
    }
    // pi_for lazy-spawns if this is the first time the conversation is opened
    // since the app launched. The fresh pi's switch_session + apply_choice
    // happen inside pi_for.
    let pi = state.pi_for(&id).await.map_err(err)?;
    let messages = pi.get_messages().await.map_err(err)?;
    Ok(SwitchResponse {
        conversation: conv,
        messages,
    })
}

#[tauri::command]
pub async fn set_active_conversation(
    state: State<'_, AppState>,
    id: Option<String>,
) -> CmdResult<()> {
    state.set_active_conversation(id).await;
    Ok(())
}

#[tauri::command]
pub async fn archive_conversation(
    state: State<'_, AppState>,
    id: String,
    archive: bool,
) -> CmdResult<Conversation> {
    let conversation = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    state
        .store
        .set_archived(&id, archive, now_ms())
        .map_err(err)?;
    // Archived conversations don't keep an idle pi around — reclaim the
    // process. Un-archiving just leaves it cold; next interaction lazy-spawns.
    if archive {
        state.kill_pi(&id).await;
        state.abort_cli_turn(&id);
        state.kill_claude_session(&id);
        state.kill_codex_session(&id);
    }
    // Codex persists app-server threads in its own session inventory. Mirror
    // Cetus's state after stopping the live session so Codex App/CLI sees the
    // same archive bucket. Keep this best-effort for older/missing Codex CLIs.
    if let Err(error) = crate::cli_backend::sync_codex_archive_state(&conversation, archive).await {
        tracing::warn!("failed to sync Codex archive state for {id}: {error}");
    }
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

/// Set a conversation's human-in-the-loop review state. Called by the frontend
/// when the `request_review` tool fires (→ "pending"), and by the board's
/// approve ("approved") / send-back ("none") actions. Returns the updated row so
/// the UI can re-bucket the card.
#[tauri::command]
pub async fn set_review_state(
    state: State<'_, AppState>,
    id: String,
    state_value: String,
) -> CmdResult<Conversation> {
    state
        .store
        .set_review_state(&id, &state_value, now_ms())
        .map_err(err)?;
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.kill_pi(&id).await;
    state.abort_cli_turn(&id);
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    state.remove_conv_agent(&id);
    // CLI-backend leftovers: the git worktree (its branch survives so finished
    // work isn't lost), the persisted transcript, and on-disk attachments.
    // All no-ops for pi conversations.
    if let Ok(Some(conv)) = state.store.get(&id) {
        if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
            let ws = std::path::PathBuf::from(&conv.workspace_dir);
            if cetus_bridge::worktree::is_git_repo(&ws) {
                if let Err(e) = cetus_bridge::worktree::remove_worktree(&ws, &id) {
                    tracing::warn!("worktree cleanup for {id} failed: {e:#}");
                }
            }
        }
    }
    state.store.delete_cli_messages(&id).ok();
    let _ = std::fs::remove_dir_all(crate::cli_backend::attachments_dir(&state.app_data_dir, &id));
    let _ = std::fs::remove_dir_all(crate::cli_backend::artifacts_dir(&state.app_data_dir, &id));
    state.store.delete(&id).map_err(err)
}

/// Where a CLI-backend conversation's isolated changes live: the worktree path
/// + branch, when the workspace is a git repo. None for pi conversations and
/// non-repo workspaces — the UI hides the affordance.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// False until the first turn actually created the worktree.
    pub exists: bool,
}

#[tauri::command]
pub async fn conversation_worktree(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<WorktreeInfo>> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_none() {
        return Ok(None);
    }
    let ws = std::path::PathBuf::from(&conv.workspace_dir);
    if !cetus_bridge::worktree::is_git_repo(&ws) {
        return Ok(None);
    }
    let path = cetus_bridge::worktree::worktree_path(&ws, &id);
    Ok(Some(WorktreeInfo {
        exists: path.join(".git").exists(),
        path: path.to_string_lossy().to_string(),
        branch: cetus_bridge::worktree::branch_name(&id),
    }))
}

/// Branch checked out in a local workspace. Non-git and remote workspaces do
/// not render a branch indicator.
#[tauri::command]
pub async fn workspace_git_branch(workspace_dir: String) -> CmdResult<Option<String>> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Ok(None);
    }
    Ok(cetus_bridge::worktree::current_branch(Path::new(
        &workspace_dir,
    )))
}

#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> CmdResult<Conversation> {
    state.store.rename(&id, &title, now_ms()).map_err(err)?;
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".into())
}

/// pi-ai `ImageContent` block. Mirrors the wire shape so the frontend can
/// build them and we forward without re-serializing fields.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
    pub mime_type: String,
}

/// Strip a leading quick-launcher `<context source="cetus-quick"> … </context>`
/// block (with its trailing blank line) so titling sees only the user's prose.
/// Returns the input unchanged when no such fence is present.
fn strip_context_fence(msg: &str) -> &str {
    const OPEN: &str = "<context source=\"cetus-quick\">";
    const CLOSE: &str = "</context>";
    if let Some(rest) = msg.strip_prefix(OPEN) {
        if let Some(idx) = rest.find(CLOSE) {
            return rest[idx + CLOSE.len()..].trim_start_matches(['\n', '\r']);
        }
    }
    msg
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    id: String,
    message: String,
    images: Option<Vec<ImageAttachment>>,
) -> CmdResult<()> {
    // Route CLI-agent backends (claude-code / codex) to the headless-CLI runner
    // instead of the long-lived pi RPC. Each turn spawns the vendor CLI in the
    // conversation's workspace (isolated in a git worktree when it's a repo) and
    // streams its events into the same `app-event` channel the pi path uses, so
    // the chat UI renders a claude/codex turn with no frontend changes.
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        crate::cli_backend::dispatch_turn(
            state.handle(),
            &conv,
            &message,
            images.unwrap_or_default(),
        )?;
        let now = now_ms();
        state.store.touch(&id, now).ok();
        // Same title contract as the pi path: paint the mechanical fallback
        // immediately, upgrade to an AI title in the background on first send.
        let was_untitled = conv.title.trim().is_empty();
        let title_src = strip_context_fence(&message);
        let fallback = derive_title(title_src);
        state.store.set_title_if_empty(&id, &fallback, now).ok();
        if was_untitled && !title_src.trim().is_empty() {
            spawn_auto_title(
                state.store.clone(),
                state.handle().clone(),
                id.clone(),
                title_src.to_string(),
                fallback,
            );
        }
        return Ok(());
    }

    let pi = state.pi_for(&id).await.map_err(err)?;
    let image_values: Vec<Value> = images
        .unwrap_or_default()
        .into_iter()
        .map(|img| {
            serde_json::json!({
                "type": img.kind,
                "data": img.data,
                "mimeType": img.mime_type,
            })
        })
        .collect();
    pi.send_prompt(&message, image_values).await.map_err(err)?;
    let now = now_ms();
    state.store.touch(&id, now).ok();

    // Auto-title only on the first prompt of a fresh conversation (title still
    // empty). Paint the mechanical first-line title immediately as a
    // placeholder, then upgrade it to an AI-generated title in the background —
    // ChatGPT-style, the thread gets a real name a beat after the first send.
    let was_untitled = state
        .store
        .get(&id)
        .ok()
        .flatten()
        .map(|c| c.title.trim().is_empty())
        .unwrap_or(false);
    // Title from the user's prose, not the quick-launcher context fence that may
    // lead the message — otherwise the thread would be named "<context …>".
    let title_src = strip_context_fence(&message);
    let fallback = derive_title(title_src);
    state.store.set_title_if_empty(&id, &fallback, now).ok();
    if was_untitled && !title_src.trim().is_empty() {
        spawn_auto_title(
            state.store.clone(),
            state.handle().clone(),
            id.clone(),
            title_src.to_string(),
            fallback,
        );
    }
    Ok(())
}

/// Fetch a single conversation row (read-only). Used by the backend picker to
/// show the conversation's current backend without a full list scan.
#[tauri::command]
pub async fn get_conversation(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<crate::store::Conversation>> {
    state.store.get(&id).map_err(err)
}

/// Switch which coding-agent backend serves a conversation:
/// "pi" (built-in) | "claude-code" | "codex". The next `send_prompt` routes
/// accordingly. Idempotent.
///
/// Swaps the per-runtime resume tokens (see [`crate::store::Store::switch_backend`])
/// and drops an audit marker into the CLI transcript so the switch is visible
/// in history. Refused while a CLI turn is mid-run — the running turn belongs
/// to the old runtime, and rebinding under it would steer the next prompt into
/// the wrong CLI's stdin.
#[tauri::command]
pub async fn set_conversation_backend(
    state: State<'_, AppState>,
    id: String,
    backend: String,
) -> CmdResult<()> {
    if state.cli_turn_active(&id) {
        return Err(
            "A turn is still running — stop it or let it finish before switching runtime."
                .to_string(),
        );
    }
    let now = now_ms();
    let Some(old) = state.store.switch_backend(&id, &backend, now).map_err(err)? else {
        return Ok(()); // missing conversation or same backend — nothing to do
    };
    // An idle vendor process owns background terminals and configuration for
    // the old runtime. Switching runtime is an explicit lifecycle boundary.
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    // Audit marker, but only when there's already a transcript: fresh
    // conversations get their backend set at creation (pending picker choice)
    // and must not open with a stray "Cetus → Codex" divider.
    let has_transcript = !state.store.list_cli_messages(&id).map_err(err)?.is_empty();
    if has_transcript {
        let marker = serde_json::json!({
            "role": "custom",
            "customType": "runtime_switch",
            "content": [{ "type": "text",
                          "text": format!("{} → {}", backend_label(&old), backend_label(&backend)) }],
            "details": { "from": old, "to": backend },
        });
        state.store.append_cli_message(&id, &marker, None, now).ok();
    }
    Ok(())
}

/// Display name for a backend id, matching the frontend's picker labels.
fn backend_label(id: &str) -> &str {
    match id {
        "pi" => "Cetus",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        other => other,
    }
}

/// Set a CLI-backend conversation's model override (`claude --model` /
/// `codex -m`); empty string clears it back to the CLI's own default. Applies
/// from the next turn.
#[tauri::command]
pub async fn set_conversation_cli_model(
    state: State<'_, AppState>,
    id: String,
    model: String,
    effort: String,
) -> CmdResult<()> {
    state
        .store
        .set_cli_model(&id, model.trim(), effort.trim(), now_ms())
        .map_err(err)?;
    // Model/effort are sticky app-server/session configuration; recreate the
    // idle process so the new choice applies on the next turn.
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryResponse {
    /// Text of the rolled-back user message, for the caller to resubmit.
    pub text: String,
    /// The conversation's history AFTER the failed turn was forked away, so the
    /// frontend can re-render a clean state before resending.
    pub messages: Vec<Value>,
}

/// Roll back the last turn for a retry: fork the session at the most recent user
/// message (dropping it and the failed/empty assistant response that poisoned
/// the history), then return that message's text plus the truncated history.
/// The frontend resets its view to `messages` and resubmits `text` — the
/// ChatGPT "regenerate" contract: a failed turn never persists into history.
#[tauri::command]
pub async fn retry_last_turn(state: State<'_, AppState>, id: String) -> CmdResult<RetryResponse> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // CLI backends: drop the last user turn (and everything after it) from the
    // persisted transcript and rewind session_file to the resume token that was
    // in effect before that turn, so the resend replays from the same context.
    if cetus_bridge::cli_agent::CliBackend::from_id(&conv.backend).is_some() {
        state.kill_claude_session(&id);
        state.kill_codex_session(&id);
        let (row_id, message, resume_before) = state
            .store
            .last_cli_user_message(&id)
            .map_err(err)?
            .ok_or_else(|| "nothing to retry: no user message to roll back to".to_string())?;
        let text = crate::cli_backend::message_text(&message);
        state
            .store
            .delete_cli_messages_from(&id, row_id)
            .map_err(err)?;
        state
            .store
            .set_session_file(&id, resume_before.as_deref().unwrap_or(""))
            .map_err(err)?;
        let messages = state.store.list_cli_messages(&id).map_err(err)?;
        return Ok(RetryResponse { text, messages });
    }
    let pi = state.pi_for(&id).await.map_err(err)?;
    let forkable = pi.get_fork_messages().await.map_err(err)?;
    let last = forkable
        .last()
        .ok_or_else(|| "nothing to retry: no user message to roll back to".to_string())?;
    let entry_id = last
        .get("entryId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "fork entry missing id".to_string())?;
    let text = pi.fork(entry_id).await.map_err(err)?;
    let messages = pi.get_messages().await.map_err(err)?;
    Ok(RetryResponse { text, messages })
}

/// Fire-and-forget: ask DeepSeek V4 Pro for a concise title and, if the
/// conversation still carries our placeholder, replace it and notify the
/// frontend. Silent on any failure — the mechanical fallback already stuck.
fn spawn_auto_title(
    store: Arc<crate::store::Store>,
    handle: tauri::AppHandle,
    id: String,
    message: String,
    fallback: String,
) {
    tauri::async_runtime::spawn(async move {
        let api_key = match secrets::get("deepseek") {
            Ok(Some(k)) => k,
            _ => return, // no key → keep the mechanical fallback
        };
        let url = crate::provider::deepseek_chat_url(&store);
        let title = match crate::titling::generate_title(&api_key, &url, &message).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("auto-title failed for {id}: {e}");
                return;
            }
        };
        // Don't clobber a title the user renamed during the request window.
        let still_placeholder = store
            .get(&id)
            .ok()
            .flatten()
            .map(|c| c.title == fallback || c.title.trim().is_empty())
            .unwrap_or(false);
        if !still_placeholder || store.rename(&id, &title, now_ms()).is_err() {
            return;
        }
        if let Ok(Some(conversation)) = store.get(&id) {
            use tauri::Emitter;
            let _ = handle.emit(
                "app-event",
                crate::app_event::AppEvent::ConversationUpdated { conversation },
            );
        }
    });
}

#[tauri::command]
pub async fn abort(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    // A running CLI turn (claude-code / codex) has a kill switch; firing it is
    // a no-op when idle, as is the pi abort below when no pi exists.
    state.abort_cli_turn(&id);
    if let Some(pi) = state.pi_existing(&id).await {
        pi.abort().await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn compact_conversation(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conversation = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    crate::cli_backend::compact_codex_conversation(state.handle(), &conversation).await
}

#[tauri::command]
pub async fn pi_ping(_state: State<'_, AppState>) -> CmdResult<bool> {
    // Backend is up if this command resolves at all. With per-conversation
    // lazy spawn there's nothing to ping globally.
    Ok(true)
}

#[tauri::command]
pub async fn default_workspace(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.default_workspace.to_string_lossy().to_string())
}

/// Open a native folder picker. Returns the chosen path or None if cancelled.
#[tauri::command]
pub async fn pick_workspace_dir(app: tauri::AppHandle) -> CmdResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.and_then(|p| p.into_path().ok()));
    });
    let result = rx.await.map_err(err)?;
    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn list_workspace_files(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
) -> CmdResult<Vec<WorkspaceFileEntry>> {
    const MAX_ENTRIES: usize = 800;
    const MAX_DEPTH: usize = 8;
    let dir = workspace_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_workspace.clone());
    if cetus_bridge::remote::parse_remote_workspace(&dir.to_string_lossy()).is_some() {
        return Ok(Vec::new());
    }
    let entries = collect_workspace_files(&dir, MAX_DEPTH, MAX_ENTRIES)?;
    Ok(entries)
}

#[tauri::command]
pub async fn list_workspace_directory(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    directory_path: Option<String>,
) -> CmdResult<WorkspaceDirectoryListing> {
    const MAX_CHILDREN: usize = 500;
    let workspace = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let requested = directory_path;
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace) {
        return tokio::task::spawn_blocking(move || {
            list_remote_workspace_directory(&remote, requested.as_deref(), MAX_CHILDREN)
        })
        .await
        .map_err(err)?;
    }
    tokio::task::spawn_blocking(move || {
        list_local_workspace_directory(Path::new(&workspace), requested.as_deref(), MAX_CHILDREN)
    })
    .await
    .map_err(err)?
}

fn list_local_workspace_directory(
    workspace: &Path,
    directory_path: Option<&str>,
    max_children: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = workspace.canonicalize().map_err(err)?;
    let requested = directory_path.map(PathBuf::from).unwrap_or_else(|| root.clone());
    let dir = requested.canonicalize().map_err(err)?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err("directory is outside the workspace".to_string());
    }

    let git_records = workspace_git_status(&root, &dir);
    let mut children = std::fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| !should_hide_workspace_entry(&entry.file_name().to_string_lossy()))
        .collect::<Vec<_>>();
    children.sort_by(|a, b| {
        let a_dir = a.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        let b_dir = b.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });
    let truncated = children.len() > max_children;
    children.truncate(max_children);

    let mut entries = children
        .into_iter()
        .map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let link_meta = std::fs::symlink_metadata(&path).ok();
            let meta = entry.metadata().ok();
            let is_symlink = link_meta
                .as_ref()
                .map(|value| value.file_type().is_symlink())
                .unwrap_or(false);
            let is_dir = meta.as_ref().map(|value| value.is_dir()).unwrap_or(false);
            let git_status = git_status_for_path(&path, &git_records);
            let is_ignored = git_status.as_deref() == Some("ignored");
            WorkspaceFileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                relative_path: path
                    .strip_prefix(&root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string(),
                is_dir,
                is_ignored,
                git_status,
                is_symlink,
                symlink_target: is_symlink.then(|| std::fs::read_link(&path).ok()).flatten().map(
                    |target| target.to_string_lossy().to_string(),
                ),
                size_bytes: meta.as_ref().filter(|value| value.is_file()).map(|value| value.len()),
                modified_ms: meta
                    .as_ref()
                    .and_then(|value| value.modified().ok())
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64),
            }
        })
        .collect::<Vec<_>>();
    for (path, status) in &git_records {
        if status != "deleted" || path.parent() != Some(dir.as_path()) {
            continue;
        }
        if entries.iter().any(|entry| Path::new(&entry.path) == path) {
            continue;
        }
        entries.push(WorkspaceFileEntry {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            relative_path: path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string(),
            is_dir: false,
            is_ignored: false,
            git_status: Some("deleted".to_string()),
            is_symlink: false,
            symlink_target: None,
            size_bytes: None,
            modified_ms: None,
        });
    }
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: false,
    })
}

fn workspace_git_status(root: &Path, scope: &Path) -> Vec<(PathBuf, String)> {
    let repo = std::process::Command::new("git")
        .args(["-C", &root.to_string_lossy(), "rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| PathBuf::from(value.trim()))
        .and_then(|path| path.canonicalize().ok());
    let Some(repo) = repo else { return Vec::new() };
    let scope_relative = scope.strip_prefix(&repo).unwrap_or(scope);
    let scope_arg = if scope_relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        scope_relative
    };
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=matching",
            "--untracked-files=all",
            "--",
        ])
        .arg(scope_arg)
        .output();
    let Ok(output) = output else { return Vec::new() };
    if !output.status.success() {
        return Vec::new();
    }

    let chunks = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut records = Vec::new();
    let mut index = 0;
    while index < chunks.len() {
        let chunk = chunks[index];
        if chunk.len() < 4 {
            index += 1;
            continue;
        }
        let xy = &chunk[..2];
        let path = String::from_utf8_lossy(&chunk[3..]).to_string();
        records.push((repo.join(path), porcelain_status(xy).to_string()));
        if matches!(xy.first(), Some(b'R' | b'C')) {
            index += 1;
        }
        index += 1;
    }
    records
}

fn porcelain_status(xy: &[u8]) -> &'static str {
    if xy == b"!!" {
        "ignored"
    } else if xy == b"??" {
        "untracked"
    } else if xy.contains(&b'U') || xy == b"AA" || xy == b"DD" {
        "conflict"
    } else if xy.contains(&b'D') {
        "deleted"
    } else if xy.contains(&b'R') {
        "renamed"
    } else if xy.contains(&b'A') {
        "added"
    } else {
        "modified"
    }
}

fn git_status_for_path(path: &Path, records: &[(PathBuf, String)]) -> Option<String> {
    records
        .iter()
        .filter(|(record, _)| record == path || record.starts_with(path))
        .map(|(_, status)| status.clone())
        .min_by_key(|status| match status.as_str() {
            "conflict" => 0,
            "deleted" => 1,
            "modified" => 2,
            "renamed" => 3,
            "added" => 4,
            "untracked" => 5,
            "ignored" => 6,
            _ => 7,
        })
}

fn list_remote_workspace_directory(
    remote: &cetus_bridge::remote::RemoteWorkspace,
    directory_path: Option<&str>,
    max_children: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = normalize_remote_path(&remote.path)?;
    let dir = normalize_remote_path(directory_path.unwrap_or(&root))?;
    if dir != root && !dir.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
        return Err("directory is outside the remote workspace".to_string());
    }
    let script = format!(
        "root={root}; dir={dir}; for p in \"$dir\"/* \"$dir\"/.[!.]* \"$dir\"/..?*; do \
         [ -e \"$p\" ] || [ -L \"$p\" ] || continue; name=${{p##*/}}; \
         [ \"$name\" = .git ] && continue; \
         kind=f; [ -d \"$p\" ] && kind=d; link=0; target=; \
         if [ -L \"$p\" ]; then link=1; target=$(readlink \"$p\" 2>/dev/null || true); fi; \
         ignored=0; git -C \"$root\" check-ignore -q -- \"$p\" 2>/dev/null && ignored=1; \
         size=0; [ \"$kind\" = f ] && size=$(wc -c < \"$p\" 2>/dev/null | tr -d ' ' || printf 0); \
         mtime=$(stat -c %Y \"$p\" 2>/dev/null || stat -f %m \"$p\" 2>/dev/null || printf 0); \
         printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' \"$kind\" \"$ignored\" \"$link\" \"$target\" \"$size\" \"$mtime\" \"$name\"; done",
        root = cetus_bridge::remote::shell_word(&root),
        dir = cetus_bridge::remote::shell_word(&dir),
    );
    let output = std::process::Command::new("ssh")
        .args(cetus_bridge::remote::remote_command_args(remote, &script))
        .output()
        .map_err(err)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut entries = Vec::new();
    for record in fields.chunks(7) {
        if record.len() < 7 || record[6].is_empty() {
            continue;
        }
        let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).to_string();
        let name = text(record[6]);
        let path = cetus_bridge::remote::join_remote(&dir, &name);
        let is_ignored = record[1] == b"1";
        entries.push(WorkspaceFileEntry {
            name,
            relative_path: path
                .strip_prefix(root.trim_end_matches('/'))
                .unwrap_or(&path)
                .trim_start_matches('/')
                .to_string(),
            path,
            is_dir: record[0] == b"d",
            is_ignored,
            git_status: is_ignored.then(|| "ignored".to_string()),
            is_symlink: record[2] == b"1",
            symlink_target: (!record[3].is_empty()).then(|| text(record[3])),
            size_bytes: text(record[4]).trim().parse().ok(),
            modified_ms: text(record[5]).trim().parse::<u64>().ok().map(|value| value * 1000),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let truncated = entries.len() > max_children;
    entries.truncate(max_children);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: true,
    })
}

fn normalize_remote_path(raw: &str) -> CmdResult<String> {
    if !raw.starts_with('/') {
        return Err("remote workspace path must be absolute".to_string());
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

#[tauri::command]
pub async fn search_workspace_files(
    state: State<'_, AppState>,
    workspace_dir: Option<String>,
    query: String,
) -> CmdResult<WorkspaceDirectoryListing> {
    const MAX_RESULTS: usize = 100;
    let workspace = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| state.default_workspace.to_string_lossy().to_string());
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(WorkspaceDirectoryListing {
            entries: Vec::new(),
            truncated: false,
            is_remote: cetus_bridge::remote::parse_remote_workspace(&workspace).is_some(),
        });
    }
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace) {
        return tokio::task::spawn_blocking(move || {
            search_remote_workspace_files(&remote, &query, MAX_RESULTS)
        })
        .await
        .map_err(err)?;
    }
    tokio::task::spawn_blocking(move || search_local_workspace_files(&workspace, &query, MAX_RESULTS))
        .await
        .map_err(err)?
}

fn search_local_workspace_files(
    workspace: &str,
    query: &str,
    max_results: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = PathBuf::from(workspace).canonicalize().map_err(err)?;
    let git_records = workspace_git_status(&root, &root);
    let mut entries = Vec::new();
    for result in ignore::WalkBuilder::new(&root).hidden(false).follow_links(false).build() {
        let Ok(entry) = result else { continue };
        if entry.path() == root || entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let relative_path = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if !relative_path.to_lowercase().contains(&query) {
            continue;
        }
        let meta = entry.metadata().ok();
        let is_symlink = entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false);
        entries.push(WorkspaceFileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            relative_path,
            is_dir: false,
            is_ignored: false,
            git_status: git_status_for_path(entry.path(), &git_records),
            is_symlink,
            symlink_target: is_symlink
                .then(|| std::fs::read_link(entry.path()).ok())
                .flatten()
                .map(|target| target.to_string_lossy().to_string()),
            size_bytes: meta.as_ref().map(|value| value.len()),
            modified_ms: meta
                .as_ref()
                .and_then(|value| value.modified().ok())
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64),
        });
        if entries.len() > max_results {
            break;
        }
    }
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .find(query)
            .unwrap_or(usize::MAX)
            .cmp(&b.name.to_lowercase().find(query).unwrap_or(usize::MAX))
            .then_with(|| a.relative_path.len().cmp(&b.relative_path.len()))
    });
    let truncated = entries.len() > max_results;
    entries.truncate(max_results);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: false,
    })
}

fn search_remote_workspace_files(
    remote: &cetus_bridge::remote::RemoteWorkspace,
    query: &str,
    max_results: usize,
) -> CmdResult<WorkspaceDirectoryListing> {
    let root = normalize_remote_path(&remote.path)?;
    let pattern = format!("*{query}*");
    let script = format!(
        "find {root} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -iname {pattern} -print | head -n {limit}",
        root = cetus_bridge::remote::shell_word(&root),
        pattern = cetus_bridge::remote::shell_word(&pattern),
        limit = max_results + 1,
    );
    let output = std::process::Command::new("ssh")
        .args(cetus_bridge::remote::remote_command_args(remote, &script))
        .output()
        .map_err(err)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|path| !path.is_empty())
        .map(|path| WorkspaceFileEntry {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            relative_path: path
                .strip_prefix(root.trim_end_matches('/'))
                .unwrap_or(path)
                .trim_start_matches('/')
                .to_string(),
            is_dir: false,
            is_ignored: false,
            git_status: None,
            is_symlink: false,
            symlink_target: None,
            size_bytes: None,
            modified_ms: None,
        })
        .collect::<Vec<_>>();
    let truncated = entries.len() > max_results;
    entries.truncate(max_results);
    Ok(WorkspaceDirectoryListing {
        entries,
        truncated,
        is_remote: true,
    })
}

fn checked_local_workspace_entry(workspace_dir: &str, path: &str) -> CmdResult<(PathBuf, PathBuf)> {
    let root = PathBuf::from(workspace_dir).canonicalize().map_err(err)?;
    let target = PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "workspace entry has no parent".to_string())?
        .canonicalize()
        .map_err(err)?;
    if !parent.starts_with(&root) || target == root {
        return Err("path is outside the workspace".to_string());
    }
    Ok((root, target))
}

#[tauri::command]
pub async fn create_workspace_entry(
    workspace_dir: String,
    parent_path: String,
    name: String,
    is_dir: bool,
) -> CmdResult<String> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("creating remote files from Files is not supported yet".to_string());
    }
    let root = PathBuf::from(&workspace_dir).canonicalize().map_err(err)?;
    let parent = PathBuf::from(&parent_path).canonicalize().map_err(err)?;
    if !parent.starts_with(&root) || !parent.is_dir() {
        return Err("parent is outside the workspace".to_string());
    }
    let safe_name = sanitize_segment(&name);
    if safe_name.is_empty() || safe_name != name {
        return Err("invalid file name".to_string());
    }
    let target = parent.join(safe_name);
    if is_dir {
        std::fs::create_dir(&target).map_err(err)?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(err)?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn rename_workspace_entry(
    workspace_dir: String,
    path: String,
    new_name: String,
) -> CmdResult<String> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("renaming remote files from Files is not supported yet".to_string());
    }
    let (_, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    let safe_name = sanitize_segment(&new_name);
    if safe_name.is_empty() || safe_name != new_name {
        return Err("invalid file name".to_string());
    }
    let renamed = target.parent().unwrap().join(safe_name);
    std::fs::rename(&target, &renamed).map_err(err)?;
    Ok(renamed.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn trash_workspace_entry(workspace_dir: String, path: String) -> CmdResult<()> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_some() {
        return Err("trashing remote files from Files is not supported yet".to_string());
    }
    let (_, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
            "-e",
            "end run",
            "--",
        ])
        .arg(&target)
        .status()
        .map_err(err)?;
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin')",
            "--",
        ])
        .arg(&target)
        .status()
        .map_err(err)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("gio")
        .arg("trash")
        .arg(&target)
        .status()
        .map_err(err)?;
    if status.success() {
        Ok(())
    } else {
        Err("the operating system could not move the entry to Trash".to_string())
    }
}

fn collect_workspace_files(
    root: &Path,
    max_depth: usize,
    max_entries: usize,
) -> CmdResult<Vec<WorkspaceFileEntry>> {
    // Build the set Git considers visible, then enumerate the workspace
    // breadth-first. Ignored entries remain in the result (the UI dims them),
    // but ignored directories are not eagerly crawled so caches cannot consume
    // the entire bounded result before normal project files are reached.
    let visible_paths = ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(max_depth + 1))
        .build()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .collect::<std::collections::HashSet<_>>();

    let mut entries = Vec::new();
    let mut pending = std::collections::VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = pending.pop_front() {
        let mut children = std::fs::read_dir(&dir)
            .map_err(err)?
            .filter_map(Result::ok)
            .filter(|entry| !should_hide_workspace_entry(&entry.file_name().to_string_lossy()))
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for entry in children {
            if entries.len() >= max_entries {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata().ok();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let is_ignored = !visible_paths.contains(&path);
            let size_bytes = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len());
            let modified_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64);
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            entries.push(WorkspaceFileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                relative_path,
                is_dir,
                is_ignored,
                git_status: None,
                is_symlink: entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false),
                symlink_target: std::fs::read_link(&path)
                    .ok()
                    .map(|target| target.to_string_lossy().to_string()),
                size_bytes,
                modified_ms,
            });
            if is_dir && !is_ignored && depth < max_depth {
                pending.push_back((path, depth + 1));
            }
        }
        if entries.len() >= max_entries {
            break;
        }
    }

    // A depth-first cap lets one alphabetically early cache consume the whole
    // result. Keep shallow entries first so the root and main project folders
    // remain visible even when a large workspace exceeds the cap.
    entries.sort_by(|a, b| {
        workspace_entry_depth(&a.relative_path)
            .cmp(&workspace_entry_depth(&b.relative_path))
            .then_with(|| b.is_dir.cmp(&a.is_dir))
            .then_with(|| {
                a.relative_path
                    .to_lowercase()
                    .cmp(&b.relative_path.to_lowercase())
            })
    });
    entries.truncate(max_entries);
    Ok(entries)
}

fn workspace_entry_depth(path: &str) -> usize {
    path.split(['/', '\\']).count()
}

fn should_hide_workspace_entry(name: &str) -> bool {
    name == ".git"
}

#[tauri::command]
pub async fn set_workspace(
    state: State<'_, AppState>,
    id: String,
    workspace_dir: String,
) -> CmdResult<Conversation> {
    if cetus_bridge::remote::parse_remote_workspace(&workspace_dir).is_none() {
        std::fs::create_dir_all(&workspace_dir).map_err(err)?;
    }
    state
        .store
        .set_workspace(&id, &workspace_dir, now_ms())
        .map_err(err)?;
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    // The pi process pinned to this conv was spawned with the *old* cwd.
    // Drop it; next interaction lazy-spawns with the new cwd.
    state.kill_pi(&id).await;
    state.kill_claude_session(&id);
    state.kill_codex_session(&id);
    Ok(conv)
}

#[tauri::command]
pub async fn set_model_choice(
    state: State<'_, AppState>,
    id: String,
    choice: ModelChoice,
) -> CmdResult<Conversation> {
    state.store.set_model(&id, choice, now_ms()).map_err(err)?;
    // If pi is already running for this conv, push the new choice through
    // immediately. If it's cold, the next pi_for() will pick it up from the
    // freshly persisted row.
    if let Some(pi) = state.pi_existing(&id).await {
        crate::model_bridge::apply_choice(&pi, choice)
            .await
            .map_err(err)?;
    }
    state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())
}

#[tauri::command]
pub async fn get_model_choice(state: State<'_, AppState>, id: String) -> CmdResult<ModelChoice> {
    let conv = state
        .store
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "conversation not found".to_string())?;
    Ok(conv.model)
}

#[tauri::command]
pub async fn extension_ui_respond(
    state: State<'_, AppState>,
    conversation_id: String,
    id: String,
    payload: Value,
) -> CmdResult<()> {
    let mut obj = match payload {
        Value::Object(m) => m,
        _ => return Err("payload must be a JSON object".into()),
    };
    obj.insert(
        "type".to_string(),
        Value::String("extension_ui_response".to_string()),
    );
    obj.insert("id".to_string(), Value::String(id));
    let pi = state
        .pi_existing(&conversation_id)
        .await
        .ok_or_else(|| format!("no pi running for conversation {conversation_id}"))?;
    pi.notify(Value::Object(obj)).await.map_err(err)
}

#[tauri::command]
pub async fn list_api_keys() -> CmdResult<Vec<String>> {
    Ok(secrets::KNOWN_PROVIDERS
        .iter()
        .filter(|(prov, _)| secrets::has(prov))
        .map(|(prov, _)| (*prov).to_string())
        .collect())
}

#[tauri::command]
pub async fn list_api_keys_masked() -> CmdResult<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for (prov, _) in secrets::KNOWN_PROVIDERS {
        if let Ok(Some(raw)) = secrets::get(prov) {
            out.insert((*prov).to_string(), secrets::mask(&raw));
        }
    }
    Ok(out)
}

/// Return the full, unmasked key for a provider so the user can copy it back
/// out. These are the user's own keys on their own machine; the masked preview
/// (list_api_keys_masked) is still the default the UI shows.
#[tauri::command]
pub async fn reveal_api_key(provider: String) -> CmdResult<Option<String>> {
    secrets::get(&provider).map_err(err)
}

#[tauri::command]
pub async fn set_api_key(
    state: State<'_, AppState>,
    provider: String,
    key: String,
) -> CmdResult<()> {
    if !secrets::KNOWN_PROVIDERS.iter().any(|(p, _)| *p == provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    if key.is_empty() {
        secrets::delete(&provider).map_err(err)?;
    } else {
        secrets::set(&provider, &key).map_err(err)?;
    }
    // Kill every pi so the next interaction respawns with the new env.
    state.kill_all().await;
    state.kill_all_cli_sessions();
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    secrets::delete(&provider).map_err(err)?;
    state.kill_all().await;
    state.kill_all_cli_sessions();
    Ok(())
}

/// Persist a composer attachment (any non-image file) to disk so the agent can
/// read it via the `read_document` extension tool. Images keep riding the
/// `send_prompt` images channel; this is for everything else.
///
/// Files land in `<app_data>/attachments/<conv id>/<uuid>-<name>` — outside the
/// workspace so we never pollute the user's project tree. Returns the absolute
/// path, which the frontend embeds in the prompt for the model to read.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    id: String,
    name: String,
    data: String,
) -> CmdResult<String> {
    use base64::Engine;
    use tauri::Manager;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64 attachment: {e}"))?;

    let conv = sanitize_segment(&id);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("attachments")
        .join(conv);
    std::fs::create_dir_all(&dir).map_err(err)?;

    // Keep the original basename for readability; prefix a short unique id so
    // re-sending the same filename never overwrites an earlier attachment.
    let base = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_segment)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let prefix = Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("{}-{base}", &prefix[..8]));

    std::fs::write(&dest, &bytes).map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Absolute paths of any file URLs currently on the general pasteboard. When the
/// user copies a file in Finder, its real path lands here — the composer uses it
/// to reference a too-large paste by path instead of inlining its bytes. Returns
/// an empty list on non-file clipboards (raw image/text) and off macOS.
#[tauri::command]
pub async fn read_clipboard_file_paths() -> CmdResult<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::text_input::clipboard_file_paths())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

/// Strip path separators and control chars so a filename can't escape its dir.
fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file too large for inline preview ({} bytes, max {} bytes)",
            meta.len(),
            MAX_BYTES
        ));
    }
    std::fs::read_to_string(&path).map_err(err)
}

#[tauri::command]
pub async fn read_workspace_text_file(
    workspace_dir: String,
    path: String,
) -> CmdResult<WorkspaceTextPreview> {
    const MAX_BYTES: u64 = 1024 * 1024;
    if let Some(remote) = cetus_bridge::remote::parse_remote_workspace(&workspace_dir) {
        let root = normalize_remote_path(&remote.path)?;
        let target = normalize_remote_path(&path)?;
        if target != root && !target.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
            return Err("file is outside the remote workspace".to_string());
        }
        let script = format!(
            "size=$(wc -c < {path} 2>/dev/null) || exit 2; printf '%s\\0' \"$size\"; head -c {max} {path}",
            path = cetus_bridge::remote::shell_word(&target),
            max = MAX_BYTES,
        );
        let output = std::process::Command::new("ssh")
            .args(cetus_bridge::remote::remote_command_args(&remote, &script))
            .output()
            .map_err(err)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let split = output.stdout.iter().position(|byte| *byte == 0).unwrap_or(0);
        let total_bytes = String::from_utf8_lossy(&output.stdout[..split])
            .trim()
            .parse::<u64>()
            .map_err(err)?;
        let bytes = output.stdout.get(split + 1..).unwrap_or_default();
        return Ok(WorkspaceTextPreview {
            text: String::from_utf8_lossy(bytes).to_string(),
            truncated: total_bytes > MAX_BYTES,
            total_bytes,
        });
    }
    let (root, target) = checked_local_workspace_entry(&workspace_dir, &path)?;
    let readable = target.canonicalize().map_err(err)?;
    if !readable.starts_with(&root) {
        return Err("file symlink points outside the workspace".to_string());
    }
    let meta = std::fs::metadata(&readable).map_err(err)?;
    let mut file = std::fs::File::open(readable).map_err(err)?;
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_BYTES) as usize);
    std::io::Read::take(&mut file, MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    Ok(WorkspaceTextPreview {
        text: String::from_utf8_lossy(&bytes).to_string(),
        truncated: meta.len() > MAX_BYTES,
        total_bytes: meta.len(),
    })
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .ok_or_else(|| "no parent dir".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

/// Open a web link in the user's default browser.
///
/// Chat links are rendered inside the WKWebView, and a bare `<a>` click lets
/// the webview resolve the navigation itself. macOS then honours Universal
/// Links, so domains an installed app has claimed (e.g. Lark/Feishu's
/// `*.larksuite.com` / `*.feishu.cn` docs) open that app instead of the page.
/// Routing the click through a separate `open` process resolves the http(s)
/// scheme to the default browser, so the page actually opens in a browser.
#[tauri::command]
pub async fn open_external(url: String) -> CmdResult<()> {
    // Only hand off web/mail links — never arbitrary schemes from model output
    // (e.g. `file://`, custom app schemes) which could launch unexpected apps.
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err(format!("refusing to open non-web url: {url}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

fn supported_browser_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "about" | "file")
}

/// Open a URL in a Cetus-owned browser webview window. This is the Browser
/// surface's escape hatch for sites that refuse iframe embedding; it behaves
/// like a real top-level browser page instead of a nested frame.
#[tauri::command]
pub async fn open_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<()> {
    open_browser_window_with_app_data_dir(&app, &state.app_data_dir, &url).await
}

pub(crate) async fn open_browser_window_with_app_data_dir(
    app: &AppHandle,
    app_data_dir: &Path,
    url: &str,
) -> CmdResult<()> {
    let parsed = Url::parse(&url).map_err(err)?;
    if !supported_browser_scheme(parsed.scheme()) {
        return Err(format!(
            "refusing to open unsupported browser url scheme: {}",
            parsed.scheme()
        ));
    }
    if let Some(win) = app.get_webview_window("browser") {
        win.navigate(parsed).map_err(err)?;
        win.show().map_err(err)?;
        return Ok(());
    }
    let data_dir = app_data_dir.join("browser-webview");
    std::fs::create_dir_all(&data_dir).map_err(err)?;
    let app_for_annotation = app.clone();
    let annotation_token = format!(
        "{}{}__",
        BROWSER_ANNOTATION_TITLE_PREFIX,
        Uuid::new_v4().simple()
    );
    let annotation_script =
        browser_annotation_script(&annotation_token, &BrowserAnnotationLabels::default(), true);
    match WebviewWindowBuilder::new(app, "browser", WebviewUrl::External(parsed.clone()))
        .title("Cetus Browser")
        .inner_size(1200.0, 820.0)
        .resizable(true)
        .data_directory(data_dir)
        .initialization_script(annotation_script)
        .on_document_title_changed(move |win, title| {
            let Some(raw) = title.strip_prefix(&annotation_token) else {
                return;
            };
            match serde_json::from_str::<BrowserAnnotationPayload>(raw) {
                Ok(payload) => {
                    let _ = app_for_annotation.emit_to("main", "browser-annotation", payload);
                    let _ = win.set_title("Cetus Browser");
                }
                Err(e) => {
                    tracing::warn!("browser annotation payload parse failed: {e}");
                }
            }
        })
        .build()
    {
        Ok(_) => {}
        Err(e) => {
            if let Some(win) = app.get_webview_window("browser") {
                win.navigate(parsed).map_err(err)?;
                win.show().map_err(err)?;
            } else {
                return Err(err(e));
            }
        }
    }
    Ok(())
}

fn browser_panel_rect(bounds: &BrowserPanelBounds) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0))),
        size: Size::Logical(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        )),
    }
}

#[tauri::command]
pub async fn open_browser_panel(
    app: AppHandle,
    url: String,
    bounds: BrowserPanelBounds,
    labels: Option<BrowserAnnotationLabels>,
) -> CmdResult<()> {
    let parsed = Url::parse(&url).map_err(err)?;
    if !supported_browser_scheme(parsed.scheme()) {
        return Err(format!(
            "refusing to open unsupported browser url scheme: {}",
            parsed.scheme()
        ));
    }
    if bounds.width < 2.0 || bounds.height < 2.0 {
        return Ok(());
    }
    let rect = browser_panel_rect(&bounds);
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview.set_bounds(rect).map_err(err)?;
        webview.navigate(parsed).map_err(err)?;
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let app_for_annotation = app.clone();
    let annotation_token = format!(
        "{}{}__",
        BROWSER_ANNOTATION_TITLE_PREFIX,
        Uuid::new_v4().simple()
    );
    let annotation_script =
        browser_annotation_script(&annotation_token, &labels.unwrap_or_default(), false);
    let builder = WebviewBuilder::new(BROWSER_PANEL_LABEL, WebviewUrl::External(parsed.clone()))
        .initialization_script(annotation_script)
        .on_document_title_changed(move |_webview, title| {
            let Some(raw) = title.strip_prefix(&annotation_token) else {
                return;
            };
            match serde_json::from_str::<BrowserAnnotationPayload>(raw) {
                Ok(payload) => {
                    let _ = app_for_annotation.emit_to("main", "browser-annotation", payload);
                }
                Err(e) => {
                    tracing::warn!("browser panel annotation payload parse failed: {e}");
                }
            }
        });
    match window.add_child(
        builder,
        LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
        LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    ) {
        Ok(_) => {}
        Err(e) => {
            if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
                webview.set_bounds(rect).map_err(err)?;
                webview.navigate(parsed).map_err(err)?;
            } else {
                return Err(err(e));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_browser_panel_bounds(app: AppHandle, bounds: BrowserPanelBounds) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview
            .set_bounds(browser_panel_rect(&bounds))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_browser_panel_annotation_mode(app: AppHandle, enabled: bool) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        let enabled_js = if enabled { "true" } else { "false" };
        webview
            .eval(&format!(
                "window.dispatchEvent(new CustomEvent('cetus-browser-annotation-mode', {{ detail: {{ enabled: {enabled_js} }} }}));"
            ))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_browser_panel(app: AppHandle) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview.close().map_err(err)?;
    }
    Ok(())
}

/// Open a local file with the OS default application (e.g. an HTML artifact in
/// the default browser, a PDF in Preview). Unlike `open_external` this takes a
/// filesystem path rather than a URL, so it powers the artifact dialog's "Open"
/// action across every file type.
#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn log_fe(level: String, msg: String) -> CmdResult<()> {
    match level.as_str() {
        "error" => tracing::error!(target: "fe", "{msg}"),
        "warn" => tracing::warn!(target: "fe", "{msg}"),
        "info" => tracing::info!(target: "fe", "{msg}"),
        _ => tracing::debug!(target: "fe", "{msg}"),
    }
    Ok(())
}

pub(crate) fn derive_title(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or("").trim();
    let title: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        format!("{title}…")
    } else {
        title
    }
}

// ---- automations ----------------------------------------------------------
//
// Thin wrappers over `automation_api` — the same impls back the external
// control socket (`control.rs`), so validation, next-run derivation, and UI
// refresh events stay identical no matter who mutates an automation.

use crate::automation::{Automation, AutomationInput};

#[tauri::command]
pub async fn list_automations(state: State<'_, AppState>) -> CmdResult<Vec<Automation>> {
    crate::automation_api::list(&state)
}

#[tauri::command]
pub async fn create_automation(app: AppHandle, input: AutomationInput) -> CmdResult<Automation> {
    crate::automation_api::create(&app, input)
}

#[tauri::command]
pub async fn update_automation(
    app: AppHandle,
    id: String,
    input: AutomationInput,
) -> CmdResult<Automation> {
    crate::automation_api::update(&app, &id, input)
}

#[tauri::command]
pub async fn delete_automation(app: AppHandle, id: String) -> CmdResult<()> {
    crate::automation_api::delete(&app, &id)
}

#[tauri::command]
pub async fn set_automation_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> CmdResult<Automation> {
    crate::automation_api::set_enabled(&app, &id, enabled)
}

#[tauri::command]
pub async fn run_automation_now(state: State<'_, AppState>, id: String) -> CmdResult<Conversation> {
    let ctx = state.scheduler_ctx();
    crate::scheduler::run_now(&ctx, &id).await
}

// ---- screen-context collection (Rewind-like) ------------------------------

#[tauri::command]
pub async fn get_capture_settings(
    state: State<'_, AppState>,
) -> CmdResult<crate::capture::CaptureSettings> {
    Ok(crate::capture::load_settings(&state.store))
}

#[tauri::command]
pub async fn set_capture_settings(
    state: State<'_, AppState>,
    settings: crate::capture::CaptureSettings,
) -> CmdResult<()> {
    crate::capture::save_settings(&state.store, &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub enabled: bool,
    pub count: i64,
}

#[tauri::command]
pub async fn capture_stats(state: State<'_, AppState>) -> CmdResult<CaptureStats> {
    let enabled = crate::capture::load_settings(&state.store).enabled;
    let count = state.store.screenshots_count().map_err(err)?;
    Ok(CaptureStats { enabled, count })
}

#[tauri::command]
pub async fn recent_screenshots(
    state: State<'_, AppState>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .recent_screenshots(limit.unwrap_or(50), before_ts)
        .map_err(err)
}

#[tauri::command]
pub async fn search_screenshots(
    state: State<'_, AppState>,
    query: String,
    since_ts: Option<i64>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::Screenshot>> {
    state
        .store
        .search_screenshots(
            &query,
            since_ts.unwrap_or(0),
            limit.unwrap_or(50),
            before_ts,
        )
        .map_err(err)
}

// ---- ambient text context (Littlebird-like AX collector) -------------------

#[tauri::command]
pub async fn get_ambient_settings(
    state: State<'_, AppState>,
) -> CmdResult<crate::ambient::AmbientSettings> {
    Ok(crate::ambient::load_settings(&state.store))
}

#[tauri::command]
pub async fn set_ambient_settings(
    state: State<'_, AppState>,
    settings: crate::ambient::AmbientSettings,
) -> CmdResult<()> {
    crate::ambient::save_settings(&state.store, &settings).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientStats {
    pub enabled: bool,
    pub count: i64,
}

#[tauri::command]
pub async fn ambient_stats(state: State<'_, AppState>) -> CmdResult<AmbientStats> {
    let enabled = crate::ambient::load_settings(&state.store).enabled;
    let count = state.store.ax_context_count().map_err(err)?;
    Ok(AmbientStats { enabled, count })
}

#[tauri::command]
pub async fn recent_ambient_context(
    state: State<'_, AppState>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::AxContextEntry>> {
    state
        .store
        .recent_ax_context(limit.unwrap_or(50), before_ts)
        .map_err(err)
}

#[tauri::command]
pub async fn search_ambient_context(
    state: State<'_, AppState>,
    query: String,
    since_ts: Option<i64>,
    limit: Option<u32>,
    before_ts: Option<i64>,
) -> CmdResult<Vec<crate::store::AxContextEntry>> {
    state
        .store
        .search_ax_context(
            &query,
            since_ts.unwrap_or(0),
            limit.unwrap_or(50),
            before_ts,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn clear_ambient_history(state: State<'_, AppState>) -> CmdResult<()> {
    state.store.clear_ax_context().map_err(err)
}

/// The compressed recent-activity block the composer injects (inner text of the
/// `<context source="cetus-ambient">` fence). Null when the collector is off or
/// the rolling window is empty — the composer simply sends the bare prompt.
#[tauri::command]
pub async fn ambient_recent_summary(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    Ok(crate::ambient::recent_summary(&state.store))
}

/// Sync the native window appearance to the app's color theme. On macOS/Linux
/// this is app-wide, so it fixes the frosted vibrancy behind the launcher's
/// HUD glass when the user locks a theme that differs from the OS. `None`
/// (the "system" preference)
/// lets the OS drive it, which also keeps each webview's `prefers-color-scheme`
/// tracking the system for live updates. Best-effort — a missing window or an
/// unsupported platform is a no-op.
#[tauri::command]
pub async fn set_theme_appearance(app: tauri::AppHandle, preference: String) -> CmdResult<()> {
    use tauri::Manager;
    let theme = match preference.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    // App-wide on macOS, so one window is enough; fall back if main is gone.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
    } else if let Some(w) = app.get_webview_window("quick") {
        let _ = w.set_theme(theme);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(root: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[test]
    fn workspace_directory_reports_git_states_symlinks_and_deleted_files() {
        let root = std::env::temp_dir().join(format!("cetus-listing-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("cache")).unwrap();
        std::fs::write(root.join(".gitignore"), "cache/\n").unwrap();
        std::fs::write(root.join("tracked.txt"), "initial").unwrap();
        std::fs::write(root.join("deleted.txt"), "delete me").unwrap();
        run_git(&root, &["init", "-q"]);
        run_git(&root, &["add", "."]);
        run_git(
            &root,
            &[
                "-c",
                "user.name=Cetus Test",
                "-c",
                "user.email=cetus@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
        );
        std::fs::write(root.join("tracked.txt"), "changed").unwrap();
        std::fs::write(root.join("untracked.txt"), "new").unwrap();
        std::fs::remove_file(root.join("deleted.txt")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("tracked.txt", root.join("linked.txt")).unwrap();

        let listing = list_local_workspace_directory(&root, None, 100).unwrap();
        let entry = |name: &str| listing.entries.iter().find(|entry| entry.name == name).unwrap();
        assert_eq!(entry("cache").git_status.as_deref(), Some("ignored"));
        assert_eq!(entry("tracked.txt").git_status.as_deref(), Some("modified"));
        assert_eq!(entry("untracked.txt").git_status.as_deref(), Some("untracked"));
        assert_eq!(entry("deleted.txt").git_status.as_deref(), Some("deleted"));
        #[cfg(unix)]
        assert!(entry("linked.txt").is_symlink);
        assert!(!listing.truncated);

        let limited = list_local_workspace_directory(&root, None, 2).unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.entries.len(), 3, "deleted Git entries remain visible");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_paths_are_normalized_before_boundary_checks() {
        assert_eq!(normalize_remote_path("/srv/repo/./src/../README.md").unwrap(), "/srv/repo/README.md");
        assert!(normalize_remote_path("relative/path").is_err());
    }

    #[test]
    fn porcelain_codes_map_to_file_decorations() {
        assert_eq!(porcelain_status(b"!!"), "ignored");
        assert_eq!(porcelain_status(b"??"), "untracked");
        assert_eq!(porcelain_status(b"UU"), "conflict");
        assert_eq!(porcelain_status(b" D"), "deleted");
        assert_eq!(porcelain_status(b"R "), "renamed");
        assert_eq!(porcelain_status(b"A "), "added");
        assert_eq!(porcelain_status(b" M"), "modified");
    }

    #[tokio::test]
    async fn workspace_text_preview_is_bounded_and_rejects_escaping_symlinks() {
        let root = std::env::temp_dir().join(format!("cetus-preview-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let large = root.join("large.txt");
        std::fs::write(&large, vec![b'x'; 1024 * 1024 + 128]).unwrap();

        let preview = read_workspace_text_file(
            root.to_string_lossy().to_string(),
            large.to_string_lossy().to_string(),
        )
        .await
        .unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.text.len(), 1024 * 1024);
        assert_eq!(preview.total_bytes, 1024 * 1024 + 128);

        #[cfg(unix)]
        {
            let outside = root.parent().unwrap().join(format!("outside-{}.txt", Uuid::new_v4()));
            std::fs::write(&outside, "secret").unwrap();
            let link = root.join("outside.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let result = read_workspace_text_file(
                root.to_string_lossy().to_string(),
                link.to_string_lossy().to_string(),
            )
            .await;
            assert!(result.unwrap_err().contains("outside the workspace"));
            std::fs::remove_file(outside).unwrap();
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn workspace_create_and_rename_stay_inside_parent() {
        let root = std::env::temp_dir().join(format!("cetus-actions-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let created = create_workspace_entry(
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "note.md".to_string(),
            false,
        )
        .await
        .unwrap();
        assert!(Path::new(&created).is_file());
        let renamed = rename_workspace_entry(
            root.to_string_lossy().to_string(),
            created,
            "renamed.md".to_string(),
        )
        .await
        .unwrap();
        assert!(Path::new(&renamed).is_file());
        assert!(create_workspace_entry(
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "../escape".to_string(),
            false,
        )
        .await
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_files_respect_git_ignores_and_keep_shallow_entries() {
        let root = std::env::temp_dir().join(format!("cetus-files-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::create_dir_all(root.join("cache/nested")).unwrap();
        std::fs::create_dir_all(root.join("excluded/nested")).unwrap();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::write(root.join(".gitignore"), "cache/\n").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "/excluded/\n").unwrap();
        std::fs::write(root.join("cache/nested/runtime.bin"), "cache").unwrap();
        std::fs::write(root.join("excluded/nested/memory.md"), "generated").unwrap();
        std::fs::write(root.join("src/deep/lib.rs"), "pub fn example() {}").unwrap();
        std::fs::write(root.join("README.md"), "project").unwrap();

        let entries = collect_workspace_files(&root, 8, 10).unwrap();
        let by_path = entries
            .iter()
            .map(|entry| (entry.relative_path.as_str(), entry.is_ignored))
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(by_path.get("cache"), Some(&true));
        assert_eq!(by_path.get("excluded"), Some(&true));
        assert_eq!(by_path.get("src"), Some(&false));
        assert_eq!(by_path.get("README.md"), Some(&false));
        assert!(!by_path.contains_key("cache/nested"));
        assert!(!by_path.contains_key("excluded/nested"));
        assert_eq!(by_path.get("src/deep/lib.rs"), Some(&false));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn browser_annotation_script_uses_per_window_token() {
        let token = "__CETUS_BROWSER_ANNOTATION__test-token__";
        let script = browser_annotation_script(token, &BrowserAnnotationLabels::default(), true);

        assert!(script.contains(&format!("var PREFIX = \"{token}\";")));
        assert!(!script.contains("__CETUS_BROWSER_ANNOTATION_TOKEN__"));
    }

    #[test]
    fn browser_annotation_script_keeps_payload_shape() {
        let script = browser_annotation_script(
            "__CETUS_BROWSER_ANNOTATION__test-token__",
            &BrowserAnnotationLabels::default(),
            true,
        );

        assert!(script.contains("selector: selector"));
        assert!(script.contains("rect: {"));
        assert!(script.contains("drawHighlight(target)"));
        assert!(script.contains("element: describeElement(target)"));
        assert!(script.contains("text: clippedText(target)"));
        assert!(script.contains("document.title = PREFIX + JSON.stringify(pending)"));
    }

    #[test]
    fn browser_annotation_script_selects_elements_not_points() {
        let script = browser_annotation_script(
            "__CETUS_BROWSER_ANNOTATION__test-token__",
            &BrowserAnnotationLabels::default(),
            true,
        );

        assert!(script.contains("document.addEventListener(\"mousemove\", onMove, true)"));
        assert!(script.contains("document.addEventListener(\"click\", onPick, true)"));
        assert!(script.contains("getBoundingClientRect()"));
        assert!(script.contains("selectorFor(target)"));
        assert!(script.contains("cetus-browser-annotation-highlight"));
        assert!(script.contains("cetus-browser-annotation-mode"));
        assert!(!script.contains("cetus-browser-annotation-layer"));
        assert!(!script.contains("pos.textContent = \"x \""));
        assert!(!script.contains("xPct:"));
        assert!(!script.contains("yPct:"));
    }

    #[test]
    fn browser_annotation_script_does_not_capture_own_controls() {
        let script = browser_annotation_script(
            "__CETUS_BROWSER_ANNOTATION__test-token__",
            &BrowserAnnotationLabels::default(),
            true,
        );

        assert!(script.contains("if (isChrome(e.target)) return;"));
        assert!(script.contains("cancel.addEventListener(\"click\""));
        assert!(script.contains("setAnnotating(false);"));
        assert!(!script.contains("setAnnotating(true);\n    });"));
    }

    #[test]
    fn browser_annotation_script_can_hide_floating_toggle() {
        let script = browser_annotation_script(
            "__CETUS_BROWSER_ANNOTATION__test-token__",
            &BrowserAnnotationLabels::default(),
            false,
        );

        assert!(!script.contains("<button id=\"cetus-browser-annotation-toggle\""));
        assert!(script.contains("window.addEventListener(\"cetus-browser-annotation-mode\""));
        assert!(script.contains("if (toggle)"));
    }

    #[test]
    fn browser_surface_allows_web_about_and_file_urls() {
        for scheme in ["http", "https", "about", "file"] {
            assert!(supported_browser_scheme(scheme));
        }
        for scheme in ["javascript", "data", "chrome"] {
            assert!(!supported_browser_scheme(scheme));
        }
    }
}
