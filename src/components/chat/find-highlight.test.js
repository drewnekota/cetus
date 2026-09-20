import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearFindHighlights, paintFindHighlights } from "./find-highlight.ts";

const globals = ["CSS", "Highlight", "document", "NodeFilter"];
let originals;
let highlights;
let scroller;

beforeEach(() => {
  originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  highlights = new Map();
  const row = {
    dataset: { findRow: "0" },
    nodes: [{ nodeValue: "RL and rl", parentElement: { closest: () => null } }],
  };
  scroller = { querySelectorAll: () => [row] };
  const values = {
    // Match the browser API shape: CSS.Highlight does not exist.
    CSS: { highlights },
    Highlight: class extends Set {
      constructor(...ranges) { super(ranges); }
    },
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      createTreeWalker(root) {
        const nodes = root.nodes.values();
        return { nextNode: () => nodes.next().value ?? null };
      },
      createRange: () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      }),
    },
  };
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(() => {
  globals.forEach((key, i) => {
    if (originals[i]) Object.defineProperty(globalThis, key, originals[i]);
    else delete globalThis[key];
  });
});

describe("find highlights", () => {
  test("paints all matches using the global constructor and moves the active highlight", () => {
    const first = paintFindHighlights(scroller, "rl", { itemIndex: 0, nth: 0 });
    expect(first?.startOffset).toBe(0);
    expect(first?.endOffset).toBe(2);
    expect([...highlights.get("cetus-find-active")]).toEqual([first]);
    expect([...highlights.get("cetus-find")].map(r => r.startOffset)).toEqual([7]);

    const second = paintFindHighlights(scroller, "rl", { itemIndex: 0, nth: 1 });
    expect(second?.startOffset).toBe(7);
    expect([...highlights.get("cetus-find-active")]).toEqual([second]);
    expect([...highlights.get("cetus-find")].map(r => r.startOffset)).toEqual([0]);
  });

  test("clears both highlights on close or an empty query", () => {
    paintFindHighlights(scroller, "rl", { itemIndex: 0, nth: 0 });
    clearFindHighlights();
    expect(highlights.size).toBe(0);
    paintFindHighlights(scroller, "rl", { itemIndex: 0, nth: 0 });
    paintFindHighlights(scroller, "  ", null);
    expect(highlights.size).toBe(0);
  });

  test("removes stale highlights when the query has no matches", () => {
    paintFindHighlights(scroller, "rl", { itemIndex: 0, nth: 0 });
    expect(paintFindHighlights(scroller, "absent", null)).toBeNull();
    expect(highlights.size).toBe(0);
  });

  test("gracefully skips engines without the API", () => {
    delete globalThis.Highlight;
    expect(paintFindHighlights(scroller, "rl", null)).toBeNull();
    expect(() => clearFindHighlights()).not.toThrow();
    delete globalThis.CSS;
    expect(paintFindHighlights(scroller, "rl", null)).toBeNull();
  });
});
