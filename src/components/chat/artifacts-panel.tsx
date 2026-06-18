"use client";
import { X, Inbox } from "lucide-react";
import { isArtifactDetails, type ArtifactDetails } from "@/lib/artifact";
import { useChatStore } from "@/lib/chat-store";
import { useShallow } from "zustand/react/shallow";
import { ArtifactView } from "./artifact-view";
import { useTranslation } from "@/lib/i18n";

interface Props {
  convId: string | null;
  open: boolean;
  onClose: () => void;
}

export function ArtifactsPanel({ convId, open, onClose }: Props) {
  const { t } = useTranslation("chat");
  // Subscribes via a stable-reference selector: re-renders only when the set
  // of artifact details actually changes (length or any payload differs).
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

  if (!open) return null;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Inbox className="h-3.5 w-3.5" /> {t("artifacts.title")}
          {artifacts.length > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-foreground">
              {artifacts.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t("artifacts.closePanel")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {artifacts.length === 0 ? (
          <div className="pt-8 text-center text-xs text-muted-foreground">
            {t("artifacts.emptyPrefix")}{" "}
            <code className="rounded bg-muted px-1">send_artifact</code>
            {t("artifacts.emptySuffix")}
          </div>
        ) : (
          artifacts.map((a, i) => <ArtifactView key={i} artifact={a} variant="compact" />)
        )}
      </div>
    </aside>
  );
}

const EMPTY: ArtifactDetails[] = [];
