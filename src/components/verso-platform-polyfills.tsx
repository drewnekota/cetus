"use client";

import ResizeObserverPolyfill from "resize-observer-polyfill";

// Servo/Verso does not implement ResizeObserver yet. Install the standards-
// compatible polyfill during client module initialization, before any child
// component effects subscribe to layout changes.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverPolyfill,
  });
}

export function VersoPlatformPolyfills() {
  return null;
}
