// Small real-DOM fixture: production virtualizer and scroll controller, without
// Tauri or a user's conversations. Run through pnpm test:chat-scroll.
const build = await Bun.build({ entrypoints: ['tests/fixtures/chat-scroll.tsx'], target: 'browser' });
if (!build.success) throw new Error(build.logs.join('\n'));
const bundle = await build.outputs[0].text();
Bun.serve({
  hostname: '127.0.0.1', port: 18765,
  fetch(request) {
    if (new URL(request.url).pathname === '/harness.js') {
      return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
    }
    return new Response('<!doctype html><html><head><style>.list{flex:1;min-height:0}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  },
});
