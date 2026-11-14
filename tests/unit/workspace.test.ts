import type { WorkspaceState } from "../../src/shared/protocol.js";
import { test, vi, type Mock } from 'vitest';
import assert from 'node:assert/strict';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkspace, fingerprint, loadWorkspace, moneySchema, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession, type WorkspaceDialogs } from '../../electron/workspace-session.js';

async function directory(): Promise<string> {
  await mkdir('artifacts', { recursive: true }); return mkdtemp(path.resolve('artifacts/unit-'));
}

function scriptedDialogs(): { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; dialogs: WorkspaceDialogs; } {
  const plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ('save' | 'discard' | 'cancel')[] } = { saves: [], opens: [], choices: [] };
  const dialogs: WorkspaceDialogs = { save: async (): Promise<string | null> => Promise.resolve(plan.saves.shift() ?? null), open: async (): Promise<string | null> => Promise.resolve(plan.opens.shift() ?? null), unsaved: async (): Promise<"discard" | "save" | "cancel"> => Promise.resolve(plan.choices.shift() ?? 'cancel') };
  return { plan, dialogs };
}

test('workspace stores exact canonical amounts, source references and independent approvals without modifying originals', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'records.receiptmatch'); const original: string = path.join(root, 'original.pdf');
  await writeFile(original, 'original supporting document'); const originalHash: string = await fingerprint(original);
  await createWorkspace(file, newMetadata());
  const db: Database.Database = new Database(file); db.pragma('foreign_keys=ON');
  db.exec(`INSERT INTO sources VALUES('s1','${original.replace(/'/g, "''")}',NULL); INSERT INTO accounts VALUES('a1','Business','EUR'); INSERT INTO statements VALUES('st1','a1','s1');
    INSERT INTO transactions VALUES('t1','st1','9007199254740993','EUR',2,1); INSERT INTO transactions VALUES('t2','st1','-9007199254740993','EUR',2,1);
    INSERT INTO documents VALUES('d1','s1',1); INSERT INTO documents VALUES('d2','s1',1);
    INSERT INTO associations VALUES('x1','t1','d1','uncertain',1,'1:1:1'); INSERT INTO associations VALUES('x2','t1','d2','reliable',1,NULL); INSERT INTO associations VALUES('x3','t2','d1','reliable',1,NULL);`);
  assert.throws((): Database.RunResult => db.prepare('INSERT INTO statements VALUES(?,?,?)').run('invalid', 'missing', 's1'), /FOREIGN KEY/);
  db.close();
  const loaded: SavedWorkspace = await loadWorkspace(file);
  await saveWorkspace(loaded, { ...loaded.metadata, name: 'Business — November' });
  const reopened: SavedWorkspace = await loadWorkspace(file); assert.equal(reopened.metadata.name, 'Business — November');
  const read: Database.Database = new Database(file, { readonly: true });
  assert.equal((read.prepare('SELECT coefficient FROM transactions WHERE id=?').get('t1') as { coefficient: string }).coefficient, '9007199254740993');
  assert.deepEqual(read.prepare('SELECT confidence,approved_revision FROM associations ORDER BY id').all(), [{ confidence: 'uncertain', approved_revision: '1:1:1' }, { confidence: 'reliable', approved_revision: null }, { confidence: 'reliable', approved_revision: null }]);
  read.close(); assert.equal(await fingerprint(original), originalHash);
  assert.equal(BigInt(moneySchema.parse({ coefficient: '9007199254740993', currency: 'EUR', scale: 2 }).coefficient), 9007199254740993n);
  for (const coefficient of ['01', '-0', '+1', '1.5', '1e4']) {
    assert.equal(moneySchema.safeParse({ coefficient, currency: 'EUR', scale: 2 }).success, false);
  }
});

