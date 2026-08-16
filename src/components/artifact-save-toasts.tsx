"use client";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { useTranslation } from "@/lib/i18n";

/** Surfaces the outcome of "Download" (save_artifact_copy) as toasts.
 *
 *  Event-driven rather than reading the invoke result: the native save panel
 *  outlives page state — the copy lands after the panel closes, and if the
 *  webview reloaded meanwhile the invoke promise is simply gone (its callback
 *  id no longer exists), so a result-based toast would silently vanish exactly
 *  when feedback matters most. The Rust side emits `artifact-saved` /
 *  `artifact-save-failed` to the main window after the copy attempt; this
 *  listener is mounted for the window's whole life, so whichever page instance
 *  is current shows the toast. */
export function ArtifactSaveToasts() {
  const { t } = useTranslation("chat");
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<{ path: string; name: string }>("artifact-saved", (e) => {
        toast.success(t("artifact.savedTo", { name: e.payload.name }), {
          description: e.payload.path,
          action: {
            label: t("artifact.reveal"),
            onClick: () =>
              invoke("reveal_in_finder", { path: e.payload.path }).catch(
                console.error,
              ),
          },
        });
      }),
      listen<{ name: string; error: string }>("artifact-save-failed", (e) => {
        toast.error(
          t("artifact.saveFailed", {
            name: e.payload.name,
            error: e.payload.error,
          }),
        );
      }),
    ];
    return () => {
      for (const p of unlistens) p.then((fn) => fn()).catch(() => {});
    };
  }, [t]);
  return null;
}
