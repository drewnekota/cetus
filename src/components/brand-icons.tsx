import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

export type AppIcon = ComponentType<{ className?: string }>;

function BrandImage({
  src,
  label,
  className,
}: {
  src: string;
  label: string;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-label={label}
      draggable={false}
      className={className}
    />
  );
}

export function CetusIcon({ className }: { className?: string }) {
  return (
    <BrandImage src="/brands/cetus.svg" label="Cetus" className={className} />
  );
}

export function ClaudeCodeIcon({ className }: { className?: string }) {
  return (
    <BrandImage
      src="/brands/claude-code.svg"
      label="Claude Code"
      className={className}
    />
  );
}

export function CodexIcon({ className }: { className?: string }) {
  return (
    <BrandImage
      src="/brands/codex.svg"
      label="Codex"
      className={className}
    />
  );
}

export function OpenCodeIcon({ className }: { className?: string }) {
  return (
    <BrandImage
      src="/brands/opencode.svg"
      label="OpenCode"
      className={className}
    />
  );
}

export function GrokIcon({ className }: { className?: string }) {
  return (
    <BrandImage src="/brands/grok.svg" label="Grok" className={className} />
  );
}

export function KimiIcon({ className }: { className?: string }) {
  return (
    <BrandImage src="/brands/kimi.svg" label="Kimi" className={className} />
  );
}

/** The dsh mark is a bare black glyph with no badge behind it (unlike Kimi /
 * Grok / OpenCode / Cetus, which ship their own dark tile), so it vanishes on
 * dark surfaces unless we flip it. */
export function DshIcon({ className }: { className?: string }) {
  return (
    <BrandImage
      src="/brands/dsh.svg"
      label="DeepSeek Harness"
      className={cn("dark:invert", className)}
    />
  );
}
