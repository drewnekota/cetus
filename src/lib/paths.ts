/**
 * Display a filesystem path as just its bottom-most folder name, like Codex's
 * project picker. Avoids leaking the absolute path — and with it the user's
 * home directory / username — into the UI.
 *
 * "/workspace/cetus" -> "cetus"
 */
export function workspaceName(p: string): string {
  if (!p) return p;
  const sshUrl = p.match(/^ssh:\/\/([^/]+)(\/.+)$/);
  if (sshUrl) {
    const host = sshUrl[1];
    const parts = sshUrl[2].split("/").filter(Boolean);
    return `${host}:${parts.length ? parts[parts.length - 1] : "/"}`;
  }
  const scp = p.match(/^([^/:\s]+@?[^/:\s]+):(.+)$/);
  if (scp) {
    const parts = scp[2].split("/").filter(Boolean);
    return `${scp[1]}:${parts.length ? parts[parts.length - 1] : scp[2]}`;
  }
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
