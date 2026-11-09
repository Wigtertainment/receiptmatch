import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runValidation } from './run-packaged.mjs';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/runner-check-'));
const fixture = path.join(root, 'runner-fixture.cjs');
await writeFile(fixture, `const fs = require('node:fs'); const path = require('node:path');
const mode = process.argv[2];
const dir = process.argv.find(value => value.startsWith('--validation-dir=')).slice('--validation-dir='.length);
if (mode === 'timeout') setTimeout(() => {}, 10000);
else if (mode === 'failed-stage') { fs.writeFileSync(path.join(dir, 'save.json'), JSON.stringify({status:'failed',error:'intentional runner fixture failure'})); process.exitCode=1; }
`);
const checks = [];
for (const mode of ['launch-error', 'timeout', 'missing-stage', 'failed-stage']) {
  const outputRoot = path.join(root, mode);
  await mkdir(outputRoot);
  const reportFile = path.join(outputRoot, `results-${process.platform}.json`);
  await writeFile(reportFile, JSON.stringify({ status: 'passed', runId: 'stale-success' }));
  const result = await runValidation({ outputRoot, executable: mode === 'launch-error' ? path.join(root, 'does-not-exist') : process.execPath, commandPrefix: [fixture, mode], timeoutMilliseconds: mode === 'timeout' ? 200 : 10000 });
  const persisted = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(result.status, 'failed'); assert.equal(persisted.status, 'failed');
  assert.notEqual(persisted.runId, 'stale-success'); assert.ok(persisted.startedAt); assert.ok(persisted.finishedAt);
  assert.match(persisted.error, mode === 'launch-error' || mode === 'missing-stage' ? /ENOENT/ : mode === 'timeout' ? /timed out/ : /intentional runner fixture failure/);
  checks.push({ mode, status: 'passed', failureRunId: persisted.runId });
}
const evidence = { status: 'passed', runnerOnlyTests: true, architectureExecutableInvoked: false, checks };
await writeFile('artifacts/runner-verification.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
