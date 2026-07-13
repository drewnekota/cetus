"use client";
// Auto-recover from stale code-split chunks. The Tauri webview is long-lived, so
// after the dev server recompiles a lazily-imported chunk (or after a prod
// deploy while a window stays open) the in-memory module graph can still point
// at an old chunk URL that no longer exists — `next/dynamic`'s loader then
// rejects with a ChunkLoadError. We catch that globally and reload the window
// once to pick up the fresh chunk map.
//
// A durable cooldown prevents a reload loop: if the chunk is genuinely gone (so
// the reload can't fix it), we back off after a few tries and let the error
// surface instead of flashing forever. The cooldown is tracked in
// sessionStorage when available, BUT some webviews (custom-protocol / private
// origins) deny storage — and the old code's catch-branch reloaded
// *unconditionally* there, turning one chunk error into an endless reload loop.
// So we mirror the marker into `window.name`, which survives a reload without
// any storage permission, and we refuse to reload at all unless we managed to
// record the attempt somewhere durable. Two limits: COOLDOWN_MS between
// reloads, and MAX_RELOADS consecutive attempts inside RESET_MS before we stop.
//
import { useEffect } from "react";

const COOLDOWN_MS = 10_000;
// Reloads within RESET_MS of each other count as one recovery streak; after
// MAX_RELOADS of them we give up so a permanently-broken chunk can't flash the
// window indefinitely. A quiet gap longer than RESET_MS resets the streak.
const RESET_MS = 60_000;
const MAX_RELOADS = 3;
const STAMP_KEY = "cetus.chunkReloadAt";
// Token embedded in `window.name` as the storage-free fallback marker. Format:
// `cetusCR=<lastReloadMs>:<consecutiveCount>`.
const NAME_RE = /\bcetusCR=(\d+):(\d+)\b/;

type Marker = { t: number; n: number };

// Read the last-reload marker, preferring sessionStorage and falling back to
// window.name when storage is denied (so the cooldown still holds there).
function readMarker(): Marker {
  try {
    const raw = sessionStorage.getItem(STAMP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Marker>;
      return { t: Number(parsed.t) || 0, n: Number(parsed.n) || 0 };
    }
  } catch {
    // storage denied → fall through to the window.name mirror
  }
  try {
    const m = NAME_RE.exec(window.name);
    if (m) return { t: Number(m[1]), n: Number(m[2]) };
  } catch {
    // window.name unreadable (extraordinarily unlikely) → treat as no marker
  }
  return { t: 0, n: 0 };
}

// Persist the marker. Returns true if it landed in *either* store — the caller
// only reloads when this is true, so a reload always leaves a trace the next
// load can back off on. window.name is a plain settable string, so in practice
// this never returns false; the guarantee is what kills the loop.
function writeMarker(mk: Marker): boolean {
  let ok = false;
  try {
    sessionStorage.setItem(STAMP_KEY, JSON.stringify(mk));
    ok = true;
  } catch {
    // storage denied → rely on the window.name mirror below
  }
  try {
    const tag = `cetusCR=${mk.t}:${mk.n}`;
    const base = window.name.replace(NAME_RE, "").trim();
    window.name = base ? `${base} ${tag}` : tag;
    ok = true;
  } catch {
    // leave ok as-is
  }
  return ok;
}

function isChunkLoadError(reason: unknown): boolean {
  if (!reason) return false;
  const name = (reason as { name?: unknown }).name;
  if (name === "ChunkLoadError") return true;
  const msg =
    typeof reason === "string"
      ? reason
      : typeof (reason as { message?: unknown }).message === "string"
        ? ((reason as { message: string }).message)
        : "";
  return /ChunkLoadError|Loading chunk \S+ failed|Failed to load chunk/i.test(msg);
}

function recover() {
  const now = Date.now();
  const { t, n } = readMarker();
  // Cooldown: a reload this recent means the previous one hasn't had a chance to
  // settle (or didn't help) — don't pile another on top.
  if (now - t < COOLDOWN_MS) return;
  // Count this against the recovery streak. A long quiet gap means the last
  // trouble was unrelated, so start a fresh streak.
  const consecutive = now - t < RESET_MS ? n + 1 : 1;
  // Already retried enough without the error clearing — reloading clearly isn't
  // fixing it, so stop and let the real error surface instead of flashing.
  if (consecutive > MAX_RELOADS) return;
  // Only reload if we durably recorded the attempt; otherwise a repeating chunk
  // error would reload forever with nothing to back off against.
  if (!writeMarker({ t: now, n: consecutive })) return;
  window.location.reload();
}

export function ChunkReloadGuard() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error) || isChunkLoadError(e.message)) recover();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) recover();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
