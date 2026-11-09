import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

async function footprint(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) { const item = path.join(directory, entry.name); bytes += entry.isDirectory() ? await footprint(item) : (await stat(item)).size; }
  return bytes;
}
export async function runValidation({ executable = path.resolve(`artifacts/package/receiptmatch-validation-${process.platform}-${process.arch}/receiptmatch-validation${process.platform === 'win32' ? '.exe' : ''}`), outputRoot = path.resolve('artifacts'), commandPrefix = [], timeoutMilliseconds = 180000 } = {}) {
  await mkdir(outputRoot, { recursive: true });
  const reportFile = path.join(outputRoot, `results-${process.platform}.json`);
  const report = { status: 'running', runId: randomUUID(), startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, os: os.release(), node: process.version, syntheticOnly: true, executable, stages: [] };
  const writeReport = () => writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  // Replace any previous success before attempting to launch this run.
  await writeReport();
  try {
    report.runDirectory = await mkdtemp(path.join(outputRoot, 'run-'));
    for (const stage of ['save', 'restore']) {
      report.activeStage = stage;
      const code = await new Promise((resolve, reject) => {
        const child = spawn(executable, [...commandPrefix, `--validation-dir=${report.runDirectory}`, `--validation-stage=${stage}`], { stdio: 'inherit', windowsHide: true });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged ${stage} timed out after ${timeoutMilliseconds}ms`)); }, timeoutMilliseconds);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('exit', code => { clearTimeout(timeout); resolve(code); });
      });
      const result = JSON.parse(await readFile(path.join(report.runDirectory, `${stage}.json`), 'utf8'));
      report.stages.push(result);
      if (code !== 0 || result.status !== 'passed') throw new Error(`Packaged ${stage} failed (exit ${code}): ${result.error ?? result.status}`);
    }
    report.packageBytes = await footprint(path.dirname(executable));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
  }
  report.finishedAt = new Date().toISOString();
  await writeReport();
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const report = await runValidation();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
