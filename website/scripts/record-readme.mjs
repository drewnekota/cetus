// Records the README animations from the coded product scenes in index.html,
// so they follow the sample UI instead of going stale like screen recordings.
//
//   node scripts/record-readme.mjs [demo|quick|automation|stills ...]
//
// Needs Google Chrome, ffmpeg and gifsicle; Playwright comes from the repo root.
// Writes docs/cetus-demo.gif, docs/quick-launcher.gif and docs/automation.gif;
// `stills` writes the two static README screenshots.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(fileURLToPath(import.meta.url), '../..');
const docs = resolve(site, '../docs');
const { chromium } = createRequire(resolve(site, '../package.json'))('@playwright/test');

const WIDTH = 1040, HEIGHT = 640, SCALE = 1.5, FRAME_MS = 60;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = readFileSync(join(site, path === '/' ? 'index.html' : path));
    response.writeHead(200, { 'content-type': types[extname(path)] ?? (path === '/' ? 'text/html' : 'application/octet-stream') }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}/`;

// The preview normally scales a 1440px app down to the page. For a README the
// text has to stay readable at ~880px, so the app is laid out at its real size
// in a smaller window that fills the viewport.
const stageCss = `
html,body{overflow:hidden!important;background:#17171a!important}
.demo-app{position:fixed!important;inset:0!important;width:${WIDTH}px!important;height:${HEIGHT}px!important;zoom:1!important;border-radius:0!important;z-index:9000;margin:0!important}
.demo-app,.demo-app *{scrollbar-width:none}
.demo-welcome{transform:translate(-40px,-45px)!important}
.demo-app .demo-glyph{width:500px!important;height:500px!important;top:calc(50% - 45px)!important}
.demo-threads-docked .demo-composer-bar .demo-model{display:none}
#rec-cursor{position:fixed;left:0;top:0;z-index:9999;width:22px;height:22px;pointer-events:none;transition:transform .5s cubic-bezier(.45,.05,.25,1)}
#rec-cursor svg{display:block;transition:transform .09s}
#rec-cursor.down svg{transform:scale(.82)}
.rec-off{opacity:0!important;transform:translateY(6px)}
.rec-fade{transition:opacity .28s ease,transform .28s ease}
.rec-caret{display:inline-block;width:1.5px;height:1.15em;margin-left:1px;vertical-align:text-bottom;background:var(--app-brand)}
.rec-pop{transition:opacity .22s ease,transform .22s cubic-bezier(.2,.9,.3,1.2)}
.rec-pop.rec-off{transform:scale(.96)}
.rec-keys kbd{transition:background .12s,color .12s}
.rec-keys.down kbd{background:var(--app-brand);color:#17171a}
`;
const cursorSvg = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8.2-6.3 1.5L9.4 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';

const browser = await chromium.launch({ channel: 'chrome' });

async function record(name, output, play) {
  const frames = mkdtempSync(join(tmpdir(), `cetus-${name}-`));
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: output ? SCALE : 2, colorScheme: 'dark' });
  await page.goto(origin);
  await page.addStyleTag({ content: stageCss });
  await page.evaluate(svg => {
    const cursor = document.createElement('div');
    cursor.id = 'rec-cursor'; cursor.innerHTML = svg;
    cursor.style.transform = `translate(${innerWidth - 150}px,${innerHeight + 30}px)`;
    document.body.append(cursor);
  }, cursorSvg);
  await page.evaluate(() => document.fonts.ready);

  let count = 0;
  const run = (fn, arg) => page.evaluate(fn, arg);
  // Frames are captured in real time so CSS transitions land in the recording.
  async function hold(ms) {
    for (let left = Math.max(1, Math.round(ms / FRAME_MS)); left > 0; left--) {
      const started = Date.now();
      await page.screenshot({ path: join(frames, `${String(count++).padStart(5, '0')}.png`) });
      await page.waitForTimeout(Math.max(0, FRAME_MS - (Date.now() - started)));
    }
  }
  async function moveTo(selector, dx = 0, dy = 0) {
    const box = await page.locator(selector).first().boundingBox();
    await run(([x, y]) => { document.getElementById('rec-cursor').style.transform = `translate(${x}px,${y}px)`; },
      [box.x + box.width / 2 + dx - 5, box.y + box.height / 2 + dy - 3]);
    await hold(560);
  }
  async function click(selector, { dx = 0, dy = 0, after = 500, act = true } = {}) {
    await moveTo(selector, dx, dy);
    await run(() => document.getElementById('rec-cursor').classList.add('down'));
    await hold(120);
    await run(() => document.getElementById('rec-cursor').classList.remove('down'));
    if (act) await run(target => { document.querySelector(target).click(); document.activeElement?.blur(); }, selector);
    await hold(after);
  }
  async function type(selector, text) {
    await run(target => {
      const field = document.querySelector(target);
      field.textContent = ''; field.style.color = 'var(--app-ink)';
      const caret = document.createElement('span'); caret.className = 'rec-caret';
      field.append(document.createTextNode(''), caret);
    }, selector);
    await hold(200);
    for (let at = 0; at < text.length; at += 2) {
      await run(([target, value]) => { document.querySelector(target).firstChild.data = value; }, [selector, text.slice(0, at + 2)]);
      await hold(FRAME_MS);
    }
    await hold(350);
  }
  // Hide a story's reply, then bring it back block by block like a stream.
  const replyBlocks = story => `[data-demo-story="${story}"] > .demo-tool, [data-demo-story="${story}"] > .demo-agent-message > *, [data-demo-story="${story}"] > .demo-completion`;
  const hide = selector => run(target => document.querySelectorAll(target).forEach(item => item.classList.add('rec-fade', 'rec-off')), selector);
  async function stream(story) {
    const total = await page.locator(replyBlocks(story)).count();
    await hold(700);
    for (let index = 0; index < total; index++) {
      await run(([target, at]) => {
        const item = document.querySelectorAll(target)[at];
        item.classList.remove('rec-off');
        const content = item.closest('.demo-chat-content');
        const overflow = item.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom + 24;
        if (overflow > 0) content.scrollBy({ top: overflow, behavior: 'smooth' });
      }, [replyBlocks(story), index]);
      await hold(index === 0 ? 800 : 300);
    }
  }

  const still = file => page.screenshot({ path: join(docs, file) });
  await play({ page, run, hold, moveTo, click, type, hide, stream, still });
  await page.close();
  if (!output) { rmSync(frames, { recursive: true }); return; }

  const gif = join(docs, output), palette = join(frames, 'palette.png'), raw = join(frames, 'raw.gif');
  const input = ['-y', '-loglevel', 'error', '-framerate', String(1000 / FRAME_MS), '-i', join(frames, '%05d.png')];
  execFileSync('ffmpeg', [...input, '-vf', 'palettegen=max_colors=128:stats_mode=diff', palette]);
  execFileSync('ffmpeg', [...input, '-i', palette, '-lavfi', 'paletteuse=dither=none:diff_mode=rectangle', raw]);
  execFileSync('gifsicle', ['-O3', '--lossy=30', '--loopcount=0', raw, '-o', gif]);
  rmSync(frames, { recursive: true });
  console.log(`${output}: ${count} frames, ${(statSync(gif).size / 1e6).toFixed(2)} MB`);
}

const scenes = {
  // Pick a runtime, send a task, answer a permission in Threads, approve on the board.
  demo: ['cetus-demo.gif', async ({ run, hold, moveTo, click, type, hide, stream }) => {
    await run(() => {
      document.querySelector('[data-demo-view="home"]').click();
      document.querySelector('.demo-conversation[data-demo-chat="meeting"]').hidden = true;
    });
    await hide('[data-demo-story="meeting"] > .demo-tool, [data-demo-story="meeting"] > .demo-agent-message > *, [data-demo-story="meeting"] > .demo-completion');
    await hold(700);
    await click('#demo-runtime-toggle', { after: 450 });
    await click('[data-demo-runtime="claude-code"]', { after: 600 });
    await type('.demo-home .demo-prompt', 'Summarize today’s launch meeting and draft the next steps.');
    await run(() => document.querySelector('.demo-home .demo-send').removeAttribute('disabled'));
    await click('.demo-home .demo-send', { after: 60, act: false });
    await run(() => {
      const conversation = document.querySelector('.demo-conversation[data-demo-chat="meeting"]');
      conversation.hidden = false; conversation.querySelector('small').textContent = 'now';
      conversation.click();
    });
    await stream('meeting');
    await hold(1300);
    await click('#demo-mode-toggle', { after: 400 });
    await click('#demo-mode-menu [data-demo-view="threads"]', { after: 1100 });
    await click('[data-demo-open-thread="migrate"] .demo-thread-head', { after: 900 });
    await click('.demo-thread-card [data-demo-thread-approve]', { after: 1500 });
    await click('#demo-mode-toggle', { after: 400 });
    await click('#demo-mode-menu [data-demo-view="board"]', { after: 1000 });
    await click('[data-demo-approve]', { after: 600 });
    await moveTo('.demo-settings', 200, -60);
    await hold(1800);
  }],
  // Both ⌘ keys summon the launcher with context chips; type, send, back to work.
  quick: ['quick-launcher.gif', async ({ run, hold, type }) => {
    await run(() => {
      document.querySelector('[data-demo-scene="quick"]').click();
      document.getElementById('rec-cursor').hidden = true;
      const launcher = document.querySelector('.demo-launcher');
      launcher.classList.add('rec-pop', 'rec-off');
      launcher.querySelector('.demo-launcher-body p').textContent = '';
      launcher.querySelectorAll('.demo-quick-context > span').forEach(chip => chip.classList.add('rec-fade', 'rec-off'));
      document.querySelector('.demo-quick-hint').classList.add('rec-keys');
    });
    await hold(900);
    await run(() => document.querySelector('.demo-quick-hint').classList.add('down'));
    await hold(350);
    await run(() => document.querySelector('.demo-launcher').classList.remove('rec-off'));
    await hold(300);
    await run(() => document.querySelector('.demo-quick-hint').classList.remove('down'));
    for (const index of [0, 1]) {
      await run(at => document.querySelectorAll('.demo-quick-context > span')[at].classList.remove('rec-off'), index);
      await hold(380);
    }
    await type('.demo-launcher-body p', 'Summarize this page and pull out the next steps.');
    await run(() => document.querySelector('.demo-launcher .demo-send').removeAttribute('disabled'));
    await hold(500);
    await run(() => { document.querySelector('.demo-launcher .demo-send').style.transform = 'scale(.86)'; });
    await hold(140);
    await run(() => document.querySelector('.demo-launcher').classList.add('rec-off'));
    await hold(1500);
  }],
  // A scheduled prompt becomes a card; its run lands as a finished conversation.
  automation: ['automation.gif', async ({ run, hold, moveTo, click, type, hide, stream }) => {
    await run(() => {
      document.querySelector('[data-demo-view="home"]').click();
      document.querySelector('[data-demo-runtime="cetus"]').click();
      document.activeElement?.blur();
      document.querySelector('.demo-conversation[data-demo-chat="briefing"]').hidden = true;
      const card = document.querySelector('.demo-automation');
      card.classList.add('rec-fade', 'rec-off');
      card.querySelector('.demo-auto-history').firstChild.data = 'No runs yet ';
      card.querySelector('.demo-auto-history button').hidden = true;
      card.querySelector('[data-demo-next]').textContent = 'Next: 9:00 AM';
    });
    await hide('[data-demo-story="briefing"] > .demo-tool, [data-demo-story="briefing"] > .demo-agent-message > *, [data-demo-story="briefing"] > .demo-completion');
    await hold(700);
    await type('.demo-home .demo-prompt', 'Every weekday at 9 AM, summarize my meetings and priorities. Keep it short and tell me what needs my attention.');
    await run(() => document.querySelector('.demo-home .demo-send').removeAttribute('disabled'));
    await click('.demo-home .demo-send', { after: 60, act: false });
    await run(() => document.querySelector('.demo-nav-item[data-demo-view="automations"]').click());
    await hold(350);
    await run(() => { const card = document.querySelector('.demo-automation'); card.classList.remove('rec-off'); });
    await hold(1700);
    // The 9:00 run: the card picks up its first run and the conversation appears.
    await run(() => {
      const card = document.querySelector('.demo-automation');
      card.querySelector('.demo-auto-history').firstChild.data = '1 run · Last run just now ';
      card.querySelector('.demo-auto-history button').hidden = false;
      card.querySelector('[data-demo-next]').textContent = 'Next: tomorrow';
      document.querySelector('.demo-conversation[data-demo-chat="briefing"]').hidden = false;
    });
    await hold(900);
    await click('.demo-auto-history button', { after: 100 });
    await moveTo('.demo-settings', 175, -170);
    await stream('briefing');
    await hold(2200);
  }],
};

// Static screenshots: the runtime picker and the Threads view.
scenes.stills = [null, async ({ page, run, still }) => {
  await run(() => {
    document.getElementById('rec-cursor').hidden = true;
    document.querySelector('[data-demo-view="home"]').click();
    document.getElementById('demo-runtime-toggle').click();
    document.activeElement?.blur();
  });
  await page.waitForTimeout(300);
  await still('screenshot-runtime-picker.png');
  await run(() => document.querySelector('#demo-mode-menu [data-demo-view="threads"]').click());
  await page.waitForTimeout(300);
  await still('screenshot-threads.png');
}];

const wanted = process.argv.slice(2);
for (const [name, [output, play]] of Object.entries(scenes)) {
  if (!wanted.length || wanted.includes(name)) await record(name, output, play);
}
await browser.close();
server.close();
