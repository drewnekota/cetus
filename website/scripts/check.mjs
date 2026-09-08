import { readFile, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
assert.equal([...html.matchAll(/<h1\b/g)].length, 1, 'Exactly one page heading');
for (const [, id] of html.matchAll(/(?:href="#|aria-controls="|aria-labelledby=")([^" ]+)"/g)) {
  assert(ids.includes(id), `Unresolved anchor or accessible reference: ${id}`);
}
const resources = new Set([...html.matchAll(/(?:src|data-src|href)="([^"#]+)"/g)].map(m => m[1]).filter(s => !/^(https?:|data:)/.test(s)));
resources.add('inter.woff2'); resources.add('media.json');
for (const resource of resources) await access(new URL(resource, root));
for (const [, attributes] of html.matchAll(/<img\b([^>]+)>/g)) assert(/\balt="/.test(attributes), 'Every image needs alt text');
const media = JSON.parse(await readFile(new URL('media.json', root), 'utf8'));
for (const [, key] of html.matchAll(/data-image="([^"]+)"/g)) assert(key in media, `Missing image slot: ${key}`);
for (const entry of Object.values(media)) if (entry.src && !/^https?:/.test(entry.src)) await access(new URL(entry.src, root));
console.log(`PASS: ${ids.length} unique IDs, all section/tab references, image alt text, and ${resources.size} local resources.`);
