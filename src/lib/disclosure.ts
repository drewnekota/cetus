// Persistent expand/collapse state for disclosure widgets (activity groups, tool
// cards, thinking blocks) inside the chat transcript.
//
// The message list is virtualized (react-virtuoso), so a turn scrolled far out
// of view is UNMOUNTED — a plain `useState(false)` would reset every expander
// when you scroll back. Keep the open/closed bit in a module-level map keyed by
// a stable id (conversation + turn + widget path) so it survives unmount and is
// restored on remount. Cleared lazily: entries are tiny booleans and bounded by
// how many widgets a user actually toggles in a session.
import { useCallback, useState, useSyncExternalStore } from "react";
import { DisclosureState } from "./disclosure-state";

const store = new DisclosureState();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const noRelatedIds: readonly string[] = [];

/** Disclosure state that persists across unmount/remount for a stable `id`.
 *  When `id` is undefined (caller has no stable key) it degrades to plain local
 *  state. Returns `[open, toggle]`. */
export function useDisclosure(
  id: string | undefined,
  initial = false,
  relatedIds: readonly string[] = noRelatedIds,
): [boolean, () => void] {
  const [localChoice, setLocalChoice] = useState<boolean | undefined>();
  const getSnapshot = () => id ? store.get(id, initial, relatedIds) : localChoice ?? initial;
  const open = useSyncExternalStore(subscribe, getSnapshot, () => initial);
  const toggle = useCallback(() => {
    if (!id) {
      setLocalChoice((choice) => !(choice ?? initial));
      return;
    }
    store.set(id, !store.get(id, initial, relatedIds));
    listeners.forEach((listener) => listener());
  }, [id, initial, relatedIds]);
  return [open, toggle];
}
