/**
 * Click-to-focus for composers: a plain click on non-interactive chrome
 * (message text, empty pane space, headers, the sidebar's blank area) drops
 * the caret back into the nearest composer, and so does re-activating the
 * window with nothing focused. Interactive targets (buttons, links, fields,
 * terminals, editors), text selections, drags and anything layered on top
 * (dialogs, menus, popovers) are left alone.
 *
 * Several composers can be mounted at once (Threads: feed + docked thread),
 * so one shared listener picks the composer closest in the DOM to the click,
 * breaking ties toward the one the user typed in last.
 */

type Entry = {
  root: HTMLElement;
  textarea: () => HTMLTextAreaElement | null;
  enabled: () => boolean;
};

const entries = new Set<Entry>();
let lastFocused: Entry | null = null;
let teardown: (() => void) | null = null;
let bareKey = false;

/** True when the latest user input was an unmodified key pressed outside a
 *  field — keyboard navigation (Threads' J/K) that focus must not hijack. */
export function lastInputWasBareKey(): boolean {
  return bareKey;
}

/** Targets that own the click themselves. `[tabindex="-1"]` scrollers are
 *  deliberately not listed — clicking blank scroll space should refocus. */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "video",
  "audio",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='separator']",
  "[tabindex]:not([tabindex='-1'])",
  "[data-no-composer-focus]",
  ".xterm",
  ".cm-editor",
  ".monaco-editor",
].join(",");

/** Anything floating above the page: while one is open a click is about
 *  dismissing it, and Radix hands focus back to its trigger. */
const OVERLAY =
  "[data-radix-popper-content-wrapper], [role='menu'][data-state='open'], [role='alertdialog'][data-state='open']";

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable ||
    !!el.closest(".xterm")
  );
}

function usable(entry: Entry): HTMLTextAreaElement | null {
  const ta = entry.textarea();
  if (!ta || !entry.enabled() || ta.disabled || !ta.isConnected) return null;
  if (ta.getClientRects().length === 0) return null;
  // Respect modal layering: with a dialog open only a composer inside the
  // topmost one qualifies; without one, composers inside dialogs don't.
  const dialogs = document.querySelectorAll<HTMLElement>(
    "[role='dialog'][data-state='open']",
  );
  const top = dialogs[dialogs.length - 1];
  if (top ? !top.contains(entry.root) : entry.root.closest("[role='dialog']"))
    return null;
  return ta;
}

function depth(node: Node | null): number {
  let d = 0;
  for (let n = node; n; n = n.parentNode) d++;
  return d;
}

/** Depth of the deepest common ancestor of `a` and `b` — larger = closer. */
function closeness(a: Node, b: Node): number {
  for (let n: Node | null = a; n; n = n.parentNode) {
    if (n.contains(b)) return depth(n);
  }
  return 0;
}

function pick(near: Node | null): HTMLTextAreaElement | null {
  let best: { entry: Entry; ta: HTMLTextAreaElement; score: number } | null =
    null;
  for (const entry of entries) {
    const ta = usable(entry);
    if (!ta) continue;
    const score = near ? closeness(entry.root, near) : 0;
    if (
      !best ||
      score > best.score ||
      (score === best.score && entry === lastFocused)
    )
      best = { entry, ta, score };
  }
  return best?.ta ?? null;
}

function focus(ta: HTMLTextAreaElement) {
  if (document.activeElement === ta) return;
  // A textarea keeps its caret across blur, so this resumes where the user
  // left off.
  ta.focus({ preventScroll: true });
}

function install() {
  let down: { x: number; y: number } | null = null;

  const onKeyDown = (e: KeyboardEvent) => {
    bareKey =
      !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target as Element);
  };

  const onPointerDown = (e: PointerEvent) => {
    bareKey = false;
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  const onClick = (e: MouseEvent) => {
    const start = down;
    down = null;
    // detail 0 = keyboard-activated click; leave keyboard users where they are.
    if (e.defaultPrevented || e.button !== 0 || e.detail === 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (
      start &&
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4
    )
      return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(INTERACTIVE)) return;
    if (document.querySelector(OVERLAY)) return;
    // A click that just made (or extended) a selection is about copying or
    // quoting it, not typing.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    // Let the click's own handlers settle first; one that moved focus
    // somewhere editable (a rename field, a terminal) wins.
    requestAnimationFrame(() => {
      if (isEditable(document.activeElement)) return;
      if (document.querySelector(OVERLAY)) return;
      const live = window.getSelection();
      if (live && !live.isCollapsed && live.toString().trim()) return;
      const ta = pick(target);
      if (ta) focus(ta);
    });
  };

  // Coming back to the window with nothing focused (Cmd-Tab, Dock, clicking
  // the title bar) lands in the composer too.
  const onWindowFocus = () => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (document.querySelector(OVERLAY)) return;
      const ta = pick(null);
      if (ta) focus(ta);
    });
  };

  const onFocusIn = (e: FocusEvent) => {
    for (const entry of entries) {
      if (entry.textarea() === e.target) {
        lastFocused = entry;
        return;
      }
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("click", onClick);
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("click", onClick);
    window.removeEventListener("focus", onWindowFocus);
    document.removeEventListener("focusin", onFocusIn);
  };
}

/** Register a mounted composer; returns the unregister function. */
export function registerComposerAutofocus(entry: Entry): () => void {
  entries.add(entry);
  teardown ??= install();
  return () => {
    entries.delete(entry);
    if (lastFocused === entry) lastFocused = null;
    if (entries.size === 0) {
      teardown?.();
      teardown = null;
    }
  };
}
