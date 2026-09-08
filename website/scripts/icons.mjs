import { readFile, writeFile } from 'node:fs/promises';
import * as lucide from 'lucide';
const file = new URL('../index.html', import.meta.url);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const attrs = values => Object.entries(values).map(([key,value]) => `${key}="${escape(value)}"`).join(' ');
let count = 0;
const html = (await readFile(file, 'utf8')).replace(/<(svg|i)\b([^>]*\bdata-lucide="([^"]+)"[^>]*)>[\s\S]*?<\/\1>/g, (_, tag, source, name) => {
  const node = lucide[name];
  if (!node || node[0] !== 'svg') throw new Error(`Unknown official Lucide icon: ${name}`);
  const existing = Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  count++;
  return `<svg ${attrs({...node[1], ...existing, viewBox: node[1].viewBox, 'aria-hidden': 'true', focusable: 'false'})}>${node[2].map(([element, attributes]) => `<${element} ${attrs(attributes)}/>`).join('')}</svg>`;
});
await writeFile(file, html);
console.log(`Rendered ${count} icons from the official Lucide package.`);
