"use client";

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * genre: modern-minimal · macrostructure: Workbench · designed-as-app */
// Full-window settings screen. Renders over the whole app (sidebar included)
// as a dedicated page rather than a modal dialog, with a left section rail and
// a scrollable content pane. Opened from the sidebar, the command palette, or
// ⌘, ; closed with Back or Esc.
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  markdownComponents,
  markdownUrlTransform,
  remarkTrimAutolinkCjk,
} from "@/lib/markdown";
import {
  AudioLines,
  Cloud,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  Mic,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { formatElapsed } from "@/lib/format";
import {
  api,
  onAppEvent,
  onMeetingCaption,
  type Meeting,
  type MeetingSettings,
  type MeetingStatus,
  type MeetingSegment,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { HotkeyRecorder } from "../hotkey-recorder";
import {
  SectionHeading,
  ToggleRow,
  SettingsRowsSkeleton,
} from "../settings-controls";

// =============================================================================
// Meetings (ambient audio transcription)
// =============================================================================

function MeetingTranscriptPanel({
  meetingId,
  live = false,
}: {
  meetingId: string;
  live?: boolean;
}) {
  const { t } = useTranslation("meeting");
  const [segments, setSegments] = useState<MeetingSegment[]>([]);
  const [partials, setPartials] = useState<Record<string, MeetingSegment>>({});
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    api
      .meetingTranscript(meetingId)
      .then(setSegments)
      .catch(() => {});
  }, [meetingId]);

  useEffect(() => {
    refresh();
    if (!live) return;
    const timer = setInterval(refresh, 1200);
    return () => clearInterval(timer);
  }, [live, refresh]);

  // Live sessions also stream the in-flight hypothesis per source — rendered
  // as a ghost bubble below the settled ones, replaced in place. A `final`
  // clears its source's ghost (the settled row arrives via the next poll).
  useEffect(() => {
    if (!live) {
      setPartials({});
      return;
    }
    let unlisten: (() => void) | undefined;
    onMeetingCaption((c) => {
      if (c.meetingId !== meetingId) return;
      setPartials((p) => {
        if (c.kind === "final" || !c.text.trim()) {
          if (!(c.source in p)) return p;
          const next = { ...p };
          delete next[c.source];
          return next;
        }
        return {
          ...p,
          [c.source]: { ts: c.ts, source: c.source, text: c.text },
        };
      });
      if (c.kind === "final") refresh();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [live, meetingId, refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? segments.filter((segment) =>
          segment.text.toLocaleLowerCase().includes(needle),
        )
      : segments;
  }, [query, segments]);

  async function copyAll() {
    const text = segments
      .map(
        (segment) =>
          `${segment.source === "mic" ? t("transcript.you") : t("transcript.them")}: ${segment.text}`,
      )
      .join("\n\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-[#f7f7f4] dark:border-white/10 dark:bg-white/[0.035]">
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-3 py-2.5 dark:border-white/10">
        <div className="flex items-center gap-2">
          {live && (
            <span className="flex h-3 items-end gap-px" aria-hidden="true">
              {[7, 11, 5, 9].map((height, index) => (
                <span
                  key={index}
                  className="w-0.5 animate-pulse rounded-full bg-emerald-600"
                  style={{ height, animationDelay: `${index * 120}ms` }}
                />
              ))}
            </span>
          )}
          <p className="text-xs font-semibold tracking-tight">
            {live ? t("transcript.live") : t("transcript.title")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative hidden sm:block">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("transcript.search")}
              aria-label={t("transcript.search")}
              className="h-7 w-40 border-0 bg-black/[0.04] pl-7 text-xs shadow-none dark:bg-white/[0.06]"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={copyAll}
            disabled={segments.length === 0}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
            {copied ? t("transcript.copied") : t("transcript.copy")}
          </Button>
        </div>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
        {filtered.length === 0 ? (
          <div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
            {t("transcript.empty")}
          </div>
        ) : (
          filtered.map((segment, index) => {
            const mine = segment.source === "mic";
            return (
              <div
                key={`${segment.ts}-${index}`}
                className={cn("flex", mine ? "justify-end" : "justify-start")}
              >
                <div className={cn("max-w-[86%]", mine && "text-right")}>
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {mine ? t("transcript.you") : t("transcript.them")}
                    <span className="font-normal normal-case tracking-normal opacity-70">
                      {new Date(segment.ts).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p
                    className={cn(
                      "rounded-2xl px-3 py-2 text-left text-md leading-relaxed shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
                      mine
                        ? "rounded-br-md bg-[#ddefd7] text-[#173819] dark:bg-emerald-900/50 dark:text-emerald-50"
                        : "rounded-bl-md bg-white text-foreground dark:bg-white/[0.08]",
                    )}
                  >
                    {segment.text}
                  </p>
                </div>
              </div>
            );
          })
        )}
        {live &&
          !query.trim() &&
          Object.values(partials)
            .sort((a, b) => a.ts - b.ts)
            .map((partial) => {
              const mine = partial.source === "mic";
              return (
                <div
                  key={`partial-${partial.source}`}
                  className={cn("flex", mine ? "justify-end" : "justify-start")}
                >
                  <p
                    className={cn(
                      "max-w-[86%] rounded-2xl px-3 py-2 text-left text-md leading-relaxed italic opacity-60",
                      mine
                        ? "rounded-br-md bg-[#ddefd7] text-[#173819] dark:bg-emerald-900/50 dark:text-emerald-50"
                        : "rounded-bl-md bg-white text-foreground dark:bg-white/[0.08]",
                    )}
                  >
                    {partial.text}
                  </p>
                </div>
              );
            })}
      </div>
    </div>
  );
}

/** "Show audio files" reveal button — rendered only when the meeting actually
 *  has a saved-audio directory (audio saving can be off, or predate it). */
function MeetingAudioButton({ meetingId }: { meetingId: string }) {
  const { t } = useTranslation("meeting");
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    api
      .meetingAudioDir(meetingId)
      .then(setDir)
      .catch(() => {});
  }, [meetingId]);

  if (!dir) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5 text-muted-foreground"
      onClick={() => api.revealInFinder(dir).catch(() => {})}
    >
      <FolderOpen className="size-3.5" />
      {t("audio.reveal")}
    </Button>
  );
}

export function MeetingsSection({ open }: { open: boolean }) {
  const { t } = useTranslation("meeting");
  // The hotkey recorder reuses the summon shortcut's generic strings.
  const { t: tSettings } = useTranslation("settings");
  const [settings, setSettings] = useState<MeetingSettings | null>(null);
  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Re-render tick that drives the live elapsed-time readout while recording.
  const [, setClock] = useState(0);
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  const reload = useCallback(() => {
    api
      .listMeetings(50)
      .then(setMeetings)
      .catch(() => {});
    api
      .meetingStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    api
      .getMeetingSettings()
      .then(setSettings)
      .catch(() => {});
    reload();
  }, [open, reload]);

  // While the section is visible, poll the live session (it can start/stop
  // underneath us via auto-detect or the hotkey) and tick the elapsed clock.
  // Idle polls keep the previous status reference (and skip the clock tick) so
  // they don't force a whole-section re-render every 2s when nothing changed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      api
        .meetingStatus()
        .then((next) => {
          setStatus((prev) =>
            prev &&
            prev.recording === next.recording &&
            prev.startedTs === next.startedTs &&
            prev.auto === next.auto &&
            prev.appHint === next.appHint &&
            prev.segments === next.segments
              ? prev
              : next,
          );
          if (next.recording) setClock((c) => c + 1);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [open]);

  // A finished session lands its row (and, a beat later, its summary)
  // asynchronously — refresh the list when the backend says it saved.
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    onAppEvent((e) => {
      if (e.type === "meeting_event") reload();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [open, reload]);

  function update(patch: Partial<MeetingSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.setMeetingSettings(next).catch(() => {});
      return next;
    });
  }

  async function onStart() {
    try {
      await api.meetingStart();
    } catch {
      // surfaced via status staying idle
    }
    api
      .meetingStatus()
      .then(setStatus)
      .catch(() => {});
  }

  async function onStop() {
    try {
      await api.meetingStop();
    } catch {
      // ignore; poll reconciles
    }
    reload();
  }

  if (!settings) return null;

  const recording = status?.recording ?? false;

  return (
    <section>
      <SectionHeading title={t("title")} description={t("description")} />

      {!isMac && (
        <p className="mt-3 text-xs text-muted-foreground">{t("macOnly")}</p>
      )}

      {/* Live session / manual control */}
      <div
        className={cn(
          "mt-5 overflow-hidden rounded-2xl border transition-colors",
          recording
            ? "border-emerald-700/20 bg-[#f4f8f0] shadow-[0_12px_40px_rgba(31,70,35,0.08)] dark:border-emerald-400/20 dark:bg-emerald-950/20"
            : "border-border bg-muted/20",
        )}
      >
        <div className="flex items-center justify-between gap-4 px-4 py-4">
          {recording && status?.startedTs ? (
            <>
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white shadow-sm">
                  <AudioLines className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight">
                    {t("status.recording")} {formatElapsed(status.startedTs)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {status.auto
                      ? `${t("status.auto")}${status.appHint ? ` · ${status.appHint}` : ""}`
                      : t("status.manual")}
                    {" · "}
                    {t("status.segments", { count: String(status.segments) })}
                    {" · "}
                    {t(
                      status.engine === "cloud"
                        ? "status.cloud"
                        : "status.local",
                    )}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                onClick={onStop}
                className="rounded-full bg-foreground px-4 text-background hover:bg-foreground/85"
              >
                {t("action.stop")}
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
                  <Mic className="size-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{t("ready.title")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("ready.description", { hotkey: settings.toggleHotkey })}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                className="gap-1.5 rounded-full bg-emerald-700 px-4 text-white hover:bg-emerald-800"
                onClick={onStart}
                disabled={!settings.enabled || !isMac}
              >
                <AudioLines className="size-3.5" />
                {t("action.start")}
              </Button>
            </>
          )}
        </div>
        {recording && status?.meetingId && (
          <div className="border-t border-emerald-800/10 p-3 dark:border-emerald-300/10">
            <MeetingTranscriptPanel meetingId={status.meetingId} live />
          </div>
        )}
      </div>

      <div className="mt-6 space-y-1">
        <ToggleRow
          id="meeting-enabled"
          label={t("enable.label")}
          description={t("enable.description")}
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
        />
      </div>

      <div
        className={cn(
          "mt-4 space-y-5",
          !settings.enabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-4 p-3">
            <div className="flex min-w-0 gap-2.5">
              {settings.asrEngine === "local" ? (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Cloud className="mt-0.5 size-4 shrink-0 text-emerald-700" />
              )}
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor="meeting-asr" className="font-medium">
                  {t("asr.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("asr.description")}
                </p>
              </div>
            </div>
            <Select
              value={settings.asrEngine}
              onValueChange={(value) =>
                update({ asrEngine: value as MeetingSettings["asrEngine"] })
              }
            >
              <SelectTrigger id="meeting-asr" className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("asr.auto")}</SelectItem>
                <SelectItem value="local">{t("asr.local")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-auto-detect"
            label={t("autoDetect.label")}
            description={t("autoDetect.description")}
            checked={settings.autoDetect}
            onCheckedChange={(v) => update({ autoDetect: v })}
            boxed
          />
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-system-audio"
            label={t("systemAudio.label")}
            description={t("systemAudio.description")}
            checked={settings.systemAudio}
            onCheckedChange={(v) => update({ systemAudio: v })}
            boxed
          />
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-summarize"
            label={t("summarize.label")}
            description={t("summarize.description")}
            checked={settings.summarize}
            onCheckedChange={(v) => update({ summarize: v })}
            boxed
          />
          <div className="border-t border-border" />
          <ToggleRow
            id="meeting-save-audio"
            label={t("saveAudio.label")}
            description={t("saveAudio.description")}
            checked={settings.saveAudio}
            onCheckedChange={(v) => update({ saveAudio: v })}
            boxed
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="meeting-retention" className="font-medium">
              {t("retention.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("retention.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberInput
              id="meeting-retention"
              min={0}
              fallback={0}
              className="w-20"
              value={settings.retentionDays}
              onValueChange={(v) => update({ retentionDays: v })}
            />
            <span className="text-xs text-muted-foreground">
              {t("retention.unit")}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label className="font-medium">{t("hotkey.label")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("hotkey.description")}
            </p>
          </div>
          <HotkeyRecorder
            value={settings.toggleHotkey}
            onChange={(v) => update({ toggleHotkey: v })}
            placeholder={tSettings("launcher.summon.placeholder")}
            recordingLabel={tSettings("launcher.summon.recording")}
            clearLabel={tSettings("launcher.summon.clear")}
          />
        </div>
      </div>

      {/* Recent meetings */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold">{t("recent.title")}</h3>
        {meetings === null ? (
          <SettingsRowsSkeleton rows={2} />
        ) : meetings.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("recent.empty")}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {meetings.map((m) => {
              const expanded = expandedId === m.id;
              const mins =
                m.endedTs != null
                  ? Math.max(1, Math.round((m.endedTs - m.startedTs) / 60_000))
                  : null;
              const when = new Date(m.startedTs).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div key={m.id} className="rounded-lg border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {m.title || t("untitled")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {when}
                        {mins != null && ` · ${mins} min`}
                        {" · "}
                        {t("status.segments", {
                          count: String(m.segmentCount),
                        })}
                        {m.appName && ` · ${m.appName}`}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>
                  {expanded && (
                    <div className="border-t border-border px-3 py-3">
                      {m.summary ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkTrimAutolinkCjk]}
                            components={markdownComponents}
                            urlTransform={markdownUrlTransform}
                          >
                            {m.summary}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t("noSummary")}
                        </p>
                      )}
                      <div className="mt-4">
                        <MeetingTranscriptPanel meetingId={m.id} />
                      </div>
                      <div className="mt-2 flex justify-end gap-1">
                        <MeetingAudioButton meetingId={m.id} />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            api
                              .deleteMeeting(m.id)
                              .then(reload)
                              .catch(() => {});
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          {t("delete.label")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
