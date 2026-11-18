import type { BankImportInput, BankImportResult, PositionedSpan, SourceEvidence, TransactionCandidate, UnresolvedDraft } from "../../src/shared/bank-import.js";
import { test, vi, type Mock, type MockInstance, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkspace, fingerprint, loadWorkspace, newMetadata, saveWorkspace, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { parseBankStatement } from '../../electron/import/registry.js';
import type { BankCorrection } from '../../src/shared/bank-corrections.js';
import { advanceReviewRevision, approvalSelectionFor, type ReviewApprovalState } from '../../src/shared/match-approvals.js';
import { duplicatePairKey, type DuplicateDecision } from '../../src/shared/transaction-duplicates.js';
import type { StoredDocumentImport, StoredSupportingDocument } from '../../src/shared/workspace-documents.js';
import { storedBankImportSchema, type StoredBankImport } from '../../src/shared/workspace-import.js';
import { row, statement } from './bank-fixtures.js';
import { documentRun, retainedDocument } from './document-fixtures.js';

async function directory(): Promise<string> {
  await mkdir('artifacts', { recursive: true }); return mkdtemp(path.resolve('artifacts/import-store-'));
}

function record(root: string, partial: boolean = false): StoredBankImport {
  const input: BankImportInput = statement(); const id: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
  input.source = { sourceId: randomUUID(), sha256: createHash('sha256').update(id).digest('hex') };
  input.extraction.runId = randomUUID();
  input.pages[0].spans.find((value: PositionedSpan): boolean => value.text === '1,234.56')!.text = '90,071,992,547,409.93';
  if (partial) {
    input.pages[0].spans.push(...row(330, '31 Feb 2032', 'Unresolved synthetic payment', '4.00', null));
  }
  const result: BankImportResult = parseBankStatement(input);
  assert.equal(result.status, partial ? 'partial' : 'complete');
  return storedBankImportSchema.parse({
    id, importedAt: '2032-03-01T12:00:00.000Z', filePath: path.join(root, `${id}.pdf`), result,
    accounts: result.accountSections.map((value: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): { sectionId: string; accountId: `${string}-${string}-${string}-${string}-${string}`; statementId: `${string}-${string}-${string}-${string}-${string}`; } => ({ sectionId: value.sectionId, accountId: randomUUID(), statementId: randomUUID() })),
    transactions: result.transactions.map((value: TransactionCandidate): { rowId: string; transactionId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: value.rowId, transactionId: randomUUID() })),
    drafts: result.unresolvedDrafts.map((value: UnresolvedDraft): { rowId: string; draftId: `${string}-${string}-${string}-${string}-${string}`; } => ({ rowId: value.rowId, draftId: randomUUID() }))
  });
}

async function legacy(root: string): Promise<{ file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; }> {
  const file: string = path.join(root, 'legacy.receiptmatch'); await createWorkspace(file, newMetadata());
  const legacyAccountId: `${string}-${string}-${string}-${string}-${string}` = randomUUID();
  const db: Database.Database = new Database(file); db.pragma('foreign_keys=ON');
  db.exec(`DROP TABLE statement_analysis_versions; DROP TABLE receipt_analysis_versions; DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; DROP TABLE match_approval_state; DROP TABLE document_corrections; DROP TABLE bank_corrections; DROP TABLE match_reviews;
    DROP TABLE match_results; DROP TABLE document_imports; DROP TABLE bank_imports; PRAGMA user_version=1;`);
  db.prepare('INSERT INTO sources VALUES(?,?,?)').run('legacy-source', path.join(root, 'legacy-original.pdf'), 'f'.repeat(64));
  db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(legacyAccountId, 'Legacy account', 'EUR');
  db.prepare('INSERT INTO statements VALUES(?,?,?)').run('legacy-statement', legacyAccountId, 'legacy-source');
  db.exec("INSERT INTO transactions VALUES('legacy-transaction','legacy-statement','-9007199254740993','EUR',2,3); INSERT INTO documents VALUES('legacy-document','legacy-source',4); INSERT INTO associations VALUES('legacy-association','legacy-transaction','legacy-document','uncertain',2,'3:2:4');");
  db.close();
  return { file, legacyAccountId, saved: await loadWorkspace(file) };
}

