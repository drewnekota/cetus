"use client";
// Inline cards for blocking CLI-host requests, rendered above the composer —
// the same surface native desktop agents use (not a modal):
//
// - AskUserQuestion → option buttons with descriptions, multi-select chips, and
//   a free-text "Other" input; answers flow back as the tool's `answers` map.
// - Codex plugin suggestion → install card with provider handoff + confirmation.
// - Codex request_user_input → protocol-native question cards.
// - any other tool → an Allow / Deny approval card showing the tool call.
//
// Pending requests live in the chat store (populated by the app's single
// always-mounted event listener), keyed by conversation. Reading them from the
// store — instead of each card owning its own async event subscription — means
// a request can't be dropped by a listener that hasn't finished registering,
// and it survives switching conversations away and back (the turn keeps
// waiting either way). The turn blocks until each is answered; a turn ending
// (agent_end) clears any stragglers, since the child process is then gone.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Blocks,
  Check,
  ExternalLink,
  KeyRound,
  MessageCircleQuestion,
  ShieldQuestion,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { useChatStore, useControlRequests } from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CliAskQuestion, CliControlRequest } from "@/lib/types";

export function CliControlCard({ convId }: { convId: string }) {
  const { t } = useTranslation("chat");
  const queue = useControlRequests(convId);
  const current = queue[0] ?? null;
  if (!current) return null;

  async function respond(response: unknown, installPluginId?: string) {
    const req = current!;
    // Drop it from the store first so the card advances immediately, then
    // answer the running turn over stdin.
    useChatStore.getState().clearControlRequest(convId, req.requestId);
    try {
      await api.cliControlRespond(
        convId,
        req.requestId,
        response,
        req.source,
        installPluginId,
      );
    } catch (e) {
      // The answer never reached the CLI, which is still blocked waiting on
      // it — silently eating this leaves the conversation wedged on a request
      // the user believes they answered. Put the card back and say so.
      console.error("cli_control_respond failed:", e);
      useChatStore.getState().pushControlRequest(convId, req);
      toast.error(t("cliControl.respondFailed"));
    }
  }

  if (current.source === "codex") {
    if (current.requestKind === "mcp_elicitation" && isToolSuggestion(current)) {
      return (
        <PluginSuggestionCard
          key={current.requestId}
          request={current}
          onAccept={() => respond({ action: "accept", content: {}, _meta: null })}
          onInstall={(pluginId) =>
            respond(
              { action: "accept", content: {}, _meta: null },
              pluginId,
            )
          }
          onDecline={() => respond({ action: "decline", content: null, _meta: null })}
        />
      );
    }
    if (current.requestKind === "request_user_input") {
      return (
        <CodexQuestionCard
          key={current.requestId}
          request={current}
          onSubmit={(answers) => respond({ answers })}
        />
      );
    }
    return (
      <ApprovalCard
        key={current.requestId}
        request={current}
        onAllow={() => respond({ action: "accept", content: {}, _meta: null })}
        onDeny={() => respond({ action: "decline", content: null, _meta: null })}
      />
    );
  }

  if (current.toolName === "AskUserQuestion") {
    return (
      <AskQuestionCard
        key={current.requestId}
        request={current}
        onSubmit={(answers) =>
          respond({
            behavior: "allow",
            updatedInput: { ...current.input, answers },
          })
        }
      />
    );
  }
  return (
    <ApprovalCard
      key={current.requestId}
      request={current}
      onAllow={() => respond({ behavior: "allow", updatedInput: current.input })}
      onDeny={() =>
        respond({ behavior: "deny", message: t("cliControl.denyMessage") })
      }
    />
  );
}

interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}

interface ToolSuggestionMeta {
  codex_approval_kind?: string;
  tool_type?: string;
  suggest_reason?: string;
  tool_id?: string;
  tool_name?: string;
  install_url?: string;
}

function suggestionMeta(request: CliControlRequest): ToolSuggestionMeta {
  const meta = request.input._meta;
  return meta && typeof meta === "object" ? (meta as ToolSuggestionMeta) : {};
}

function isToolSuggestion(request: CliControlRequest): boolean {
  return suggestionMeta(request).codex_approval_kind === "tool_suggestion";
}

/** Codex request_plugin_install is an MCP elicitation carrying structured
 *  plugin metadata. URL-backed installs finish in the provider's page; other
 *  remote plugins are installed through app-server before we accept. */
