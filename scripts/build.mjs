import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

for (const args of [['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'], ['node_modules/@angular/cli/bin/ng.js', 'build']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await build({ entryPoints: ['electron/main.ts'], outfile: '.build/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] });
await build({ entryPoints: ['electron/preload.ts'], outfile: '.build/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['electron/extraction/host.ts'], outfile: '.build/extraction-host.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['electron/extraction/preload.ts'], outfile: '.build/extraction-preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['electron/extraction/renderer.ts'], outfile: '.build/extraction/renderer.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022' });

await mkdir('.build/extraction/pdf', { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', '.build/extraction/pdf/pdf.worker.min.mjs');
for (const resource of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${resource}`, `.build/extraction/pdf/${resource}`, { recursive: true });
await mkdir('.build/extraction/ocr/core', { recursive: true });
await cp('node_modules/tesseract.js/dist/worker.min.js', '.build/extraction/ocr/worker.min.js');
for (const resource of await readdir('node_modules/tesseract.js-core')) {
	if (/^tesseract-core[\w.-]*\.(js|wasm)$/.test(resource)) await cp(`node_modules/tesseract.js-core/${resource}`, `.build/extraction/ocr/core/${resource}`);
}
await cp('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', '.build/extraction/ocr/eng.traineddata.gz');
// Preserve the notices for libraries and data copied out of development dependencies.
await mkdir('.build/extraction/notices', { recursive: true });
for (const [source, target] of [
	['pdfjs-dist/LICENSE', 'pdfjs.txt'], ['tesseract.js/LICENSE.md', 'tesseract-js.txt'], ['tesseract.js-core/LICENSE', 'tesseract-core.txt']
]) await cp(`node_modules/${source}`, `.build/extraction/notices/${target}`);
await writeFile('.build/extraction/notices/english-data.txt', `English traineddata: @tesseract.js-data/eng 1.0.0
https://github.com/naptha/tessdata

MIT License
Copyright Balearica and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
await writeFile('.build/extraction/index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local PDF extraction</title></head><body><script type="module" src="renderer.js"></script></body></html>');
