// Run with: node tests/quote-navigation.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'cetus-quote-test-'));
let browser;
try {
  const output = join(dir, 'quote.mjs');
  execFileSync('bun', ['build', 'src/lib/quote-navigation.ts', '--target', 'browser', '--format', 'esm', '--outfile', output]);
  browser = await chromium.launch({ channel: process.env.CETUS_TEST_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  await page.setContent('<div id="source"><p>伪 <strong>Live2D</strong>，零成本。</p><p>用 <a href="#">CSS</a> 和 canvas 做。</p><div data-message-actions>Copy</div></div>');
  const result = await page.evaluate(async (code) => {
    const mod = await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const messages = [
      { role: 'assistant', blocks: [{ kind: 'text', text: '伪 **Live2D**，零成本。\n\n用 [CSS](https://example.com) 和 canvas 做。' }] },
      { role: 'user', blocks: [{ kind: 'text', text: '> 伪 Live2D，零成本。\n\n继续' }] },
      { role: 'user', blocks: [{ kind: 'text', text: '> 伪 Live2D，零成本。\n\n请解释' }] },
    ];
    const root = document.getElementById('source');
    const range = mod.quoteRange(root, '伪 Live2D，零成本。\n用 CSS 和 canvas 做。');
    CSS.highlights.set('cetus-quote', new Highlight(range));
    return {
      source: mod.findQuoteSource(messages, 2, '伪 Live2D，零成本。'),
      missing: mod.findQuoteSource(messages, 2, '不存在'),
      formatted: mod.findQuoteSource(messages, 2, '伪 Live2D，零成本。\n用 CSS 和 canvas 做。'),
      future: mod.findQuoteSource(messages, 0, '伪 Live2D，零成本。'),
      range: range?.toString(),
      toolbar: mod.quoteRange(root, 'Copy'),
      highlighted: CSS.highlights.get('cetus-quote').size,
    };
  }, readFileSync(output, 'utf8'));
  assert.equal(result.source, 0);
  assert.equal(result.missing, -1);
  assert.equal(result.formatted, 0);
  assert.equal(result.future, -1);
  assert.equal(result.range, '伪 Live2D，零成本。用 CSS 和 canvas 做。');
  assert.equal(result.toolbar, null);
  assert.equal(result.highlighted, 1);
  console.log('Quote navigation: 7 browser assertions passed');
} finally {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
}
