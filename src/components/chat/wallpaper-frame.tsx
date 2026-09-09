"use client";

import type { ReactNode } from "react";
import { useWallpaper } from "@/lib/wallpaper-prefs";

export function WallpaperFrame({ children, className }: { children: ReactNode; className: string }) {
  const { image, fade } = useWallpaper();
  return (
    <div
      className={`chat-wallpaper ${className}`}
      data-wallpaper={image ? "true" : undefined}
      style={image ? {
        backgroundImage: `linear-gradient(color-mix(in srgb, var(--background) ${fade}%, transparent), color-mix(in srgb, var(--background) ${fade}%, transparent)), url("${image}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      } : undefined}
    >
      {children}
    </div>
  );
}
