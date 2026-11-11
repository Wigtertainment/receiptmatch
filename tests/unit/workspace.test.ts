import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkspace, fingerprint, loadWorkspace, moneySchema, newMetadata, saveWorkspace, SCHEMA_VERSION } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';

async function directory() { await mkdir('artifacts', { recursive: true }); return mkdtemp(path.resolve('artifacts/unit-')); }
function scriptedDialogs() {
  const plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ('save' | 'discard' | 'cancel')[] } = { saves: [], opens: [], choices: [] };
  const dialogs: WorkspaceDialogs = { save: async () => plan.saves.shift() ?? null, open: async () => plan.opens.shift() ?? null, unsaved: async () => plan.choices.shift() ?? 'cancel' };
  return { plan, dialogs };
}

test('workspace stores exact canonical amounts, source references and independent approvals without modifying originals', async () => {
  const root = await directory(); const file = path.join(root, 'records.receiptmatch'); const original = path.join(root, 'original.pdf');
  await writeFile(original, 'original supporting document'); const originalHash = await fingerprint(original);
  await createWorkspace(file, newMetadata());
  const db = new Database(file); db.pragma('foreign_keys=ON');
  db.exec(`INSERT INTO sources VALUES('s1','${original.replace(/'/g, "''")}',NULL); INSERT INTO accounts VALUES('a1','Business','EUR'); INSERT INTO statements VALUES('st1','a1','s1');
    INSERT INTO transactions VALUES('t1','st1','9007199254740993','EUR',2,1); INSERT INTO transactions VALUES('t2','st1','-9007199254740993','EUR',2,1);
    INSERT INTO documents VALUES('d1','s1',1); INSERT INTO documents VALUES('d2','s1',1);
    INSERT INTO associations VALUES('x1','t1','d1','uncertain',1,'1:1:1'); INSERT INTO associations VALUES('x2','t1','d2','reliable',1,NULL); INSERT INTO associations VALUES('x3','t2','d1','reliable',1,NULL);`);
  assert.throws(() => db.prepare('INSERT INTO statements VALUES(?,?,?)').run('invalid', 'missing', 's1'), /FOREIGN KEY/);
  db.close();
  const loaded = await loadWorkspace(file);
  await saveWorkspace(loaded, { ...loaded.metadata, name: 'Business — November' });
  const reopened = await loadWorkspace(file); assert.equal(reopened.metadata.name, 'Business — November');
  const read = new Database(file, { readonly: true });
  assert.equal((read.prepare('SELECT coefficient FROM transactions WHERE id=?').get('t1') as { coefficient: string }).coefficient, '9007199254740993');
  assert.deepEqual(read.prepare('SELECT confidence,approved_revision FROM associations ORDER BY id').all(), [{ confidence: 'uncertain', approved_revision: '1:1:1' }, { confidence: 'reliable', approved_revision: null }, { confidence: 'reliable', approved_revision: null }]);
  read.close(); assert.equal(await fingerprint(original), originalHash);
  assert.equal(BigInt(moneySchema.parse({ coefficient: '9007199254740993', currency: 'EUR', scale: 2 }).coefficient), 9007199254740993n);
  for (const coefficient of ['01', '-0', '+1', '1.5', '1e4']) assert.equal(moneySchema.safeParse({ coefficient, currency: 'EUR', scale: 2 }).success, false);
});

test('foreign, corrupt and future workspaces are read-only rejected; existing files are never replaced', async () => {
  const root = await directory();
  const foreign = path.join(root, 'foreign.receiptmatch'); const foreignDb = new Database(foreign); foreignDb.exec('CREATE TABLE unrelated(value TEXT)'); foreignDb.close();
  const future = path.join(root, 'future.receiptmatch'); await createWorkspace(future, newMetadata()); const futureDb = new Database(future); futureDb.pragma(`user_version=${SCHEMA_VERSION + 1}`); futureDb.close();
  const corrupt = path.join(root, 'corrupt.receiptmatch'); await writeFile(corrupt, 'not a database');
  for (const file of [foreign, future, corrupt]) {
    const before = await fingerprint(file); await assert.rejects(() => loadWorkspace(file)); assert.equal(await fingerprint(file), before);
  }
  const before = await readFile(foreign); await assert.rejects(() => createWorkspace(foreign, newMetadata()), { code: 'EEXIST' }); assert.deepEqual(await readFile(foreign), before);
});

test('external changes are not overwritten by an existing workspace save', async () => {
  const root = await directory(); const file = path.join(root, 'workspace.receiptmatch'); const saved = await createWorkspace(file, newMetadata());
  const external = new Database(file); external.prepare('UPDATE workspace SET name=?').run('External change'); external.close();
  const before = await fingerprint(file);
  await assert.rejects(() => saveWorkspace(saved, { ...saved.metadata, name: 'Overwrite' }), /changed outside/);
  assert.equal(await fingerprint(file), before);
});

