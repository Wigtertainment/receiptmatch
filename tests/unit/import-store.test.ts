import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkspace, fingerprint, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION } from '../../electron/store.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import { row, statement } from './bank-fixtures.js';

async function directory() { await mkdir('artifacts', { recursive: true }); return mkdtemp(path.resolve('artifacts/import-store-')); }
function record(root: string, partial = false): StoredBankImport {
  const input = statement(); const id = randomUUID();
  input.source = { sourceId: randomUUID(), sha256: createHash('sha256').update(id).digest('hex') };
  input.extraction.runId = randomUUID();
  input.pages[0].spans.find(value => value.text === '1,234.56')!.text = '90,071,992,547,409.93';
  if (partial) input.pages[0].spans.push(...row(330, '31 Feb 2032', 'Unresolved synthetic payment', '4.00', null));
  const result = parseBankStatement(input);
  assert.equal(result.status, partial ? 'partial' : 'complete');
  return storedBankImportSchema.parse({
    id, importedAt: '2032-03-01T12:00:00.000Z', filePath: path.join(root, `${id}.pdf`), result,
    accounts: result.accountSections.map(value => ({ sectionId: value.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
    transactions: result.transactions.map(value => ({ rowId: value.rowId, transactionId: randomUUID() })),
    drafts: result.unresolvedDrafts.map(value => ({ rowId: value.rowId, draftId: randomUUID() }))
  });
}
async function legacy(root: string) {
  const file = path.join(root, 'legacy.receiptmatch'); await createWorkspace(file, newMetadata());
  const legacyAccountId = randomUUID();
  const db = new Database(file); db.pragma('foreign_keys=ON');
  db.exec('DROP TABLE document_imports; DROP TABLE bank_imports; PRAGMA user_version=1;');
  db.prepare('INSERT INTO sources VALUES(?,?,?)').run('legacy-source', path.join(root, 'legacy-original.pdf'), 'f'.repeat(64));
  db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(legacyAccountId, 'Legacy account', 'EUR');
  db.prepare('INSERT INTO statements VALUES(?,?,?)').run('legacy-statement', legacyAccountId, 'legacy-source');
  db.exec("INSERT INTO transactions VALUES('legacy-transaction','legacy-statement','-9007199254740993','EUR',2,3); INSERT INTO documents VALUES('legacy-document','legacy-source',4); INSERT INTO associations VALUES('legacy-association','legacy-transaction','legacy-document','uncertain',2,'3:2:4');");
  db.close();
  return { file, legacyAccountId, saved: await loadWorkspace(file) };
}
function baseRows(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return Object.fromEntries(['sources', 'accounts', 'statements', 'transactions', 'documents', 'associations'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  } finally { db.close(); }
}

test('version 1 opens without writes; its first explicit metadata-only save atomically upgrades without changing financial records', async () => {
  const root = await directory(); const { file, saved } = await legacy(root); const before = await readFile(file); const financial = baseRows(file);
  assert.equal(saved.schemaVersion, 1); assert.deepEqual(saved.imports, []);
  const opened = await loadWorkspace(file); assert.deepEqual(await readFile(file), before); assert.equal(opened.schemaVersion, 1);
  const upgraded = await saveWorkspace(opened, { ...opened.metadata, name: 'Explicitly upgraded' });
  assert.equal(upgraded.schemaVersion, SCHEMA_VERSION); assert.deepEqual(upgraded.imports, []);
  assert.equal((await loadWorkspace(file)).metadata.name, 'Explicitly upgraded'); assert.deepEqual(baseRows(file), financial);
  const db = new Database(file, { readonly: true });
  try { assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION); assert.deepEqual(db.prepare('SELECT * FROM bank_imports').all(), []); }
  finally { db.close(); }
});

test('partial imports preserve drafts, field evidence, adapter versions, stable identities and exact projected money across reopening', async () => {
  const root = await directory(); const file = path.join(root, 'partial.receiptmatch'); const retained = record(root, true);
  const created = await createWorkspace(file, newMetadata(), [retained]); const loaded = await loadWorkspace(file);
  assert.equal(created.schemaVersion, SCHEMA_VERSION); assert.deepEqual(loaded.imports, [retained]);
  const db = new Database(file, { readonly: true });
  try {
    const projected = db.prepare('SELECT coefficient,currency,scale,statement_id FROM transactions WHERE id=?').get(retained.transactions[0].transactionId);
    assert.deepEqual(projected, { coefficient: '-9007199254740993', currency: 'EUR', scale: 2, statement_id: retained.accounts[0].statementId });
    const source = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?').get(retained.result.sourceProvenance!.sourceId);
    assert.deepEqual(source, { path: retained.filePath, fingerprint: retained.result.sourceProvenance!.sha256 });
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, retained.result.transactions.length);
  } finally { db.close(); }
  assert.equal(loaded.imports[0].result.unresolvedDrafts.length, 1);
  assert.deepEqual(loaded.imports[0].result.unresolvedDrafts[0].evidence, retained.result.unresolvedDrafts[0].evidence);
  assert.equal(loaded.fingerprint, await fingerprint(file));
});

test('explicit append to a version 1 file preserves every legacy transaction, document and manual approval', async () => {
  const root = await directory(); const { file, saved } = await legacy(root); const before = baseRows(file); const retained = record(root, true);
  const appended = await saveWorkspace(saved, { ...saved.metadata, name: 'With imports' }, [retained]);
  assert.equal(appended.schemaVersion, SCHEMA_VERSION); assert.deepEqual((await loadWorkspace(file)).imports, [retained]);
  const after = baseRows(file);
  for (const table of ['sources', 'accounts', 'statements', 'transactions', 'documents', 'associations']) {
    for (const oldRow of before[table]) assert.ok(after[table].some(value => JSON.stringify(value) === JSON.stringify(oldRow)), `${table} must preserve each legacy row`);
  }
  assert.deepEqual(after.documents, before.documents); assert.deepEqual(after.associations, before.associations);
});

test('default two-argument saves preserve imports and repeated appends never duplicate projected records', async () => {
  const root = await directory(); const file = path.join(root, 'append.receiptmatch'); const first = record(root); const second = record(root, true);
  const saved = await createWorkspace(file, newMetadata(), [first]);
  const renamed = await saveWorkspace(saved, { ...saved.metadata, name: 'Renamed with imports' }); assert.deepEqual(renamed.imports, [first]);
  const appended = await saveWorkspace(renamed, renamed.metadata, [first, second]);
  const repeated = await saveWorkspace(appended, appended.metadata, [first, second]);
  assert.deepEqual((await loadWorkspace(file)).imports, [first, second]); assert.deepEqual(repeated.imports, [first, second]);
  const db = new Database(file, { readonly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS count FROM bank_imports').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM sources').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, first.transactions.length + second.transactions.length);
  } finally { db.close(); }
  for (const requested of [[], [second, first], [first, { ...second, filePath: path.join(root, 'rewritten.pdf') }]]) {
    const before = await readFile(file); await assert.rejects(() => saveWorkspace(repeated, repeated.metadata, requested), /cannot be removed|rewritten/);
    assert.deepEqual(await readFile(file), before);
  }
});

test('duplicate content and global identities are rejected against legacy rows, the workspace and other new imports without writes', async () => {
  const root = await directory(); const { file, saved, legacyAccountId } = await legacy(root);
  const variants: StoredBankImport[][] = [];
  const legacyCollision = record(root); legacyCollision.transactions[0].transactionId = legacyAccountId; variants.push([legacyCollision]);
  const workspaceCollision = record(root, true); workspaceCollision.drafts[0].draftId = saved.metadata.id; variants.push([workspaceCollision]);
  const legacyHash = record(root); legacyHash.result.sourceProvenance!.sha256 = 'f'.repeat(64); variants.push([legacyHash]);
  const first = record(root); const sameHash = record(root); sameHash.result.sourceProvenance!.sha256 = first.result.sourceProvenance!.sha256; variants.push([first, sameHash]);
  const sameIdentity = record(root, true); sameIdentity.drafts[0].draftId = first.transactions[0].transactionId.toUpperCase(); variants.push([first, sameIdentity]);
  for (const imports of variants) {
    const before = await readFile(file); await assert.rejects(() => saveWorkspace(saved, saved.metadata, imports), /identity|content/);
    assert.deepEqual(await readFile(file), before); assert.equal((await loadWorkspace(file)).schemaVersion, 1);
  }
});

test('invalid mappings reject before writes and failed creation does not leave a workspace', async () => {
  const root = await directory(); const { file, saved } = await legacy(root); const invalid = record(root); invalid.transactions.pop();
  const before = await readFile(file); await assert.rejects(() => saveWorkspace(saved, saved.metadata, [invalid])); assert.deepEqual(await readFile(file), before);
  const target = path.join(root, 'invalid.receiptmatch'); await assert.rejects(() => createWorkspace(target, newMetadata(), [invalid]));
  await assert.rejects(() => readFile(target), { code: 'ENOENT' });
  const metadata = newMetadata(); const collision = record(root); collision.id = metadata.id;
  await assert.rejects(() => createWorkspace(target, metadata, [collision]), /identity/);
  await assert.rejects(() => readFile(target), { code: 'ENOENT' });
});

test('external changes block stale saves in both version 1 and imported version 2 files without changing the newer bytes', async () => {
  const root = await directory(); const old = await legacy(root);
  const current = await createWorkspace(path.join(root, 'current.receiptmatch'), newMetadata(), [record(root, true)]);
  for (const saved of [old.saved, current]) {
    const db = new Database(saved.filePath); try { db.prepare('UPDATE workspace SET name=?').run('External revision'); } finally { db.close(); }
    const before = await readFile(saved.filePath);
    await assert.rejects(() => saveWorkspace(saved, { ...saved.metadata, name: 'Stale overwrite' }), /changed outside/);
    assert.deepEqual(await readFile(saved.filePath), before);
    assert.equal((await loadWorkspace(saved.filePath)).metadata.name, 'External revision');
  }
});

test('broken manifests and mismatched normalized source, account, statement and transaction projections are rejected read-only', async () => {
  const root = await directory(); const source = path.join(root, 'valid.receiptmatch'); const retained = record(root, true);
  await createWorkspace(source, newMetadata(), [retained]);
  const mutations = [
    (db: Database.Database) => db.prepare('UPDATE bank_imports SET record_json=?').run('{broken json'),
    (db: Database.Database) => db.prepare('UPDATE bank_imports SET id=?').run(randomUUID()),
    (db: Database.Database) => db.prepare('UPDATE sources SET path=?').run(path.join(root, 'different-original.pdf')),
    (db: Database.Database) => db.prepare('UPDATE sources SET fingerprint=?').run('b'.repeat(64)),
    (db: Database.Database) => db.prepare('UPDATE accounts SET currency=?').run('USD'),
    (db: Database.Database) => db.prepare('UPDATE accounts SET name=?').run('Different account evidence'),
    (db: Database.Database) => db.prepare('UPDATE transactions SET coefficient=?').run('-1'),
    (db: Database.Database) => db.prepare('UPDATE transactions SET scale=?').run(3),
    (db: Database.Database) => db.prepare('INSERT INTO transactions(id,statement_id,coefficient,currency,scale) VALUES(?,?,?,?,?)').run(randomUUID(), retained.accounts[0].statementId, '1', 'EUR', 2),
    (db: Database.Database) => db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), retained.accounts[0].accountId, retained.result.sourceProvenance!.sourceId),
    (db: Database.Database) => {
      const other = randomUUID(); db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(other, 'Unowned account', 'EUR');
      db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), other, retained.result.sourceProvenance!.sourceId);
    },
    (db: Database.Database) => {
      const other = randomUUID(); db.prepare('INSERT INTO sources VALUES(?,?,?)').run(other, '/unowned-source.pdf', null);
      db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), retained.accounts[0].accountId, other);
    },
    (db: Database.Database) => db.prepare('INSERT INTO sources VALUES(?,?,?)').run(randomUUID(), '/duplicate-source.pdf', retained.result.sourceProvenance!.sha256),
    (db: Database.Database) => {
      const other = randomUUID(); db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(other, 'Other account', 'EUR');
      db.prepare('UPDATE statements SET account_id=?').run(other);
    },
    (db: Database.Database) => {
      const other = randomUUID(); db.prepare('INSERT INTO sources VALUES(?,?,?)').run(other, '/other-source.pdf', null);
      db.prepare('UPDATE bank_imports SET source_id=?').run(other);
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const file = path.join(root, `corrupt-${index}.receiptmatch`); await copyFile(source, file);
    const db = new Database(file); try { mutate(db); } finally { db.close(); }
    const before = await readFile(file); await assert.rejects(() => loadWorkspace(file)); assert.deepEqual(await readFile(file), before);
  }
});

