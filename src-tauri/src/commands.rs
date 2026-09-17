//! Tauri commands invoked by the React frontend.
//!
//! Every command that talks to a pi process takes the owning conversation id
//! explicitly — the previous "active session" model is gone now that each
//! conversation has its own dedicated pi child (see AppState::pi_for).

mod files;
#[cfg(test)]
mod tests;
pub(crate) use files::*;
mod settings;
pub(crate) use settings::*;
mod transcripts;
pub(crate) use transcripts::*;
mod workspace;
pub(crate) use workspace::*;
mod prompt;
pub(crate) use prompt::*;
mod conversations;
pub(crate) use conversations::*;
mod browser;
pub(crate) use browser::*;

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

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn pi_ping(_state: State<'_, AppState>) -> CmdResult<bool> {
    // Backend is up if this command resolves at all. With per-conversation
    // lazy spawn there's nothing to ping globally.
    Ok(true)
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
