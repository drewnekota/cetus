// Unsent composer drafts, keyed by a stable string (e.g. `chat:<convId>` or
// `chat:new`). The Composer reads/writes this so an in-progress message survives
// a view switch (chat ↔ board ↔ automations, which unmounts the composer) and a
// conversation switch (which keeps the composer mounted but changes its key).
//
// Backed by an in-memory cache (survives unmounts within a session) plus
// localStorage write-through, so text also survives a ⌘R reload. Attachment
// bytes stay in memory: they can be large, but still need to survive composer
// unmounts while navigating around the app.

const PREFIX = "cetus:draft:";

const cache = new Map<string, string>();
export type DraftAttachment =
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "file"; data: string; mimeType: string; name: string; sizeBytes: number };
const attachmentCache = new Map<string, DraftAttachment[]>();
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

export function writeDraftAttachments(key: string, attachments: DraftAttachment[]): void {
  if (attachments.length) {
    attachmentCache.set(
      key,
      attachments.map((attachment) =>
        attachment.type === "image"
          ? {
              type: attachment.type,
              data: attachment.data,
              mimeType: attachment.mimeType,
              name: attachment.name,
            }
          : { ...attachment },
      ),
    );
  } else {
    attachmentCache.delete(key);
  }
}
