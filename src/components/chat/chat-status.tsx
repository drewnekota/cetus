"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUp, Pencil, RotateCw, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { type QueuedMessage } from "@/components/chat/composer";
import { useChatError } from "@/lib/chat-store";
import { useTranslation } from "@/lib/i18n";

/** Inline failure row pinned to the end of the message list: surfaces a send /
 *  run error right under the last message (rather than in the far-off header)
 *  and offers a Retry that rolls back + reruns the last turn. Self-guards on the
 *  conversation-level error, so it renders nothing on a healthy chat. */
export function MessageError({
  convId,
  onRetry,
  retrying,
}: {
  convId: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation("chat");
  const error = useChatError(convId);
  if (!error) return null;
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="break-words">{error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex w-fit items-center gap-1 rounded-md border border-destructive/30 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {retrying ? (
                <Spinner className="size-3" />
              ) : (
                <RotateCw className="size-3" />
              )}
              {retrying ? t("pane.retrying") : t("pane.retry")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The follow-up queue rendered just above the composer: messages the user
 *  typed while the agent was mid-run. Each waits for the run to end (then it's
 *  delivered as a new turn), or the user can "Steer now" to inject it into the
 *  current run immediately, or return it to the composer for editing. */
export function QueuedMessages({
  items,
  onSteer,
  onEdit,
  onRemove,
}: {
  items: QueuedMessage[];
  onSteer?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((m) => (
        <QueuedMessageRow
          key={m.id}
          item={m}
          onSteer={onSteer}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function QueuedMessageRow({
  item,
  onSteer,
  onEdit,
  onRemove,
}: {
  item: QueuedMessage;
  onSteer?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  const label =
    item.text.trim() ||
    (item.attachments.length
      ? t("pane.attachmentCount", { count: item.attachments.length })
      : t("pane.emptyMessage"));

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="shrink-0 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {t("pane.queued")}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/80">
        {label}
      </span>
      {onEdit && (
        <button
          type="button"
          onClick={() => onEdit(item.id)}
          title={t("pane.editQueued")}
          aria-label={t("pane.editQueued")}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
      )}
      {onSteer && (
        <button
          type="button"
          onClick={() => onSteer(item.id)}
          title={t("pane.steerTooltip")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <ArrowUp className="size-3" />
          {t("pane.steerNow")}
        </button>
      )}
      <button
        type="button"
        onClick={() => onRemove?.(item.id)}
        aria-label={t("pane.removeFromQueue")}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Live "the agent is working" line: a braille spinner plus the elapsed
 *  time. The only progress cue while a turn runs — the steps themselves stay
 *  folded behind the activity summary above it. The spinner sits in the same
 *  size-3.5 / gap-2.5 slot as the activity row's wrench so the text lines up. */
export function WorkingIndicator({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return (
    <div role="status" className="flex items-center gap-2.5 py-0.5 text-sm text-muted-foreground">
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center font-mono text-[15px] leading-none animate-working-braille"
      />
      <span className="tabular-nums">{elapsed}</span>
    </div>
  );
}

/** Shown between the user's send and the first message_start event so the
 *  conversation doesn't feel like it's hanging. For CLI backends
 *  (claude-code / codex) this covers the whole process boot — message_start is
 *  deferred until real content streams. */
export function ThinkingPlaceholder() {
  const { t } = useTranslation("chat");
  const [startedAt] = useState(() => Date.now());
  return (
    <div className="flex w-full justify-start py-3">
      <div className="flex max-w-[88%] flex-col gap-2 items-start">
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("pane.assistant")}
        </div>
        <WorkingIndicator startedAt={startedAt} />
      </div>
    </div>
  );
}
