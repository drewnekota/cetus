"use client";
// Unified model for the OS permissions cetus asks for. The backend already
// exposes per-permission check / request / open-system-settings primitives
// (quick.rs, voice.rs) plus the notification plugin; this module folds them
// into one catalog so both the Settings → Permissions page and the first-run
// onboarding render from a single source of truth. Missing i18n keys fall back
// to English, so callers only need en + zh strings.

import type { ComponentType } from "react";
import { Accessibility, Bell, Mic, Monitor } from "lucide-react";
import { api } from "@/lib/tauri";
import { ensurePermission, refreshPermission } from "@/lib/notifications";

/** `granted` — usable now. `needed` — not yet authorized (or denied). `unknown`
 *  — the probe itself failed (no backend / non-desktop). */
export type PermStatus = "granted" | "needed" | "unknown";

export type PermissionId =
  | "notifications"
  | "accessibility"
  | "screen"
  | "microphone";

export interface PermissionMeta {
  id: PermissionId;
  icon: ComponentType<{ className?: string }>;
  /** settings-namespace i18n keys, resolved at render. */
  labelKey: string;
  descKey: string;
  /** macOS-only TCC permission — hidden on other platforms. */
  macOnly: boolean;
  /** Whether a "Open System Settings" deep link exists for it. */
  canOpenSettings: boolean;
}

export const PERMISSIONS: PermissionMeta[] = [
  {
    id: "notifications",
    icon: Bell,
    labelKey: "permissions.notifications.label",
    descKey: "permissions.notifications.description",
    macOnly: false,
    canOpenSettings: false,
  },
  {
    id: "accessibility",
    icon: Accessibility,
    labelKey: "permissions.accessibility.label",
    descKey: "permissions.accessibility.description",
    macOnly: true,
    canOpenSettings: true,
  },
  {
    id: "screen",
    icon: Monitor,
    labelKey: "permissions.screen.label",
    descKey: "permissions.screen.description",
    macOnly: true,
    canOpenSettings: true,
  },
  {
    id: "microphone",
    icon: Mic,
    labelKey: "permissions.microphone.label",
    descKey: "permissions.microphone.description",
    macOnly: true,
    canOpenSettings: true,
  },
];

/** Read the current state without prompting (where the platform allows it). */
export async function checkPermission(id: PermissionId): Promise<PermStatus> {
  try {
    switch (id) {
      case "notifications":
        return (await refreshPermission()) ? "granted" : "needed";
      case "accessibility":
        return (await api.accessibilityTrusted()) ? "granted" : "needed";
      case "screen":
        return (await api.screenRecordingTrusted()) ? "granted" : "needed";
      case "microphone": {
        // Voice needs both mic capture and (for the Apple ASR engine) speech
        // recognition; treat the pair as one "Microphone" capability.
        const p = await api.voicePermissions();
        return p.mic === "authorized" && p.speech === "authorized"
          ? "granted"
          : "needed";
      }
    }
  } catch {
    return "unknown";
  }
}

/** Trigger the OS grant flow (prompt or, if already decided, a no-op probe). */
export async function requestPermission(id: PermissionId): Promise<PermStatus> {
  try {
    switch (id) {
      case "notifications":
        return (await ensurePermission()) ? "granted" : "needed";
      case "accessibility":
        return (await api.requestAccessibility()) ? "granted" : "needed";
      case "screen":
        return (await api.requestScreenRecording()) ? "granted" : "needed";
      case "microphone": {
        const p = await api.requestVoicePermissions();
        return p.mic === "authorized" && p.speech === "authorized"
          ? "granted"
          : "needed";
      }
    }
  } catch {
    return "unknown";
  }
}

/** Deep-link into the relevant System Settings pane (macOS). No-op where none. */
export async function openPermissionSettings(id: PermissionId): Promise<void> {
  try {
    switch (id) {
      case "accessibility":
        await api.openAccessibilitySettings();
        break;
      case "screen":
        await api.openScreenRecordingSettings();
        break;
      case "microphone":
        await api.openMicrophoneSettings();
        break;
      case "notifications":
        break; // no deep link; the Grant button re-checks instead
    }
  } catch {
    /* best-effort */
  }
}
