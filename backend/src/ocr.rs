//! On-device OCR + frontmost-app detection.
//!
//! On macOS we shell out to a tiny Swift helper that calls Apple's Vision
//! framework (the same engine behind Live Text / Rewind). The helper is
//! compiled lazily on first use with `swiftc`; if `swiftc` is unavailable or
//! compilation fails we degrade gracefully — capture keeps storing frames,
//! just without text or app attribution. On non-macOS platforms both calls are
//! no-ops.

/// Frontmost application identity, surfaced to the capture pipeline for
/// exclusion filtering and per-frame attribution.
#[derive(Debug, Clone, Default)]
pub struct AppInfo {
    pub app: String,
    pub bundle_id: String,
}

/// Ambient context captured at the moment the quick launcher is summoned — what
/// the user was looking at *before* the panel took focus. Attached to a
/// screenshot-mode prompt so the agent knows the surrounding situation. Every
/// field is best-effort and may be empty (permission denied, non-browser app,
/// nothing selected). Mirrors the JSON the `context` Swift subcommand prints and
/// the `QuickContext` shape on the frontend.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientContext {
    pub app: String,
    pub bundle_id: String,
    pub url: String,
    pub title: String,
    pub selection: String,
}

impl AmbientContext {
    /// True when nothing useful was captured — callers skip attaching it.
    pub fn is_empty(&self) -> bool {
        self.app.is_empty()
            && self.url.is_empty()
            && self.title.is_empty()
            && self.selection.is_empty()
    }
}

/// Hard cap on the selected-text field as *captured*. Prompt-side budgets
/// (`context_budget::SELECTION_CHARS`) decide how much rides inline; the
/// launcher externalizes the rest as a text attachment, so capture keeps
/// more than the inline budget — bounded only so a select-all on a huge
/// document can't stall the pasteboard read or the IPC payload.
pub(crate) const MAX_SELECTION_CHARS: usize = 40_000;

#[cfg(target_os = "macos")]
mod imp {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    /// The Swift source, embedded at build time. Written to disk and compiled
    /// once on first use.
    const HELPER_SRC: &str = include_str!("../ocr/cetus-screen-helper.swift");

    /// Resolved helper path, computed once. `None` means "OCR/app-detection
    /// unavailable on this machine" — we stop retrying.
    static HELPER: OnceLock<Option<PathBuf>> = OnceLock::new();

    fn helper(app_data: &Path) -> Option<&'static Path> {
        HELPER
            .get_or_init(|| resolve_or_compile(app_data))
            .as_deref()
    }

    fn resolve_or_compile(app_data: &Path) -> Option<PathBuf> {
        // Explicit override (dev / packaged builds that ship a prebuilt helper).
        if let Ok(p) = std::env::var("CETUS_OCR_HELPER") {
            let p = PathBuf::from(p);
            if p.exists() {
                return Some(p);
            }
        }
        let bin_dir = app_data.join("bin");
        // Versioned name: bump the suffix whenever the Swift source gains a
        // subcommand, so a previously-compiled binary (which lacks it) is
        // replaced instead of silently reused. `-v2` added the `context` command.
        let bin = bin_dir.join("cetus-screen-helper-v2");
        if bin.exists() {
            return Some(bin);
        }
        std::fs::create_dir_all(&bin_dir).ok()?;
        let src = bin_dir.join("cetus-screen-helper.swift");
        if std::fs::write(&src, HELPER_SRC).is_err() {
            return None;
        }
        let output = Command::new("swiftc")
            .args([
                "-O",
                "-framework",
                "Vision",
                "-framework",
                "AppKit",
                // AppleScript (NSAppleScript) + Accessibility (AXUIElement) APIs
                // used by the `context` subcommand live in ApplicationServices.
                "-framework",
                "ApplicationServices",
                "-o",
            ])
            .arg(&bin)
            .arg(&src)
            .output();
        match output {
            Ok(o) if o.status.success() && bin.exists() => {
                tracing::info!("compiled screen OCR helper at {}", bin.display());
                Some(bin)
            }
            Ok(o) => {
                tracing::warn!(
                    "swiftc failed to build OCR helper; screen OCR disabled: {}",
                    String::from_utf8_lossy(&o.stderr)
                );
                None
            }
            Err(e) => {
                tracing::warn!("swiftc unavailable; screen OCR disabled: {e}");
                None
            }
        }
    }

    pub fn recognize(app_data: &Path, image_path: &Path) -> Option<String> {
        let bin = helper(app_data)?;
        let out = Command::new(bin).arg("ocr").arg(image_path).output().ok()?;
        if !out.status.success() {
            tracing::debug!("ocr failed: {}", String::from_utf8_lossy(&out.stderr));
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::path::Path;

    pub fn recognize(_app_data: &Path, _image_path: &Path) -> Option<String> {
        None
    }
}

pub use imp::recognize;
