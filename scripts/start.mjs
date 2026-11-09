import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const executable = path.resolve(`artifacts/package/ReceiptMatch-${process.platform}-${process.arch}/ReceiptMatch${process.platform === 'win32' ? '.exe' : ''}`);
try { await access(executable); }
catch { console.error('Build ReceiptMatch first: npm run build && npm run package'); process.exit(1); }
const child = spawn(executable, [], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
