import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Small badge for keyboard shortcut hints. Uses the system UI font instead of
 * our brand mono, because modifier glyphs (⌘ ⇧ ⌃ ⌥ ↵) only render correctly
 * in platform fonts — most custom mono families render them as boxes or with
 * inconsistent baselines.
 */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-4 items-center rounded border border-border/50 bg-muted/40 px-1 text-[10px] leading-none tracking-wide text-muted-foreground/80",
        "font-[system-ui,-apple-system,'SF_Pro_Text','Segoe_UI',sans-serif]",
        className
      )}
      {...props}
    />
  );
}
