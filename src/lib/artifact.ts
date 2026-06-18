import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Payload the cetus send_artifact pi extension returns in tool result `details`.
 * Mirror of the structure built in pi-install/cetus-extensions/send-artifact.ts.
 */
export interface ArtifactDetails {
  kind: "artifact";
  artifactKind: "image" | "video" | "audio" | "pdf" | "markdown" | "html" | "text" | "other";
  path: string;
  name: string;
  mimeType: string;
  caption: string | null;
  sizeBytes: number;
}

export function isArtifactDetails(d: unknown): d is ArtifactDetails {
  return !!d && typeof d === "object" && (d as { kind?: string }).kind === "artifact";
}

/** Tauri asset:// URL for an absolute local path — streams without bouncing through Rust. */
export function artifactUrl(path: string): string {
  return convertFileSrc(path);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
