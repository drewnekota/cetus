"use client";

import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  APPLICABLE_PERMISSIONS,
  PermissionRow,
  usePermissionStatuses,
} from "../permission-row";
import { SectionHeading } from "../settings-controls";

// =============================================================================
// Permissions
// =============================================================================

// One place to see every OS permission cetus uses, what each unlocks, and its
// live status — instead of hunting across the Launcher / Voice / Screen /
// Meetings sections. Rows are shared with the first-run onboarding.
export function PermissionsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const { statuses, reload, onChanged } = usePermissionStatuses(open);

  return (
    <section>
      <SectionHeading
        title={t("permissions.title")}
        description={t("permissions.description")}
      />

      <div className="mt-6 divide-y divide-border rounded-lg border border-border">
        {APPLICABLE_PERMISSIONS.map((p) => (
          <PermissionRow
            key={p.id}
            meta={p}
            status={statuses[p.id]}
            onChanged={onChanged}
          />
        ))}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {t("permissions.note")}
      </p>

      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => reload().catch(() => {})}
        >
          <RotateCw className="size-3.5" />
          {t("permissions.recheck")}
        </Button>
      </div>
    </section>
  );
}