function baseRows(file: string): Record<string, unknown[]> {
  const db: Database.Database = new Database(file, { readonly: true });
  try {
    return Object.fromEntries(['sources', 'accounts', 'statements', 'transactions', 'documents', 'associations'].map((table: string): [string, unknown[]] => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  } finally {
    db.close();
  }
}

test('version 1 opens without writes; its first explicit metadata-only save atomically upgrades without changing financial records', async (): Promise<void> => {
  const root: string = await directory(); const { file, saved }: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root); const before: NonSharedBuffer = await readFile(file); const financial: Record<string, unknown[]> = baseRows(file);
  assert.equal(saved.schemaVersion, 1); assert.deepEqual(saved.imports, []);
  const opened: SavedWorkspace = await loadWorkspace(file); assert.deepEqual(await readFile(file), before); assert.equal(opened.schemaVersion, 1);
  const upgraded: SavedWorkspace = await saveWorkspace(opened, { ...opened.metadata, name: 'Explicitly upgraded' });
  assert.equal(upgraded.schemaVersion, SCHEMA_VERSION); assert.deepEqual(upgraded.imports, []);
  assert.equal((await loadWorkspace(file)).metadata.name, 'Explicitly upgraded'); assert.deepEqual(baseRows(file), financial);
  const db: Database.Database = new Database(file, { readonly: true });
  try {
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION); assert.deepEqual(db.prepare('SELECT * FROM bank_imports').all(), []);
  } finally {
    db.close();
  }
});

test('partial imports preserve drafts, field evidence, adapter versions, stable identities and exact projected money across reopening', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'partial.receiptmatch'); const retained: StoredBankImport = record(root, true);
  const created: SavedWorkspace = await createWorkspace(file, newMetadata(), [retained]); const loaded: SavedWorkspace = await loadWorkspace(file);
  assert.equal(created.schemaVersion, SCHEMA_VERSION); assert.deepEqual(loaded.imports, [retained]);
  const db: Database.Database = new Database(file, { readonly: true });
  try {
    const projected: unknown = db.prepare('SELECT coefficient,currency,scale,statement_id FROM transactions WHERE id=?').get(retained.transactions[0].transactionId);
    assert.deepEqual(projected, { coefficient: '-9007199254740993', currency: 'EUR', scale: 2, statement_id: retained.accounts[0].statementId });
    const source: unknown = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?').get(retained.result.sourceProvenance!.sourceId);
    assert.deepEqual(source, { path: retained.filePath, fingerprint: retained.result.sourceProvenance!.sha256 });
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, retained.result.transactions.length);
  } finally {
    db.close();
  }
  assert.equal(loaded.imports[0].result.unresolvedDrafts.length, 1);
  assert.deepEqual(loaded.imports[0].result.unresolvedDrafts[0].evidence, retained.result.unresolvedDrafts[0].evidence);
  assert.equal(loaded.fingerprint, await fingerprint(file));
});

test('explicit append to a version 1 file preserves every legacy transaction, document and manual approval', async (): Promise<void> => {
  const root: string = await directory(); const { file, saved }: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root); const before: Record<string, unknown[]> = baseRows(file); const retained: StoredBankImport = record(root, true);
  const appended: SavedWorkspace = await saveWorkspace(saved, { ...saved.metadata, name: 'With imports' }, [retained]);
  assert.equal(appended.schemaVersion, SCHEMA_VERSION); assert.deepEqual((await loadWorkspace(file)).imports, [retained]);
  const after: Record<string, unknown[]> = baseRows(file);
  for (const table of ['sources', 'accounts', 'statements', 'transactions', 'documents', 'associations']) {
    for (const oldRow of before[table]) {
      assert.ok(after[table].some((value: unknown): boolean => JSON.stringify(value) === JSON.stringify(oldRow)), `${table} must preserve each legacy row`);
    }
  }
  assert.deepEqual(after.documents, before.documents); assert.deepEqual(after.associations, before.associations);
});

