use anyhow::{anyhow, bail, Context, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWorkspace {
    pub target: String,
    pub port: Option<u16>,
    pub path: String,
}

impl RemoteWorkspace {
    pub fn display(&self) -> String {
        match self.port {
            Some(port) => format!("ssh://{}:{}{}", self.target, port, self.path),
            None => format!("{}:{}", self.target, self.path),
        }
    }

    pub fn ssh_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.push("-p".to_string());
            args.push(port.to_string());
        }
        args.push(self.target.clone());
        args
    }
}

#[derive(Debug, Clone)]
pub struct RemoteRuntime {
    pub workspace: RemoteWorkspace,
    pub root: String,
    pub pi_dir: String,
    pub pi_bin: String,
    pub sessions_dir: String,
    pub local_sessions_dir: PathBuf,
}

/// Parse the two workspace forms Cetus accepts for Remote SSH:
///
/// - `ssh://[user@]host[:port]/absolute/path`
/// - `[user@]host:/absolute/path` (OpenSSH/scp style)
pub fn parse_remote_workspace(raw: &str) -> Option<RemoteWorkspace> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    if let Some(rest) = s.strip_prefix("ssh://") {
        let slash = rest.find('/')?;
        let authority = &rest[..slash];
        let path = &rest[slash..];
        if authority.is_empty() || path.len() <= 1 {
            return None;
        }
        let (target, port) = split_port(authority);
        if target.is_empty() {
            return None;
        }
        return Some(RemoteWorkspace {
            target: target.to_string(),
            port,
            path: path.to_string(),
        });
    }

    // OpenSSH's scp-like syntax. Avoid treating local absolute paths or relative
    // paths containing a slash before the colon as remote specs.
    let colon = s.find(':')?;
    if s.starts_with('/') || s[..colon].contains('/') || colon == 0 {
        return None;
    }
    let target = &s[..colon];
    let path = &s[colon + 1..];
    if target.is_empty() || path.is_empty() {
        return None;
    }
    Some(RemoteWorkspace {
        target: target.to_string(),
        port: None,
        path: path.to_string(),
    })
}

fn split_port(authority: &str) -> (&str, Option<u16>) {
    let Some(colon) = authority.rfind(':') else {
        return (authority, None);
    };
    let host_part = &authority[..colon];
    let port_part = &authority[colon + 1..];
    if host_part.is_empty() || port_part.is_empty() {
        return (authority, None);
    }
    match port_part.parse::<u16>() {
        Ok(port) => (host_part, Some(port)),
        Err(_) => (authority, None),
    }
}

