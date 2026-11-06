// App metadata.

import { bridge } from "./bridge";

export async function getVersion(): Promise<string> {
  return bridge().version;
}
