"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { SectionHeading } from "../settings-controls";

// cetus is a DeepSeek-only desktop client; keep the key surface minimal.
// `labelKey` is a settings-namespace i18n key resolved at render (hooks can't
// run at module level); `envHint` is a literal env-var name, never translated.
const PROVIDERS: { id: string; labelKey: string; envHint: string }[] = [
  {
    id: "deepseek",
    labelKey: "providers.deepseek",
    envHint: "DEEPSEEK_API_KEY",
  },
  // Optional. When set, web_search prefers Exa over Tavily.
  { id: "exa", labelKey: "providers.exa", envHint: "EXA_API_KEY" },
  // Optional. Fallback provider for web_search/web_fetch extraction.
  { id: "tavily", labelKey: "providers.tavily", envHint: "TAVILY_API_KEY" },
  // Doubao (Volcano Engine) real-time streaming ASR — the voice-dictation engine
  // (new-console X-Api-Key). Fast (~90ms), live partials, great zh/en, CN-native.
  { id: "doubao", labelKey: "providers.doubao", envHint: "DOUBAO_API_KEY" },
  // Volcano Ark LLM key — fast dictation cleanup/rewrite (Doubao flash). Separate
  // from the Doubao speech key above; get it from the Ark console (火山方舟).
  { id: "volc_ark", labelKey: "providers.volcArk", envHint: "ARK_API_KEY" },
];

// =============================================================================
// API keys
// =============================================================================

interface RowState {
  pending: string | null;
}

export function ApiKeysSection({
  storedProviders,
  onSaved,
}: {
  storedProviders: string[];
  onSaved: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Custom DeepSeek base URL. `dsUrl` is the live field; `dsUrlSaved` is what's
  // persisted, so the Save button only lights up on a real change.
  const [dsUrl, setDsUrl] = useState("");
  const [dsUrlSaved, setDsUrlSaved] = useState("");
  const [dsUrlBusy, setDsUrlBusy] = useState(false);

  useEffect(() => {
    setRows({});
    setError(null);
    api
      .listApiKeysMasked()
      .then(setMasked)
      .catch((e) => setError(String(e)));
  }, [storedProviders]);

  useEffect(() => {
    api
      .getDeepseekBaseUrl()
      .then((u) => {
        setDsUrl(u);
        setDsUrlSaved(u);
      })
      .catch(() => {});
  }, []);

  async function saveDsUrl() {
    setDsUrlBusy(true);
    setError(null);
    try {
      const v = dsUrl.trim();
      await api.setDeepseekBaseUrl(v);
      setDsUrl(v);
      setDsUrlSaved(v);
    } catch (e) {
      setError(String(e));
    } finally {
      setDsUrlBusy(false);
    }
  }

  async function copy(provider: string) {
    setError(null);
    try {
      const key = await api.revealApiKey(provider);
      if (!key) return;
      await navigator.clipboard.writeText(key);
      setCopied(provider);
      window.setTimeout(
        () => setCopied((c) => (c === provider ? null : c)),
        1500,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(provider: string) {
    setRows((s) => ({ ...s, [provider]: { pending: "" } }));
  }

  function cancelEdit(provider: string) {
    setRows((s) => {
      const next = { ...s };
      delete next[provider];
      return next;
    });
  }

  function setPending(provider: string, value: string) {
    setRows((s) => ({ ...s, [provider]: { pending: value } }));
  }

  async function save(provider: string) {
    const v = rows[provider]?.pending?.trim() ?? "";
    if (!v) return;
    setSaving(provider);
    setError(null);
    try {
      await api.setApiKey(provider, v);
      const next = await api.listApiKeysMasked().catch(() => masked);
      setMasked(next);
      cancelEdit(provider);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  async function remove(provider: string) {
    setSaving(provider);
    setError(null);
    try {
      await api.deleteApiKey(provider);
      setMasked((m) => {
        const next = { ...m };
        delete next[provider];
        return next;
      });
      cancelEdit(provider);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <SectionHeading
        title={t("apiKeys.title")}
        description={t("apiKeys.description")}
      />
      <div className="mt-6 space-y-5">
        {PROVIDERS.map((p) => {
          const stored = storedProviders.includes(p.id) || masked[p.id] != null;
          const row = rows[p.id];
          const editing = row != null;
          const busy = saving === p.id;
          const pending = row?.pending ?? "";

          function onInputKey(e: React.KeyboardEvent) {
            if (e.key === "Enter" && pending.trim()) {
              e.preventDefault();
              save(p.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelEdit(p.id);
            }
          }

          return (
            <div key={p.id} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <label htmlFor={`key-${p.id}`} className="font-medium">
                  {t(p.labelKey)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {p.envHint}
                  </span>
                </label>
                {stored && !editing && (
                  <span className="text-xs text-success">
                    {t("apiKeys.stored")}
                  </span>
                )}
                {editing && (
                  <span className="text-xs text-warning">
                    {t("apiKeys.unsaved")}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {stored && !editing ? (
                  <>
                    <div className="flex h-9 flex-1 items-center px-3 font-mono text-sm text-muted-foreground">
                      {masked[p.id] ?? "•••"}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copy(p.id)}
                      disabled={busy}
                      className="gap-1.5"
                    >
                      {copied === p.id ? (
                        <>
                          <Check className="size-3.5" />
                          {tc("action.copied")}
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          {tc("action.copy")}
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => startEdit(p.id)}
                      disabled={busy}
                    >
                      {t("apiKeys.replace")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remove(p.id)}
                      disabled={busy}
                    >
                      {tc("action.remove")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      id={`key-${p.id}`}
                      type={stored ? "password" : "text"}
                      placeholder="sk-…"
                      value={pending}
                      autoFocus={editing}
                      onKeyDown={onInputKey}
                      onChange={(e) => setPending(p.id, e.target.value)}
                      disabled={busy}
                      className="font-mono"
                    />
                    {pending.trim().length > 0 && (
                      <Button
                        size="sm"
                        onClick={() => save(p.id)}
                        disabled={busy}
                      >
                        {tc("action.save")}
                      </Button>
                    )}
                    {stored && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => cancelEdit(p.id)}
                        disabled={busy}
                      >
                        {tc("action.cancel")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* Custom DeepSeek endpoint — redirects every DeepSeek call (the main
            agent plus titling / meeting minutes) to an OpenAI-compatible base
            URL. Blank = stock api.deepseek.com. */}
        <div className="space-y-1.5 border-t border-border pt-5">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor="deepseek-base-url" className="font-medium">
              {t("apiKeys.deepseekUrl.label")}
            </label>
            {dsUrl.trim() !== dsUrlSaved && (
              <span className="text-xs text-warning">
                {t("apiKeys.unsaved")}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              id="deepseek-base-url"
              type="text"
              placeholder="https://api.deepseek.com"
              value={dsUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dsUrl.trim() !== dsUrlSaved) {
                  e.preventDefault();
                  saveDsUrl();
                }
              }}
              onChange={(e) => setDsUrl(e.target.value)}
              disabled={dsUrlBusy}
              className="font-mono"
            />
            {dsUrl.trim() !== dsUrlSaved && (
              <Button size="sm" onClick={saveDsUrl} disabled={dsUrlBusy}>
                {tc("action.save")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("apiKeys.deepseekUrl.hint")}
          </p>
        </div>
      </div>
      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}
