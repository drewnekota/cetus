"use client";
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/tauri";

/** Header button + dialog for the user's standing instructions to every
 *  coordinator. The coordinator re-reads them each turn, so saving applies to
 *  its next reply. */
export function CoordinatorInstructionsButton() {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  function show() {
    setLoaded(false);
    setOpen(true);
    api
      .coordinatorInstructions()
      .then(setText, () => setText(""))
      .finally(() => setLoaded(true));
  }

  async function save() {
    setSaving(true);
    try {
      await api.setCoordinatorInstructions(text);
      setOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("coordinator.instructions")}
            onClick={show}
            className="shrink-0 text-muted-foreground"
          >
            <SlidersHorizontal />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("coordinator.instructions")}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("coordinator.instructions")}</DialogTitle>
            <DialogDescription>{t("coordinator.instructions.hint")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={text}
            disabled={!loaded}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder={t("coordinator.instructions.placeholder")}
            className="min-h-40 text-sm"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("coordinator.instructions.cancel")}
            </Button>
            <Button onClick={save} disabled={!loaded || saving}>
              {t("coordinator.instructions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
