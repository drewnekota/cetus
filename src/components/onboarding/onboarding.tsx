"use client";
// First-run welcome + permission setup. Shown once (gated by a localStorage
// flag, mirroring cetus:notificationPrefs / cetus:lastModelChoice). Step 1 is a
// brand welcome; step 2 lets the user grant the OS permissions up front — using
// the very same PermissionRow the Settings → Permissions page renders, so the
// grant flow and copy never drift. Granting is optional; everything here can
// also be done later from Settings.

import { useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  APPLICABLE_PERMISSIONS,
  PermissionRow,
  usePermissionStatuses,
} from "@/components/settings/permission-row";

const ONBOARDING_KEY = "cetus:onboardingDone";

function markDone() {
  try {
    localStorage.setItem(ONBOARDING_KEY, "1");
  } catch {
    /* best-effort */
  }
}

export function Onboarding() {
  const { t } = useTranslation("settings");
  // Undecided (null) until we read localStorage client-side, so we never flash
  // the overlay before knowing whether it's already been seen.
  const [show, setShow] = useState<boolean | null>(null);
  const [step, setStep] = useState<0 | 1>(0);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDING_KEY) === "1";
    } catch {
      seen = false;
    }
    setShow(!seen);
  }, []);

  // Probe statuses only once the permissions step is on screen.
  const { statuses, onChanged, allGranted } = usePermissionStatuses(
    show === true && step === 1,
  );

  function finish() {
    markDone();
    setShow(false);
  }

  if (show !== true) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-lg rounded-2xl border border-border bg-background p-8 shadow-xl">
        {step === 0 ? (
          <div className="flex flex-col items-center text-center">
            <span className="font-serif text-3xl font-semibold italic">
              cetus
            </span>
            <h1 className="mt-6 text-xl font-semibold">
              {t("onboarding.welcome.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("onboarding.welcome.subtitle")}
            </p>
            <div className="mt-8 flex w-full flex-col gap-2">
              <Button className="w-full gap-1.5" onClick={() => setStep(1)}>
                {t("onboarding.welcome.start")}
                <ArrowRight className="size-4" />
              </Button>
              <Button variant="ghost" className="w-full" onClick={finish}>
                {t("onboarding.skip")}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <h1 className="text-xl font-semibold">
              {t("onboarding.permissions.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("onboarding.permissions.subtitle")}
            </p>

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
              {t("onboarding.permissions.note")}
            </p>

            <div className="mt-8 flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(0)}>
                {t("onboarding.back")}
              </Button>
              <Button className="gap-1.5" onClick={finish}>
                {allGranted && <Check className="size-4" />}
                {t("onboarding.done")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
