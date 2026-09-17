"use client";

import { api } from "@/lib/tauri";
import type { BackendId, CliDefaults } from "@/lib/types";

export type CliBackendId = Exclude<BackendId, "pi">;

const sidebarCliDefaultsCache = new Map<CliBackendId, Promise<CliDefaults>>();

export function fetchSidebarCliDefaults(
  backend: CliBackendId,
): Promise<CliDefaults> {
  let pending = sidebarCliDefaultsCache.get(backend);
  if (!pending) {
    pending = api.getCliDefaults(backend).catch(() => ({
      model: null,
      effort: null,
      models: null,
    }));
    sidebarCliDefaultsCache.set(backend, pending);
  }
  return pending;
}
