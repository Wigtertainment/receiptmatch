import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

for (const args of [['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'], ['node_modules/@angular/cli/bin/ng.js', 'build']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await build({ entryPoints: ['electron/main.ts'], outfile: '.build/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] });
await build({ entryPoints: ['electron/preload.ts'], outfile: '.build/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
