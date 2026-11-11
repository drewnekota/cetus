"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { Check } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerSearch,
} from "@/components/ui/emoji-picker";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  autoFolderColor,
  dropRepoIcon,
  FOLDER_AVATAR_COLORS,
  setFolderAvatarEditing,
  setFolderAvatarStyle,
  useFolderAvatarEditing,
  useFolderAvatarStyle,
  useRepoIcon,
} from "@/lib/folder-avatar-prefs";

/** The folder part of a workspace label ("host:repo" → "repo"). */
function baseName(name: string) {
  return name.slice(name.lastIndexOf(":") + 1) || name;
}

interface FolderAvatarProps {
  dir: string;
  /** The workspace label (workspaceName(dir)). */
  name: string;
  size?: number;
  className?: string;
  /** "click": the avatar itself opens the editor (folder headers). "anchor":
   *  only anchors it, opened from a ⋯ menu (rows whose click means select). */
  editable?: "click" | "anchor";
}

/** Rounded-square folder avatar, like the phone app's: the user's own color /
 *  emoji, else the repo's icon for a git folder that has one, else an initial
 *  on a color derived from the name. */
export function FolderAvatar({
  dir,
  name,
  size = 16,
  className,
  editable,
}: FolderAvatarProps) {
  const style = useFolderAvatarStyle(dir);
  const color = style?.color ?? autoFolderColor(baseName(name));
  const emoji = style?.emoji;
  const repoIcon = useRepoIcon(dir);
  const tile = repoIcon && !style ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={repoIcon}
      alt=""
      aria-hidden={!editable}
      draggable={false}
      onError={() => dropRepoIcon(dir)}
      className={cn("shrink-0 object-cover select-none", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
    />
  ) : (
    <span
      aria-hidden={!editable}
      className={cn(
        "inline-flex shrink-0 items-center justify-center leading-none font-semibold text-white select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        // An emoji brings its own colors; a soft tint keeps the shape without
        // fighting them.
        background: emoji ? `${color}38` : color,
        fontSize: emoji ? Math.round(size * 0.7) : Math.round(size * 0.56),
      }}
    >
      {emoji ?? ([...baseName(name)][0]?.toUpperCase() || "·")}
    </span>
  );
  if (!editable) return tile;
  return <EditableTile dir={dir} name={name} mode={editable} tile={tile} />;
}

// Popover content renders in a portal, but React still bubbles its events to
// the row it's declared in — which would collapse the folder, start a drag,
// or pick the filter.
const stop = (e: SyntheticEvent) => e.stopPropagation();

function EditableTile({
  dir,
  name,
  mode,
  tile,
}: {
  dir: string;
  name: string;
  mode: "click" | "anchor";
  tile: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const open = useFolderAvatarEditing(dir);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => setFolderAvatarEditing(next ? dir : null)}
    >
      <PopoverAnchor asChild>
        {mode === "click" ? (
          <button
            type="button"
            title={t("action.changeIcon")}
            className="mr-1.5 flex shrink-0 rounded-[5px] outline-hidden transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onPointerDown={stop}
            onKeyDown={stop}
            onClick={(e) => {
              e.stopPropagation();
              setFolderAvatarEditing(open ? null : dir);
            }}
          >
            {tile}
            <span className="sr-only">{t("action.changeIcon")}</span>
          </button>
        ) : (
          <span className="flex shrink-0">{tile}</span>
        )}
      </PopoverAnchor>
      <PopoverContent
        // Below, not beside: the header (and its live preview) stays in view.
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-auto gap-0 overflow-hidden p-0"
        onClick={stop}
        onPointerDown={stop}
        onKeyDown={stop}
      >
        <FolderAvatarEditor dir={dir} name={name} />
      </PopoverContent>
    </Popover>
  );
}

function FolderAvatarEditor({ dir, name }: { dir: string; name: string }) {
  const { t } = useTranslation("sidebar");
  const style = useFolderAvatarStyle(dir);
  const repoIcon = useRepoIcon(dir);
  const autoColor = autoFolderColor(baseName(name));
  // While the repo icon shows, no swatch is the current one.
  const color = repoIcon && !style ? undefined : (style?.color ?? autoColor);
  return (
    <div className="flex w-[274px] flex-col">
      <div className="flex items-center gap-2 px-2.5 py-2.5">
        <FolderAvatar dir={dir} name={name} size={28} />
        <div className="flex flex-1 flex-wrap gap-1">
          {FOLDER_AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={c === color}
              onClick={() => setFolderAvatarStyle(dir, { color: c })}
              className="flex size-[22px] items-center justify-center rounded-full outline-hidden ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ background: c }}
            >
              {c === color && <Check className="size-3 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>
      <EmojiPicker
        // Shrinks for folders low in the sidebar so the footer stays on screen.
        className="h-[min(248px,calc(var(--radix-popover-content-available-height)-96px))] min-h-28 w-full border-t"
        columns={9}
        onEmojiSelect={({ emoji }) => setFolderAvatarStyle(dir, { emoji })}
      >
        <EmojiPickerSearch placeholder={t("avatar.searchEmoji")} autoFocus />
        <EmojiPickerContent emptyLabel={t("avatar.noEmoji")} />
      </EmojiPicker>
      <div className="flex items-center justify-between border-t px-1.5 py-1.5">
        <button
          type="button"
          disabled={!style?.emoji && !(repoIcon && !style)}
          // An explicit color is what keeps the letter over the repo icon.
          onClick={() =>
            setFolderAvatarStyle(dir, {
              emoji: undefined,
              color: style?.color ?? (repoIcon ? autoColor : undefined),
            })
          }
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {t("avatar.useLetter")}
        </button>
        <button
          type="button"
          disabled={!style}
          onClick={() => setFolderAvatarStyle(dir, null)}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {repoIcon ? t("avatar.useRepoIcon") : t("avatar.reset")}
        </button>
      </div>
    </div>
  );
}
