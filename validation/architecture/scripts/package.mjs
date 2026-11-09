import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('package.json', 'utf8'));
// better-sqlite3 13 ships Node-API prebuilds; packaged runtime tests verify actual loading.
const result = await packager({ dir: '.', out: 'artifacts/package', name: 'receiptmatch-validation', executableName: 'receiptmatch-validation', platform: process.platform, arch: process.arch, electronVersion: config.devDependencies.electron, overwrite: true, asar: { unpack: '**/*.{node,dll,so,dylib}' }, prune: true, ignore: [/^\/artifacts(?:\/|$)/, /^\/src(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.angular(?:\/|$)/, /^\/Dockerfile$/, /^\/\.dockerignore$/] });
console.log(JSON.stringify({ packaged: result }));
