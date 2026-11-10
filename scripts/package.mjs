import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('package.json', 'utf8'));
const result = await packager({ dir: '.', out: 'artifacts/package', name: 'ReceiptMatch', executableName: 'ReceiptMatch', platform: process.platform, arch: process.arch, electronVersion: config.devDependencies.electron, overwrite: true, asar: { unpack: '**/*.{node,dll,so,dylib}' }, prune: true, ignore: [/^\/(artifacts|validation|docs|tmp|tests|scripts|src|electron|\.angular)(?:\/|$)/, /^\/\.build\/node(?:\/|$)/, /^\/(AGENTS\.md|Dockerfile|\.dockerignore|tsconfig.*\.json|angular\.json|package-lock\.json)$/] });
console.log(JSON.stringify({ packaged: result }));
