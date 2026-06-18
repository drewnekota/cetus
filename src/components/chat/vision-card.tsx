"use client";
import { useState } from "react";
import { Eye, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

interface Props {
  text: string;
  details?: unknown;
}

export function VisionCard({ text, details }: Props) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const meta = isVisionDetails(details) ? details : { count: 1, model: "vision" };
  return (
    <div className="rounded-md border border-border/60 bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">vision_describe</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t(meta.count === 1 ? "vision.image" : "vision.image_plural", { count: meta.count })} · {meta.model}
        </span>
      </button>
      {open && (
        <div
          className={cn(
            "border-t border-border/40 px-3 py-2 text-xs leading-relaxed text-foreground/90",
            "max-h-72 overflow-auto whitespace-pre-wrap",
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function isVisionDetails(d: unknown): d is { count: number; model: string } {
  return (
    !!d &&
    typeof d === "object" &&
    typeof (d as { count?: unknown }).count === "number" &&
    typeof (d as { model?: unknown }).model === "string"
  );
}
