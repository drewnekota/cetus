"use client";
// First-run welcome + permission setup. Shown once (gated by a localStorage
// flag, mirroring cetus:notificationPrefs / cetus:lastModelChoice). Step 1 is a
// brand welcome; step 2 lets the user grant the OS permissions up front — using
// the very same PermissionRow the Settings → Permissions page renders, so the
// grant flow and copy never drift. Granting is optional; everything here can
// also be done later from Settings.

import { useEffect, useState } from "react";
import { ArrowRight, Bot, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { ClaudeCodeIcon, CodexIcon } from "@/components/brand-icons";
import { cn } from "@/lib/utils";
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
  const [deepseekReady, setDeepseekReady] = useState<boolean | null>(null);
  const [cliStatus, setCliStatus] = useState<{
    claudeCode: boolean;
    codex: boolean;
  } | null>(null);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [deepseekKey, setDeepseekKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDING_KEY) === "1";
    } catch {
      seen = false;
    }
    setShow(!seen);
  }, []);

  useEffect(() => {
    if (show !== true) return;
    api
      .listApiKeys()
      .then((providers) => setDeepseekReady(providers.includes("deepseek")))
      .catch(() => setDeepseekReady(false));
    api
      .getCliRuntimeStatus()
      .then(setCliStatus)
      .catch(() => setCliStatus({ claudeCode: false, codex: false }));
  }, [show]);

  // Probe statuses only once the permissions step is on screen.
  const { statuses, onChanged, allGranted } = usePermissionStatuses(
    show === true && step === 1,
  );

  function finish() {
    markDone();
    setShow(false);
  }

  async function saveDeepseekKey() {
    const key = deepseekKey.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await api.setApiKey("deepseek", key);
      setDeepseekReady(true);
      setDeepseekKey("");
      setShowKeyInput(false);
    } catch (error) {
      setKeyError(String(error));
    } finally {
      setSavingKey(false);
    }
  }

  if (show !== true) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-2xl rounded-2xl border border-border bg-background p-8 shadow-xl">
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

            <div className="mt-7 grid w-full grid-cols-3 gap-3 text-left">
              <RuntimeCard
                icon={Bot}
                name="Cetus"
                description={t("onboarding.runtime.cetus.description")}
                ready={deepseekReady}
                readyLabel={t("onboarding.runtime.ready")}
                missingLabel={t("onboarding.runtime.keyNeeded")}
                onConfigure={() => setShowKeyInput((value) => !value)}
                configureLabel={t("onboarding.runtime.configure")}
              />
              <RuntimeCard
                icon={ClaudeCodeIcon}
                name="Claude Code"
                description={t("onboarding.runtime.claude.description")}
                ready={cliStatus?.claudeCode ?? null}
                readyLabel={t("onboarding.runtime.ready")}
                missingLabel={t("onboarding.runtime.notInstalled")}
              />
              <RuntimeCard
                icon={CodexIcon}
                name="Codex"
                description={t("onboarding.runtime.codex.description")}
                ready={cliStatus?.codex ?? null}
                readyLabel={t("onboarding.runtime.ready")}
                missingLabel={t("onboarding.runtime.notInstalled")}
              />
            </div>

            {showKeyInput && !deepseekReady && (
              <div className="mt-3 w-full rounded-xl border border-border bg-muted/30 p-3 text-left">
                <label htmlFor="onboarding-deepseek-key" className="text-xs font-medium">
                  {t("onboarding.runtime.deepseekKey")}
                </label>
                <div className="mt-2 flex gap-2">
                  <Input
                    id="onboarding-deepseek-key"
                    type="password"
                    value={deepseekKey}
                    onChange={(event) => setDeepseekKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveDeepseekKey();
                    }}
                    placeholder="sk-…"
                    autoFocus
                    className="font-mono"
                  />
                  <Button
                    size="sm"
                    onClick={saveDeepseekKey}
                    disabled={!deepseekKey.trim() || savingKey}
                  >
                    {savingKey && <Spinner className="size-4" />}
                    {t("onboarding.runtime.save")}
                  </Button>
                </div>
                {keyError && <p className="mt-2 text-xs text-destructive">{keyError}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("onboarding.runtime.keyNote")}
                </p>
              </div>
            )}

            <div className="mt-6 flex w-full flex-col gap-2">
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

function RuntimeCard({
  icon: Icon,
  name,
  description,
  ready,
  readyLabel,
  missingLabel,
  onConfigure,
  configureLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  description: string;
  ready: boolean | null;
  readyLabel: string;
  missingLabel: string;
  onConfigure?: () => void;
  configureLabel?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-44 flex-col rounded-xl border p-4 transition-colors",
        ready ? "border-success/35 bg-success/[0.035]" : "border-border bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-background">
          <Icon className="size-5" />
        </div>
        {ready === null ? (
          <Spinner className="mt-1 size-3.5 text-muted-foreground" />
        ) : (
          <span className={cn("flex items-center gap-1 text-[11px] font-medium", ready ? "text-success" : "text-muted-foreground")}>
            {ready && <Check className="size-3" />}
            {ready ? readyLabel : missingLabel}
          </span>
        )}
      </div>
      <h2 className="mt-4 text-sm font-semibold">{name}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      {!ready && ready !== null && onConfigure && (
        <button
          type="button"
          onClick={onConfigure}
          className="mt-auto pt-3 text-left text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          {configureLabel}
        </button>
      )}
    </div>
  );
}
