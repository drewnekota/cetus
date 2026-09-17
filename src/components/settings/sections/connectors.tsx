"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useState } from "react";
import {
  ClaudeCodeIcon,
  CodexIcon,
  OpenCodeIcon,
  type AppIcon,
} from "@/components/brand-icons";
import {
  ChevronDown,
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { api, onAppEvent } from "@/lib/tauri";
import type {
  DiscoverySettings,
  McpConnector,
  McpConnectorInput,
  McpImportEntry,
  McpImportSource,
  McpTestResult,
  McpToolInfo,
  McpTransport,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  SectionHeading,
  SettingsRowsSkeleton,
  SettingsList,
  SegmentRow,
} from "../settings-controls";

// =============================================================================
// MCP servers
// =============================================================================

export function ConnectorsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("settings");
  const [list, setList] = useState<McpConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id | "new" | null

  const load = useCallback(async () => {
    setError(null);
    try {
      setList(await api.listConnectors());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "mcp_updated") load();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [load]);

  async function toggle(id: string, enabled: boolean) {
    setList((cs) =>
      cs ? cs.map((c) => (c.id === id ? { ...c, enabled } : c)) : cs,
    );
    setError(null);
    try {
      await api.setConnectorEnabled(id, enabled);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  async function remove(id: string) {
    setList((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
    setError(null);
    try {
      await api.removeConnector(id);
    } catch (e) {
      setError(String(e));
      load();
    }
  }

  const connectors = list ?? [];

  return (
    <section>
      <SectionHeading
        title={t("connectors.title")}
        description={t("connectors.description")}
      />

      <div className="mt-6 flex items-center justify-between gap-4">
        <h3 className="text-xs font-medium text-muted-foreground">
          {list === null
            ? t("connectors.loading")
            : connectors.length === 0
              ? t("connectors.empty")
              : connectors.length === 1
                ? t("connectors.count.one", { count: connectors.length })
                : t("connectors.count.other", { count: connectors.length })}
        </h3>
        {editing !== "new" && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setEditing("new")}
          >
            <Plus className="size-3.5" />
            {t("connectors.add")}
          </Button>
        )}
      </div>

      {editing === "new" && (
        <ConnectorEditor
          initial={null}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onError={setError}
        />
      )}

      {list === null && <SettingsRowsSkeleton />}
      {connectors.length > 0 && (
        <SettingsList className="mt-3">
          {connectors.map((c) =>
            editing === c.id ? (
              <ConnectorEditor
                key={c.id}
                initial={c}
                embedded
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null);
                  await load();
                }}
                onError={setError}
              />
            ) : (
              <ConnectorRow
                key={c.id}
                connector={c}
                onToggle={toggle}
                onEdit={() => setEditing(c.id)}
                onRemove={remove}
              />
            ),
          )}
        </SettingsList>
      )}

      <DiscoveredMcpCard open={open} onError={setError} />

      {error && <div className="mt-4 text-xs text-destructive">{error}</div>}
    </section>
  );
}

/** mcporter `imports` sources, with the user-facing label. */
const MCP_IMPORT_SOURCES: {
  id: McpImportSource;
  label: string;
  icon?: AppIcon;
}[] = [
  { id: "claude-code", label: "Claude Code", icon: ClaudeCodeIcon },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "windsurf", label: "Windsurf" },
  { id: "codex", label: "Codex", icon: CodexIcon },
  { id: "opencode", label: "opencode", icon: OpenCodeIcon },
];

/**
 * Opt-in import of MCP servers configured in other apps. mcporter can only pull
 * from these named editor configs (not an arbitrary folder). Changes only reach
 * conversations created afterward (per-conversation freeze).
 */
