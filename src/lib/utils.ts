import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// `text-chat` is a font-size token (globals.css); without this twMerge reads it
// as a color and keeps a conflicting `text-sm` alongside it.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["chat"] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
