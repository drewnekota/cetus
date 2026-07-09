// Persistent expand/collapse state for disclosure widgets (activity groups, tool
// cards, thinking blocks) inside the chat transcript.
//
// The message list is virtualized (react-virtuoso), so a turn scrolled far out
// of view is UNMOUNTED — a plain `useState(false)` would reset every expander
// when you scroll back. Keep the open/closed bit in a module-level map keyed by
// a stable id (conversation + turn + widget path) so it survives unmount and is
// restored on remount. Cleared lazily: entries are tiny booleans and bounded by
// how many widgets a user actually toggles in a session.
import { useCallback, useState } from "react";

const store = new Map<string, boolean>();

/** Disclosure state that persists across unmount/remount for a stable `id`.
 *  When `id` is undefined (caller has no stable key) it degrades to plain local
 *  state. Returns `[open, toggle]`. */
export function useDisclosure(
  id: string | undefined,
  initial = false,
): [boolean, () => void] {
  const [open, setOpen] = useState(() => (id ? store.get(id) ?? initial : initial));
  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (id) store.set(id, next);
      return next;
    });
  }, [id]);
  return [open, toggle];
}
