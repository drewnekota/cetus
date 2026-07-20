import "./globals.css";
import type { Metadata } from "next";
import { ConsoleBridge } from "@/components/devtools/console-bridge";
import { ChunkReloadGuard } from "@/components/chunk-reload-guard";
import { ThemeWatcher } from "@/components/theme-watcher";
import { fontVariables } from "./fonts";

// Toggle the `.dark` class before first paint so the saved theme (or the
// system appearance, when following it) doesn't flash the wrong colors. Mirrors
// `theme-prefs.ts`; defaults to following the system. <html> carries
// suppressHydrationWarning since this script mutates its class pre-hydration.
const THEME_INIT = `(function(){try{var p=localStorage.getItem("cetus.theme")||"system";var d=p==="dark"||(p!=="light"&&(!window.matchMedia||window.matchMedia("(prefers-color-scheme: dark)").matches));document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";document.documentElement.dataset.theme=d?"dark":"light";}catch(e){}})();`;
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowRouter } from "@/components/window-router";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "cetus",
  description: "Key of the Twilight — DeepSeek desktop agent on top of pi.",
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
