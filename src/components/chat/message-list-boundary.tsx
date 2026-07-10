"use client";
import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/** Catches render errors inside the message list so a single pathological
 *  conversation can't take down the whole window (before this existed, one
 *  update-depth crash at startup rendered the app permanently unlaunchable —
 *  the restored conversation crashed again on every reload). Keyed by convId
 *  at the call site so switching chats naturally clears the error state. */
export class MessageListBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("message list crashed:", error);
  }

  retry = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) return <MessageListFallback onRetry={this.retry} />;
    return this.props.children;
  }
}

function MessageListFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t("pane.renderError.title")}
        </p>
        <p className="mx-auto max-w-sm text-xs text-muted-foreground">
          {t("pane.renderError.body")}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        <RotateCw className="size-3" />
        {t("pane.renderError.retry")}
      </button>
    </div>
  );
}
