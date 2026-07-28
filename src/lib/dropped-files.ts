// Files dropped on a cetus window arrive as OS paths, not as web `File`s: the
// Tauri runtime installs its own drag-drop handler on the webview, so HTML5
// `drop` events never fire with a populated `dataTransfer.files`. This module
// turns those paths back into `File` objects so the existing attachment
// pipelines (image downscaling, size caps, base64 inlining) can be reused
// unchanged, and reports what had to be referenced by path instead.
import { api } from "@/lib/tauri";

/** Extensions the composer's image pipeline can decode. Anything else rides the
 *  plain-file path — a dropped `.heic` is a file attachment, not a broken
 *  canvas decode. Mirrors what a Finder copy/paste reports for these types. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Images are downscaled before they are inlined, so they get a far larger read
 *  budget than the raw-bytes cap that applies to documents. */
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Typed as ArrayBuffer (not Uint8Array) because BlobPart rejects a view whose
// buffer could be a SharedArrayBuffer.
function base64ToBytes(data: string): ArrayBuffer {
  const binary = atob(data);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

export interface DroppedFiles {
  /** Readable files, as `File`s so callers can reuse their existing handling. */
  files: File[];
  /** File name → absolute path, for callers that reference oversized files. */
  hints: Map<string, string>;
  /** Paths not inlined: directories, and anything over `maxBytes`. */
  referenced: string[];
}

/**
 * Read dropped paths into `File` objects. Directories and files past `maxBytes`
 * are returned in `referenced` instead of being read — the caller decides
 * whether to name them in the prompt or report them as too large. A path that
 * fails to read (permissions, a file that vanished mid-drag) is skipped rather
 * than failing the whole drop.
 */
export async function readDroppedFiles(
  paths: string[],
  maxBytes: number,
): Promise<DroppedFiles> {
  const files: File[] = [];
  const hints = new Map<string, string>();
  const referenced: string[] = [];
  for (const path of paths) {
    const mimeType = IMAGE_MIME[extensionOf(path)];
    const budget = mimeType ? IMAGE_MAX_BYTES : maxBytes;
    try {
      const read = await api.readDroppedFile(path, budget);
      if (read.data == null) {
        referenced.push(path);
        continue;
      }
      files.push(
        new File([base64ToBytes(read.data)], read.name, {
          type: mimeType ?? "application/octet-stream",
        }),
      );
      hints.set(read.name, path);
    } catch (e) {
      console.error(`drop: cannot read ${path}`, e);
    }
  }
  return { files, hints, referenced };
}
