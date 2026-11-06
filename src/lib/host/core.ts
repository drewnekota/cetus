// Backend command calls + local file URLs.

import { bridge } from "./bridge";

export { isHost } from "./bridge";

/** Call a backend command. Rejects with the command's error value. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await bridge().invoke(cmd, args)) as T;
}

/** URL that streams a local file (served by the host's `asset:` protocol). */
export function convertFileSrc(filePath: string, protocol = "asset"): string {
  return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
}