test('default two-argument saves preserve imports and repeated appends never duplicate projected records', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'append.receiptmatch'); const first: StoredBankImport = record(root); const second: StoredBankImport = record(root, true);
  const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [first]);
  const renamed: SavedWorkspace = await saveWorkspace(saved, { ...saved.metadata, name: 'Renamed with imports' }); assert.deepEqual(renamed.imports, [first]);
  const appended: SavedWorkspace = await saveWorkspace(renamed, renamed.metadata, [first, second]);
  const repeated: SavedWorkspace = await saveWorkspace(appended, appended.metadata, [first, second]);
  assert.deepEqual((await loadWorkspace(file)).imports, [first, second]); assert.deepEqual(repeated.imports, [first, second]);
  const db: Database.Database = new Database(file, { readonly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS count FROM bank_imports').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM sources').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM transactions').get() as { count: number }).count, first.transactions.length + second.transactions.length);
  } finally {
    db.close();
  }
  for (const requested of [[], [second, first], [first, { ...second, filePath: path.join(root, 'rewritten.pdf') }]]) {
    const before: NonSharedBuffer = await readFile(file); await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(repeated, repeated.metadata, requested), /cannot be removed|rewritten/);
    assert.deepEqual(await readFile(file), before);
  }
});

function saveBankRemoval(current: SavedWorkspace, imports: StoredBankImport[], removed: ReadonlySet<string>): Promise<SavedWorkspace> {
  return saveWorkspace(current, current.metadata, imports, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, removed);
}

test('an explicitly removed bank import loses its stored dependencies and can be reimported after reopening', async (context: TestContext): Promise<void> => {
  const root: string = await directory();
  context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
  const file: string = path.join(root, 'remove-bank.receiptmatch');
  const first: StoredBankImport = record(root), removed: StoredBankImport = record(root, true), last: StoredBankImport = record(root);
  await copyFile(path.resolve('tests/fixtures/revolut-synthetic-scan.pdf'), removed.filePath);
  const original: NonSharedBuffer = await readFile(removed.filePath);
  const provenance: NonNullable<StoredBankImport['result']['sourceProvenance']> = removed.result.sourceProvenance!;
  provenance.sha256 = createHash('sha256').update(original).digest('hex');
  const receipt: StoredSupportingDocument = retainedDocument(root);
  const report: StoredDocumentImport = documentRun(root, [receipt]);
  report.files.push(
    { status: 'skipped', filePath: removed.filePath, sha256: provenance.sha256, existingSourceId: provenance.sourceId },
    { status: 'skipped', filePath: first.filePath, sha256: first.result.sourceProvenance!.sha256, existingSourceId: first.result.sourceProvenance!.sourceId }
  );
  const removedTx: string = removed.transactions[0].transactionId, firstTx: string = first.transactions[0].transactionId;
  const promotedDraft: string = removed.drafts[0].draftId;
  const remainingCorrections: Map<string, BankCorrection> = new Map([[
    firstTx, { rowId: firstTx, revision: 2, bookingDate: '2032-02-29' }
  ]]);
  const corrections: Map<string, BankCorrection> = new Map(remainingCorrections).set(promotedDraft, { rowId: promotedDraft, revision: 2, bookingDate: '2032-02-29' });
  const approvals: Map<string, ReviewApprovalState> = new Map([[removedTx, {
    associationRevision: 1, approval: { ...approvalSelectionFor(removedTx, receipt.id), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' }
  }]]);
  const [firstId, secondId]: string[] = [removedTx, firstTx].sort();
  const duplicates: Map<string, DuplicateDecision> = new Map([[duplicatePairKey(firstId, secondId), {
    firstId, secondId, primaryId: null, archivedReview: null
  }]]);
  const remainingRelocations: Map<string, string> = new Map([[first.result.sourceProvenance!.sourceId, path.join(root, 'first-relocated.pdf')]]);
  const relocations: Map<string, string> = new Map(remainingRelocations).set(provenance.sourceId, path.join(root, 'removed-relocated.pdf'));
  const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [first, removed, last], [report], new Map([[removedTx, receipt.id]]),
    corrections, undefined, approvals, duplicates, relocations, undefined, undefined, new Set([firstTx, promotedDraft]));
  assert.ok(saved.matches.some((match: SavedWorkspace['matches'][number]): boolean => match.transactionId === promotedDraft), 'The corrected draft is projected as a transaction.');

  await saveWorkspace(saved, saved.metadata, [first, last], [report], new Map(), remainingCorrections, undefined, undefined, new Map(), remainingRelocations,
    undefined, undefined, new Set([firstTx]), undefined, new Set([removed.id]));
  const reopened: SavedWorkspace = await loadWorkspace(file);
  assert.deepEqual(reopened.imports, [first, last]);
  assert.deepEqual(reopened.documentImports, [{ ...report, files: [report.files[0], report.files[2]] }]);
  assert.equal(reopened.sources.some((source: SavedWorkspace['sources'][number]): boolean => source.id === provenance.sourceId), false);
  assert.equal(reopened.matches.some((match: SavedWorkspace['matches'][number]): boolean => match.transactionId === removedTx || match.transactionId === promotedDraft), false);
  assert.deepEqual(reopened.matchDecisions, new Map());
  assert.deepEqual(reopened.reviewApprovals, new Map());
  assert.deepEqual(reopened.duplicateDecisions, new Map());
  assert.deepEqual(reopened.bankCorrections, remainingCorrections);
  assert.deepEqual(reopened.sourceRelocations, remainingRelocations);
  assert.deepEqual(reopened.ignoredTransactions, new Set([firstTx]));
  const financial: Record<string, unknown[]> = baseRows(file);
  assert.equal(financial.accounts.length, first.accounts.length + last.accounts.length);
  assert.equal(financial.statements.length, first.accounts.length + last.accounts.length);
  assert.equal(financial.transactions.length, first.transactions.length + last.transactions.length);

  const reimport: StoredBankImport = record(root, true);
  reimport.filePath = removed.filePath;
  reimport.result.sourceProvenance!.sha256 = provenance.sha256;
  await saveWorkspace(reopened, reopened.metadata, [first, last, reimport]);
  assert.deepEqual((await loadWorkspace(file)).imports, [first, last, reimport]);
  assert.deepEqual(await readFile(removed.filePath), original);
});

