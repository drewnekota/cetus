import type { CliBackgroundTask } from "./types";

/** True when a conversation's live background tasks keep it working past its
 *  foreground turn: an async Agent/Workflow reports back through a
 *  self-started continuation turn. Background Bash and Monitors (both reported
 *  as "Bash") can live for hours and never hold the conversation open. */
export function holdsActivity(
  tasks: readonly CliBackgroundTask[] | undefined,
): boolean {
  return !!tasks?.some((task) => task.kind !== "Bash");
}

/** How long a drained task set waits for the CLI's continuation turn to open
 *  (its first stream event) before the held notification goes out anyway. */
export const CONTINUATION_GRACE_MS = 15_000;

export type TurnOutcome = "ok" | "errored";

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Decides when a settled turn deserves a "task finished" notification.
 *
 *  claude-code settles a turn on `result` even while an async Agent/Workflow
 *  it launched is still running — the model's "I kicked off X, will report
 *  back" line ends the foreground turn, and the real answer arrives later in a
 *  continuation turn. Notifying on that first `agent_end` announces a task
 *  that is still in progress, so the notification is held until the
 *  background work drains: a continuation turn takes it over (and notifies on
 *  its own end), and if none opens within the grace window the held one
 *  fires. */
export function createTurnNotifier(
  fire: (cid: string, outcome: TurnOutcome) => void,
  timers: Timers = defaultTimers,
  graceMs = CONTINUATION_GRACE_MS,
) {
  const held = new Map<string, { outcome: TurnOutcome; timer?: unknown }>();

  const cancel = (cid: string) => {
    const h = held.get(cid);
    if (h?.timer !== undefined) timers.clear(h.timer);
    held.delete(cid);
  };

  return {
    /** A turn settled (not aborted, nothing queued behind it). */
    turnEnded(
      cid: string,
      outcome: TurnOutcome,
      tasks: readonly CliBackgroundTask[] | undefined,
    ) {
      cancel(cid);
      if (holdsActivity(tasks)) held.set(cid, { outcome });
      else fire(cid, outcome);
    },
    /** A new turn began — it owns the notification now. */
    turnStarted(cid: string) {
      cancel(cid);
    },
    tasksChanged(cid: string, tasks: readonly CliBackgroundTask[] | undefined) {
      const h = held.get(cid);
      if (!h) return;
      if (h.timer !== undefined) timers.clear(h.timer);
      h.timer = undefined;
      if (holdsActivity(tasks)) return;
      h.timer = timers.set(() => {
        held.delete(cid);
        fire(cid, h.outcome);
      }, graceMs);
    },
    /** Forget any held notification (the process exited and says so itself). */
    drop: cancel,
    dispose() {
      for (const cid of [...held.keys()]) cancel(cid);
    },
  };
}
