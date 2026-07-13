"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "cetus:autoSortConversations";
const CHANGE_EVENT = "cetus:autoSortConversationsChanged";

/** Activity sorting is the historical behavior, so missing/malformed values
 * keep it enabled. */
export function getConversationAutoSort(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setConversationAutoSort(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {}
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useConversationAutoSort(): boolean {
  return useSyncExternalStore(subscribe, getConversationAutoSort, () => true);
}