test('a save can replace a removed import with the same PDF hash while retaining the order of surviving imports', async (context: TestContext): Promise<void> => {
  const root: string = await directory();
  context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
  const first: StoredBankImport = record(root), removed: StoredBankImport = record(root), last: StoredBankImport = record(root);
  const saved: SavedWorkspace = await createWorkspace(path.join(root, 'reimport.receiptmatch'), newMetadata(), [first, removed, last]);
  const reimport: StoredBankImport = record(root);
  reimport.filePath = removed.filePath;
  reimport.result.sourceProvenance!.sha256 = removed.result.sourceProvenance!.sha256;
  const ids: Set<string> = new Set([removed.id]);
  const before: NonSharedBuffer = await readFile(saved.filePath);
  await assert.rejects(saveBankRemoval(saved, [first, last], new Set([randomUUID()])));
  await assert.rejects(saveBankRemoval(saved, [last, first, reimport], ids), /reordered|rewritten/);
  assert.deepEqual(await readFile(saved.filePath), before);
  await saveBankRemoval(saved, [first, last, reimport], ids);
  assert.deepEqual((await loadWorkspace(saved.filePath)).imports, [first, last, reimport]);
});

test('removing individual versions of a replacement chain persists the remaining links and review history', async (context: TestContext): Promise<void> => {
  const root: string = await directory();
  context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
  const first: StoredBankImport = record(root), middle: StoredBankImport = record(root), last: StoredBankImport = record(root);
  const firstSource: string = first.result.sourceProvenance!.sourceId;
  const middleSource: string = middle.result.sourceProvenance!.sourceId;
  const lastSource: string = last.result.sourceProvenance!.sourceId;
  const firstTx: string = first.transactions[0].transactionId, lastTx: string = last.transactions[0].transactionId;
  const receipt: StoredSupportingDocument = retainedDocument(root);
  const decisions: Map<string, string | null> = new Map([[lastTx, receipt.id]]);
  const approvals: Map<string, ReviewApprovalState> = new Map([[lastTx, {
    associationRevision: 1, approval: { ...approvalSelectionFor(lastTx, receipt.id), batchId: randomUUID(), approvedAt: '2032-03-01T12:00:00.000Z' }
  }]]);
  const remainingArchive: SavedWorkspace['archivedSourceReviews'] = new Map([[firstSource, new Map([[firstTx, receipt.id]])]]);
  const archives: SavedWorkspace['archivedSourceReviews'] = new Map(remainingArchive).set(middleSource, new Map([[middle.transactions[0].transactionId, receipt.id]]));
  const replacements: Map<string, string> = new Map([[firstSource, middleSource], [middleSource, lastSource]]);
  const file: string = path.join(root, 'remove-replacement.receiptmatch');
  const saved: SavedWorkspace = await createWorkspace(file, newMetadata(), [first, middle, last], [documentRun(root, [receipt])], decisions,
    undefined, undefined, approvals, undefined, undefined, replacements, archives);

  const bridged: Map<string, string> = new Map([[firstSource, lastSource]]);
  await saveWorkspace(saved, saved.metadata, [first, last], undefined, decisions, undefined, undefined, approvals, undefined, undefined,
    bridged, remainingArchive, undefined, undefined, new Set([middle.id]));
  const reopened: SavedWorkspace = await loadWorkspace(file);
  assert.deepEqual(reopened.imports, [first, last]);
  assert.deepEqual(reopened.sourceReplacements, bridged);
  assert.deepEqual(reopened.archivedSourceReviews, remainingArchive);
  assert.deepEqual(reopened.reviewApprovals, approvals);

  const restored: Map<string, string | null> = new Map([[firstTx, receipt.id]]);
  const restoredApprovals: Map<string, ReviewApprovalState> = new Map([[firstTx, advanceReviewRevision()]]);
  await saveWorkspace(reopened, reopened.metadata, [first], undefined, restored, undefined, undefined, restoredApprovals, undefined, undefined,
    new Map(), new Map(), undefined, undefined, new Set([last.id]));
  const final: SavedWorkspace = await loadWorkspace(file);
  assert.deepEqual(final.imports, [first]);
  assert.deepEqual(final.sourceReplacements, new Map());
  assert.deepEqual(final.archivedSourceReviews, new Map());
  assert.deepEqual(final.matchDecisions, restored);
  assert.deepEqual(final.reviewApprovals, restoredApprovals);
  assert.deepEqual(final.documentImports, saved.documentImports);
});

