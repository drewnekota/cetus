import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The cetus glyph silhouette, blown up huge and rendered as a faint single-line
 * outline behind the new-chat empty state — the Linear-style ambient backdrop.
 *
 * Derived from the brand glyph (an Figma "inside-stroke" export): the visible
 * path is a thin ring clipped to the inside of the blob via the SVG <mask>. We
 * strip the original drop-shadow filter and swap the hardcoded white for
 * `currentColor` so it tracks the theme (light/dark) through Tailwind's text
 * color. A radial CSS mask fades the edges so it reads as ambient, not a logo.
 */
export function GlyphBackdrop({ className }: { className?: string }) {
  // Unique per instance so two mounted backdrops can't collide on the ids.
  const uid = useId();
  const maskId = `${uid}-mask`;
  const gradId = `${uid}-grad`;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden select-none",
        className,
      )}
    >
      <svg
        viewBox="0 0 1024 1024"
        fill="none"
        className="absolute left-1/2 top-1/2 h-[96vmin] w-[96vmin] -translate-x-1/2 -translate-y-[52%] text-primary/[0.16] dark:text-primary/[0.22]"
        style={{
          maskImage:
            "radial-gradient(70% 70% at 50% 47%, #000 48%, transparent 86%)",
          WebkitMaskImage:
            "radial-gradient(70% 70% at 50% 47%, #000 48%, transparent 86%)",
        }}
      >
        <defs>
          {/* Top-bright → bottom-faint fade along the stroke, like a light cast
              from above. Stops use currentColor so the hue still tracks the
              theme; only the alpha varies down the glyph. */}
          <linearGradient
            id={gradId}
            x1="512"
            y1="108"
            x2="512"
            y2="916"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="currentColor" stopOpacity="1" />
            <stop offset="0.55" stopColor="currentColor" stopOpacity="0.62" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        <mask id={maskId} fill="white">
          <path d="M512 108C739.541 108 924 292.459 924 520C924 700.997 807.285 854.733 645.012 910.054C632.927 914.174 626.884 916.234 619.386 915.916C613.304 915.658 605.851 913.437 600.62 910.323C594.171 906.484 589.642 900.683 580.583 889.081L369.758 619.073C352.563 597.052 343.965 586.041 333.522 582.073C324.369 578.594 314.258 578.594 305.105 582.072C294.661 586.041 286.064 597.052 268.869 619.073L223.165 677.607C205.689 699.989 196.951 711.18 184.352 714.738C174.521 717.514 160.565 715.455 151.955 709.958C140.92 702.912 136.525 691.579 127.735 668.912C109.824 622.728 100 572.511 100 520C100 292.459 284.459 108 512 108Z" />
        </mask>
        <path
          d="M512 108C739.541 108 924 292.459 924 520C924 700.997 807.285 854.733 645.012 910.054C632.927 914.174 626.884 916.234 619.386 915.916C613.304 915.658 605.851 913.437 600.62 910.323C594.171 906.484 589.642 900.683 580.583 889.081L369.758 619.073C352.563 597.052 343.965 586.041 333.522 582.073C324.369 578.594 314.258 578.594 305.105 582.072C294.661 586.041 286.064 597.052 268.869 619.073L223.165 677.607C205.689 699.989 196.951 711.18 184.352 714.738C174.521 717.514 160.565 715.455 151.955 709.958C140.92 702.912 136.525 691.579 127.735 668.912C109.824 622.728 100 572.511 100 520C100 292.459 284.459 108 512 108Z"
          stroke={`url(#${gradId})`}
          strokeWidth={4}
          fill="none"
          mask={`url(#${maskId})`}
        />
      </svg>
    </div>
  );
}
