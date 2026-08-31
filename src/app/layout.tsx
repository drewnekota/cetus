import "./globals.css";
import type { Metadata } from "next";
import { ConsoleBridge } from "@/components/devtools/console-bridge";
import { ChunkReloadGuard } from "@/components/chunk-reload-guard";
import { FileDropHost } from "@/components/file-drop-host";
import { LinkGuard } from "@/components/link-guard";
import { ThemeWatcher } from "@/components/theme-watcher";
import { fontVariables } from "./fonts";

// Toggle the `.dark` class before first paint so the saved theme (or the
// system appearance, when following it) doesn't flash the wrong colors. Mirrors
// `theme-prefs.ts`; defaults to following the system. <html> carries
// suppressHydrationWarning since this script mutates its class pre-hydration.
// The second half applies the saved skin's seed colors for that mode (mirrors
// `skin-prefs.ts` — the seed→var map and the on-accent luminance rule must
// stay in sync with it). The leading block applies the "UI font size" ramp
// (mirrors TYPE_RAMP / LINE_HEIGHT_RAMP in `type-scale-prefs.ts`).
const THEME_INIT = `(function(){try{var fs=Number(localStorage.getItem("cetus.fontSize"));if(fs>=12&&fs<=16&&fs!==14){var r=fs/14,ramp={"--text-2xs":11,"--text-xs":12,"--text-md":13,"--text-sm":14,"--text-base":15,"--text-lg":18,"--text-xl":20,"--text-2xl":24};for(var tk in ramp)document.documentElement.style.setProperty(tk,Math.round(ramp[tk]*r)+"px");}}catch(e){}try{var lh=Number(localStorage.getItem("cetus.lineHeight"));if(lh>=0.9&&lh<=1.2&&lh!==1){var lr={"--text-2xs--line-height":1.4,"--text-xs--line-height":1.35,"--text-md--line-height":1.4,"--text-sm--line-height":1.43,"--text-base--line-height":1.5,"--text-lg--line-height":1.5,"--text-xl--line-height":1.4,"--text-2xl--line-height":1.33};for(var lk in lr)document.documentElement.style.setProperty(lk,(lr[lk]*lh).toFixed(3));}}catch(e){}try{var p=localStorage.getItem("cetus.theme")||"system";var d=p==="dark"||(p!=="light"&&(!window.matchMedia||window.matchMedia("(prefers-color-scheme: dark)").matches));var h=document.documentElement;h.classList.toggle("dark",d);h.style.colorScheme=d?"dark":"light";h.dataset.theme=d?"dark":"light";var raw=localStorage.getItem("cetus.skin");if(!raw)return;var v=JSON.parse(raw)[d?"dark":"light"];if(!v)return;var m={surface:"--surface",ink:"--ink",accent:"--brand",diffAdded:"--diff-added",diffRemoved:"--diff-removed",skill:"--skill"};var hex=/^#[0-9a-fA-F]{6}$/;for(var k in m){if(hex.test(v[k]||""))h.style.setProperty(m[k],v[k]);}if(typeof v.contrast==="number")h.style.setProperty("--contrast",String(Math.min(100,Math.max(0,v.contrast))));if(hex.test(v.accent||"")){var c=function(i){var t=parseInt(v.accent.slice(i,i+2),16)/255;return t<=0.04045?t/12.92:Math.pow((t+0.055)/1.055,2.4)};var L=c(1)*0.2126+c(3)*0.7152+c(5)*0.0722;h.style.setProperty("--on-accent",L>0.179?"#000000":"#ffffff");}}catch(e){}})();`;
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowRouter } from "@/components/window-router";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "cetus",
  description:
    "Turn Codex, Claude Code, or your favorite agent runtime into an always-on desktop assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={fontVariables}>
      <body className="h-full font-sans">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {/* Keeps every window's `.dark` class synced with the saved theme after
            the pre-paint apply (OS-appearance + cross-window changes). */}
        <ThemeWatcher />
        <ConsoleBridge />
        <ChunkReloadGuard />
        {/* Routes OS file drops anywhere in the window to the composer that is
            on screen. Mounted at the root so every window is covered. */}
        <FileDropHost />
        {/* Backstop for link inputs that component-level interception cannot
            see (middle click, link drag-drop, context-menu Open Link) — any
            of which would navigate the webview away from the app. */}
        <LinkGuard />
        {/* Sidebar uses `tooltip` prop on SidebarMenuButton, which calls
            useContext on TooltipProvider. Hoist the provider to the root so
            every sidebar item (and any future tooltips) finds it.

            disableHoverableContent: no tooltip in the app has interactive
            content, and the hover-grace polygon Radix keeps between trigger
            and content otherwise delays closes — worse, it waits on a
            document pointermove that never arrives once the cursor has left
            the window, latching tooltips open. */}
        <TooltipProvider delayDuration={200} disableHoverableContent>
          {/* Provides the active language + `t()` to every window. Wraps
              WindowRouter so the launcher/voice HUD are translated too; safe to
              read localStorage synchronously since the text-bearing tree only
              mounts after the window label resolves (client-side). */}
          <I18nProvider>
            {/* Branch the full app vs. the frameless launcher by window label. */}
            <WindowRouter>{children}</WindowRouter>
          </I18nProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
