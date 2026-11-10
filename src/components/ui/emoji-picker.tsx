"use client";

import * as React from "react";
import {
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
  EmojiPicker as EmojiPickerPrimitive,
} from "frimousse";
import { LoaderIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// Emoji data ships in public/emojibase (copied from emojibase-data) so the
// picker works offline and never reaches a CDN.
const EMOJIBASE_URL = "/emojibase";

function EmojiPicker({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Root>) {
  return (
    <EmojiPickerPrimitive.Root
      emojibaseUrl={EMOJIBASE_URL}
      className={cn(
        "isolate flex h-full w-fit flex-col overflow-hidden bg-popover text-popover-foreground",
        className,
      )}
      data-slot="emoji-picker"
      {...props}
    />
  );
}

function EmojiPickerSearch({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Search>) {
  return (
    <div
      className={cn("flex h-8 items-center gap-2 border-b px-2.5", className)}
      data-slot="emoji-picker-search-wrapper"
    >
      <SearchIcon className="size-3.5 shrink-0 opacity-50" />
      <EmojiPickerPrimitive.Search
        className="flex h-8 w-full bg-transparent py-2 text-sm outline-hidden placeholder:text-muted-foreground"
        data-slot="emoji-picker-search"
        {...props}
      />
    </div>
  );
}

function EmojiPickerRow({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div {...props} className="scroll-my-1 px-1" data-slot="emoji-picker-row">
      {children}
    </div>
  );
}

function EmojiPickerEmoji({
  emoji,
  className,
  ...props
}: EmojiPickerListEmojiProps) {
  return (
    <button
      {...props}
      className={cn(
        "flex size-7 items-center justify-center rounded-sm text-base data-[active]:bg-accent",
        className,
      )}
      data-slot="emoji-picker-emoji"
    >
      {emoji.emoji}
    </button>
  );
}

function EmojiPickerCategoryHeader({
  category,
  ...props
}: EmojiPickerListCategoryHeaderProps) {
  return (
    <div
      {...props}
      className="bg-popover px-2.5 pt-2 pb-1 text-xs leading-none text-muted-foreground"
      data-slot="emoji-picker-category-header"
    >
      {category.label}
    </div>
  );
}

function EmojiPickerContent({
  className,
  emptyLabel = "No emoji found.",
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport> & {
  emptyLabel?: string;
}) {
  return (
    <EmojiPickerPrimitive.Viewport
      className={cn("relative flex-1 outline-hidden", className)}
      data-slot="emoji-picker-viewport"
      {...props}
    >
      <EmojiPickerPrimitive.Loading
        className="absolute inset-0 flex items-center justify-center text-muted-foreground"
        data-slot="emoji-picker-loading"
      >
        <LoaderIcon className="size-4 animate-spin" />
      </EmojiPickerPrimitive.Loading>
      <EmojiPickerPrimitive.Empty
        className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
        data-slot="emoji-picker-empty"
      >
        {emptyLabel}
      </EmojiPickerPrimitive.Empty>
      <EmojiPickerPrimitive.List
        className="pb-1 select-none"
        components={{
          Row: EmojiPickerRow,
          Emoji: EmojiPickerEmoji,
          CategoryHeader: EmojiPickerCategoryHeader,
        }}
        data-slot="emoji-picker-list"
      />
    </EmojiPickerPrimitive.Viewport>
  );
}

export { EmojiPicker, EmojiPickerSearch, EmojiPickerContent };