test('a failure deleting the bank import manifest rolls back the removal', async (context: TestContext): Promise<void> => {
  const root: string = await directory();
  context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
  const removed: StoredBankImport = record(root);
  const saved: SavedWorkspace = await createWorkspace(path.join(root, 'remove-rollback.receiptmatch'), newMetadata(), [removed]);
  const before: NonSharedBuffer = await readFile(saved.filePath);
  const prepare: (db: Database.Database, sql: string) => Database.Statement =
    Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
  const probe: MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database, sql: string
  ): Database.Statement<unknown[], unknown> {
    const query: Database.Statement<unknown[], unknown> = prepare(this, sql);
    if (sql.startsWith('DELETE FROM bank_imports')) {
      const remove: Database.Statement<unknown[], unknown>['run'] = query.run.bind(query);
      query.run = (...params: unknown[]): never => {
        assert.equal(remove(...params).changes, 1);
        throw new Error('Controlled manifest removal failure');
      };
    }
    return query;
  });
  try {
    await assert.rejects(saveBankRemoval(saved, [], new Set([removed.id])), /Controlled manifest removal failure/);
  } finally {
    probe.mockRestore();
  }
  assert.deepEqual(await readFile(saved.filePath), before);
  assert.deepEqual((await loadWorkspace(saved.filePath)).imports, [removed]);
});