test('foreign, corrupt and future workspaces are read-only rejected; existing files are never replaced', async (): Promise<void> => {
  const root: string = await directory();
  const foreign: string = path.join(root, 'foreign.receiptmatch'); const foreignDb: Database.Database = new Database(foreign); foreignDb.exec('CREATE TABLE unrelated(value TEXT)'); foreignDb.close();
  const future: string = path.join(root, 'future.receiptmatch'); await createWorkspace(future, newMetadata()); const futureDb: Database.Database = new Database(future); futureDb.pragma(`user_version=${SCHEMA_VERSION + 1}`); futureDb.close();
  const corrupt: string = path.join(root, 'corrupt.receiptmatch'); await writeFile(corrupt, 'not a database');
  for (const file of [foreign, future, corrupt]) {
    const before: string = await fingerprint(file); await assert.rejects((): Promise<SavedWorkspace> => loadWorkspace(file)); assert.equal(await fingerprint(file), before);
  }
  const before: NonSharedBuffer = await readFile(foreign); await assert.rejects((): Promise<SavedWorkspace> => createWorkspace(foreign, newMetadata()), { code: 'EEXIST' }); assert.deepEqual(await readFile(foreign), before);
});

test('external changes are not overwritten by an existing workspace save', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'workspace.receiptmatch'); const saved: SavedWorkspace = await createWorkspace(file, newMetadata());
  const external: Database.Database = new Database(file); external.prepare('UPDATE workspace SET name=?').run('External change'); external.close();
  const before: string = await fingerprint(file);
  await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, { ...saved.metadata, name: 'Overwrite' }), /changed outside/);
  assert.equal(await fingerprint(file), before);
});

test('two concurrent saves from the same revision cannot silently overwrite one another', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'workspace.receiptmatch'); const saved: SavedWorkspace = await createWorkspace(file, newMetadata());
  const results: [PromiseSettledResult<SavedWorkspace>, PromiseSettledResult<SavedWorkspace>] = await Promise.allSettled([saveWorkspace(saved, { ...saved.metadata, name: 'First writer' }), saveWorkspace(saved, { ...saved.metadata, name: 'Second writer' })]);
  assert.equal(results.filter((result: PromiseSettledResult<SavedWorkspace>): result is PromiseFulfilledResult<SavedWorkspace> => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result: PromiseSettledResult<SavedWorkspace>): result is PromiseRejectedResult => result.status === 'rejected').length, 1);
  const reopened: SavedWorkspace = await loadWorkspace(file); assert.ok(['First writer', 'Second writer'].includes(reopened.metadata.name));
});

for (const operation of ['create', 'save'] as const) {
  test(`${operation} captures its committed fingerprint while competing SQLite writers remain excluded`, async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'protected.receiptmatch'); const metadata: { name: string; id: string; createdAt: string; savedAt: string | null; } = { ...newMetadata(), name: 'Protected revision' };
  const existing: SavedWorkspace | null = operation === 'save' ? await createWorkspace(file, newMetadata()) : null;
  const originalRead: { (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fsModule.ReadPosition | null): number; (fd: number, buffer: NodeJS.ArrayBufferView, opts?: fsModule.ReadOptions): number; } = fsModule.readSync; let reads: number = 0; let attempts: number = 0;
  const captureRead: 1 | 3 = operation === 'create' ? 1 : 3;
  const probe: Mock<{ (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fsModule.ReadPosition | null): number; (fd: number, buffer: NodeJS.ArrayBufferView, opts?: fsModule.ReadOptions): number; }> = vi.spyOn(fsModule, 'readSync').mockImplementation(((selected: number, ...rest: [buffer: NodeJS.ArrayBufferView, options?: fsModule.ReadOptions] | [buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fsModule.ReadPosition | null]): number => {
    if (rest[2] === 65536 && rest[3] === 0 && fsModule.fstatSync(Number(selected)).ino === fsModule.statSync(file).ino && ++reads === captureRead) {
      attempts++;
      const other: SpawnSyncReturns<string> = spawnSync(process.execPath, ['-e', "const Database=require('better-sqlite3');let db;try{db=new Database(process.argv[1],{timeout:0});db.prepare('UPDATE workspace SET name=?').run('External writer');process.exitCode=2;}catch(error){if(error.code==='SQLITE_BUSY'){console.log(error.code);}else{console.error(error);process.exitCode=3;}}finally{db?.close();}", file], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(other.status, 0, other.stderr); assert.match(other.stdout, /SQLITE_BUSY/);
    }
    return Reflect.apply(originalRead, fsModule, [selected, ...rest]) as number;
  }));
  syncBuiltinESMExports();
  let saved: SavedWorkspace;
  try {
    saved = existing ? await saveWorkspace(existing, { ...existing.metadata, name: metadata.name }) : await createWorkspace(file, metadata);
  } finally {
    probe.mockRestore(); syncBuiltinESMExports();
  }
  assert.equal(attempts, 1, 'Probe must run at committed-file capture, not merely before commit');
  assert.equal(saved.fingerprint, await fingerprint(file)); assert.equal((await loadWorkspace(file)).metadata.name, 'Protected revision');
});
}

