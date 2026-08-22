import { describe, expect, test } from "bun:test";
import {
  nextConversationIdInWorkspace,
  visibleConversationIds,
} from "./collapsed-workspaces.ts";

describe("visible conversation navigation", () => {
  const groups = [
    { dir: "/chat", items: [{ id: "a" }, { id: "b" }] },
    { dir: "/repo/hidden", items: [{ id: "c" }, { id: "d" }] },
    { dir: "/repo/visible", items: [{ id: "e" }] },
  ];

  test("uses the complete sidebar order when every workspace is expanded", () => {
    expect(visibleConversationIds(groups, new Set(), new Set())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("omits every chat in a collapsed workspace", () => {
    expect(
      visibleConversationIds(groups, new Set(["/repo/hidden"]), new Set()),
    ).toEqual(["a", "b", "e"]);
  });

  test("omits rows truncated behind an unexpanded Show more", () => {
    const long = [
      {
        dir: "/chat",
        items: ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id })),
      },
    ];
    expect(visibleConversationIds(long, new Set(), new Set())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(visibleConversationIds(long, new Set(), new Set(["/chat"]))).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"],
    );
  });
});

describe("archive fallback navigation", () => {
  const conversations = [
    { id: "a", workspaceDir: "/chat" },
    { id: "b", workspaceDir: "/chat" },
    { id: "c", workspaceDir: "/repo" },
    { id: "d", workspaceDir: "/repo" },
  ];
  const visibleIds = conversations.map((chat) => chat.id);

  test("selects the next chat in the same workspace", () => {
    expect(nextConversationIdInWorkspace(visibleIds, conversations, "c")).toBe("d");
  });

  test("wraps from the last chat to the first chat in the same workspace", () => {
    expect(nextConversationIdInWorkspace(visibleIds, conversations, "d")).toBe("c");
  });

  test("does not cross into another workspace when no sibling remains", () => {
    expect(nextConversationIdInWorkspace(visibleIds, conversations, "b")).toBe("a");
    expect(
      nextConversationIdInWorkspace(["b", "c", "d"], conversations, "b"),
    ).toBeUndefined();
  });
});