test('duplicate content and global identities are rejected against legacy rows, the workspace and other new imports without writes', async (): Promise<void> => {
  const root: string = await directory(); const { file, saved, legacyAccountId }: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root);
  const variants: StoredBankImport[][] = [];
  const legacyCollision: StoredBankImport = record(root); legacyCollision.transactions[0].transactionId = legacyAccountId; variants.push([legacyCollision]);
  const workspaceCollision: StoredBankImport = record(root, true); workspaceCollision.drafts[0].draftId = saved.metadata.id; variants.push([workspaceCollision]);
  const legacyHash: StoredBankImport = record(root); legacyHash.result.sourceProvenance!.sha256 = 'f'.repeat(64); variants.push([legacyHash]);
  const first: StoredBankImport = record(root); const sameHash: StoredBankImport = record(root); sameHash.result.sourceProvenance!.sha256 = first.result.sourceProvenance!.sha256; variants.push([first, sameHash]);
  const sameIdentity: StoredBankImport = record(root, true); sameIdentity.drafts[0].draftId = first.transactions[0].transactionId.toUpperCase(); variants.push([first, sameIdentity]);
  for (const imports of variants) {
    const before: NonSharedBuffer = await readFile(file); await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, imports), /identity|content/);
    assert.deepEqual(await readFile(file), before); assert.equal((await loadWorkspace(file)).schemaVersion, 1);
  }
});

test('invalid mappings reject before writes and failed creation does not leave a workspace', async (): Promise<void> => {
  const root: string = await directory(); const { file, saved }: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root); const invalid: StoredBankImport = record(root); invalid.transactions.pop();
  const before: NonSharedBuffer = await readFile(file); await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, saved.metadata, [invalid])); assert.deepEqual(await readFile(file), before);
  const target: string = path.join(root, 'invalid.receiptmatch'); await assert.rejects((): Promise<SavedWorkspace> => createWorkspace(target, newMetadata(), [invalid]));
  await assert.rejects((): Promise<NonSharedBuffer> => readFile(target), { code: 'ENOENT' });
  const metadata: { id: string; name: string; createdAt: string; savedAt: string | null; } = newMetadata(); const collision: StoredBankImport = record(root); collision.id = metadata.id;
  await assert.rejects((): Promise<SavedWorkspace> => createWorkspace(target, metadata, [collision]), /identity/);
  await assert.rejects((): Promise<NonSharedBuffer> => readFile(target), { code: 'ENOENT' });
});

test('external changes block stale saves in both version 1 and imported version 2 files without changing the newer bytes', async (): Promise<void> => {
  const root: string = await directory(); const old: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root);
  const current: SavedWorkspace = await createWorkspace(path.join(root, 'current.receiptmatch'), newMetadata(), [record(root, true)]);
  for (const saved of [old.saved, current]) {
    const db: Database.Database = new Database(saved.filePath); try {
      db.prepare('UPDATE workspace SET name=?').run('External revision');
    } finally {
      db.close();
    }
    const before: NonSharedBuffer = await readFile(saved.filePath);
    await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, { ...saved.metadata, name: 'Stale overwrite' }), /changed outside/);
    assert.deepEqual(await readFile(saved.filePath), before);
    assert.equal((await loadWorkspace(saved.filePath)).metadata.name, 'External revision');
  }
});

