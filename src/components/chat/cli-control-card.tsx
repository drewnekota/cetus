"use client";
// Inline cards for claude-code control requests, rendered above the composer —
// the same surface the native desktop app uses (not a modal):
//
// - AskUserQuestion → option buttons with descriptions, multi-select chips, and
//   a free-text "Other" input; answers flow back as the tool's `answers` map.
// - any other tool  → an Allow / Deny approval card showing the tool call.
//
// Pending requests live in the chat store (populated by the app's single
// always-mounted event listener), keyed by conversation. Reading them from the
// store — instead of each card owning its own async event subscription — means
// a request can't be dropped by a listener that hasn't finished registering,
// and it survives switching conversations away and back (the turn keeps
// waiting either way). The turn blocks until each is answered; a turn ending
// (agent_end) clears any stragglers, since the child process is then gone.

import { useMemo, useState } from "react";
import { Check, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
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

  async function respond(response: unknown) {
    const req = current!;
    // Drop it from the store first so the card advances immediately, then
    // answer the running turn over stdin.
    useChatStore.getState().clearControlRequest(convId, req.requestId);
    try {
      await api.cliControlRespond(convId, req.requestId, response);
    } catch (e) {
      console.error("cli_control_respond failed:", e);
    }
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

/** AskUserQuestion: one section per question. Single-select answers by click;
 *  multi-select toggles + submit. A free-text input covers "Other". */
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

  function answerFor(i: number, q: CliAskQuestion): string {
    const free = (other[i] ?? "").trim();
    const sel = [...(picked[i] ?? [])];
    if (free) return sel.length && q.multiSelect ? [...sel, free].join(", ") : free;
    return sel.join(", ");
  }
  const complete = questions.every((q, i) => answerFor(i, q).length > 0);

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
    // Single question, single choice, no pending free text → answer instantly,
    // matching the native one-click flow.
    if (!q.multiSelect && questions.length === 1 && !(other[i] ?? "").trim()) {
      onSubmit({ [q.question]: label });
    }
  }

  function submit() {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i, q);
    });
    onSubmit(answers);
  }

  return (
    <div className="rounded-xl border border-[#d97757]/50 bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[#d97757]">
        <MessageCircleQuestion className="size-3.5" />
        {t("cliControl.questionTitle")}
      </div>
      <div className="space-y-3">
        {questions.map((q, i) => (
          <div key={i} className="space-y-1.5">
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
                const on = picked[i]?.has(o.label) ?? false;
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(i, q, o.label)}
                    title={o.description}
                    className={cn(
                      "flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                      on
                        ? "border-[#d97757] bg-[#d97757]/10 text-foreground"
                        : "border-border hover:border-[#d97757]/50 hover:bg-muted",
                    )}
                  >
                    {q.multiSelect && (
                      <span
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded border",
                          on ? "border-[#d97757] bg-[#d97757] text-white" : "border-border",
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
              value={other[i] ?? ""}
              onChange={(e) => setOther((m) => ({ ...m, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && complete) submit();
              }}
              placeholder={t("cliControl.otherPlaceholder")}
              className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-[#d97757]/60"
            />
          </div>
        ))}
      </div>
      {(questions.length > 1 || questions.some((q) => q.multiSelect) ||
        Object.values(other).some((v) => v.trim())) && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" className="h-7 text-xs" disabled={!complete} onClick={submit}>
            {t("cliControl.submit")}
          </Button>
        </div>
      )}
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
    <div className="rounded-xl border border-warning/50 bg-card p-3 shadow-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning">
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
