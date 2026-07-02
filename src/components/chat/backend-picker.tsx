"use client";
import { useEffect, useState } from "react";
import { Bot, Cpu, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/tauri";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

/** Coding-agent runtime for a conversation. "pi" is the built-in harness;
 *  claude-code / codex are headless CLI backends orchestrated per-turn (spawned
 *  in a git worktree, streamed through the same chat UI). */
type BackendId = "pi" | "claude-code" | "codex";

const BACKENDS: { id: BackendId; label: string; icon: LucideIcon }[] = [
  { id: "pi", label: "Pi", icon: Bot },
  { id: "claude-code", label: "Claude Code", icon: Cpu },
  { id: "codex", label: "Codex", icon: SquareTerminal },
];

/** Self-contained picker: reads the conversation's current backend and switches
 *  it via the API. Rendered next to the model picker in the composer. */
export function BackendPicker({
  conversationId,
  disabled,
}: {
  conversationId: string | null;
  disabled?: boolean;
}) {
  const [backend, setBackend] = useState<BackendId>("pi");

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setBackend("pi");
      return;
    }
    api
      .getConversation(conversationId)
      .then((c) => {
        if (!cancelled && c) {
          setBackend(((c.backend as BackendId | undefined) ?? "pi"));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (!conversationId) return null;

  const current = BACKENDS.find((b) => b.id === backend) ?? BACKENDS[0];
  const TriggerIcon = current.icon;

  function select(id: string) {
    const b = BACKENDS.find((x) => x.id === id);
    if (!b || !conversationId) return;
    setBackend(b.id);
    api.setConversationBackend(conversationId, b.id).catch(() => {});
  }

  return (
    <Select value={backend} onValueChange={select} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:ring-0 data-[size=sm]:h-7"
      >
        <TriggerIcon className="size-3" />
        <span className="truncate">{current.label}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {BACKENDS.map((b) => {
          const Icon = b.icon;
          return (
            <SelectItem key={b.id} value={b.id} className="text-xs">
              <Icon className="size-4" />
              <span className="truncate">{b.label}</span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