test('two concurrent saves from the same revision cannot silently overwrite one another', async () => {
  const root = await directory(); const file = path.join(root, 'workspace.receiptmatch'); const saved = await createWorkspace(file, newMetadata());
  const results = await Promise.allSettled([saveWorkspace(saved, { ...saved.metadata, name: 'First writer' }), saveWorkspace(saved, { ...saved.metadata, name: 'Second writer' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const reopened = await loadWorkspace(file); assert.ok(['First writer', 'Second writer'].includes(reopened.metadata.name));
});

for (const operation of ['create', 'save'] as const) test(`${operation} captures its committed fingerprint while competing SQLite writers remain excluded`, async () => {
  const root = await directory(); const file = path.join(root, 'protected.receiptmatch'); const metadata = { ...newMetadata(), name: 'Protected revision' };
  const existing = operation === 'save' ? await createWorkspace(file, newMetadata()) : null;
  const originalRead = fsModule.readSync; let reads = 0; let attempts = 0;
  const captureRead = operation === 'create' ? 1 : 3;
  const probe = vi.spyOn(fsModule, 'readSync').mockImplementation(((selected: unknown, ...rest: unknown[]) => {
    if (rest[2] === 65536 && rest[3] === 0 && fsModule.fstatSync(Number(selected)).ino === fsModule.statSync(file).ino && ++reads === captureRead) {
      attempts++;
      const other = spawnSync(process.execPath, ['-e', "const Database=require('better-sqlite3');let db;try{db=new Database(process.argv[1],{timeout:0});db.prepare('UPDATE workspace SET name=?').run('External writer');process.exitCode=2;}catch(error){if(error.code==='SQLITE_BUSY'){console.log(error.code);}else{console.error(error);process.exitCode=3;}}finally{db?.close();}", file], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(other.status, 0, other.stderr); assert.match(other.stdout, /SQLITE_BUSY/);
    }
    return Reflect.apply(originalRead, fsModule, [selected, ...rest]);
  }) as typeof fsModule.readSync);
  syncBuiltinESMExports();
  let saved;
  try { saved = existing ? await saveWorkspace(existing, { ...existing.metadata, name: metadata.name }) : await createWorkspace(file, metadata); }
  finally { probe.mockRestore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1, 'Probe must run at committed-file capture, not merely before commit');
  assert.equal(saved.fingerprint, await fingerprint(file)); assert.equal((await loadWorkspace(file)).metadata.name, 'Protected revision');
});

test('cancelled and failed saves block replacement/close and retain the unsaved workspace', async () => {
  const root = await directory(); const { plan, dialogs } = scriptedDialogs(); const session = new WorkspaceSession(dialogs);
  await session.dispatch({ type: 'new' }); await session.dispatch({ type: 'rename', name: 'Current work' }); const id = session.state().workspace!.id;
  plan.choices.push('save'); plan.saves.push(null); await session.dispatch({ type: 'new' });
  assert.equal(session.state().workspace!.id, id); assert.equal(session.state().workspace!.dirty, true);
  plan.choices.push('cancel'); assert.equal(await session.requestClose(), false);
  const existing = path.join(root, 'existing.receiptmatch'); await writeFile(existing, 'never overwrite');
  plan.choices.push('save'); plan.saves.push(existing); assert.equal(await session.requestClose(), false);
  assert.equal(session.state().workspace!.name, 'Current work'); assert.equal(session.state().workspace!.dirty, true); assert.ok(session.state().error);
  assert.equal(await readFile(existing, 'utf8'), 'never overwrite');
  plan.saves.push(path.join(root, 'saved.receiptmatch')); await session.dispatch({ type: 'save' }); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Changed' }); await session.dispatch({ type: 'rename', name: 'Current work' }); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Saved on close' }); plan.choices.push('save'); assert.equal(await session.requestClose(), true);
  assert.equal((await loadWorkspace(path.join(root, 'saved.receiptmatch'))).metadata.name, 'Saved on close');
});

test('discard only replaces current work after Open succeeds; cancelled/invalid Open preserves it', async () => {
  const root = await directory(); const { plan, dialogs } = scriptedDialogs(); const session = new WorkspaceSession(dialogs);
  await session.dispatch({ type: 'new' }); await session.dispatch({ type: 'rename', name: 'Keep me' }); const id = session.state().workspace!.id;
  plan.choices.push('discard'); plan.opens.push(null); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.id, id);
  plan.choices.push('discard'); plan.opens.push(path.join(root, 'missing.receiptmatch')); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.name, 'Keep me'); assert.equal(session.state().workspace!.dirty, true);
  const file = path.join(root, 'other.receiptmatch'); await createWorkspace(file, { ...newMetadata(), name: 'Other workspace' });
  plan.choices.push('discard'); plan.opens.push(file); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.name, 'Other workspace'); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Will discard' }); plan.choices.push('discard'); await session.dispatch({ type: 'new' }); assert.equal(session.state().workspace!.filePath, null); assert.notEqual(session.state().workspace!.id, id);
});

test('concurrent native operations cannot replace or rename a workspace during save', async () => {
  let release: ((value: string | null) => void) | undefined;
  const dialogs: WorkspaceDialogs = { save: () => new Promise(resolve => { release = resolve; }), open: async () => null, unsaved: async () => 'cancel' };
  const session = new WorkspaceSession(dialogs); await session.dispatch({ type: 'new' });
  const saving = session.dispatch({ type: 'save' }); assert.equal(session.state().busy, true);
  const rejected = await session.dispatch({ type: 'rename', name: 'Race' }); assert.ok(rejected.error); assert.equal(session.state().workspace!.name, 'Untitled workspace');
  assert.equal(await session.requestClose(), false); assert.ok(release); release(null); await saving; assert.equal(session.state().busy, false);
});
