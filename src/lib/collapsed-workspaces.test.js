import { describe, expect, test } from "bun:test";
import { visibleConversationIds } from "./collapsed-workspaces.ts";

describe("visible conversation navigation", () => {
  const groups = [
    { dir: "/chat", items: [{ id: "a" }, { id: "b" }] },
    { dir: "/repo/hidden", items: [{ id: "c" }, { id: "d" }] },
    { dir: "/repo/visible", items: [{ id: "e" }] },
  ];

  test("uses the complete sidebar order when every workspace is expanded", () => {
    expect(visibleConversationIds(groups, new Set())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("omits every chat in a collapsed workspace", () => {
    expect(
      visibleConversationIds(groups, new Set(["/repo/hidden"])),
    ).toEqual(["a", "b", "e"]);
  });
});
