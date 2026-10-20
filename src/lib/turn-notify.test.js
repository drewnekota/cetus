import { describe, expect, test } from "bun:test";
import { createTurnNotifier, holdsActivity } from "./turn-notify.ts";

const agent = { taskId: "a1", kind: "general-purpose", description: "Research" };
const workflow = { taskId: "w1", kind: "Workflow", description: "Review" };
const monitor = { taskId: "m1", kind: "Bash", description: "Watch dev server" };

function harness() {
  const fired = [];
  let pending = new Map();
  let next = 0;
  const timers = {
    set: (fn) => {
      const h = ++next;
      pending.set(h, fn);
      return h;
    },
    clear: (h) => pending.delete(h),
  };
  const n = createTurnNotifier((cid, outcome) => fired.push([cid, outcome]), timers, 1000);
  const flush = () => {
    const fns = [...pending.values()];
    pending = new Map();
    for (const fn of fns) fn();
  };
  return { n, fired, flush, timerCount: () => pending.size };
}

describe("holdsActivity", () => {
  test("async agents and workflows hold the conversation; Bash and Monitors don't", () => {
    expect(holdsActivity(undefined)).toBe(false);
    expect(holdsActivity([])).toBe(false);
    expect(holdsActivity([monitor])).toBe(false);
    expect(holdsActivity([agent])).toBe(true);
    expect(holdsActivity([monitor, workflow])).toBe(true);
  });
});

describe("turn notifications", () => {
  test("a plain finished turn notifies immediately", () => {
    const { n, fired } = harness();
    n.turnStarted("c1");
    n.turnEnded("c1", "ok", undefined);
    expect(fired).toEqual([["c1", "ok"]]);
  });

  test("a turn ending with only a Monitor running still notifies", () => {
    const { n, fired } = harness();
    n.turnEnded("c1", "ok", [monitor]);
    expect(fired).toEqual([["c1", "ok"]]);
  });

  test("a mid-work reply (async agent still running) does not notify; the continuation's end does", () => {
    const { n, fired, flush } = harness();
    n.turnStarted("c1");
    // "I've started a research agent, will report back." → result → agent_end
    n.turnEnded("c1", "ok", [agent]);
    expect(fired).toEqual([]);
    // Progress updates while the agent works.
    n.tasksChanged("c1", [{ ...agent, statusText: "Reading files" }]);
    expect(fired).toEqual([]);
    // The agent finishes and the CLI opens its continuation turn.
    n.tasksChanged("c1", []);
    n.turnStarted("c1");
    flush();
    expect(fired).toEqual([]);
    n.turnEnded("c1", "ok", []);
    expect(fired).toEqual([["c1", "ok"]]);
  });

  test("held notification fires once the work drains and no continuation opens", () => {
    const { n, fired, flush } = harness();
    n.turnEnded("c1", "errored", [workflow]);
    n.tasksChanged("c1", [monitor]);
    expect(fired).toEqual([]);
    flush();
    expect(fired).toEqual([["c1", "errored"]]);
    // Nothing left held — a later task update doesn't refire.
    n.tasksChanged("c1", []);
    flush();
    expect(fired).toEqual([["c1", "errored"]]);
  });

  test("a task coming back during the grace window re-holds", () => {
    const { n, fired, flush, timerCount } = harness();
    n.turnEnded("c1", "ok", [agent]);
    n.tasksChanged("c1", []);
    expect(timerCount()).toBe(1);
    n.tasksChanged("c1", [agent]);
    expect(timerCount()).toBe(0);
    flush();
    expect(fired).toEqual([]);
  });

  test("drop forgets a held notification; conversations are independent", () => {
    const { n, fired, flush } = harness();
    n.turnEnded("c1", "ok", [agent]);
    n.turnEnded("c2", "ok", [agent]);
    n.drop("c1");
    n.tasksChanged("c1", []);
    n.tasksChanged("c2", []);
    flush();
    expect(fired).toEqual([["c2", "ok"]]);
  });
});
