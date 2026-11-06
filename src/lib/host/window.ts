// The current app window.

import { bridge } from "./bridge";
import type { Event, UnlistenFn } from "./event";

export class AppWindow {
  constructor(readonly label: string) {}

  async show(): Promise<void> {
    await bridge().windowOp("show");
  }

  async hide(): Promise<void> {
    await bridge().windowOp("hide");
  }

  async setFocus(): Promise<void> {
    await bridge().windowOp("focus");
  }

  /** Fires when the OS window gains or loses key focus. */
  async onFocusChanged(handler: (event: Event<boolean>) => void): Promise<UnlistenFn> {
    const focus = () => handler({ event: "focus", id: 0, payload: true });
    const blur = () => handler({ event: "blur", id: 0, payload: false });
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }
}

export function getCurrentWindow(): AppWindow {
  return new AppWindow(bridge().label);
}
