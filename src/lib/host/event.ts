// Backend → frontend events.

import { bridge, type HostEvent } from "./bridge";

export type Event<T> = HostEvent<T>;
export type UnlistenFn = () => void;

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return bridge().listen(event, handler as (e: HostEvent<unknown>) => void);
}
