import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { KATEX_OPTIONS, REMARK_MATH_OPTIONS, normalizeMath } from "./markdown.tsx";

function render(text) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, [remarkMath, REMARK_MATH_OPTIONS]],
    rehypePlugins: [[rehypeKatex, KATEX_OPTIONS]],
    children: normalizeMath(text),
  }));
}

describe("chat math rendering", () => {
  test("renders single-dollar formulas before Markdown can consume stars or underscores", () => {
    const html = render(`对 $h(p)$ 作归纳定义 $v(p) \\in \\{W_\\mathrm{I}, D, W_\\mathrm{II}\\}$。

**定义最优策略。** 对每个 $\\lambda(p)=\\mathrm{I}$ 的 $p$，取 $\\sigma^*$ 使 $v(\\sigma^*(p)) = v(p)$。

> 对每个节点 $p$：$o(p,\\sigma^*,\\tau) \\ge_\\mathrm{I} v(p)$。`);
    expect(html.match(/class="katex"/g)).toHaveLength(8);
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("<em>");
    expect(html).toContain("<strong>定义最优策略。</strong>");
  });

  test("keeps currency literal even when mixed with math", () => {
    const html = render(`价格 $1，另一个 $0.10，变动 -$0.10。范围 $5–$10。预算 $20 and $30. 公式 $x^2$，转义 \\$5。`);
    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain("价格 $1，另一个 $0.10，变动 -$0.10。范围 $5–$10。预算 $20 and $30.");
    expect(html).toContain("转义 $5。");
  });

  test("preserves display math and LaTeX delimiters", () => {
    const html = render(`\\(h(p)\\) 和 $$x^2$$

$$
v(p) = \\begin{cases} o(p), & p\\text{ 终局} \\\\ \\max_{q\\in C(p)} v(q), & \\lambda(p)=\\mathrm{I} \\end{cases}
$$

\\[
x+y
\\]`);
    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).not.toContain("katex-error");
  });

  test("leaves code and incomplete or ambiguous delimiters alone", () => {
    for (const source of ["`$x$`", "```tex\n$x$\n```", "$x", "$ x $", "$5$", "$1,000.00$", "$x\ny$", `\\$x\\$`]) {
      expect(normalizeMath(source)).toBe(source);
      expect(render(source)).not.toContain('class="katex"');
    }
  });
});
