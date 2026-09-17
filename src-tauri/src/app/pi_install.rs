use super::{plugins, AppHandle, Manager, Path, PathBuf, PI_BINARY_NAME};

/// Return a writable directory containing the pi binary and its runtime tree.
///
/// Precedence:
/// 1. `PI_INSTALL` env var — absolute path to an existing install tree (dev).
/// 2. `<app_data>/pi-install` if already populated.
/// 3. Copy from the Tauri resource bundle (`<resource_dir>/pi-install`) to
///    `<app_data>/pi-install` on first launch.
pub(super) fn resolve_pi_install(app: &AppHandle, app_data: &Path) -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("PI_INSTALL") {
        let p = PathBuf::from(p);
        if p.join(PI_BINARY_NAME).exists() {
            tracing::info!("using PI_INSTALL={}", p.display());
            // The bundled-resource overlay below never runs on this dev branch,
            // so without a sync here the install's cetus-extensions stay frozen at
            // whatever build-pi-sidecar.sh last produced — editing
            // src-tauri/cetus-extensions/*.ts (e.g. adding browser-use) would have
            // no effect, yet the capability prompt would still promise tools the
            // stale overlay never registered. Re-sync straight from the tracked
            // source so a pi respawn always reflects the current files.
            if let Some(src) = dev_ext_src() {
                if let Err(e) = sync_cetus_extensions_from(&src, &p) {
                    tracing::warn!("dev cetus-extensions sync skipped: {e}");
                } else {
                    tracing::info!("synced cetus-extensions from {}", src.display());
                }
            }
            if let Some(src) = plugins::dev_plugins_src() {
                if let Err(e) = sync_cetus_plugins_from(&src, &p) {
                    tracing::warn!("dev cetus-plugins sync skipped: {e}");
                } else {
                    tracing::info!("synced cetus-plugins from {}", src.display());
                }
            }
            std::env::set_var(
                plugins::CETUS_BUILTIN_PLUGINS_ENV,
                plugins::runtime_plugins_dir(&p),
            );
            return Ok(p);
        }
        anyhow::bail!("PI_INSTALL={} does not contain a pi binary", p.display());
    }

    let target = app_data.join("pi-install");
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| anyhow::anyhow!("resource_dir: {e}"))?
        .join("pi-install");

    if target.join(PI_BINARY_NAME).exists() {
        // The writable runtime used to be copied only on first launch. App
        // updates therefore kept an arbitrarily old pi binary/model registry,
        // even while the UI moved to newer model ids (for example
        // deepseek-v4-pro). A marker produced with the bundled tree lets us
        // replace the complete runtime whenever either Cetus or pi changes.
        if pi_runtime_needs_refresh(&resource, &target) {
            tracing::info!(
                "refreshing pi runtime {} → {}",
                resource.display(),
                target.display()
            );
            replace_pi_install(&resource, &target)?;
        }
        // Always re-sync our cetus-extensions overlay so new tool files (and
        // edits to existing ones) ship without needing to wipe the install
        // tree. Without this, a stale install from before cetus-extensions/
        // existed would silently strand new tools.
        if let Some(src) = dev_ext_src() {
            sync_cetus_extensions_from(&src, &target)?;
            tracing::info!("synced cetus-extensions from {}", src.display());
        } else if resource.join(PI_BINARY_NAME).exists() {
            sync_cetus_extensions(&resource, &target)?;
        }
        if let Some(src) = plugins::dev_plugins_src() {
            sync_cetus_plugins_from(&src, &target)?;
            tracing::info!("synced cetus-plugins from {}", src.display());
        } else if resource.join(PI_BINARY_NAME).exists() {
            sync_cetus_plugins(&resource, &target)?;
        }
        if resource.join(PI_BINARY_NAME).exists() {
            // The tree's node_modules is copied only on first install, so a
            // bundled pi-ai hotfix (the transform-messages content guard, see
            // scripts/build-pi-sidecar.sh) would otherwise never reach an
            // already-installed tree — leaving it permanently prone to the
            // "undefined is not an object (evaluating 'content')" brick.
            if let Err(e) = sync_pi_ai_guard(&resource, &target) {
                tracing::warn!("pi-ai guard sync skipped: {e}");
            }
        }
        std::env::set_var(
            plugins::CETUS_BUILTIN_PLUGINS_ENV,
            plugins::runtime_plugins_dir(&target),
        );
        return Ok(target);
    }

    if !resource.join(PI_BINARY_NAME).exists() {
        anyhow::bail!(
            "pi-install missing from resources at {}; run scripts/build-pi-sidecar.sh",
            resource.display()
        );
    }
    tracing::info!(
        "installing pi tree {} → {}",
        resource.display(),
        target.display()
    );
    copy_dir(&resource, &target)?;
    if let Some(src) = dev_ext_src() {
        sync_cetus_extensions_from(&src, &target)?;
        tracing::info!("synced cetus-extensions from {}", src.display());
    }
    if let Some(src) = plugins::dev_plugins_src() {
        sync_cetus_plugins_from(&src, &target)?;
        tracing::info!("synced cetus-plugins from {}", src.display());
    }
    std::env::set_var(
        plugins::CETUS_BUILTIN_PLUGINS_ENV,
        plugins::runtime_plugins_dir(&target),
    );
    Ok(target)
}