pub fn default_remote_root() -> String {
    std::env::var("CETUS_REMOTE_ROOT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "~/.cache/cetus/remote-agent".to_string())
}

pub fn prepare_remote_runtime(
    workspace: RemoteWorkspace,
    local_pi_bin: &Path,
    local_sessions_dir: &Path,
    conversation_id: Option<&str>,
    extra_env: &mut [(String, String)],
) -> Result<RemoteRuntime> {
    let local_pi_dir = local_pi_bin
        .parent()
        .ok_or_else(|| anyhow!("pi binary has no parent: {}", local_pi_bin.display()))?;
    let root = default_remote_root();
    let pi_dir = join_remote(&root, "pi-install");
    let pi_bin = join_remote(&pi_dir, "pi");
    let sessions_dir = join_remote(&root, "sessions");

    ensure_remote_pi(&workspace, local_pi_dir, &pi_bin)?;
    ensure_remote_dir(&workspace, &workspace.path)?;
    ensure_remote_dir(&workspace, &sessions_dir)?;
    sync_conv_agent_env(&workspace, &root, conversation_id, extra_env)?;

    Ok(RemoteRuntime {
        workspace,
        root,
        pi_dir,
        pi_bin,
        sessions_dir,
        local_sessions_dir: local_sessions_dir.to_path_buf(),
    })
}

fn ensure_remote_pi(
    workspace: &RemoteWorkspace,
    local_pi_dir: &Path,
    remote_pi_bin: &str,
) -> Result<()> {
    let force = std::env::var("CETUS_REMOTE_SYNC")
        .map(|v| v.eq_ignore_ascii_case("always") || v == "1")
        .unwrap_or(false);
    if !force {
        let check = format!("test -x {}", shell_word(remote_pi_bin));
        if ssh_status(workspace, &check).unwrap_or(false) {
            return Ok(());
        }
    }

    let remote_pi_dir = remote_pi_bin
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .ok_or_else(|| anyhow!("invalid remote pi path: {remote_pi_bin}"))?;
    tar_dir_contents_to_remote(workspace, local_pi_dir, remote_pi_dir)
        .with_context(|| format!("sync pi runtime to {}", workspace.target))?;
    Ok(())
}

fn sync_conv_agent_env(
    workspace: &RemoteWorkspace,
    remote_root: &str,
    conversation_id: Option<&str>,
    extra_env: &mut [(String, String)],
) -> Result<()> {
    let Some(conv_id) = conversation_id else {
        return Ok(());
    };
    let Some((_, local_agent_dir)) = extra_env
        .iter()
        .find(|(k, _)| k == "PI_CODING_AGENT_DIR")
        .cloned()
    else {
        return Ok(());
    };
    let local_agent_dir = PathBuf::from(local_agent_dir);
    if !local_agent_dir.is_dir() {
        return Ok(());
    }

    let remote_conv_parent = join_remote(remote_root, "conv-agents");
    let remote_agent_dir = join_remote(&remote_conv_parent, conv_id);
    tar_dir_to_remote(
        workspace,
        local_agent_dir
            .parent()
            .ok_or_else(|| anyhow!("conversation agent dir has no parent"))?,
        local_agent_dir
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("invalid conversation agent dir"))?,
        &remote_conv_parent,
    )
    .with_context(|| format!("sync conversation agent dir for {conv_id}"))?;

    for (key, value) in extra_env.iter_mut() {
        match key.as_str() {
            "PI_CODING_AGENT_DIR" => *value = remote_agent_dir.clone(),
            "CETUS_MCP_CONFIG" | "MCPORTER_CONFIG" => {
                *value = join_remote(&remote_agent_dir, "mcp.json");
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn remote_session_path(runtime: &RemoteRuntime, local_or_remote: &str) -> String {
    if local_or_remote.starts_with(&runtime.sessions_dir) {
        return local_or_remote.to_string();
    }
    let name = Path::new(local_or_remote)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(local_or_remote);
    join_remote(&runtime.sessions_dir, name)
}

pub fn local_session_path(runtime: &RemoteRuntime, remote_or_local: &str) -> PathBuf {
    let name = Path::new(remote_or_local)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(remote_or_local);
    runtime.local_sessions_dir.join(name)
}

pub fn upload_session(runtime: &RemoteRuntime, local_path: &Path) -> Result<String> {
    let remote_path = remote_session_path(runtime, &local_path.to_string_lossy());
    if !local_path.exists() {
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(local_path, b"")?;
    }
    let bytes = std::fs::read(local_path)?;
    let cmd = format!("cat > {}", shell_word(&remote_path));
    ssh_with_stdin(&runtime.workspace, &cmd, &bytes)
        .with_context(|| format!("upload session {}", local_path.display()))?;
    Ok(remote_path)
}

pub fn download_session(runtime: &RemoteRuntime, remote_path: &str) -> Result<PathBuf> {
    let local = local_session_path(runtime, remote_path);
    let cmd = format!("cat {}", shell_word(remote_path));
    let output = ssh_output(&runtime.workspace, &cmd)
        .with_context(|| format!("download session {remote_path}"))?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&local, output)?;
    Ok(local)
}

pub fn remote_command_args(workspace: &RemoteWorkspace, script: &str) -> Vec<String> {
    let mut args = workspace.ssh_args();
    args.push(format!("sh -lc {}", shell_word(script)));
    args
}

pub fn shell_word(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%_+=:,./~-".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

pub fn join_remote(base: &str, child: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), child.trim_start_matches('/'))
}

fn ensure_remote_dir(workspace: &RemoteWorkspace, path: &str) -> Result<()> {
    let cmd = format!("mkdir -p {}", shell_word(path));
    if ssh_status(workspace, &cmd)? {
        Ok(())
    } else {
        bail!("failed to create remote directory {path}")
    }
}

fn tar_dir_to_remote(
    workspace: &RemoteWorkspace,
    local_parent: &Path,
    local_name: &str,
    remote_parent: &str,
) -> Result<()> {
    let remote_cmd = format!(
        "mkdir -p {} && tar -xzf - -C {}",
        shell_word(remote_parent),
        shell_word(remote_parent)
    );
    let mut tar = Command::new("tar")
        .arg("-czf")
        .arg("-")
        .arg("-C")
        .arg(local_parent)
        .arg(local_name)
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn tar for {}", local_parent.join(local_name).display()))?;
    let tar_stdout = tar.stdout.take().context("tar stdout missing")?;

    let mut ssh = Command::new("ssh");
    ssh.args(remote_command_args(workspace, &remote_cmd))
        .stdin(Stdio::from(tar_stdout))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = ssh.output().context("spawn ssh for remote tar")?;
    let tar_status = tar.wait().context("wait tar")?;
    if !tar_status.success() {
        bail!("tar exited with {tar_status}");
    }
    if !output.status.success() {
        bail!(
            "ssh tar exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn tar_dir_contents_to_remote(
    workspace: &RemoteWorkspace,
    local_dir: &Path,
    remote_dir: &str,
) -> Result<()> {
    let remote_cmd = format!(
        "mkdir -p {} && tar -xzf - -C {}",
        shell_word(remote_dir),
        shell_word(remote_dir)
    );
    let mut tar = Command::new("tar")
        .arg("-czf")
        .arg("-")
        .arg("-C")
        .arg(local_dir)
        .arg(".")
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn tar for {}", local_dir.display()))?;
    let tar_stdout = tar.stdout.take().context("tar stdout missing")?;

    let mut ssh = Command::new("ssh");
    ssh.args(remote_command_args(workspace, &remote_cmd))
        .stdin(Stdio::from(tar_stdout))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = ssh.output().context("spawn ssh for remote tar")?;
    let tar_status = tar.wait().context("wait tar")?;
    if !tar_status.success() {
        bail!("tar exited with {tar_status}");
    }
    if !output.status.success() {
        bail!(
            "ssh tar exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn ssh_status(workspace: &RemoteWorkspace, script: &str) -> Result<bool> {
    let status = Command::new("ssh")
        .args(remote_command_args(workspace, script))
        .status()
        .context("spawn ssh")?;
    Ok(status.success())
}

fn ssh_output(workspace: &RemoteWorkspace, script: &str) -> Result<Vec<u8>> {
    let output = Command::new("ssh")
        .args(remote_command_args(workspace, script))
        .output()
        .context("spawn ssh")?;
    if !output.status.success() {
        bail!(
            "ssh exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(output.stdout)
}

fn ssh_with_stdin(workspace: &RemoteWorkspace, script: &str, bytes: &[u8]) -> Result<()> {
    let mut child = Command::new("ssh")
        .args(remote_command_args(workspace, script))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ssh")?;
    child
        .stdin
        .take()
        .context("ssh stdin missing")?
        .write_all(bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "ssh exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_url_workspace() {
        assert_eq!(
            parse_remote_workspace("ssh://dev@example.com:2222/work/repo"),
            Some(RemoteWorkspace {
                target: "dev@example.com".into(),
                port: Some(2222),
                path: "/work/repo".into(),
            })
        );
    }

    #[test]
    fn parses_scp_like_workspace() {
        assert_eq!(
            parse_remote_workspace("devbox:/srv/repo"),
            Some(RemoteWorkspace {
                target: "devbox".into(),
                port: None,
                path: "/srv/repo".into(),
            })
        );
    }

    #[test]
    fn leaves_local_paths_alone() {
        assert_eq!(parse_remote_workspace("/Users/me/repo"), None);
        assert_eq!(parse_remote_workspace("relative/path:with-colon"), None);
    }

    #[test]
    fn quotes_shell_words() {
        assert_eq!(shell_word("/tmp/repo"), "/tmp/repo");
        assert_eq!(shell_word("/tmp/my repo"), "'/tmp/my repo'");
        assert_eq!(shell_word("a'b"), "'a'\"'\"'b'");
    }
}