test('cancelled and failed saves block replacement/close and retain the unsaved workspace', async (): Promise<void> => {
  const root: string = await directory(); const { plan, dialogs }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; dialogs: WorkspaceDialogs; } = scriptedDialogs(); const session: WorkspaceSession = new WorkspaceSession(dialogs);
  await session.dispatch({ type: 'new' }); await session.dispatch({ type: 'rename', name: 'Current work' }); const id: string = session.state().workspace!.id;
  plan.choices.push('save'); plan.saves.push(null); await session.dispatch({ type: 'new' });
  assert.equal(session.state().workspace!.id, id); assert.equal(session.state().workspace!.dirty, true);
  plan.choices.push('cancel'); assert.equal(await session.requestClose(), false);
  const existing: string = path.join(root, 'existing.receiptmatch'); await writeFile(existing, 'never overwrite');
  plan.choices.push('save'); plan.saves.push(existing); assert.equal(await session.requestClose(), false);
  assert.equal(session.state().workspace!.name, 'Current work'); assert.equal(session.state().workspace!.dirty, true); assert.ok(session.state().error);
  assert.equal(await readFile(existing, 'utf8'), 'never overwrite');
  plan.saves.push(path.join(root, 'saved.receiptmatch')); await session.dispatch({ type: 'save' }); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Changed' }); await session.dispatch({ type: 'rename', name: 'Current work' }); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Saved on close' }); plan.choices.push('save'); assert.equal(await session.requestClose(), true);
  assert.equal((await loadWorkspace(path.join(root, 'saved.receiptmatch'))).metadata.name, 'Saved on close');
});

test('discard only replaces current work after Open succeeds; cancelled/invalid Open preserves it', async (): Promise<void> => {
  const root: string = await directory(); const { plan, dialogs }: { plan: { saves: (string | null)[]; opens: (string | null)[]; choices: ("save" | "discard" | "cancel")[]; }; dialogs: WorkspaceDialogs; } = scriptedDialogs(); const session: WorkspaceSession = new WorkspaceSession(dialogs);
  await session.dispatch({ type: 'new' }); await session.dispatch({ type: 'rename', name: 'Keep me' }); const id: string = session.state().workspace!.id;
  plan.choices.push('discard'); plan.opens.push(null); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.id, id);
  plan.choices.push('discard'); plan.opens.push(path.join(root, 'missing.receiptmatch')); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.name, 'Keep me'); assert.equal(session.state().workspace!.dirty, true);
  const file: string = path.join(root, 'other.receiptmatch'); await createWorkspace(file, { ...newMetadata(), name: 'Other workspace' });
  plan.choices.push('discard'); plan.opens.push(file); await session.dispatch({ type: 'open' }); assert.equal(session.state().workspace!.name, 'Other workspace'); assert.equal(session.state().workspace!.dirty, false);
  await session.dispatch({ type: 'rename', name: 'Will discard' }); plan.choices.push('discard'); await session.dispatch({ type: 'new' }); assert.equal(session.state().workspace!.filePath, null); assert.notEqual(session.state().workspace!.id, id);
});

test('concurrent native operations cannot replace or rename a workspace during save', async (): Promise<void> => {
  let release: ((value: string | null) => void) | undefined;
  const dialogs: WorkspaceDialogs = { save: (): Promise<string | null> => new Promise((resolve: (value: string | PromiseLike<string | null> | null) => void): void => {
    release = resolve;
  }), open: async (): Promise<null> => Promise.resolve(null), unsaved: async (): Promise<"cancel"> => Promise.resolve('cancel') };
  const session: WorkspaceSession = new WorkspaceSession(dialogs); await session.dispatch({ type: 'new' });
  const saving: Promise<WorkspaceState> = session.dispatch({ type: 'save' }); assert.equal(session.state().busy, true);
  const rejected: WorkspaceState = await session.dispatch({ type: 'rename', name: 'Race' }); assert.ok(rejected.error); assert.equal(session.state().workspace!.name, 'Untitled workspace');
  assert.equal(await session.requestClose(), false); assert.ok(release); release(null); await saving; assert.equal(session.state().busy, false);
});