const PI_RUNTIME_MARKER: &str = ".cetus-runtime-version";

pub(super) fn pi_runtime_marker(root: &Path) -> Option<String> {
    std::fs::read_to_string(root.join(PI_RUNTIME_MARKER))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn pi_runtime_needs_refresh(resource: &Path, target: &Path) -> bool {
    let Some(bundled) = pi_runtime_marker(resource) else {
        // Older/dev resource trees have no marker. Preserve the existing
        // behavior instead of replacing a user runtime on every launch.
        return false;
    };
    pi_runtime_marker(target).as_deref() != Some(bundled.as_str())
}

/// Replace the writable pi tree without exposing a half-copied directory if a
/// copy fails. Startup runs before any pi child is spawned, so the old tree can
/// be renamed safely on every supported desktop platform.
pub(super) fn replace_pi_install(resource: &Path, target: &Path) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "pi install has no parent")
    })?;
    let staging = parent.join("pi-install.next");
    let backup = parent.join("pi-install.previous");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    if backup.exists() {
        std::fs::remove_dir_all(&backup)?;
    }
    copy_dir(resource, &staging)?;
    std::fs::rename(target, &backup)?;
    if let Err(error) = std::fs::rename(&staging, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(error);
    }
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        tracing::warn!("could not prune previous pi runtime: {error}");
    }
    Ok(())
}

/// Re-deploy `<resource>/cetus-extensions` over `<target>/cetus-extensions`.
/// Cheap (tiny number of small .ts files) and keeps tool updates flowing
/// without bumping the install version or wiping the cache.
pub(super) fn sync_cetus_extensions(resource: &Path, target: &Path) -> std::io::Result<()> {
    sync_cetus_extensions_from(&resource.join(crate::bridge::CETUS_EXTENSIONS_DIR), target)
}

/// Re-deploy `<resource>/cetus-plugins` over `<target>/cetus-plugins`.
pub(super) fn sync_cetus_plugins(resource: &Path, target: &Path) -> std::io::Result<()> {
    sync_cetus_plugins_from(&resource.join(plugins::CETUS_PLUGINS_DIR), target)
}

pub(super) fn sync_cetus_plugins_from(src: &Path, target: &Path) -> std::io::Result<()> {
    let dst = target.join(plugins::CETUS_PLUGINS_DIR);
    if !src.exists() {
        return Ok(());
    }
    if dst.exists() {
        std::fs::remove_dir_all(&dst)?;
    }
    copy_dir(src, &dst)
}

/// Recursively copy `src` into `dst`, creating `dst`. Best-effort helper used
/// once at startup to carry pre-rename app data (the old `dev.jinqiu.kott` dir)
/// over to the new identifier's dir. Regular files and directories only —
/// symlinks are skipped so a stray link can't escape the tree or loop.
pub(super) fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy a cetus-extensions source directory over `<target>/cetus-extensions`,
/// replacing it wholesale so removed tool files don't linger, and pruning any
/// dir left behind by a previous name for the extensions tree. No-op when `src`
/// is absent.
pub(super) fn sync_cetus_extensions_from(src: &Path, target: &Path) -> std::io::Result<()> {
    let dst = target.join(crate::bridge::CETUS_EXTENSIONS_DIR);
    if !src.exists() {
        return Ok(());
    }
    // A valid replacement is going in, so drop any extensions dir left by an
    // earlier name. The loader reads only CETUS_EXTENSIONS_DIR, so a renamed-away
    // copy is dead weight that hides rename bugs (it can leave an install with
    // tools the loader never sees). Pruned only once `src` is confirmed present
    // so we never strip the install down to no extensions at all.
    for legacy in crate::bridge::LEGACY_EXTENSION_DIRS {
        let stale = target.join(legacy);
        if stale.is_dir() {
            match std::fs::remove_dir_all(&stale) {
                Ok(()) => tracing::info!("pruned stale extensions dir {}", stale.display()),
                Err(e) => {
                    tracing::warn!(
                        "pruning stale extensions dir {} failed: {e}",
                        stale.display()
                    )
                }
            }
        }
    }
    if dst.exists() {
        std::fs::remove_dir_all(&dst)?;
    }
    copy_dir(src, &dst)
}

