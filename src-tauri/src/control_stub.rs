//! Windows fallback for the Unix-domain control socket and CLI shim.

use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const AGENT_HINT: &str = "You are running inside Cetus, a desktop agent app. \
Whenever you create or obtain any file the user should receive, use the app's artifact tools.";

pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("cetus.sock")
}

pub fn cli_bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin")
}

pub fn install_cli_shim(_app_data_dir: &Path) {}

pub fn start(_app: AppHandle) {}
