"use client";
// One OS-permission row — icon, name, what it unlocks, live status, and the
// Grant / Open-Settings actions. Shared verbatim between the Settings →
// Permissions page and the first-run onboarding so the two never drift.

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  PERMISSIONS,
  checkPermission,
  openPermissionSettings,
  requestPermission,
  type PermStatus,
  type PermissionId,
  type PermissionMeta,
} from "@/lib/permissions";

const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent || "");

/** Permissions that actually apply to this platform, computed once (stable
 *  identity so it's safe in effect deps). */
export const APPLICABLE_PERMISSIONS: PermissionMeta[] = PERMISSIONS.filter(
  (p) => !p.macOnly || isMac,
);

/** Load + cache the live status of every applicable permission. Re-checks
 *  whenever `active` flips true (e.g. the section/onboarding becomes visible),
 *  so returning from System Settings reflects the new state. */
export function usePermissionStatuses(active: boolean) {
  const [statuses, setStatuses] = useState<Record<string, PermStatus>>({});

  const reload = useCallback(async () => {
    const entries = await Promise.all(
      APPLICABLE_PERMISSIONS.map(
        async (p) => [p.id, await checkPermission(p.id)] as const,
      ),
    );
    setStatuses(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    if (active) reload().catch(() => {});
  }, [active, reload]);

  const onChanged = useCallback((id: PermissionId, status: PermStatus) => {
    setStatuses((s) => ({ ...s, [id]: status }));
  }, []);

  const allGranted = APPLICABLE_PERMISSIONS.every(
    (p) => statuses[p.id] === "granted",
  );

  return { statuses, reload, onChanged, allGranted };
}

export function PermissionRow({
  meta,
  status,
  onChanged,
}: {
  meta: PermissionMeta;
  status: PermStatus | undefined;
  onChanged: (id: PermissionId, status: PermStatus) => void;
}) {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const Icon = meta.icon;
  const granted = status === "granted";

  async function grant() {
    setBusy(true);
    try {
      onChanged(meta.id, await requestPermission(meta.id));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
            granted
              ? "border-emerald-600/30 bg-emerald-600/10 text-emerald-600"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{t(meta.labelKey)}</p>
          <p className="text-xs text-muted-foreground">{t(meta.descKey)}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {granted ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
            <Check className="size-3.5" />
            {t("permissions.status.granted")}
          </span>
        ) : (
          <>
            {status === "needed" && (
              <span className="hidden text-xs text-amber-500 sm:inline">
                {t("permissions.status.needed")}
              </span>
            )}
            <Button size="sm" onClick={grant} disabled={busy}>
              {t("permissions.grant")}
            </Button>
            {meta.canOpenSettings && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPermissionSettings(meta.id)}
              >
                {t("permissions.openSettings")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
