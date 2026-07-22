"use client";
import { Terminal } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { AnsiText } from "@/components/ui/ansi-text";
import type { BashResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** `details` shape stored on a `bash_exec` custom block by the reducer. */
type BashDetails =
  | { status: "running"; cwd?: string }
  | { status: "done"; result: BashResult };

interface Props {
  /** The command the user ran (without the leading `!`). */
  command: string;
  details?: unknown;
}

/** Terminal-style card for a local `!` bash-mode command: the command line up
 *  top, captured stdout/stderr below, and an exit-code badge. Renders a spinner
 *  while the command is still running. */
export function BashCard({ command, details }: Props) {
  const { t } = useTranslation("chat");
  const d = isBashDetails(details) ? details : { status: "running" as const };
  const result = d.status === "done" ? d.result : null;
  const output = result ? joinOutput(result) : "";
  const failed = !!result && (result.timedOut || result.exitCode !== 0);

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border/60 bg-muted/40 font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 select-none text-muted-foreground">$</span>
        <span className="min-w-0 flex-1 truncate text-foreground/90" title={command}>
          {command}
        </span>
        {d.status === "running" ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              failed
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success dark:text-success",
            )}
          >
            {result!.timedOut
              ? t("bash.timedOut")
              : t("bash.exit", { code: result!.exitCode })}
          </span>
        )}
      </div>
      {result &&
        (output ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 leading-relaxed text-foreground/90">
            <AnsiText>{output}</AnsiText>
          </pre>
        ) : (
          <div className="px-3 py-2 italic text-muted-foreground">{t("bash.noOutput")}</div>
        ))}
    </div>
  );
}

/** stdout then stderr, separated by a blank line when both are present. */
function joinOutput(r: BashResult): string {
  const parts = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean);
  return parts.join("\n\n");
}

function isBashDetails(d: unknown): d is BashDetails {
  return !!d && typeof d === "object" && "status" in d;
}
