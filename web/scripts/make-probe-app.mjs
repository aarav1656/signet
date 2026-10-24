// Writes dist/probe-app.html: the built index.html with scripts/readonly-wallet.js inlined before the app module,
// and dist/probe.html: the layout probe. Serve dist, then open /probe.html?w=375&path=/&app=1&click=...
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const html = readFileSync(new URL('../dist/index.html', here), 'utf8');
const wallet = readFileSync(new URL('readonly-wallet.js', here), 'utf8');
if (!html.includes('<script type="module"')) throw new Error('dist/index.html has no module script to precede');
writeFileSync(new URL('../dist/probe-app.html', here), html.replace('<script type="module"', `<script>${wallet}</script><script type="module"`));
copyFileSync(new URL('probe.html', here), new URL('../dist/probe.html', here));
console.log('wrote dist/probe-app.html and dist/probe.html');
