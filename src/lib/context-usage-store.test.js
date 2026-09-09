import { describe, expect, test } from "bun:test";
import { parseContextUsage, pruneContextUsage } from "./context-usage-store.ts";

describe("parseContextUsage", () => {
  test("returns empty for missing or corrupt snapshots", () => {
    expect(parseContextUsage(null)).toEqual({});
    expect(parseContextUsage("not json")).toEqual({});
    expect(parseContextUsage("[]")).toEqual({});
  });

  test("keeps well-formed rows and drops malformed ones", () => {
    const raw = JSON.stringify({
      ok: { usedTokens: 1000, contextWindow: 200000, at: 5 },
      zeroWindow: { usedTokens: 1, contextWindow: 0, at: 5 },
      noAt: { usedTokens: 1, contextWindow: 10 },
      junk: "x",
    });
    expect(Object.keys(parseContextUsage(raw))).toEqual(["ok"]);
  });
});

describe("pruneContextUsage", () => {
  test("keeps the most recently written entries", () => {
    const entries = {};
    for (let i = 0; i < 10; i++) {
      entries[`c${i}`] = { usedTokens: i, contextWindow: 100, at: i };
    }
    const kept = Object.keys(pruneContextUsage(entries, 3)).sort();
    expect(kept).toEqual(["c7", "c8", "c9"]);
  });

  test("returns the same object when under the cap", () => {
    const entries = { a: { usedTokens: 1, contextWindow: 100, at: 1 } };
    expect(pruneContextUsage(entries, 3)).toBe(entries);
  });
});