function PluginSuggestionCard({
  request,
  onAccept,
  onInstall,
  onDecline,
}: {
  request: CliControlRequest;
  onAccept: () => void;
  onInstall: (pluginId: string) => void;
  onDecline: () => void;
}) {
  const { t } = useTranslation("chat");
  const meta = suggestionMeta(request);
  const name = meta.tool_name || meta.tool_id || request.toolName;
  const reason =
    (typeof request.input.message === "string" && request.input.message) ||
    meta.suggest_reason ||
    "";
  const installUrl = meta.install_url;
  const installHost = useMemo(() => {
    if (!installUrl) return null;
    try {
      return new URL(installUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }, [installUrl]);
  const [installOpened, setInstallOpened] = useState(false);

  async function openInstall() {
    if (!installUrl) {
      if (meta.tool_id) onInstall(meta.tool_id);
      else onAccept();
      return;
    }
    try {
      await api.openExternal(installUrl);
      setInstallOpened(true);
    } catch (error) {
      console.error("open plugin install failed:", error);
      toast.error(t("cliControl.pluginOpenFailed"));
    }
  }

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
        <Blocks className="size-3.5" />
        {t("cliControl.pluginTitle")}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-foreground">{name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {meta.tool_type || t("cliControl.pluginBadge")}
        </span>
        {installHost && (
          <span className="text-[11px] text-muted-foreground/70">{installHost}</span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {reason || t("cliControl.pluginFallbackReason")}
      </p>
      {installOpened && (
        <p className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/80">
          {t("cliControl.pluginFinishHint")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDecline}>
          {t("cliControl.notNow")}
        </Button>
        {installOpened ? (
          <Button size="sm" className="h-7 text-xs" onClick={onAccept}>
            <Check className="mr-1 size-3.5" />
            {t("cliControl.pluginInstalled")}
          </Button>
        ) : (
          <Button size="sm" className="h-7 text-xs" onClick={openInstall}>
            {installUrl && <ExternalLink className="mr-1 size-3.5" />}
            {t("cliControl.installPlugin")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Generic Codex request_user_input flow. Answers are keyed by stable question
 *  id and always returned as string arrays, exactly matching app-server v2. */
function CodexQuestionCard({
  request,
  onSubmit,
}: {
  request: CliControlRequest;
  onSubmit: (answers: Record<string, { answers: string[] }>) => void;
}) {
  const { t } = useTranslation("chat");
  const questions = useMemo<CodexQuestion[]>(
    () => (Array.isArray(request.input.questions) ? request.input.questions as unknown as CodexQuestion[] : []),
    [request],
  );
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");
  const q = questions[step];
  if (!q) return null;

  const selected = answers[q.id] ?? [];
  const isLast = step === questions.length - 1;
  const canContinue = selected.length > 0 || other.trim().length > 0;

  function finish(next: Record<string, string[]>) {
    onSubmit(Object.fromEntries(Object.entries(next).map(([id, value]) => [id, { answers: value }])));
  }

  function choose(label: string) {
    const next = { ...answers, [q.id]: [label] };
    setAnswers(next);
    if (isLast) finish(next);
    else {
      setOther("");
      setStep((value) => value + 1);
    }
  }

  function advanceWithText() {
    const value = other.trim();
    if (!value) return;
    const next = { ...answers, [q.id]: [value] };
    setAnswers(next);
    if (isLast) finish(next);
    else {
      setOther("");
      setStep((current) => current + 1);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-primary">
        <span className="flex items-center gap-1.5">
          <MessageCircleQuestion className="size-3.5" />
          {t("cliControl.codexQuestionTitle")}
        </span>
        {questions.length > 1 && (
          <span className="text-[11px] tabular-nums text-muted-foreground">{step + 1} / {questions.length}</span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        {q.header && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {q.header}
          </span>
        )}
        <span className="text-sm font-medium">{q.question}</span>
      </div>
      {!!q.options?.length && (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {q.options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => choose(option.label)}
              className="rounded-lg border border-border px-2.5 py-2 text-left text-xs transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="font-medium">{option.label}</span>
              {option.description && <span className="mt-0.5 block text-[11px] text-muted-foreground">{option.description}</span>}
            </button>
          ))}
        </div>
      )}
      {(q.isOther || !q.options?.length) && (
        <div className="relative mt-2">
          {q.isSecret && <KeyRound className="absolute left-2 top-2 size-3 text-muted-foreground" />}
          <input
            type={q.isSecret ? "password" : "text"}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              const composing = event.nativeEvent.isComposing || event.keyCode === 229;
              if (event.key === "Enter" && !composing) advanceWithText();
            }}
            placeholder={t("cliControl.otherPlaceholder")}
            className={cn(
              "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-primary/60",
              q.isSecret && "pl-7",
            )}
          />
        </div>
      )}
      {(q.isOther || !q.options?.length) && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" className="h-7 text-xs" disabled={!canContinue} onClick={advanceWithText}>
            {isLast ? t("cliControl.submit") : t("cliControl.next")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** AskUserQuestion: a one-question-at-a-time stepper (the 1-2-3 TUI flow), so a
 *  multi-question prompt never grows past the viewport. Single-select answers by
 *  click; multi-select toggles + Next. A free-text input covers "Other". The
 *  question body scrolls when a single question has many long options. */
function AskQuestionCard({
  request,
  onSubmit,
}: {
  request: CliControlRequest;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const { t } = useTranslation("chat");
  const questions = useMemo<CliAskQuestion[]>(
    () => request.input.questions ?? [],
    [request],
  );
  // Per-question selection state: label set (multi) or single label + other.
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [step, setStep] = useState(0);

  function answerFor(i: number, q: CliAskQuestion): string {
    const free = (other[i] ?? "").trim();
    const sel = [...(picked[i] ?? [])];
    if (free) return sel.length && q.multiSelect ? [...sel, free].join(", ") : free;
    return sel.join(", ");
  }

  const q = questions[step];
  const isLast = step === questions.length - 1;
  const stepAnswered = q ? answerFor(step, q).length > 0 : false;

  function submit() {
    const answers: Record<string, string> = {};
    questions.forEach((qq, i) => {
      answers[qq.question] = answerFor(i, qq);
    });
    onSubmit(answers);
  }

  // Advance to the next question, or submit when the last one is answered.
  function advance() {
    if (isLast) submit();
    else setStep((s) => Math.min(s + 1, questions.length - 1));
  }

  function toggle(i: number, q: CliAskQuestion, label: string) {
    setPicked((p) => {
      const cur = new Set(p[i] ?? []);
      if (q.multiSelect) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...p, [i]: cur };
    });
    // Single-select with no pending free text → jump ahead instantly, matching
    // the native one-click flow (submits directly on the final question).
    if (!q.multiSelect && !(other[i] ?? "").trim()) {
      if (isLast) {
        const answers: Record<string, string> = {};
        questions.forEach((qq, idx) => {
          answers[qq.question] = idx === i ? label : answerFor(idx, qq);
        });
        onSubmit(answers);
      } else {
        setStep((s) => Math.min(s + 1, questions.length - 1));
      }
    }
  }

  if (!q) return null;

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-primary">
        <span className="flex items-center gap-1.5">
          <MessageCircleQuestion className="size-3.5" />
          {t("cliControl.questionTitle")}
        </span>
        {questions.length > 1 && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {step + 1} / {questions.length}
          </span>
        )}
      </div>
      <div className="max-h-[min(50vh,22rem)] space-y-1.5 overflow-y-auto">
        <div className="flex items-baseline gap-2">
          {q.header && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {q.header}
            </span>
          )}
          <span className="text-sm font-medium">{q.question}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => {
            const on = picked[step]?.has(o.label) ?? false;
            return (
              <button
                key={o.label}
                type="button"
                onClick={() => toggle(step, q, o.label)}
                title={o.description}
                className={cn(
                  "flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                  on
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border hover:border-primary/50 hover:bg-muted",
                )}
              >
                {q.multiSelect && (
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {on && <Check className="size-2.5" />}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="font-medium">{o.label}</span>
                  {o.description && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={other[step] ?? ""}
          onChange={(e) => setOther((m) => ({ ...m, [step]: e.target.value }))}
          onKeyDown={(e) => {
            // Don't submit while an IME is composing — CJK users press Enter to
            // commit a candidate. `isComposing` is the spec; `keyCode === 229`
            // is the legacy fallback for WebViews that drop it during commit.
            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
            if (e.key === "Enter" && !composing && stepAnswered) advance();
          }}
          placeholder={t("cliControl.otherPlaceholder")}
          className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary/60"
        />
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        {step > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
          >
            {t("cliControl.back")}
          </Button>
        )}
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!stepAnswered}
          onClick={advance}
        >
          {isLast ? t("cliControl.submit") : t("cliControl.next")}
        </Button>
      </div>
    </div>
  );
}

/** Any other tool asking for permission: show the call, Allow / Deny. */
function ApprovalCard({
  request,
  onAllow,
  onDeny,
}: {
  request: CliControlRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation("chat");
  const preview = toolPreview(request);
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
        <ShieldQuestion className="size-3.5" />
        {t("cliControl.approvalTitle", { tool: request.toolName })}
      </div>
      {preview && (
        <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90">
          {preview}
        </pre>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDeny}>
          {t("cliControl.deny")}
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={onAllow}>
          {t("cliControl.allow")}
        </Button>
      </div>
    </div>
  );
}

/** A compact human-readable rendering of the tool call being approved. */
function toolPreview(req: CliControlRequest): string {
  const input = req.input as Record<string, unknown>;
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") {
    return `${input.file_path}${typeof input.content === "string" ? `\n${truncate(input.content, 600)}` : ""}`;
  }
  try {
    return truncate(JSON.stringify(input, null, 1), 800);
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
