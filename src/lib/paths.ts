/**
 * Display a filesystem path as just its bottom-most folder name, like Codex's
 * project picker. Avoids leaking the absolute path — and with it the user's
 * home directory / username (e.g. "jinqiu") — into the UI.
 *
 * "/Users/jinqiu/Developer/cetus" -> "cetus"
 */
export function workspaceName(p: string): string {
  if (!p) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
