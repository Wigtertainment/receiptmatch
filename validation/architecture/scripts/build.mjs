import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const angular = spawnSync(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'build'], { stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
if (angular.status !== 0) process.exit(angular.status ?? 1);
await build({ entryPoints: ['src/main.ts'], outfile: '.build/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'csv-stringify/sync', 'pdf-lib'] });
await build({ entryPoints: ['src/extract.ts'], outfile: '.build/extract/extract.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022' });
await cp('src/preload.cjs', '.build/preload.cjs');
await cp('src/extract-preload.cjs', '.build/extract-preload.cjs');
await mkdir('.build/extract/pdf', { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', '.build/extract/pdf/pdf.worker.min.mjs');
for (const asset of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${asset}`, `.build/extract/pdf/${asset}`, { recursive: true });
await mkdir('.build/extract/ocr', { recursive: true });
await cp('node_modules/tesseract.js/dist/worker.min.js', '.build/extract/ocr/worker.min.js');
await cp('node_modules/tesseract.js-core', '.build/extract/ocr/core', { recursive: true });
const languageRoot = 'node_modules/@tesseract.js-data/eng';
async function findLanguage(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { const result = await findLanguage(child); if (result) return result; }
    else if (entry.name === 'eng.traineddata.gz') return child;
  }
}
const language = await findLanguage(languageRoot);
if (!language) throw new Error('English OCR resource missing');
await cp(language, '.build/extract/ocr/eng.traineddata.gz');
await writeFile('.build/extract/index.html', '<!doctype html><html><head><meta charset="utf-8"><title>Isolated extraction</title></head><body><script type="module" src="extract.js"></script></body></html>');
console.log('Angular AOT, Electron host, isolated extraction and local resources built.');
