import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/** A spinner with fixed geometry: the circles stay put while only the dash
 *  phase changes, so tiny instances keep a stable visual centre. */
export function Spinner({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="14 43"
        className="animate-spinner-dash motion-reduce:animate-none"
      />
    </svg>
  );
}
