//! Per-task git worktree isolation — the other half of the Superset/Conductor
//! pattern. Each CLI-agent conversation gets its own worktree (a checkout on its
//! own branch under `<repo>/.cetus/worktrees/<slug>`) so parallel `claude`/
//! `codex` runs edit isolated files and land on separate branches instead of
//! fighting over the shared working tree.
//!
//! Git is driven via `std::process::Command` (sync) since these are one-shot
//! setup/teardown calls, not a streaming loop.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Turn an arbitrary conversation id/title into a filesystem- and git-ref-safe
/// slug. Pure so it can be unit tested.
pub fn sanitize_slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed
    }
}

/// Where a task's worktree lives for a given repo. Pure; no filesystem touch.
pub fn worktree_path(repo: &Path, slug: &str) -> PathBuf {
    repo.join(".cetus").join("worktrees").join(sanitize_slug(slug))
}

/// The branch name a task's worktree checks out.
pub fn branch_name(slug: &str) -> String {
    format!("cetus/{}", sanitize_slug(slug))
}

/// True if `dir` is inside a git work tree.
pub fn is_git_repo(dir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// The branch checked out at `dir`. Detached HEADs still get a useful, stable
/// label instead of disappearing from the UI.
pub fn current_branch(dir: &Path) -> Option<String> {
    let branch = Command::new("git")
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    branch.or_else(|| {
        let commit = Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(dir)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())?;
        Some(format!("detached@{commit}"))
    })
}

fn run_git(repo: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .with_context(|| format!("git {args:?} failed to launch"))?;
    if !out.status.success() {
        bail!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Create (or reuse) an isolated worktree for `slug` off `base` (defaults to the
/// repo's current HEAD). Returns the worktree directory. Idempotent: if the
/// worktree already exists it is returned as-is.
pub fn ensure_worktree(repo: &Path, slug: &str, base: Option<&str>) -> Result<PathBuf> {
    if !is_git_repo(repo) {
        bail!("{} is not a git repository", repo.display());
    }
    let path = worktree_path(repo, slug);
    if path.join(".git").exists() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let branch = branch_name(slug);
    let path_str = path.to_string_lossy().to_string();

    // If the branch already exists (previous run), attach the worktree to it;
    // otherwise create a fresh branch off `base`.
    let branch_exists = run_git(repo, &["rev-parse", "--verify", "--quiet", &branch]).is_ok();
    if branch_exists {
        run_git(repo, &["worktree", "add", &path_str, &branch])?;
    } else {
        let base = base.unwrap_or("HEAD");
        run_git(repo, &["worktree", "add", "-b", &branch, &path_str, base])?;
    }
    Ok(path)
}

/// Remove a task worktree (and prune the admin record). Leaves the branch so the
/// work isn't lost; callers who want a full cleanup can delete the branch too.
pub fn remove_worktree(repo: &Path, slug: &str) -> Result<()> {
    let path = worktree_path(repo, slug);
    if path.exists() {
        run_git(
            repo,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        )?;
    }
    let _ = run_git(repo, &["worktree", "prune"]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_safe() {
        assert_eq!(sanitize_slug("Hello World!"), "hello-world");
        assert_eq!(sanitize_slug("  a//b__c  "), "a-b-c");
        assert_eq!(sanitize_slug("UUID-1234-ABCD"), "uuid-1234-abcd");
        assert_eq!(sanitize_slug("***"), "task");
        assert_eq!(sanitize_slug(""), "task");
    }

    #[test]
    fn paths_and_branch() {
        let repo = Path::new("/repo");
        assert_eq!(
            worktree_path(repo, "My Task"),
            Path::new("/repo/.cetus/worktrees/my-task")
        );
        assert_eq!(branch_name("My Task"), "cetus/my-task");
    }

    #[test]
    fn ensure_worktree_rejects_non_repo() {
        // A plain temp dir is not a git repo -> error, no panic.
        let dir = std::env::temp_dir().join("cetus-not-a-repo-xyz");
        let _ = std::fs::create_dir_all(&dir);
        assert!(ensure_worktree(&dir, "t", None).is_err());
    }
}