/// The tracked cetus-extensions source, located relative to this crate at compile
/// time. Only resolves on the machine that built the binary (the path is baked
/// in by `env!`), and returns `None` once that directory is gone — so a shipped
/// release, whose resources live elsewhere, never touches it.
pub(super) fn dev_ext_src() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(crate::bridge::CETUS_EXTENSIONS_DIR);
    p.is_dir().then_some(p)
}

/// Propagate the bundled pi-ai content guard into an already-installed tree.
///
/// `resolve_pi_install` copies the full `node_modules` only on first install and
/// thereafter re-syncs just `cetus-extensions`, so a guard added/upgraded in a
/// later build never reaches an existing writable tree. That left the live tree
/// crashing on null/empty `content` (a half-streamed turn) on every send — the
/// classic bricked conversation. Copy the one bundled file over whenever the
/// installed copy is missing or differs from it. Path-stable (no version in the
/// path), cheap, and idempotent. Only acts when the bundle itself is patched.
pub(super) fn sync_pi_ai_guard(resource: &Path, target: &Path) -> std::io::Result<()> {
    const REL: &str = "node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js";
    let src = resource.join(REL);
    let dst = target.join(REL);
    if !src.exists() || !dst.exists() {
        return Ok(());
    }
    let src_txt = std::fs::read_to_string(&src)?;
    if !src_txt.contains("cetus-guard") {
        return Ok(()); // bundle unpatched (older build) — nothing to propagate
    }
    let dst_txt = std::fs::read_to_string(&dst).unwrap_or_default();
    if dst_txt != src_txt {
        std::fs::copy(&src, &dst)?;
        tracing::info!("synced pi-ai content guard into install tree");
    }
    Ok(())
}

/// The user's home directory. Windows GUI processes get no `HOME` (that's a
/// Unix/Git-Bash convention), so fall back to the native variables — otherwise
/// every home-relative lookup silently degrades there.
pub(super) fn dirs_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(home));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|p| !p.is_empty()) {
            return Some(PathBuf::from(profile));
        }
        if let (Some(drive), Some(path)) = (
            std::env::var_os("HOMEDRIVE").filter(|d| !d.is_empty()),
            std::env::var_os("HOMEPATH").filter(|p| !p.is_empty()),
        ) {
            let mut home = std::ffi::OsString::from(drive);
            home.push(path);
            return Some(PathBuf::from(home));
        }
    }
    None
}

pub(super) fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            let link_target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            {
                let _ = std::fs::remove_file(&to);
                std::os::unix::fs::symlink(&link_target, &to)?;
            }
            #[cfg(not(unix))]
            {
                // Best-effort: dereference and copy on platforms without symlinks.
                let resolved = std::fs::canonicalize(&from)?;
                if resolved.is_dir() {
                    copy_dir(&resolved, &to)?;
                } else {
                    std::fs::copy(&resolved, &to)?;
                }
            }
        } else if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
            // Preserve executable bit for the pi binary and any tooling.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&from)?.permissions().mode();
                let mut perms = std::fs::metadata(&to)?.permissions();
                perms.set_mode(mode);
                std::fs::set_permissions(&to, perms)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod pi_runtime_refresh_tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cetus-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn marker_requests_refresh_only_for_a_new_bundled_runtime() {
        let root = temp_root("pi-marker");
        let resource = root.join("resource");
        let target = root.join("target");
        std::fs::create_dir_all(&resource).unwrap();
        std::fs::create_dir_all(&target).unwrap();

        assert!(!pi_runtime_needs_refresh(&resource, &target));
        std::fs::write(resource.join(PI_RUNTIME_MARKER), "cetus=1 pi=2\n").unwrap();
        assert!(pi_runtime_needs_refresh(&resource, &target));
        std::fs::write(target.join(PI_RUNTIME_MARKER), "cetus=1 pi=2\n").unwrap();
        assert!(!pi_runtime_needs_refresh(&resource, &target));
        std::fs::write(target.join(PI_RUNTIME_MARKER), "cetus=1 pi=1\n").unwrap();
        assert!(pi_runtime_needs_refresh(&resource, &target));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replacement_swaps_the_complete_runtime_tree() {
        let root = temp_root("pi-replace");
        let resource = root.join("resource");
        let target = root.join("pi-install");
        std::fs::create_dir_all(&resource).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(resource.join("new-runtime"), "new").unwrap();
        std::fs::write(target.join("old-runtime"), "old").unwrap();

        replace_pi_install(&resource, &target).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("new-runtime")).unwrap(),
            "new"
        );
        assert!(!target.join("old-runtime").exists());
        assert!(!root.join("pi-install.next").exists());
        assert!(!root.join("pi-install.previous").exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
