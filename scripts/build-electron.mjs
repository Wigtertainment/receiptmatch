import { cp, mkdir, readdir } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'extraction-host': 'electron/extraction/host.ts', 'extraction-preload': 'electron/extraction/preload.ts' },
  outdir: '.build', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3']
});
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
await cp('electron/extraction/index.html', '.build/extraction/index.html');
await mkdir('.build/extraction/notices', { recursive: true });
for (const [source, target] of [
  ['node_modules/pdfjs-dist/LICENSE', 'pdfjs.txt'], ['node_modules/tesseract.js/LICENSE.md', 'tesseract-js.txt'],
  ['node_modules/tesseract.js-core/LICENSE', 'tesseract-core.txt'], ['electron/extraction/english-data-notice.txt', 'english-data.txt']
]) await cp(source, `.build/extraction/notices/${target}`);