test('broken manifests and mismatched normalized source, account, statement and transaction projections are rejected read-only', async (): Promise<void> => {
  const root: string = await directory(); const source: string = path.join(root, 'valid.receiptmatch'); const retained: StoredBankImport = record(root, true);
  await createWorkspace(source, newMetadata(), [retained]);
  const mutations: ((db: Database.Database) => void)[] = [
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE bank_imports SET record_json=?').run('{broken json'),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE bank_imports SET id=?').run(randomUUID()),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE sources SET path=?').run(path.join(root, 'different-original.pdf')),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE sources SET fingerprint=?').run('b'.repeat(64)),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE accounts SET currency=?').run('USD'),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE accounts SET name=?').run('Different account evidence'),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE transactions SET coefficient=?').run('-1'),
    (db: Database.Database): Database.RunResult => db.prepare('UPDATE transactions SET scale=?').run(3),
    (db: Database.Database): Database.RunResult => db.prepare('INSERT INTO transactions(id,statement_id,coefficient,currency,scale) VALUES(?,?,?,?,?)').run(randomUUID(), retained.accounts[0].statementId, '1', 'EUR', 2),
    (db: Database.Database): Database.RunResult => db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), retained.accounts[0].accountId, retained.result.sourceProvenance!.sourceId),
    (db: Database.Database): void => {
      const other: `${string}-${string}-${string}-${string}-${string}` = randomUUID(); db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(other, 'Unowned account', 'EUR');
      db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), other, retained.result.sourceProvenance!.sourceId);
    },
    (db: Database.Database): void => {
      const other: `${string}-${string}-${string}-${string}-${string}` = randomUUID(); db.prepare('INSERT INTO sources VALUES(?,?,?)').run(other, '/unowned-source.pdf', null);
      db.prepare('INSERT INTO statements VALUES(?,?,?)').run(randomUUID(), retained.accounts[0].accountId, other);
    },
    (db: Database.Database): Database.RunResult => db.prepare('INSERT INTO sources VALUES(?,?,?)').run(randomUUID(), '/duplicate-source.pdf', retained.result.sourceProvenance!.sha256),
    (db: Database.Database): void => {
      const other: `${string}-${string}-${string}-${string}-${string}` = randomUUID(); db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(other, 'Other account', 'EUR');
      db.prepare('UPDATE statements SET account_id=?').run(other);
    },
    (db: Database.Database): void => {
      const other: `${string}-${string}-${string}-${string}-${string}` = randomUUID(); db.prepare('INSERT INTO sources VALUES(?,?,?)').run(other, '/other-source.pdf', null);
      db.prepare('UPDATE bank_imports SET source_id=?').run(other);
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const file: string = path.join(root, `corrupt-${index}.receiptmatch`); await copyFile(source, file);
    const db: Database.Database = new Database(file); try {
      mutate(db);
    } finally {
      db.close();
    }
    const before: NonSharedBuffer = await readFile(file); await assert.rejects((): Promise<SavedWorkspace> => loadWorkspace(file)); assert.deepEqual(await readFile(file), before);
  }
});

test('an actual append failure rolls back migration, projections and metadata together', async (): Promise<void> => {
  const root: string = await directory(); const { file, saved }: { file: string; legacyAccountId: `${string}-${string}-${string}-${string}-${string}`; saved: SavedWorkspace; } = await legacy(root); const before: NonSharedBuffer = await readFile(file); const original: (db: Database.Database, sql: string) => Database.Statement = Function.prototype.call.bind(Reflect.get(Database.prototype, 'prepare')) as (db: Database.Database, sql: string) => Database.Statement;
  const probe: import("vitest").MockInstance<typeof Database.prototype.prepare> = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function(this: Database.Database, sql: string): Database.Statement<unknown[], unknown> {
    const query: Database.Statement<unknown[], unknown> = original(this, sql);
    if (sql.startsWith('INSERT INTO bank_imports')) {
      query.run = (): never => {
        throw new Error('Controlled manifest write failure');
      };
    }
    return query;
  });
  try {
    await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(saved, { ...saved.metadata, name: 'Must roll back' }, [record(root)]), /Controlled manifest write failure/);
  } finally {
    probe.mockRestore();
  }
  assert.deepEqual(await readFile(file), before);
  const reopened: SavedWorkspace = await loadWorkspace(file); assert.equal(reopened.schemaVersion, 1); assert.deepEqual(reopened.imports, []); assert.deepEqual(reopened.metadata, saved.metadata);
});

