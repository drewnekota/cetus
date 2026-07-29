import { describe, expect, test } from "bun:test";
import { groupByWorkspace } from "./app-sidebar.tsx";

const DEFAULT = "/Users/x/cetus";

describe("workspace grouping", () => {
  test("the default workspace is a group even with no conversations", () => {
    const groups = groupByWorkspace([], [], [], DEFAULT);
    expect(groups.map((g) => g.dir)).toEqual([DEFAULT]);
    expect(groups[0].items).toEqual([]);
  });

  test("a stale hidden entry cannot hide the default workspace", () => {
    const groups = groupByWorkspace([], [], [DEFAULT, "/repo/a"], DEFAULT);
    expect(groups.map((g) => g.dir)).toEqual([DEFAULT]);
  });

  test("the default workspace sorts first, ahead of real folders", () => {
    const groups = groupByWorkspace([], ["/repo/a"], [], DEFAULT);
    expect(groups.map((g) => g.dir)).toEqual([DEFAULT, "/repo/a"]);
  });

  test("a temporary workspace resurfaces a restored chat from a hidden folder", () => {
    const restored = {
      id: "scheduled-chat",
      workspaceDir: "/repo/automation",
      createdAt: 1,
    };
    const temporary = [restored.workspaceDir];
    const hidden = [restored.workspaceDir].filter(
      (dir) => !temporary.includes(dir),
    );

    const groups = groupByWorkspace(
      [restored],
      temporary,
      hidden,
      DEFAULT,
    );

    expect(groups.map((g) => g.dir)).toEqual([
      DEFAULT,
      restored.workspaceDir,
    ]);
    expect(groups[1].items).toEqual([restored]);
  });

  // Why the sidebar must NOT gate its "Chat" section on finding this group:
  // `defaultWorkspace` starts as "" and is filled in by an async `invoke`, and
  // an empty dir is skipped here — so between mount and that response there is
  // no default group to find. Gating on it made the Chat section (and, with no
  // conversations yet, the whole list) blink out of the sidebar; on a fresh
  // install that is the entire first impression.
  test("an unresolved default workspace produces no group to find", () => {
    expect(groupByWorkspace([], [], [], "")).toEqual([]);
  });
});
