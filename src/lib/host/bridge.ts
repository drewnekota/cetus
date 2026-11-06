// The preload bridge (`electron/preload.ts`), present in Cetus windows only.

export interface HostEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export interface CetusBridge {
  label: string;
  version: string;
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, cb: (e: HostEvent<unknown>) => void): () => void;
  windowOp(method: string, args?: unknown[]): Promise<unknown>;
  setZoom(z: number): void;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    __CETUS__?: CetusBridge;
  }
}

export function bridge(): CetusBridge {
  const b = typeof window !== "undefined" ? window.__CETUS__ : undefined;
  if (!b) throw new Error("Cetus host bridge unavailable (not running in the app)");
  return b;
}

/** True inside a Cetus app window (vs. a plain browser tab on the dev server). */
export function isHost(): boolean {
  return typeof window !== "undefined" && !!window.__CETUS__;
}
