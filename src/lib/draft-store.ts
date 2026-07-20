// Unsent composer drafts, keyed by a stable string (e.g. `chat:<convId>` or
// `chat:new`). The Composer reads/writes this so an in-progress message survives
// a view switch (chat ↔ board ↔ automations, which unmounts the composer) and a
// conversation switch (which keeps the composer mounted but changes its key).
//
// Backed by an in-memory cache (survives unmounts within a session) plus
// localStorage write-through, so text also survives a ⌘R reload. Attachment
// bytes are cached in memory and written through to IndexedDB so a renderer
// recovery/reload cannot discard an unsent attachment.

import { createStore, del, get, set } from "idb-keyval";

const PREFIX = "cetus:draft:";

const cache = new Map<string, string>();
export type DraftAttachment =
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "file"; data: string; mimeType: string; name: string; sizeBytes: number };
const attachmentCache = new Map<string, DraftAttachment[]>();
const attachmentRevision = new Map<string, number>();
const attachmentStore = createStore("cetus-drafts", "attachments");
const attachmentWrites = new Map<string, Promise<void>>();
let hydrated = false;

/** Pull any persisted drafts into the in-memory cache once, lazily. */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        cache.set(k.slice(PREFIX.length), localStorage.getItem(k) ?? "");
      }
    }
  } catch {}
}

export function readDraft(key: string): string {
  hydrate();
  return cache.get(key) ?? "";
}

export function writeDraft(key: string, text: string): void {
  hydrate();
  if (text) {
    cache.set(key, text);
  } else {
    cache.delete(key);
  }
  try {
    if (text) localStorage.setItem(PREFIX + key, text);
    else localStorage.removeItem(PREFIX + key);
  } catch {}
}

export function readDraftAttachments(key: string): DraftAttachment[] {
  return attachmentCache.get(key)?.map((attachment) => ({ ...attachment })) ?? [];
}

/** Hydrate attachment bytes after a renderer reload. A revision guard prevents
 * a slow IndexedDB read from resurrecting attachments the user just removed. */
export async function readPersistedDraftAttachments(key: string): Promise<DraftAttachment[]> {
  const cached = attachmentCache.get(key);
  if (cached) return cached.map((attachment) => ({ ...attachment }));
  const revision = attachmentRevision.get(key) ?? 0;
  try {
    const stored = (await get<DraftAttachment[]>(key, attachmentStore)) ?? [];
    if ((attachmentRevision.get(key) ?? 0) !== revision) {
      return readDraftAttachments(key);
    }
    if (stored.length) {
      attachmentCache.set(
        key,
        stored.map((attachment) => ({ ...attachment })),
      );
    }
    return stored.map((attachment) => ({ ...attachment }));
  } catch {
    return [];
  }
}

export function writeDraftAttachments(key: string, attachments: DraftAttachment[]): void {
  attachmentRevision.set(key, (attachmentRevision.get(key) ?? 0) + 1);
  let stored: DraftAttachment[] = [];
  if (attachments.length) {
    stored = attachments.map((attachment) =>
      attachment.type === "image"
        ? {
            type: attachment.type,
            data: attachment.data,
            mimeType: attachment.mimeType,
            name: attachment.name,
          }
        : { ...attachment },
    );
    attachmentCache.set(key, stored);
  } else {
    attachmentCache.delete(key);
  }
  // Serialize writes per draft. Without this, a large `set` followed quickly
  // by remove-all could finish after the `del` and resurrect stale bytes on the
  // next renderer load.
  const previous = attachmentWrites.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() =>
      stored.length ? set(key, stored, attachmentStore) : del(key, attachmentStore),
    );
  attachmentWrites.set(key, next);
  void next
    .finally(() => {
      if (attachmentWrites.get(key) === next) attachmentWrites.delete(key);
    })
    .catch(() => {});
}
