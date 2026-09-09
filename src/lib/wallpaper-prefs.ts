"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { del, get, set } from "idb-keyval";

const IMAGE_KEY = "cetus.wallpaper.image";
const CHANGE_KEY = "cetus.wallpaper.changed";
const FADE_KEY = "cetus.wallpaper.fade";
const DEFAULT_FADE = 65;

interface WallpaperState {
  image: string | null;
  fade: number;
  ready: boolean;
}

const useStore = create<WallpaperState>(() => ({ image: null, fade: DEFAULT_FADE, ready: false }));
let initialized = false;
let revision = 0;

function readFade() {
  try {
    const raw = localStorage.getItem(FADE_KEY);
    const value = raw === null ? DEFAULT_FADE : Number(raw);
    return Number.isFinite(value) ? Math.min(95, Math.max(0, value)) : DEFAULT_FADE;
  } catch { return DEFAULT_FADE; }
}

async function refreshImage() {
  const current = ++revision;
  try {
    const image = await get<string>(IMAGE_KEY);
    if (current === revision) useStore.setState({ image: typeof image === "string" && /^data:image\/(webp|png|jpeg);base64,/.test(image) ? image : null });
  } finally {
    if (current === revision) useStore.setState({ ready: true });
  }
}

export function useWallpaper() {
  const state = useStore();
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    useStore.setState({ fade: readFade() });
    void refreshImage().catch(() => {});
    window.addEventListener("storage", (event) => {
      if (event.key === CHANGE_KEY || event.key === null) void refreshImage().catch(() => {});
      if (event.key === FADE_KEY || event.key === null) useStore.setState({ fade: readFade() });
    });
  }, []);
  return state;
}

/** Keep the image in IndexedDB, not the small synchronous localStorage quota. */
export async function saveWallpaper(image: string | null) {
  if (image) await set(IMAGE_KEY, image);
  else await del(IMAGE_KEY);
  revision++;
  useStore.setState({ image, ready: true });
  try { localStorage.setItem(CHANGE_KEY, `${Date.now()}-${Math.random()}`); } catch { /* Current window still updates. */ }
}

export function saveWallpaperFade(fade: number) {
  const value = Number.isFinite(fade) ? Math.min(95, Math.max(0, fade)) : DEFAULT_FADE;
  localStorage.setItem(FADE_KEY, String(value));
  useStore.setState({ fade: value });
}

/** Decode locally and limit the stored texture size. No image leaves the device. */
export async function prepareWallpaper(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error("invalid-image");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("invalid-image");
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image-decode-failed");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.9);
  } finally { URL.revokeObjectURL(url); }
}
