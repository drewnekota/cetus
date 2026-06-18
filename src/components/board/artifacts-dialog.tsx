"use client";
import { Inbox } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArtifactView } from "@/components/chat/artifact-view";
import { useTranslation } from "@/lib/i18n";
import { useChatStore } from "@/lib/chat-store";
import { isArtifactDetails, type ArtifactDetails } from "@/lib/artifact";

interface Props {
  /** Conversation whose artifacts to show. Null closes the dialog. */
  convId: string | null;
  /** Conversation title, shown next to the heading for context. */
  title?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EMPTY: ArtifactDetails[] = [];

/** Board-mode artifact viewer: a large centered dialog showing every artifact a
 *  conversation produced as a grid of preview cards. Replaces the docked
 *  right-hand panel on the kanban so artifacts don't compete with the columns.
 *  Sized like nex-studio's deliverables gallery — `sm:max-w-5xl` overrides the
 *  base DialogContent's `sm:max-w-md` (cn()'s tailwind-merge drops the loser),
 *  which otherwise capped this at a tiny 28rem. */
export function ArtifactsDialog({ convId, title, open, onOpenChange }: Props) {
  const { t } = useTranslation("board");
  // Stable-shallow selector: re-renders only when the artifact set changes.
  const artifacts = useChatStore(
    useShallow((s) => {
      const c = convId ? s.chats[convId] : undefined;
      if (!c) return EMPTY;
      const out: ArtifactDetails[] = [];
      for (const m of c.messages) {
        for (const b of m.blocks) {
          if (b.kind !== "tool_use") continue;
          if (b.name !== "send_artifact") continue;
          if (!b.result || !isArtifactDetails(b.result.details)) continue;
          out.push(b.result.details);
        }
      }
      return out;
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100svh/var(--zoom,1)-6rem)] max-h-[calc(100svh/var(--zoom,1)-6rem)] w-[calc(100svw/var(--zoom,1)-6rem)] !max-w-5xl flex-col gap-0 overflow-hidden bg-background p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Inbox className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {t("artifacts.title")}
              {title ? (
                <span className="font-normal text-muted-foreground"> · {title}</span>
              ) : null}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t(
              artifacts.length === 1 ? "artifacts.count" : "artifacts.count_plural",
              { count: artifacts.length },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {artifacts.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t("artifacts.empty")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {artifacts.map((a, i) => (
                <ArtifactView key={`${a.path}#${i}`} artifact={a} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
