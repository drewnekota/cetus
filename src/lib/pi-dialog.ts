// pi extension dialogs (ctx.ui.select / confirm / input / editor) wait on the
// human exactly like a CLI runtime's question or approval, so they join the
// same per-conversation queue: one place for badges, Threads cards and the
// chat pane to read, instead of a separate modal.

import type { CliControlRequest, ExtensionUIRequest } from "@/lib/types";

export type PiDialogMethod = "select" | "confirm" | "input" | "editor";

export type PiDialog = Extract<ExtensionUIRequest, { method: PiDialogMethod }>;

export function isPiDialog(e: ExtensionUIRequest): e is PiDialog {
  return (
    e.method === "select" ||
    e.method === "confirm" ||
    e.method === "input" ||
    e.method === "editor"
  );
}

/** The queue entry for a pi dialog; the dialog rides along in `input`. */
export function piDialogRequest(e: PiDialog): CliControlRequest {
  return {
    type: "cli_control_request",
    requestId: e.id,
    source: "pi",
    requestKind: "extension_ui",
    toolName: typeof e.title === "string" ? e.title : "",
    input: { ...e },
    toolUseId: null,
  };
}

/** The dialog back out of a queue entry, or null for any other request. */
export function piDialogOf(req: CliControlRequest): PiDialog | null {
  if (req.source !== "pi" || req.requestKind !== "extension_ui") return null;
  return req.input as unknown as PiDialog;
}
