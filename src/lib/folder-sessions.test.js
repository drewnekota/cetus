import { describe, expect, test } from "bun:test";
import { useCoordinatorStore } from "./coordinator.ts";
import { folderSessions, groupSessions, stepThreadId, threadWalkOrder } from "./folder-sessions.ts";

const conv = (id, dir, updatedAt, extra = {}) => ({ id, workspaceDir: dir, updatedAt, archivedAt: null, ...extra });

describe("folder sessions", () => {
  test("one folder, newest first, without Cetus or archived rows", () => {
    useCoordinatorStore.getState().setRegistry({ coordinators: { "/w": "cetus" }, threads: {} });
    const all = [
      conv("a", "/w", 1),
      conv("cetus", "/w", 9),
      conv("b", "/w", 3),
      conv("old", "/w", 5, { archivedAt: 6 }),
      conv("x", "/other", 4),
    ];
    expect(folderSessions(all, "/w").map((c) => c.id)).toEqual(["b", "a"]);
  });

  test("a new registry isn't served from the cache", () => {
    const all = [conv("a", "/w", 1), conv("c2", "/w", 2)];
    useCoordinatorStore.getState().setRegistry({ coordinators: {}, threads: {} });
    expect(folderSessions(all, "/w").map((c) => c.id)).toEqual(["c2", "a"]);
    useCoordinatorStore.getState().setRegistry({ coordinators: { "/w": "c2" }, threads: {} });
    expect(folderSessions(all, "/w").map((c) => c.id)).toEqual(["a"]);
  });

  test("waiting on the user, then running, then the rest by recency", () => {
    const list = [conv("r1", "/w", 9), conv("run", "/w", 8), conv("ask", "/w", 7), conv("r2", "/w", 6)];
    const order = groupSessions(list, new Set(["ask"]), new Set(["run", "ask"]));
    expect(order.map((s) => `${s.group}:${s.conv.id}`)).toEqual([
      "input:ask",
      "working:run",
      "recent:r1",
      "recent:r2",
    ]);
  });

  test("the docked thread walks the cards oldest-first and wraps", () => {
    useCoordinatorStore.getState().setRegistry({ coordinators: {}, threads: {} });
    const all = [
      conv("mid", "/w", 9, { createdAt: 2 }),
      conv("new", "/w", 1, { createdAt: 3 }),
      conv("old", "/w", 5, { createdAt: 1 }),
    ];
    const order = threadWalkOrder(all, "/w");
    expect(order.map((c) => c.id)).toEqual(["old", "mid", "new"]);
    expect(stepThreadId(order, "mid", -1)).toBe("old");
    expect(stepThreadId(order, "mid", 1)).toBe("new");
    expect(stepThreadId(order, "new", 1)).toBe("old");
    expect(stepThreadId(order, "old", -1)).toBe("new");
    expect(stepThreadId(order, null, -1)).toBe("new");
    expect(stepThreadId(order, null, 1)).toBe("old");
  });
});
