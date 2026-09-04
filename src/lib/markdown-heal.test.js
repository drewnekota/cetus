import { describe, expect, test } from "bun:test";
import { healStreamingInline, normalizeMath, remarkTrimAutolinkCjk, splitBareUrl } from "./markdown.tsx";

describe("healStreamingInline", () => {
  test("closes a bold run that is still streaming", () => {
    expect(healStreamingInline("- **Issue 已")).toBe("- **Issue 已**");
  });

  test("bold URL becomes a link, not literal asterisks", () => {
    const healed = healStreamingInline("- **https://example.com/a/b");
    expect(healed).toBe("- **https://example.com/a/b**");
    expect(normalizeMath(healed)).toBe(
      "- **[https://example.com/a/b](https://example.com/a/b)**",
    );
  });

  test("bold URL followed by full-width punctuation still links", () => {
    expect(
      normalizeMath("跑起来了：**http://localhost:3002**（Next 16）。"),
    ).toBe(
      "跑起来了：**[http://localhost:3002](http://localhost:3002)**（Next 16）。",
    );
  });

  test("hides a bold opener that has no content yet", () => {
    expect(healStreamingInline("done — **")).toBe("done — ");
  });

  test("leaves balanced text alone", () => {
    expect(healStreamingInline("**a** and **b**")).toBe("**a** and **b**");
  });

  test("ignores asterisks inside code spans", () => {
    expect(healStreamingInline("`a ** b` tail")).toBe("`a ** b` tail");
  });

  test("closes a dangling code span before the bold around it", () => {
    expect(healStreamingInline("**see `rm -f")).toBe("**see `rm -f`**");
  });

  test("never touches text inside an open fence", () => {
    expect(healStreamingInline("```js\nx ** y")).toBe("```js\nx ** y");
  });

  test("counts fenced blocks as code, not prose", () => {
    expect(healStreamingInline("```js\nx ** y\n```\n**tail")).toBe(
      "```js\nx ** y\n```\n**tail**",
    );
  });
});

describe("splitBareUrl", () => {
  test("cuts at full-width punctuation and re-trims GFM trailers", () => {
    expect(splitBareUrl("https://x.com/p/abc）。本地稿在")).toEqual([
      "https://x.com/p/abc",
      "）。本地稿在",
    ]);
    expect(splitBareUrl("https://x.com/a.）b")).toEqual(["https://x.com/a", ".）b"]);
    expect(splitBareUrl("https://x.com/a)）")).toEqual(["https://x.com/a", ")）"]);
  });

  test("keeps balanced parens and CJK path letters", () => {
    expect(splitBareUrl("https://w.org/wiki/Foo_(bar)）")).toEqual([
      "https://w.org/wiki/Foo_(bar)",
      "）",
    ]);
    expect(splitBareUrl("https://w.org/wiki/中文")).toEqual([
      "https://w.org/wiki/中文",
      "",
    ]);
  });
});

describe("remarkTrimAutolinkCjk", () => {
  test("splits a literal autolink and returns the prose to the paragraph", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "页面在 " },
            {
              type: "link",
              url: "http://www.z.com）后",
              children: [{ type: "text", value: "www.z.com）后" }],
            },
          ],
        },
      ],
    };
    remarkTrimAutolinkCjk()(tree);
    expect(tree.children[0].children).toEqual([
      { type: "text", value: "页面在 " },
      { type: "link", url: "http://www.z.com", children: [{ type: "text", value: "www.z.com" }] },
      { type: "text", value: "）后" },
    ]);
  });

  test("leaves explicit links alone", () => {
    const link = { type: "link", url: "https://x.com", children: [{ type: "text", value: "文档）。" }] };
    const tree = { type: "root", children: [{ type: "paragraph", children: [link] }] };
    remarkTrimAutolinkCjk()(tree);
    expect(tree.children[0].children).toEqual([link]);
  });
});
