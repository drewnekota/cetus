"use client";
// Listens for extension_ui_request events emitted by pi extensions and renders
// the matching shadcn Dialog. Replies via api.extensionUiRespond.
//
// Design:
// - Only one dialog visible at a time; concurrent requests queue up. This matches
//   how a TUI handles them and avoids stacking modals over each other.
// - Closing the dialog (ESC, overlay click, X button) is treated as
//   `{cancelled: true}` for any dialog method.
// - Fire-and-forget methods: `notify` shows a transient toast; `setStatus`,
//   `setWidget`, `setTitle`, `set_editor_text` are no-ops in this UI (they only
//   make sense for a TUI editor surface).
// - We don't run our own timeout — pi auto-resolves on its side when the
//   request specifies one.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, onAppEvent } from "@/lib/tauri";
import { dispatchNotification } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { ExtensionUIRequest, ExtensionUIResponseBody } from "@/lib/types";

type DialogReq = Extract<
  ExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
> & { conversationId: string };

type Toast = {
  id: string;
  message: string;
  notifyType: "info" | "warning" | "error";
};

export function DialogHost() {
  const [queue, setQueue] = useState<DialogReq[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Tracks ids we've already responded to, so a duplicate event doesn't double-fire.
  const respondedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onAppEvent((evt) => {
        if (evt.type !== "pi_event") return;
        const e = evt.event;
        if (e.type !== "extension_ui_request") return;
        // pi extension UI requests must be answered by the same pi process
        // that sent them. With multiple parallel pi children we need to
        // remember which conversation a request belongs to so the response
        // routes back correctly.
        const conversationId = evt.conversationId ?? "";

        switch (e.method) {
          case "select":
          case "confirm":
          case "input":
          case "editor":
            setQueue((q) => [...q, { ...e, conversationId }]);
            // The modal is only useful when the window is visible; when it's in
            // the background, nudge the user so a blocked agent doesn't stall
            // unnoticed. suppressWhenFocused keeps it quiet when the dialog is
            // already on screen.
            dispatchNotification("awaiting_input", {
              title: "cetus needs your input",
              body: asText(e.title),
              suppressWhenFocused: true,
              conversationId,
            });
            break;
          case "notify": {
            const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const t: Toast = {
              id,
              message: e.message,
              notifyType: e.notifyType ?? "info",
            };
            setToasts((ts) => [...ts, t]);
            setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 5000);
            break;
          }
          // setStatus / setWidget / setTitle / set_editor_text — TUI-only, ignore.
          default:
            break;
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  async function respond(req: DialogReq, body: ExtensionUIResponseBody) {
    if (respondedRef.current.has(req.id)) return;
    respondedRef.current.add(req.id);
    try {
      await api.extensionUiRespond(req.conversationId, req.id, body);
    } catch (e) {
      console.error("extension_ui_respond failed:", e);
    } finally {
      setQueue((q) => q.filter((x) => x.id !== req.id));
    }
  }

  const current = queue[0] ?? null;

  return (
    <>
      {current && (
        <DialogShell
          req={current}
          onSubmit={(body) => respond(current, body)}
          onCancel={() => respond(current, { cancelled: true })}
        />
      )}
      <ToastStack toasts={toasts} />
    </>
  );
}

/** Render any extension-supplied value as text — non-strings (objects from a
 *  malformed ctx.ui call) get JSON-stringified instead of thrown at React. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function DialogShell({
  req,
  onSubmit,
  onCancel,
}: {
  req: DialogReq;
  onSubmit: (body: ExtensionUIResponseBody) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent onEscapeKeyDown={() => onCancel()}>
        <DialogHeader>
          {/* `title` comes straight from an extension's ctx.ui call. Coerce to a
              string so a misbehaving extension (e.g. passing an options object
              where pi expects positional args) can't white-screen the app. */}
          <DialogTitle>{asText(req.title)}</DialogTitle>
          {req.method === "confirm" && req.message && (
            <DialogDescription>{req.message}</DialogDescription>
          )}
          {req.method === "input" && req.placeholder && (
            <DialogDescription>{req.placeholder}</DialogDescription>
          )}
        </DialogHeader>

        {req.method === "select" && <SelectBody options={req.options} onPick={(v) => onSubmit({ value: v })} />}
        {req.method === "confirm" && <ConfirmBody onPick={(b) => onSubmit({ confirmed: b })} onCancel={onCancel} />}
        {req.method === "input" && (
          <InputBody placeholder={req.placeholder} onSubmit={(v) => onSubmit({ value: v })} onCancel={onCancel} />
        )}
        {req.method === "editor" && (
          <EditorBody prefill={req.prefill ?? ""} onSubmit={(v) => onSubmit({ value: v })} onCancel={onCancel} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SelectBody({ options, onPick }: { options: string[]; onPick: (v: string) => void }) {
  // Up to 6 options: button grid. More: scrolling list.
  if (options.length <= 6) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <Button key={o} variant="secondary" onClick={() => onPick(o)}>
            {o}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onPick(o)}
          className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function ConfirmBody({ onPick, onCancel }: { onPick: (b: boolean) => void; onCancel: () => void }) {
  return (
    <DialogFooter>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="outline" onClick={() => onPick(false)}>
        No
      </Button>
      <Button onClick={() => onPick(true)}>Yes</Button>
    </DialogFooter>
  );
}

function InputBody({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder?: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-3">
      <input
        autoFocus
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(text);
          if (e.key === "Escape") onCancel();
        }}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit(text)}>Submit</Button>
      </DialogFooter>
    </div>
  );
}

function EditorBody({
  prefill,
  onSubmit,
  onCancel,
}: {
  prefill: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(prefill);
  return (
    <div className="space-y-3">
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        className="min-h-[180px] font-mono text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(text);
          if (e.key === "Escape") onCancel();
        }}
      />
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit(text)}>Save (⌘⏎)</Button>
      </DialogFooter>
    </div>
  );
}

function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.notifyType === "error" ? XCircle : t.notifyType === "warning" ? AlertTriangle : Info;
        return (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-lg",
              t.notifyType === "error" && "border-destructive/60 text-destructive",
              t.notifyType === "warning" && "border-amber-500/60",
              t.notifyType === "info" && "border-border"
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 break-words">{t.message}</div>
          </div>
        );
      })}
    </div>
  );
}
