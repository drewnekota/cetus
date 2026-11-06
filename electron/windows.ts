// The app's fixed windows. Every
// window loads the same frontend; `WindowRouter` picks the UI by label.

import type { BrowserWindowConstructorOptions } from "electron";

export interface WindowSpec {
  label: string;
  options: BrowserWindowConstructorOptions;
}

export const APP_WINDOWS: WindowSpec[] = [
  {
    label: "main",
    options: {
      title: "Cetus",
      width: 1200,
      height: 800,
      minWidth: 700,
      minHeight: 480,
      show: false,
      titleBarStyle: "hidden",
      acceptFirstMouse: true,
    },
  },
  {
    label: "quick",
    options: {
      title: "Cetus",
      width: 920,
      height: 232,
      resizable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      center: true,
      hasShadow: true,
      show: false,
      type: "panel",
      vibrancy: "hud",
      visualEffectState: "active",
      roundedCorners: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
    },
  },
  {
    label: "snip",
    options: {
      title: "Cetus",
      width: 400,
      height: 300,
      resizable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      type: "panel",
      acceptFirstMouse: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      enableLargerThanScreen: true,
    },
  },
  {
    label: "voice",
    options: {
      title: "Cetus",
      width: 380,
      height: 52,
      resizable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      type: "panel",
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
    },
  },
  {
    label: "meeting",
    options: {
      title: "Cetus",
      width: 220,
      height: 52,
      resizable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      type: "panel",
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
    },
  },
];
