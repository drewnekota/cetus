"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  CHAT_SLOT_SHORTCUT_IDS,
  acceleratorModifiers,
  heldModifiers,
  keyToken,
  shortcutDisplay,
  type ShortcutMap,
} from "@/lib/keyboard-shortcuts";

/** Chat id → the shortcut that opens it, published only while the user holds
 *  the slot modifier. Rows read it to swap their timestamp for the key. */
const ChatSlotHintsContext = createContext<ReadonlyMap<string, string> | null>(
  null,
);

export const ChatSlotHintsProvider = ChatSlotHintsContext.Provider;

export function useChatSlotHint(id: string): string | undefined {
  return useContext(ChatSlotHintsContext)?.get(id);
}

// Long enough that a quick ⌘C or ⌘K doesn't flash numbers over every row.
const REVEAL_DELAY_MS = 120;
// After ⌘⇥ brings the window back, WebKit replays the still-held ⌘ as a
// keydown but the release can land before the window is key, so its keyup
// never arrives. Ignore modifier presses this soon after regaining focus.
const FOCUS_SETTLE_MS = 400;

/** The modifiers held on their own, after a short pause; null otherwise.
 *  Pressing a key while they're held keeps the hints up (⌘1 then ⌘2 reads
 *  them as you go) but cancels a pending reveal, so a quick ⌘C never flashes
 *  them. Releasing a modifier or the window losing focus hides them, and so
 *  does any pointer event reporting different modifiers — the safety net for
 *  a keyup the window never received. */
function useHeldModifiers(): string | null {
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: string | null = null;
    let focusedAt = 0;
    const show = (mods: string | null) => {
      clearTimeout(timer);
      shown = mods;
      setHeld(mods);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      clearTimeout(timer);
      if (keyToken(e.code, e.key) !== null) return;
      const mods = heldModifiers(e);
      // WebKit can re-send the held modifier's keydown; same set, keep it up.
      if (mods === shown) return;
      show(null);
      if (mods && performance.now() - focusedAt > FOCUS_SETTLE_MS)
        timer = setTimeout(() => show(mods), REVEAL_DELAY_MS);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (keyToken(e.code, e.key) === null && heldModifiers(e) !== shown)
        show(null);
    };
    const onPointer = (e: PointerEvent | WheelEvent) => {
      if (shown !== null && heldModifiers(e) !== shown) show(null);
    };
    const hide = () => show(null);
    const onFocus = () => {
      focusedAt = performance.now();
      show(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("wheel", onPointer, { passive: true });
    window.addEventListener("blur", hide);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("wheel", onPointer);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return held;
}

/** Map the visible chats onto the chat-slot shortcuts whose modifiers are
 *  being held: slots 1…8 by position, and lastChat on the final row unless
 *  that row already has a number. */
export function useChatSlotHints(
  visibleIds: readonly string[],
  shortcuts: ShortcutMap,
): ReadonlyMap<string, string> | null {
  const held = useHeldModifiers();
  return useMemo(() => {
    if (!held) return null;
    const hints = new Map<string, string>();
    const matches = (accelerator: string) =>
      !!accelerator && acceleratorModifiers(accelerator) === held;
    CHAT_SLOT_SHORTCUT_IDS.forEach((slot, index) => {
      const id = visibleIds[index];
      if (id && matches(shortcuts[slot]))
        hints.set(id, shortcutDisplay(shortcuts[slot]));
    });
    const lastId = visibleIds.at(-1);
    if (lastId && !hints.has(lastId) && matches(shortcuts.lastChat))
      hints.set(lastId, shortcutDisplay(shortcuts.lastChat));
    return hints.size > 0 ? hints : null;
  }, [held, visibleIds, shortcuts]);
}