test('an actual append failure rolls back migration, projections and metadata together', async () => {
  const root = await directory(); const { file, saved } = await legacy(root); const before = await readFile(file); const original = Database.prototype.prepare;
  const probe = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function(this: Database.Database, sql: string) {
    const query = Reflect.apply(original, this, [sql]) as Database.Statement;
    if (sql.startsWith('INSERT INTO bank_imports')) query.run = () => { throw new Error('Controlled manifest write failure'); };
    return query;
  } as typeof Database.prototype.prepare);
  try { await assert.rejects(() => saveWorkspace(saved, { ...saved.metadata, name: 'Must roll back' }, [record(root)]), /Controlled manifest write failure/); }
  finally { probe.mockRestore(); }
  assert.deepEqual(await readFile(file), before);
  const reopened = await loadWorkspace(file); assert.equal(reopened.schemaVersion, 1); assert.deepEqual(reopened.imports, []); assert.deepEqual(reopened.metadata, saved.metadata);
});

test('concurrent append saves cannot merge or overwrite one another silently', async () => {
  const root = await directory(); const file = path.join(root, 'concurrent.receiptmatch'); const saved = await createWorkspace(file, newMetadata());
  const first = record(root); const second = record(root);
  const results = await Promise.allSettled([saveWorkspace(saved, { ...saved.metadata, name: 'First' }, [first]), saveWorkspace(saved, { ...saved.metadata, name: 'Second' }, [second])]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); assert.equal(results.filter(value => value.status === 'rejected').length, 1);
  const reopened = await loadWorkspace(file); assert.equal(reopened.imports.length, 1);
  assert.deepEqual(reopened.imports[0], reopened.metadata.name === 'First' ? first : second);
});

