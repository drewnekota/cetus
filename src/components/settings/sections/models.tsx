"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type {
  CustomModel,
  CustomProvider,
  CustomProviderView,
} from "@/lib/types";
import { REASONING_LEVELS } from "@/lib/types";
import { SectionHeading } from "../settings-controls";

// =============================================================================
// Models (custom OpenAI-compatible providers)
// =============================================================================

/** Blank editor draft for a new provider. */
function emptyProviderDraft(): CustomProvider {
  return { id: "", name: "", baseUrl: "", models: [] };
}

function emptyModelDraft(): CustomModel {
  return {
    id: "",
    name: "",
    vision: false,
    reasoning: false,
    thinkingLevels: {},
    thinkingFormat: "",
    contextWindow: 0,
    maxTokens: 0,
  };
}

/** Effort-field shapes the pi runtime can emit (compat.thinkingFormat).
 *  Vendor names are product identifiers — left untranslated. */
const THINKING_FORMATS: { id: string; label: string }[] = [
  { id: "", label: "reasoning_effort" },
  { id: "deepseek", label: "DeepSeek (thinking.type)" },
  { id: "openrouter", label: "OpenRouter (reasoning.effort)" },
  { id: "together", label: "Together" },
];

export function ModelsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [providers, setProviders] = useState<CustomProviderView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = list view; a draft = the add/edit form ("" id = new provider).
  const [draft, setDraft] = useState<CustomProvider | null>(null);
  // undefined = untouched (keep the stored key); "" = clear; else replace.
  const [draftKey, setDraftKey] = useState<string | undefined>(undefined);
  const [editingHasKey, setEditingHasKey] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProviders(await api.listCustomProviders());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function startAdd() {
    setDraft({ ...emptyProviderDraft(), models: [emptyModelDraft()] });
    setDraftKey(undefined);
    setEditingHasKey(false);
    setError(null);
  }

  function startEdit(p: CustomProviderView) {
    setDraft({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      models: p.models.map((m) => ({ ...m })),
    });
    setDraftKey(undefined);
    setEditingHasKey(p.hasKey);
    setError(null);
  }

  function updateDraftModel(index: number, patch: Partial<CustomModel>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            models: d.models.map((m, i) =>
              i === index ? { ...m, ...patch } : m,
            ),
          }
        : d,
    );
  }

  async function saveDraft() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.upsertCustomProvider(
        { ...draft, models: draft.models.filter((m) => m.id.trim()) },
        draftKey,
      );
      setDraft(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCustomProvider(id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <SectionHeading
        title={t("models.title")}
        description={t("models.description")}
      />

      {draft === null ? (
        <>
          <div className="mt-6 space-y-2">
            {providers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("models.empty")}
              </p>
            )}
            {providers.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{p.name}</span>
                    {!p.hasKey && (
                      <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                        {t("models.noKey")}
                      </span>
                    )}
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {p.baseUrl}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.models.map((m) => m.name || m.id).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startEdit(p)}
                    disabled={busy}
                  >
                    {tc("action.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => remove(p.id)}
                    disabled={busy}
                  >
                    {tc("action.remove")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-4 gap-1.5"
            onClick={startAdd}
          >
            <Plus className="size-3.5" />
            {t("models.add")}
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">
            {t("models.footnote")}
          </p>
        </>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cm-name" className="font-medium">
              {t("models.name.label")}
            </Label>
            <Input
              id="cm-name"
              value={draft.name}
              placeholder={t("models.name.placeholder")}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cm-url" className="font-medium">
              {t("models.baseUrl.label")}
            </Label>
            <Input
              id="cm-url"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              className="font-mono"
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {t("models.baseUrl.hint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cm-key" className="font-medium">
              {t("models.key.label")}
            </Label>
            <Input
              id="cm-key"
              type="password"
              value={draftKey ?? ""}
              placeholder={
                editingHasKey && draftKey === undefined
                  ? t("models.key.keepStored")
                  : t("models.key.placeholder")
              }
              className="font-mono"
              onChange={(e) => setDraftKey(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">
              {t("models.models.label")}
            </span>
            <div className="space-y-2">
              {draft.models.map((m, i) => (
                <div
                  key={i}
                  className="space-y-2 rounded-md border border-border p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={m.id}
                      placeholder={t("models.model.idPlaceholder")}
                      className="font-mono"
                      onChange={(e) =>
                        updateDraftModel(i, { id: e.target.value })
                      }
                    />
                    <Input
                      value={m.name}
                      placeholder={t("models.model.namePlaceholder")}
                      onChange={(e) =>
                        updateDraftModel(i, { name: e.target.value })
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          models: draft.models.filter((_, j) => j !== i),
                        })
                      }
                      aria-label={tc("action.remove")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={m.vision}
                        onCheckedChange={(v) =>
                          updateDraftModel(i, { vision: v })
                        }
                      />
                      {t("models.model.vision")}
                    </label>
                    <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={m.reasoning}
                        onCheckedChange={(v) =>
                          updateDraftModel(
                            i,
                            v
                              ? {
                                  reasoning: true,
                                  // DeepSeek-like default set; toggle levels
                                  // below to match the endpoint.
                                  thinkingLevels: Object.keys(m.thinkingLevels)
                                    .length
                                    ? m.thinkingLevels
                                    : { off: "", high: "", max: "" },
                                }
                              : { reasoning: false },
                          )
                        }
                      />
                      {t("models.model.reasoning")}
                    </label>
                    {m.reasoning && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {t("models.model.format")}
                        </span>
                        <Select
                          value={
                            m.thinkingFormat === "" ? "std" : m.thinkingFormat
                          }
                          onValueChange={(v) =>
                            updateDraftModel(i, {
                              thinkingFormat: v === "std" ? "" : v,
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-7 w-auto text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {THINKING_FORMATS.map((f) => (
                              <SelectItem
                                key={f.id || "std"}
                                value={f.id || "std"}
                              >
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                  {m.reasoning && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                      {REASONING_LEVELS.map((lvl) => {
                        const enabled = lvl in m.thinkingLevels;
                        return (
                          <div key={lvl} className="flex items-center gap-1.5">
                            <Switch
                              checked={enabled}
                              onCheckedChange={(v) => {
                                const next = { ...m.thinkingLevels };
                                if (v) next[lvl] = next[lvl] ?? "";
                                else delete next[lvl];
                                updateDraftModel(i, { thinkingLevels: next });
                              }}
                            />
                            <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                              {lvl}
                            </span>
                            {enabled && lvl !== "off" && (
                              <Input
                                value={m.thinkingLevels[lvl] ?? ""}
                                placeholder={lvl}
                                className="h-6 min-w-0 flex-1 font-mono text-xs"
                                onChange={(e) => {
                                  const next = { ...m.thinkingLevels };
                                  next[lvl] = e.target.value;
                                  updateDraftModel(i, { thinkingLevels: next });
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() =>
                setDraft({
                  ...draft,
                  models: [...draft.models, emptyModelDraft()],
                })
              }
            >
              <Plus className="size-3.5" />
              {t("models.model.add")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("models.model.visionHint")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("models.model.reasoningHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveDraft} disabled={busy}>
              {tc("action.save")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(null)}
              disabled={busy}
            >
              {tc("action.cancel")}
            </Button>
          </div>
        </div>
      )}

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}
