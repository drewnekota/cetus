"use client";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// cetus manages its own theme via the `.dark` class on <html> (not next-themes),
// so we don't pass a `theme` to Sonner — the toast surfaces map straight to our
// design tokens below, which already follow `.dark`.
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
