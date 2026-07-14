"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Composer, type ComposerAttachment } from "@/components/chat/composer";
import { useRuntimeShortcuts } from "@/components/chat/backend-picker";
import { useTranslation } from "@/lib/i18n";
import type { BackendId, ModelChoice } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelChoice: ModelChoice;
  onModelChange: (next: ModelChoice) => void;
  workspaceDir: string | null;
  defaultWorkspace: string;
  onWorkspaceChange: (dir: string) => void;
  /** Ultra Code state + toggle, forwarded to the shared composer. */
  ultra?: boolean;
  onUltraToggle?: () => void;
  /** Runtime chosen for the new task, held by the parent (shared with the chat
   *  hero + quick launcher so the choice is sticky and consistent). */
  pendingBackend: BackendId;
  onPendingBackendChange: (backend: BackendId) => void;
  pendingCliModel: string;
  pendingCliEffort: string;
  onPendingTuningChange: (model: string, effort: string) => void;
  /** Fire-and-forget submit. Parent creates the conversation and sends the
   *  prompt using the pending runtime/model held above; the dialog just collects
   *  the text + attachments. */
  onSubmit: (text: string, attachments: ComposerAttachment[]) => void | Promise<void>;
}

/** Linear-style quick-create task dialog. Compact centered modal; opens with
 *  ⌘N from anywhere. Embeds the same <Composer> as the chat hero so the
 *  two "start something new" surfaces feel identical to compose in (attachments,
 *  slash menu, runtime picker, Ultra toggle all shared). ⏎ submits and closes
 *  (or resets when "Create more" is on); Esc closes via Radix Dialog. */
export function CreateTaskDialog({
  open,
  onOpenChange,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
  ultra,
  onUltraToggle,
  pendingBackend,
  onPendingBackendChange,
  pendingCliModel,
  pendingCliEffort,
  onPendingTuningChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation("board");
  const [createMore, setCreateMore] = useState(false);
  // Bumped on open (and after each "Create more" submit) to pull focus back into
  // the composer without remounting it.
  const [focusToken, setFocusToken] = useState(0);

  // ⌃1/⌃2/⌃3 (user-editable) + Tab switch the task's runtime while the dialog is
  // open. page.tsx's global handler is modal-guarded, so the dialog owns its own
  // token machinery; the Composer's BackendPicker applies each token once and
  // reports the choice back through onPendingBackendChange.
  const backendSwitchToken = useRef(0);
  const [backendSwitch, setBackendSwitch] = useState<{
    token: number;
    backend: BackendId;
  } | null>(null);
  const requestBackendSwitch = useCallback((backend: BackendId) => {
    backendSwitchToken.current += 1;
    setBackendSwitch({ token: backendSwitchToken.current, backend });
  }, []);
  useRuntimeShortcuts(requestBackendSwitch, open);

  useEffect(() => {
    if (open) setFocusToken((v) => v + 1);
  }, [open]);

  const handleSend = useCallback(
    (text: string, attachments: ComposerAttachment[]) => {
      // Fire-and-forget: the parent mints the conversation and streams the run
      // in the background (the kanban card shows the live dot). The Composer has
      // already cleared its own text/attachments by the time this returns.
      void onSubmit(text, attachments);
      if (createMore) setFocusToken((v) => v + 1);
      else onOpenChange(false);
    },
    [onSubmit, createMore, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Compact Linear-style modal: ~640px wide, centered, slides up.
        className="flex w-[90vw] max-w-2xl flex-col gap-0 overflow-visible p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">{t("create.srTitle")}</DialogTitle>

        {/* Breadcrumb header + Create-more toggle */}
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
            cetus
          </div>
          <span className="text-xs text-muted-foreground">›</span>
          <span className="text-xs font-medium text-foreground">
            {t("create.newTask")}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Switch
              id="create-more"
              checked={createMore}
              onCheckedChange={setCreateMore}
              className="scale-75 origin-right"
            />
            <Label
              htmlFor="create-more"
              className="cursor-pointer select-none text-xs text-muted-foreground"
            >
              {t("create.createMore")}
            </Label>
          </div>
        </div>

        {/* Shared composer — same feature set as the chat hero. */}
        <div className="p-4">
          <Composer
            variant="hero"
            focusToken={focusToken}
            streaming={false}
            placeholder={t("create.placeholder")}
            modelChoice={modelChoice}
            onModelChange={onModelChange}
            conversationId={null}
            workspaceDir={workspaceDir}
            defaultWorkspace={defaultWorkspace}
            onWorkspaceChange={onWorkspaceChange}
            requireRepository
            onSend={handleSend}
            onAbort={() => {}}
            ultra={ultra}
            onUltraToggle={onUltraToggle}
            pendingBackend={pendingBackend}
            onPendingBackendChange={onPendingBackendChange}
            pendingCliModel={pendingCliModel}
            pendingCliEffort={pendingCliEffort}
            onPendingTuningChange={onPendingTuningChange}
            backendSwitch={backendSwitch}
            onRequestBackendSwitch={requestBackendSwitch}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
