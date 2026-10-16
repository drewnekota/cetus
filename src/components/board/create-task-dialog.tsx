"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Composer, type ComposerAttachment } from "@/components/chat/composer";
import {
  useRuntimeShortcuts,
  type RuntimeSwitchTarget,
} from "@/components/chat/backend-picker";
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
  onSubmit: (
    text: string,
    attachments: ComposerAttachment[],
  ) => void | Promise<void>;
}

/** Linear-style quick-create task dialog, framed like the command palette;
 *  opens with ⌘N on Kanban. Embeds the same <Composer> as the chat hero so the
 *  two "start something new" surfaces feel identical to compose in (attachments,
 *  slash menu, and runtime picker all shared). ⏎ submits and closes
 *  (or resets when "Create more" is on); Esc closes via Radix Dialog. */
export function CreateTaskDialog({
  open,
  onOpenChange,
  modelChoice,
  onModelChange,
  workspaceDir,
  defaultWorkspace,
  onWorkspaceChange,
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
  const [backendSwitch, setBackendSwitch] = useState<
    ({ token: number } & RuntimeSwitchTarget) | null
  >(null);
  const requestBackendSwitch = useCallback((target: RuntimeSwitchTarget) => {
    backendSwitchToken.current += 1;
    setBackendSwitch({ token: backendSwitchToken.current, ...target });
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
        // Same frame as the command palette: anchored high rather than
        // centred, so it doesn't jump as the composer grows, and sized in rem
        // so it scales with the app's zoom like everything else.
        className="top-[12vh] flex w-[calc(100%-2rem)] translate-y-0 flex-col gap-0 overflow-visible rounded-2xl p-2 shadow-2xl sm:max-w-[40rem]"
      >
        <DialogTitle className="sr-only">{t("create.srTitle")}</DialogTitle>
        <div className="flex items-center gap-2 px-2 pb-2 pt-1 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">
            {t("create.newTask")}
          </span>
          <label
            htmlFor="create-more"
            className="ml-auto flex cursor-pointer select-none items-center gap-2"
          >
            {t("create.createMore")}
            <Switch
              id="create-more"
              size="sm"
              checked={createMore}
              onCheckedChange={setCreateMore}
            />
          </label>
        </div>
        {/* Shared composer — same feature set as the chat hero. */}
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
          onSend={handleSend}
          onAbort={() => {}}
          pendingBackend={pendingBackend}
          onPendingBackendChange={onPendingBackendChange}
          pendingCliModel={pendingCliModel}
          pendingCliEffort={pendingCliEffort}
          onPendingTuningChange={onPendingTuningChange}
          backendSwitch={backendSwitch}
          onRequestBackendSwitch={requestBackendSwitch}
        />
      </DialogContent>
    </Dialog>
  );
}
