"use client";
// Desktop notification system, configured by-event in Settings → Notifications.
//
// All app-events reach the frontend globally (one pi child per conversation,
// every event is emitted with a conversationId), so a single dispatcher here
// can notify for background board tasks too — even while the window is
// unfocused, which is the whole point.
//
// Preferences live in localStorage (mirroring cetus:lastModelChoice) and are
// exposed through a small Zustand store so the Settings page stays reactive.
// The OS permission round-trip goes through @tauri-apps/plugin-notification.

import { create } from "zustand";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { api } from "@/lib/tauri";
import { tt } from "@/lib/i18n";

/** By-event catalog. Each kind is an independent toggle in the settings page.
 *
 * Deliberately minimal: an agent run finishing is *one* event whether it was an
 * interactive reply, a board task, or a scheduled automation — automations are
 * just chats, so they don't get a notification case of their own. The only
 * other thing worth interrupting for is the agent blocking on your input. */
export type NotifyEvent =
  | "task_finished" // an agent run finished (reply / board task / automation), ok or error
  | "awaiting_input" // the agent is blocked on a dialog (confirm/select/input/editor)
  | "meeting"; // meeting capture started / notes saved (the consent surface)

export interface NotificationPrefs {
  /** Master switch — when off, nothing is ever shown. */
  enabled: boolean;
  /** Suppress notifications while the cetus window has OS focus. */
  muteWhenFocused: boolean;
  /** Per-event opt-in. */
  events: Record<NotifyEvent, boolean>;
}

/** Display metadata for the settings page, in render order. Label/description
 *  carry i18n keys (settings namespace) resolved at render via `t()`, since a
 *  module-level constant can't react to language changes on its own. */
export const NOTIFY_EVENTS: {
  id: NotifyEvent;
  labelKey: string;
  descriptionKey: string;
}[] = [
  {
    id: "task_finished",
    labelKey: "notifications.event.task_finished.label",
    descriptionKey: "notifications.event.task_finished.description",
  },
  {
    id: "awaiting_input",
    labelKey: "notifications.event.awaiting_input.label",
    descriptionKey: "notifications.event.awaiting_input.description",
  },
  {
    id: "meeting",
    labelKey: "notifications.event.meeting.label",
    descriptionKey: "notifications.event.meeting.description",
  },
];

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  muteWhenFocused: false,
  events: {
    task_finished: true,
    awaiting_input: true,
    meeting: true,
  },
};

const STORAGE_KEY = "cetus:notificationPrefs";

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      enabled: parsed.enabled ?? DEFAULT_PREFS.enabled,
      muteWhenFocused: parsed.muteWhenFocused ?? DEFAULT_PREFS.muteWhenFocused,
      // Merge so a newly-added event kind picks up its default rather than
      // becoming undefined for users with an older persisted blob.
      events: { ...DEFAULT_PREFS.events, ...(parsed.events ?? {}) },
    };
  } catch {
    // No localStorage (SSR/prerender) or malformed blob → safe defaults.
    return DEFAULT_PREFS;
  }
}

interface NotifyStore extends NotificationPrefs {
  /** OS permission state; null until first checked. */
  permissionGranted: boolean | null;
  setEnabled: (v: boolean) => void;
  setMuteWhenFocused: (v: boolean) => void;
  setEvent: (id: NotifyEvent, v: boolean) => void;
  setPermissionGranted: (v: boolean) => void;
}

export const useNotificationPrefs = create<NotifyStore>((set, get) => {
  const persist = () => {
    const { enabled, muteWhenFocused, events } = get();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled, muteWhenFocused, events }),
      );
    } catch {
      // best-effort; private mode / quota failures are fine.
    }
  };
  return {
    ...loadPrefs(),
    permissionGranted: null,
    setEnabled: (v) => {
      set({ enabled: v });
      persist();
    },
    setMuteWhenFocused: (v) => {
      set({ muteWhenFocused: v });
      persist();
    },
    setEvent: (id, v) => {
      set((s) => ({ events: { ...s.events, [id]: v } }));
      persist();
    },
    setPermissionGranted: (v) => set({ permissionGranted: v }),
  };
});

// ---------- OS permission --------------------------------------------------

/** Read the current OS permission without prompting; caches it in the store. */
export async function refreshPermission(): Promise<boolean> {
  try {
    const granted = await isPermissionGranted();
    useNotificationPrefs.getState().setPermissionGranted(granted);
    return granted;
  } catch {
    return false;
  }
}

/** Check, and prompt the user if not yet granted. Caches the result. */
export async function ensurePermission(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    useNotificationPrefs.getState().setPermissionGranted(granted);
    return granted;
  } catch (e) {
    console.error("notification permission request failed:", e);
    return false;
  }
}

// ---------- Dispatch -------------------------------------------------------

export interface NotifyOptions {
  title: string;
  body?: string;
  /** Suppress when the window is focused — used for the conversation the user
   *  is actively watching, where an OS banner would just be noise. */
  suppressWhenFocused?: boolean;
  /** Conversation the notification points at. Echoed back on click so the app
   *  can open (or unarchive) it. */
  conversationId?: string;
}

// We auto-request permission at most once per session, the first time a
// notification would actually fire. After that we trust the cached value so a
// denied permission doesn't re-prompt on every event.
let autoRequested = false;

/** Show an OS notification for `kind` if prefs + permission + focus allow it. */
export async function dispatchNotification(
  kind: NotifyEvent,
  opts: NotifyOptions,
): Promise<void> {
  const store = useNotificationPrefs.getState();
  if (!store.enabled || !store.events[kind]) return;

  const focused = typeof document !== "undefined" && document.hasFocus();
  if (focused && (store.muteWhenFocused || opts.suppressWhenFocused)) return;

  try {
    let granted = store.permissionGranted;
    if (granted == null) granted = await refreshPermission();
    if (!granted && !autoRequested) {
      autoRequested = true;
      granted = await ensurePermission();
    }
    if (!granted) return;
    // Route through the native command (not the plugin's sendNotification): the
    // plugin fires-and-forgets on desktop, so a click can't be routed and the
    // banner shows the wrong icon. `post_notification` pins the cetus logo and
    // echoes `conversationId` back on click (see notify.rs).
    await api.postNotification({
      title: opts.title,
      body: opts.body ?? "",
      conversationId: opts.conversationId,
    });
  } catch (e) {
    console.error("postNotification failed:", e);
  }
}

/** Fire a sample notification so the user can confirm the OS plumbing works. */
export async function sendTestNotification(): Promise<boolean> {
  const granted = await ensurePermission();
  if (!granted) return false;
  try {
    // Route through the native command (not the plugin's sendNotification): the
    // plugin fires-and-forgets on desktop, so clicking the test banner couldn't
    // bring cetus forward — the very behavior this button exists to confirm. With
    // no conversationId the click just focuses the app (see notify.rs did_activate).
    await api.postNotification({
      title: "cetus",
      body: tt("settings", "notifications.testBody"),
    });
    return true;
  } catch (e) {
    console.error("test notification failed:", e);
    return false;
  }
}
