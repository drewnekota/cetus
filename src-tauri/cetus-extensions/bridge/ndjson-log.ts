import { promises as fs } from "node:fs";

interface CacheState<T> {
  entries: T[];
  /** Bytes consumed up to and including the last complete line. */
  offset: number;
  size: number;
  mtimeMs: number;
}

const caches = new Map<string, CacheState<unknown>>();

/**
 * Read an append-only NDJSON log, parsing incrementally. Parsed entries are
 * cached per path; subsequent calls only read and parse bytes appended since
 * the last call, so repeated queries against a large recall log stay cheap.
 * A shrunken file (rotation/truncation) triggers a full re-parse. A trailing
 * line without a newline (a write in progress) is returned but not cached, so
 * it is re-read until its newline lands.
 */
export async function readNdjsonLog<T>(path: string): Promise<T[]> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    caches.delete(path);
    return [];
  }

  const cached = caches.get(path) as CacheState<T> | undefined;
  if (cached && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
    return cached.entries;
  }

  const state: CacheState<T> =
    cached && stat.size >= cached.offset
      ? cached
      : { entries: [], offset: 0, size: 0, mtimeMs: 0 };

  let tail: T[] = [];
  let handle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return state.entries;
  }
  try {
    const length = stat.size - state.offset;
    if (length > 0) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, state.offset);
      const chunk = buf.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        parseLines(chunk.subarray(0, lastNewline + 1).toString("utf8"), state.entries);
        state.offset += lastNewline + 1;
      }
      const rest = chunk.subarray(lastNewline + 1);
      if (rest.length > 0) {
        tail = [];
        parseLines(rest.toString("utf8"), tail);
      }
    }
  } finally {
    await handle.close();
  }

  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
  caches.set(path, state as CacheState<unknown>);
  return tail.length > 0 ? [...state.entries, ...tail] : state.entries;
}

function parseLines<T>(text: string, out: T[]) {
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // skip malformed lines
    }
  }
}
