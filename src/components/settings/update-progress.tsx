"use client";

import type { UpdateDownloadProgress } from "@/lib/types";
import { cn } from "@/lib/utils";

export function updateDownloadPercent(progress: UpdateDownloadProgress | null) {
  if (!progress?.total || progress.total <= 0) return null;
  return Math.max(
    0,
    Math.min(100, Math.round((progress.downloaded / progress.total) * 100)),
  );
}

/** "12.4 MB / 60.0 MB" — a 60 MB package on a slow link sits on the same
 *  percentage for minutes, and the byte counter is what shows it's alive. */
export function updateDownloadSize(progress: UpdateDownloadProgress | null) {
  if (!progress) return null;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return progress.total && progress.total > 0
    ? `${mb(progress.downloaded)} / ${mb(progress.total)} MB`
    : `${mb(progress.downloaded)} MB`;
}

export function UpdateProgressBar({
  progress,
}: {
  progress: UpdateDownloadProgress | null;
}) {
  const percent = updateDownloadPercent(progress);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <div
        className={cn(
          "h-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none",
          percent == null && "w-1/2 animate-pulse",
        )}
        style={
          percent == null
            ? undefined
            : { transform: `scaleX(${percent / 100})` }
        }
      />
    </div>
  );
}
