import { describe, expect, test } from "bun:test";
import {
  buildFindMatches,
  countOccurrences,
  firstMatchFrom,
  messageFindText,
  preserveActive,
  stepMatch,
} from "./message-search.ts";

describe("messageFindText", () => {
  const msg = (role, blocks) => ({ key: "k", role, blocks, createdAt: 0 });

  test("keeps text and custom blocks", () => {
    const m = msg("assistant", [
      { kind: "text", text: "hello" },
      { kind: "custom", customType: "vision", text: "described 2 images" },
    ]);
    expect(messageFindText(m)).toBe("hello\ndescribed 2 images");
  });

  test("skips thinking, tool calls and their arguments", () => {
    const m = msg("assistant", [
      { kind: "thinking", text: "secret reasoning" },
      { kind: "tool_use", id: "1", name: "Bash", args: { cmd: "ls" }, result: null },
      { kind: "text", text: "done" },
    ]);
    expect(messageFindText(m)).toBe("done");
  });

  test("skips tool and system messages entirely", () => {
    expect(messageFindText(msg("tool", [{ kind: "text", text: "output" }]))).toBe("");
    expect(messageFindText(msg("system", [{ kind: "text", text: "notice" }]))).toBe("");
  });
});

describe("countOccurrences", () => {
  test("counts every non-overlapping hit", () => {
    expect(countOccurrences("abcabcabc", "abc")).toBe(3);
  });

  test("does not count overlaps, matching browser find", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });

  test("empty needle never matches", () => {
    expect(countOccurrences("anything", "")).toBe(0);
  });
});

describe("buildFindMatches", () => {
  const rows = ["Deploy the app", "deployed, then DEPLOY again", "unrelated"];

  test("walks occurrences top to bottom, case-insensitively", () => {
    expect(buildFindMatches(rows, "deploy")).toEqual([
      { itemIndex: 0, nth: 0 },
      { itemIndex: 1, nth: 0 },
      { itemIndex: 1, nth: 1 },
    ]);
  });

  test("an empty or whitespace query matches nothing", () => {
    expect(buildFindMatches(rows, "")).toEqual([]);
    expect(buildFindMatches(rows, "   ")).toEqual([]);
  });

  test("surrounding whitespace in the query is ignored", () => {
    expect(buildFindMatches(["a b"], " b ")).toEqual([{ itemIndex: 0, nth: 0 }]);
  });
});

describe("stepMatch", () => {
  test("wraps forwards and backwards", () => {
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  test("is a no-op with no matches", () => {
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
});

describe("firstMatchFrom", () => {
  const matches = [
    { itemIndex: 1, nth: 0 },
    { itemIndex: 4, nth: 0 },
    { itemIndex: 4, nth: 1 },
    { itemIndex: 9, nth: 0 },
  ];

  test("lands on the first match at or below the reader", () => {
    expect(firstMatchFrom(matches, 4)).toBe(1);
    expect(firstMatchFrom(matches, 5)).toBe(3);
    expect(firstMatchFrom(matches, 0)).toBe(0);
  });

  test("wraps to the top when every match is above the reader", () => {
    expect(firstMatchFrom(matches, 20)).toBe(0);
  });

  test("is a no-op with no matches", () => {
    expect(firstMatchFrom([], 3)).toBe(0);
  });
});

describe("preserveActive", () => {
  test("keeps the current occurrence when it still exists", () => {
    expect(preserveActive(5, 3)).toBe(3);
  });

  test("clamps into range when the list shrank", () => {
    expect(preserveActive(2, 7)).toBe(1);
    expect(preserveActive(0, 7)).toBe(0);
  });
});
