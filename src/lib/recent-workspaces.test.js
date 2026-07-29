import { describe, expect, test } from "bun:test";
import { reconcileTemporaryWorkspaces } from "./recent-workspaces.ts";

function conversation(overrides) {
  return {
    id: "chat",
    workspaceDir: "/repo/default",
    sourceAutomationId: null,
    ...overrides,
  };
}

describe("temporary automation workspaces", () => {
  test("reconstructs visibility for an already-restored automation chat", () => {
    const restored = conversation({
      workspaceDir: "/repo/automation",
      sourceAutomationId: "daily-digest",
    });

    expect(reconcileTemporaryWorkspaces([], [restored])).toEqual([
      "/repo/automation",
    ]);
  });

  test("does not surface ordinary conversations from hidden workspaces", () => {
    const ordinary = conversation({ workspaceDir: "/repo/hidden" });

    expect(reconcileTemporaryWorkspaces([], [ordinary])).toEqual([]);
  });

  test("keeps a surfaced workspace until its last active chat is archived", () => {
    const ordinary = conversation({ workspaceDir: "/repo/automation" });

    expect(
      reconcileTemporaryWorkspaces(["/repo/automation"], [ordinary]),
    ).toEqual(["/repo/automation"]);
    expect(reconcileTemporaryWorkspaces(["/repo/automation"], [])).toEqual([]);
  });
});
