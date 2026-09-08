import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = new Set(['index.html','main.js','styles.css','product-demo.css','feature-scenes.css']);
const html = await readFile(path.join(root,'index.html'),'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^(https?:|data:)/.test(match[1])) files.add(match[1]);
for (const css of ['styles.css','product-demo.css','feature-scenes.css']) {
  const text = await readFile(path.join(root,css),'utf8');
  for (const match of text.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) if (!/^(data:|https?:|#)/.test(match[1])) files.add(match[1]);
}
for (const file of await readdir(path.join(root,'assets/brands'))) files.add('assets/brands/'+file);
for (const file of await readdir(path.join(root,'licenses'))) files.add('licenses/'+file);
for (const file of files) {
  if (file.startsWith('/') || file.includes('..')) throw new Error('Invalid asset path');
  await mkdir(path.dirname(path.join(output,file)),{recursive:true});
  await copyFile(path.join(root,file),path.join(output,file));
}
console.log(`Staged ${files.size} public files in website/dist.`);