for (const operation of ['load', 'save', 'create'] as const) test(`${operation} rejects an atomic pathname replacement between the protected descriptor and SQLite open`, async () => {
  const root = await directory(); const file = path.join(root, 'selected.receiptmatch'); const replacement = path.join(root, 'replacement.receiptmatch');
  const parked = path.join(root, 'original-inode.receiptmatch'); const metadata = newMetadata();
  const current = operation === 'create' ? null : await createWorkspace(file, { ...metadata, name: 'Original revision' });
  if (operation === 'create') {
    const foreign = new Database(replacement); foreign.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('external original');"); foreign.close();
  } else await createWorkspace(replacement, { ...metadata, name: 'External replacement with same workspace UUID' });
  const externalBytes = await readFile(replacement); const originalBytes = current ? await readFile(file) : Buffer.alloc(0);
  const originalOpen = fsModule.openSync; let opens = 0; let replacements = 0;
  const protectedOpen = operation === 'load' ? 2 : operation === 'save' ? 3 : 1;
  const probe = vi.spyOn(fsModule, 'openSync').mockImplementation(((selected: fsModule.PathLike, flags: string | number, mode?: fsModule.Mode) => {
    const descriptor = originalOpen(selected, flags, mode);
    if (selected === file && flags === (operation === 'create' ? 'wx+' : 'r') && ++opens === protectedOpen) {
      fsModule.renameSync(file, parked); fsModule.renameSync(replacement, file); replacements++;
    }
    return descriptor;
  }) as typeof fsModule.openSync);
  syncBuiltinESMExports();
  try {
    if (operation === 'load') await assert.rejects(() => loadWorkspace(file), /replaced or linked/);
    else if (operation === 'save') await assert.rejects(() => saveWorkspace(current!, { ...current!.metadata, name: 'Must never overwrite replacement' }, [record(root)]), /replaced or linked/);
    else await assert.rejects(() => createWorkspace(file, metadata, [record(root)]), /replaced or linked/);
  } finally { probe.mockRestore(); syncBuiltinESMExports(); }
  assert.equal(replacements, 1, 'The replacement must occur after the protected descriptor has actually opened.');
  assert.deepEqual(await readFile(file), externalBytes); assert.deepEqual(await readFile(parked), originalBytes);
  if (operation !== 'create') assert.equal((await loadWorkspace(file)).metadata.name, 'External replacement with same workspace UUID');
});