test('concurrent append saves cannot merge or overwrite one another silently', async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'concurrent.receiptmatch'); const saved: SavedWorkspace = await createWorkspace(file, newMetadata());
  const first: StoredBankImport = record(root); const second: StoredBankImport = record(root);
  const results: [PromiseSettledResult<SavedWorkspace>, PromiseSettledResult<SavedWorkspace>] = await Promise.allSettled([saveWorkspace(saved, { ...saved.metadata, name: 'First' }, [first]), saveWorkspace(saved, { ...saved.metadata, name: 'Second' }, [second])]);
  assert.equal(results.filter((value: PromiseSettledResult<SavedWorkspace>): value is PromiseFulfilledResult<SavedWorkspace> => value.status === 'fulfilled').length, 1); assert.equal(results.filter((value: PromiseSettledResult<SavedWorkspace>): value is PromiseRejectedResult => value.status === 'rejected').length, 1);
  const reopened: SavedWorkspace = await loadWorkspace(file); assert.equal(reopened.imports.length, 1);
  assert.deepEqual(reopened.imports[0], reopened.metadata.name === 'First' ? first : second);
});

for (const operation of ['load', 'save', 'create'] as const) {
  test(`${operation} rejects an atomic pathname replacement between the protected descriptor and SQLite open`, async (): Promise<void> => {
  const root: string = await directory(); const file: string = path.join(root, 'selected.receiptmatch'); const replacement: string = path.join(root, 'replacement.receiptmatch');
  const parked: string = path.join(root, 'original-inode.receiptmatch'); const metadata: { id: string; name: string; createdAt: string; savedAt: string | null; } = newMetadata();
  const current: SavedWorkspace | null = operation === 'create' ? null : await createWorkspace(file, { ...metadata, name: 'Original revision' });
  if (operation === 'create') {
    const foreign: Database.Database = new Database(replacement); foreign.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('external original');"); foreign.close();
  } else {
    await createWorkspace(replacement, { ...metadata, name: 'External replacement with same workspace UUID' });
  }
  const externalBytes: NonSharedBuffer = await readFile(replacement); const originalBytes: NonSharedBuffer = current ? await readFile(file) : Buffer.alloc(0);
  const originalOpen: (path: fsModule.PathLike, flags: fsModule.OpenMode, mode?: fsModule.Mode | null) => number = fsModule.openSync; let opens: number = 0; let replacements: number = 0;
  const protectedOpen: 2 | 1 | 3 = operation === 'load' ? 2 : operation === 'save' ? 3 : 1;
  const probe: Mock<(path: fsModule.PathLike, flags: fsModule.OpenMode, mode?: fsModule.Mode | null) => number> = vi.spyOn(fsModule, 'openSync').mockImplementation(((selected: fsModule.PathLike, flags: string | number, mode?: fsModule.Mode): number => {
    const descriptor: number = originalOpen(selected, flags, mode);
    if (selected === file && flags === (operation === 'create' ? 'wx+' : 'r') && ++opens === protectedOpen) {
      fsModule.renameSync(file, parked); fsModule.renameSync(replacement, file); replacements++;
    }
    return descriptor;
  }) as typeof fsModule.openSync);
  syncBuiltinESMExports();
  try {
    if (operation === 'load') {
      await assert.rejects((): Promise<SavedWorkspace> => loadWorkspace(file), /replaced or linked/);
    } else if (operation === 'save') {
      await assert.rejects((): Promise<SavedWorkspace> => saveWorkspace(current!, { ...current!.metadata, name: 'Must never overwrite replacement' }, [record(root)]), /replaced or linked/);
    } else {
      await assert.rejects((): Promise<SavedWorkspace> => createWorkspace(file, metadata, [record(root)]), /replaced or linked/);
    }
  } finally {
    probe.mockRestore(); syncBuiltinESMExports();
  }
  assert.equal(replacements, 1, 'The replacement must occur after the protected descriptor has actually opened.');
  assert.deepEqual(await readFile(file), externalBytes); assert.deepEqual(await readFile(parked), originalBytes);
  if (operation !== 'create') {
    assert.equal((await loadWorkspace(file)).metadata.name, 'External replacement with same workspace UUID');
  }
});
}