function DiscoveredMcpCard({
  open,
  onError,
}: {
  open: boolean;
  onError: (e: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  // Imported servers per source, fetched on demand: undefined = not yet loaded.
  const [imports, setImports] = useState<
    Record<string, McpImportEntry[] | "loading">
  >({});

  const fetchImport = useCallback(async (id: McpImportSource) => {
    setImports((m) => ({ ...m, [id]: "loading" }));
    try {
      const entries = await api.previewMcpImport(id);
      setImports((m) => ({ ...m, [id]: entries }));
    } catch {
      setImports((m) => ({ ...m, [id]: [] }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.getDiscoverySettings();
      setSettings(s);
      s.mcpImports.forEach(fetchImport);
    } catch (e) {
      onError(String(e));
    }
  }, [onError, fetchImport]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function toggleSource(id: McpImportSource, on: boolean) {
    if (!settings) return;
    const mcpImports = on
      ? [...settings.mcpImports, id]
      : settings.mcpImports.filter((s) => s !== id);
    const next = { ...settings, mcpImports };
    setSettings(next);
    if (on) fetchImport(id);
    try {
      await api.setDiscoverySettings(next);
    } catch (e) {
      onError(String(e));
      load();
    }
  }

  const enabled = settings?.mcpImports ?? [];

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">{t("discovery.mcp.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("discovery.mcp.description")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {MCP_IMPORT_SOURCES.map((src) => {
          const on = enabled.includes(src.id);
          const Icon = src.icon;
          return (
            <button
              key={src.id}
              type="button"
              disabled={!settings}
              onClick={() => toggleSource(src.id, !on)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0 rounded-[2px]" />}
              {src.label}
            </button>
          );
        })}
      </div>

      {enabled.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {enabled.map((id) => {
            const source = MCP_IMPORT_SOURCES.find((s) => s.id === id);
            const label = source?.label ?? id;
            const Icon = source?.icon;
            const entries = imports[id];
            return (
              <div key={id} className="text-xs">
                <p className="flex items-center gap-1.5 font-medium text-muted-foreground">
                  {Icon && <Icon className="size-3.5 shrink-0 rounded-[2px]" />}
                  {label}
                </p>
                {entries === "loading" || entries === undefined ? (
                  <p className="text-muted-foreground">
                    {t("connectors.details.loading")}
                  </p>
                ) : entries.length === 0 ? (
                  <p className="text-muted-foreground">
                    {t("discovery.mcp.none")}
                  </p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {entries.map((e) => (
                      <li key={e.name} className="leading-snug">
                        <span className="font-mono text-foreground">
                          {e.name}
                        </span>
                        {e.detail ? (
                          <span className="text-muted-foreground">
                            {" — "}
                            {e.detail}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectorRow({
  connector,
  onToggle,
  onEdit,
  onRemove,
}: {
  connector: McpConnector;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const summary =
    connector.transport === "http"
      ? connector.url
      : [connector.command, ...connector.args].join(" ");
  return (
    <div className={cn("min-w-0 bg-card", !connector.enabled && "opacity-50")}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{connector.name}</p>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {connector.transport === "http" ? "HTTP" : "stdio"}
            </span>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {summary || "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-label={t("connectors.details.toggleAria")}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </Button>
          <Switch
            checked={connector.enabled}
            onCheckedChange={(v) => onToggle(connector.id, v)}
            aria-label={
              connector.enabled
                ? t("connectors.disableAria")
                : t("connectors.enableAria")
            }
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={onEdit}
            aria-label={t("connectors.editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => onRemove(connector.id)}
              >
                {tc("action.remove")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-muted-foreground"
                onClick={() => setConfirming(false)}
              >
                {tc("action.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
              aria-label={t("connectors.removeAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {expanded && <ConnectorDetails connector={connector} />}
    </div>
  );
}

/**
 * The expandable detail panel under a saved MCP server: runs a live handshake
 * (initialize + tools/list) on open and lists the server identity and the tools
 * it exposes (name + description). Re-probes when the MCP server changes.
 */
function ConnectorDetails({ connector }: { connector: McpConnector }) {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<McpTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const isOauth = connector.auth === "oauth";

  const probe = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      setResult(await api.testConnector(connectorToInput(connector)));
    } catch (e) {
      setResult({
        ok: false,
        serverName: null,
        serverVersion: null,
        protocolVersion: null,
        tools: [],
        error: String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [connector]);

  useEffect(() => {
    probe();
  }, [probe]);

  async function authorize() {
    setAuthorizing(true);
    setAuthMsg(null);
    try {
      await api.authorizeConnector(connectorToInput(connector));
      setAuthMsg(t("connectors.oauth.authorized"));
      await probe();
    } catch (e) {
      setAuthMsg(String(e));
    } finally {
      setAuthorizing(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border px-3 py-2.5 text-xs">
      {isOauth && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={authorize}
            disabled={authorizing}
          >
            <KeyRound
              className={cn("size-3.5", authorizing && "animate-pulse")}
            />
            {authorizing
              ? t("connectors.oauth.authorizing")
              : t("connectors.oauth.authorize")}
          </Button>
          {authMsg && <span className="text-muted-foreground">{authMsg}</span>}
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3.5" />
          {t("connectors.details.loading")}
        </div>
      ) : result && result.ok ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {result.serverName ? (
              <span className="font-medium text-foreground">
                {result.serverName}
                {result.serverVersion ? ` v${result.serverVersion}` : ""}
              </span>
            ) : (
              t("connectors.details.connected")
            )}
            {result.protocolVersion ? ` · MCP ${result.protocolVersion}` : ""}
          </p>
          {result.tools.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">
                {result.tools.length === 1
                  ? t("connectors.details.toolCount.one", {
                      count: result.tools.length,
                    })
                  : t("connectors.details.toolCount.other", {
                      count: result.tools.length,
                    })}
              </p>
              <ul className="space-y-1">
                {result.tools.map((tool) => (
                  <li key={tool.name} className="leading-snug">
                    <span className="font-mono text-foreground">
                      {tool.name}
                    </span>
                    {tool.description ? (
                      <span className="text-muted-foreground">
                        {" — "}
                        {tool.description}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground">
              {t("connectors.test.noTools")}
            </p>
          )}
        </div>
      ) : (
        <p className="text-destructive">
          {result?.error ?? t("connectors.test.failed")}
        </p>
      )}
    </div>
  );
}

/** One editable key/value pair (an env var or a request header). */
type KeyValuePair = { key: string; value: string };

function recordToPairs(rec: Record<string, string>): KeyValuePair[] {
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

/** Collapse the editor rows back into a record, dropping rows with no key. */
function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k) out[k] = value.trim();
  }
  return out;
}

/** Comma-joined first 8 tool names, with an ellipsis when there are more. */
function toolNamesPreview(tools: McpToolInfo[]): string {
  const names = tools
    .slice(0, 8)
    .map((tool) => tool.name)
    .join(", ");
  return tools.length > 8 ? `${names}…` : names;
}

function connectorToInput(c: McpConnector): McpConnectorInput {
  return {
    name: c.name,
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: c.env,
    url: c.url,
    headers: c.headers,
    auth: c.auth,
    oauthClientId: c.oauthClientId,
    oauthScope: c.oauthScope,
    enabled: c.enabled,
  };
}

/**
 * A small editor for a list of key/value pairs (env vars, request headers): one
 * row per pair with separate Name and Value inputs, an X to drop a row, and an
 * Add button to append a blank one. Replaces the old "KEY: value, one per line"
 * textarea so users don't have to know the separator.
 */
function KeyValueRows({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeAria,
}: {
  pairs: KeyValuePair[];
  onChange: (next: KeyValuePair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  removeAria: string;
}) {
  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            placeholder={keyPlaceholder}
            value={p.key}
            onChange={(e) =>
              onChange(
                pairs.map((q, idx) =>
                  idx === i ? { ...q, key: e.target.value } : q,
                ),
              )
            }
            className="font-mono text-xs"
          />
          <Input
            placeholder={valuePlaceholder}
            value={p.value}
            onChange={(e) =>
              onChange(
                pairs.map((q, idx) =>
                  idx === i ? { ...q, value: e.target.value } : q,
                ),
              )
            }
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
            aria-label={removeAria}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function ConnectorEditor({
  initial,
  embedded = false,
  onCancel,
  onSaved,
  onError,
}: {
  initial: McpConnector | null;
  embedded?: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(
    initial?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [envPairs, setEnvPairs] = useState<KeyValuePair[]>(
    recordToPairs(initial?.env ?? {}),
  );
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headerPairs, setHeaderPairs] = useState<KeyValuePair[]>(
    recordToPairs(initial?.headers ?? {}),
  );
  const [auth, setAuth] = useState(
    initial?.auth === "oauth" ? "oauth" : "none",
  );
  const [oauthClientId, setOauthClientId] = useState(
    initial?.oauthClientId ?? "",
  );
  const [oauthScope, setOauthScope] = useState(initial?.oauthScope ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  function buildInput(): McpConnectorInput {
    return {
      name: name.trim(),
      transport,
      command: command.trim(),
      args: argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      env: pairsToRecord(envPairs),
      url: url.trim(),
      headers: pairsToRecord(headerPairs),
      auth: transport === "http" && auth === "oauth" ? "oauth" : "",
      oauthClientId: oauthClientId.trim(),
      oauthScope: oauthScope.trim(),
      enabled: initial?.enabled ?? true,
    };
  }

  async function save() {
    setSaving(true);
    onError("");
    try {
      const input = buildInput();
      if (initial) await api.updateConnector(initial.id, input);
      else await api.addConnector(input);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testConnector(buildInput()));
    } catch (e) {
      setTestResult({
        ok: false,
        serverName: null,
        serverVersion: null,
        protocolVersion: null,
        tools: [],
        error: String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      className={cn(
        "space-y-3 bg-muted/30 p-4",
        !embedded && "mt-3 rounded-lg border border-border",
      )}
    >
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">
          {t("connectors.editor.name")}
        </Label>
        <Input
          placeholder={t("connectors.editor.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <SegmentRow
        label={t("connectors.editor.transport")}
        description={t("connectors.editor.transportDesc")}
        value={transport}
        onChange={(v) => setTransport(v as McpTransport)}
        options={[
          { value: "stdio", label: "stdio" },
          { value: "http", label: "HTTP" },
        ]}
      />

      {transport === "stdio" ? (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.command")}
            </Label>
            <Input
              placeholder={t("connectors.editor.commandPlaceholder")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.args")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.argsHint")}
              </span>
            </Label>
            <Textarea
              placeholder={
                "-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"
              }
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.env")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.envHint")}
              </span>
            </Label>
            <KeyValueRows
              pairs={envPairs}
              onChange={setEnvPairs}
              keyPlaceholder={t("connectors.editor.envName")}
              valuePlaceholder={t("connectors.editor.envValue")}
              addLabel={t("connectors.editor.addEnv")}
              removeAria={t("connectors.editor.removeRow")}
            />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.url")}
            </Label>
            <Input
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("connectors.editor.headers")}
              <span className="ml-2 font-normal text-muted-foreground">
                {t("connectors.editor.headersHint")}
              </span>
            </Label>
            <KeyValueRows
              pairs={headerPairs}
              onChange={setHeaderPairs}
              keyPlaceholder={t("connectors.editor.headerName")}
              valuePlaceholder={t("connectors.editor.headerValue")}
              addLabel={t("connectors.editor.addHeader")}
              removeAria={t("connectors.editor.removeRow")}
            />
          </div>

          <SegmentRow
            label={t("connectors.oauth.auth")}
            description={t("connectors.oauth.authDesc")}
            value={auth}
            onChange={setAuth}
            options={[
              { value: "none", label: t("connectors.oauth.none") },
              { value: "oauth", label: "OAuth" },
            ]}
          />

          {auth === "oauth" && (
            <div className="space-y-3 rounded-md border border-border bg-background/60 p-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t("connectors.oauth.clientId")}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {t("connectors.oauth.optional")}
                    </span>
                  </Label>
                  <Input
                    placeholder={t("connectors.oauth.clientIdPlaceholder")}
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t("connectors.oauth.scope")}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {t("connectors.oauth.optional")}
                    </span>
                  </Label>
                  <Input
                    placeholder="read write"
                    value={oauthScope}
                    onChange={(e) => setOauthScope(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("connectors.oauth.saveHint")}
              </p>
            </div>
          )}
        </>
      )}

      {testResult && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            testResult.ok
              ? "border-success/40 bg-success/5 text-success"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {testResult.ok ? (
            <>
              <p className="font-medium">
                {t("connectors.test.connected")}
                {testResult.serverName ? ` — ${testResult.serverName}` : ""}
                {testResult.serverVersion
                  ? ` v${testResult.serverVersion}`
                  : ""}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {testResult.tools.length > 0
                  ? testResult.tools.length === 1
                    ? t("connectors.test.tools.one", {
                        count: testResult.tools.length,
                        names: toolNamesPreview(testResult.tools),
                      })
                    : t("connectors.test.tools.other", {
                        count: testResult.tools.length,
                        names: toolNamesPreview(testResult.tools),
                      })
                  : t("connectors.test.noTools")}
              </p>
            </>
          ) : (
            <p>{testResult.error ?? t("connectors.test.failed")}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving
            ? t("connectors.editor.saving")
            : initial
              ? tc("action.save")
              : tc("action.add")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={test}
          disabled={testing}
        >
          {testing ? (
            <Spinner className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          {testing ? t("connectors.testing") : t("connectors.test.button")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {tc("action.cancel")}
        </Button>
      </div>
    </div>
  );
}
