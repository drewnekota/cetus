import type { ComponentType } from "react";

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
