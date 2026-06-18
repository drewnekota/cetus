"use client";

// DEV-ONLY in-app test/debug bridge frontend hook.
//
// This component is the webview half of cetus's dev "eval bridge". It listens for
// `devtest-command` events emitted by the Rust `devtest` module (gated behind the
// `devtest` Cargo feature) and performs DOM operations, replying with the result
// via the internal `test_dom_result` invoke.
//
// It opens NO network port and is internally no-op'd unless
// `NEXT_PUBLIC_CETUS_DEVTEST === "1"` (NOT NODE_ENV — static export is always
// "production"). It renders null. Mount it only behind the same env gate.

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface DevtestCommand {
  id: string;
  op: string;
  selector?: string | null;
  text?: string | null;
  js?: string | null;
}

const MAX_DUMP = 20 * 1024; // ~20KB cap for outerHTML dumps

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function describe(el: Element) {
  const html = el.outerHTML ?? "";
  return {
    found: true,
    text: (el as HTMLElement).innerText ?? el.textContent ?? "",
    rect: rectOf(el),
    html: html.length > 2048 ? html.slice(0, 2048) : html,
  };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function runCommand(cmd: DevtestCommand): unknown {
  const { op, selector, text, js } = cmd;
  switch (op) {
    case "find": {
      const el = selector ? document.querySelector(selector) : null;
      return el ? describe(el) : { found: false };
    }
    case "getText": {
      const el = selector ? document.querySelector<HTMLElement>(selector) : null;
      return el ? { found: true, text: el.innerText ?? el.textContent ?? "" } : { found: false };
    }
    case "click": {
      const el = selector ? document.querySelector<HTMLElement>(selector) : null;
      if (!el) return { found: false };
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
      return { found: true, clicked: true };
    }
    case "type": {
      const el = selector
        ? document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
        : null;
      if (!el) return { found: false };
      setNativeValue(el, text ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, typed: text ?? "" };
    }
    case "eval": {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${js ?? "undefined"});`);
      const result = fn();
      // Round-trip through JSON to guarantee serializability.
      return { value: JSON.parse(JSON.stringify(result ?? null)) };
    }
    case "dump": {
      const html = document.documentElement.outerHTML ?? "";
      return {
        html: html.length > MAX_DUMP ? html.slice(0, MAX_DUMP) : html,
        truncated: html.length > MAX_DUMP,
        length: html.length,
      };
    }
    default:
      return { error: `unknown op: ${op}` };
  }
}

export function TestHook() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CETUS_DEVTEST !== "1") return;

    const unlistenP = listen<DevtestCommand>("devtest-command", (event) => {
      const cmd = event.payload;
      let value: unknown;
      try {
        value = runCommand(cmd);
      } catch (err) {
        value = { error: err instanceof Error ? err.message : String(err) };
      }
      // Reply to the awaiting Rust oneshot. Fire-and-forget.
      invoke<void>("test_dom_result", { id: cmd.id, value }).catch(() => {});
    });

    return () => {
      unlistenP.then((un) => un());
    };
  }, []);

  return null;
}
