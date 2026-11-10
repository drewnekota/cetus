"use client";

import { useEffect } from "react";
import { create } from "zustand";

/** Per-folder avatar overrides, keyed by workspace dir. A folder without an
 *  entry gets the same auto color + initial the phone app derives from its name. */
export interface FolderAvatarStyle {
  /** One of FOLDER_AVATAR_COLORS; absent = derived from the name. */
  color?: string;
  /** Shown instead of the initial. */
  emoji?: string;
}

const KEY = "cetus.folder-avatars";

/** Same palette (and order) as the iOS app's FolderAvatar, so an untouched
 *  folder has the same color on both. */
export const FOLDER_AVATAR_COLORS = [
  "#B0577F",
  "#4F8A8B",
  "#7C6BD6",
  "#C27C3E",
  "#5A7FC2",
  "#6E9A4F",
  "#A05BB0",
  "#8A7560",
] as const;

type Styles = Record<string, FolderAvatarStyle>;

function read(): Styles {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Styles) : {};
  } catch {
    return {};
  }
}

const useStore = create<{ styles: Styles; editingDir: string | null }>(() => ({
  styles: {},
  editingDir: null,
}));
let initialized = false;

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  useStore.setState({ styles: read() });
  // Other windows (Quick, Threads) pick up edits made in the main one.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) useStore.setState({ styles: read() });
  });
}

export function useFolderAvatarStyle(dir: string): FolderAvatarStyle | undefined {
  useEffect(init, []);
  return useStore((s) => s.styles[dir]);
}

export function setFolderAvatarStyle(dir: string, patch: FolderAvatarStyle | null) {
  const styles = { ...useStore.getState().styles };
  const next = patch ? { ...styles[dir], ...patch } : {};
  // Drop cleared fields so "back to auto" leaves no trace.
  for (const k of Object.keys(next) as (keyof FolderAvatarStyle)[]) {
    if (!next[k]) delete next[k];
  }
  if (Object.keys(next).length) styles[dir] = next;
  else delete styles[dir];
  useStore.setState({ styles });
  try {
    localStorage.setItem(KEY, JSON.stringify(styles));
  } catch {}
}

/** Name hash → palette color, byte-for-byte the iOS app's djb2 over unicode
 *  scalars, so the two clients agree. */
export function autoFolderColor(name: string): string {
  let hash = 5381;
  for (const ch of name) hash = (((hash << 5) >>> 0) + hash + ch.codePointAt(0)!) >>> 0;
  return FOLDER_AVATAR_COLORS[hash % FOLDER_AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Which avatar's editor popover is open. Global because the ⋯ menu that opens
// it and the avatar it anchors to live in different components.

let pendingDir: string | null = null;

export function useFolderAvatarEditing(dir: string): boolean {
  return useStore((s) => s.editingDir === dir);
}

export function setFolderAvatarEditing(dir: string | null) {
  useStore.setState({ editingDir: dir });
}

/** From a dropdown item: the editor opens once the menu has closed (see
 *  folderAvatarMenuCloseAutoFocus), not while it still holds focus. */
export function requestFolderAvatarEditor(dir: string) {
  pendingDir = dir;
}

/** `onCloseAutoFocus` for menus that offer "Change icon…". Radix would hand
 *  focus back to the ⋯ trigger, which the freshly opened popover reads as a
 *  focus-outside and closes on; skip that and open the editor instead. */
export function folderAvatarMenuCloseAutoFocus(e: Event) {
  if (!pendingDir) return;
  e.preventDefault();
  setFolderAvatarEditing(pendingDir);
  pendingDir = null;
}
