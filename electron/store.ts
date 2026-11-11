import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { workspaceName } from '../src/shared/protocol.js';
import { moneySchema, type Money } from '../src/shared/money.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { storedDocumentImportSchema, type StoredDocumentImport, type WorkspaceSource } from '../src/shared/workspace-documents.js';
import { transactionMatchSchema, type TransactionMatch } from '../src/shared/workspace-matching.js';
import type { TransactionCandidate } from '../src/shared/bank-import.js';
import { suggestWorkspaceMatches } from './matching.js';

export { moneySchema } from '../src/shared/money.js';

export const APPLICATION_ID = 0x52434d54;
export const SCHEMA_VERSION = 4;
const metadataSchema = z.strictObject({ id: z.uuid(), name: workspaceName.refine(value => value.trim().length > 0), createdAt: z.iso.datetime(), savedAt: z.iso.datetime().nullable() });
export type WorkspaceMetadata = z.infer<typeof metadataSchema>;
export interface SavedWorkspace {
  metadata: WorkspaceMetadata; filePath: string; fingerprint: string; schemaVersion: number;
  imports: StoredBankImport[]; documentImports: StoredDocumentImport[]; sources: WorkspaceSource[]; matches: TransactionMatch[];
}

export function newMetadata(): WorkspaceMetadata { return { id: randomUUID(), name: 'Untitled workspace', createdAt: new Date().toISOString(), savedAt: null }; }
export async function fingerprint(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function assertDescriptorPath(descriptor: number, filePath: string) {
  const descriptorInfo = fstatSync(descriptor, { bigint: true }); const pathInfo = lstatSync(filePath, { bigint: true });
  if (
    !descriptorInfo.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() || descriptorInfo.nlink !== 1n || pathInfo.nlink !== 1n ||
    descriptorInfo.dev !== pathInfo.dev || descriptorInfo.ino !== pathInfo.ino
  ) {
    throw new Error('The workspace file was replaced or linked while it was in use.');
  }
}
function fingerprintDescriptor(descriptor: number, filePath: string): string {
  // The descriptor stays open until SQLite closes; a separate POSIX close() can cancel SQLite locks.
  assertDescriptorPath(descriptor, filePath);
  const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
  let position = 0;
  for (;;) {
    const count = readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) { assertDescriptorPath(descriptor, filePath); return hash.digest('hex'); }
    hash.update(buffer.subarray(0, count)); position += count;
  }
}

const schema = `
CREATE TABLE workspace(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, saved_at TEXT NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT);
CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL);
CREATE TABLE statements(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), source_id TEXT NOT NULL REFERENCES sources(id));
CREATE TABLE transactions(id TEXT PRIMARY KEY, statement_id TEXT NOT NULL REFERENCES statements(id), coefficient TEXT NOT NULL, currency TEXT NOT NULL, scale INTEGER NOT NULL CHECK(scale BETWEEN 0 AND 18), revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE associations(id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id), document_id TEXT NOT NULL REFERENCES documents(id), confidence TEXT CHECK(confidence IN ('reliable','uncertain') OR confidence IS NULL), revision INTEGER NOT NULL DEFAULT 1, approved_revision TEXT, UNIQUE(transaction_id,document_id));
CREATE INDEX statements_account ON statements(account_id);
CREATE INDEX transactions_statement ON transactions(statement_id);
CREATE INDEX associations_document ON associations(document_id);`;
const expectedTables = ['accounts', 'associations', 'documents', 'sources', 'statements', 'transactions', 'workspace'];
const importSchema = 'CREATE TABLE bank_imports(id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id), record_json TEXT NOT NULL);';
const documentImportSchema = 'CREATE TABLE document_imports(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);';
const matchSchema = 'CREATE TABLE match_results(transaction_id TEXT PRIMARY KEY REFERENCES transactions(id), record_json TEXT NOT NULL);';

function importIdentities(record: StoredBankImport): [string, string | null][] {
  return [
    [record.id, null], [record.result.sourceProvenance!.sourceId, 'sources'],
    ...record.accounts.flatMap(value => [[value.accountId, 'accounts'], [value.statementId, 'statements']] as [string, string][]),
    ...record.transactions.map(value => [value.transactionId, 'transactions'] as [string, string]),
    ...record.drafts.map(value => [value.draftId, null] as [string, null])
  ];
}
function documentImportIdentities(record: StoredDocumentImport): [string, string | null][] {
  return [
    [record.id, null],
    ...record.files.flatMap((file): [string, string | null][] => {
      if (file.status === 'imported') return [[file.record.id, 'documents'], [file.record.result.input!.source.sourceId, 'sources']];
      if (file.status === 'failed' && file.analysis?.input) return [[file.analysis.input.source.sourceId, null]];
      return [];
    })
  ];
}
function entityIdentities(db: Database.Database): Map<string, string[]> {
  const identities = new Map<string, string[]>();
  for (const table of expectedTables) {
    for (const { id } of db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]) {
      if (typeof id !== 'string') throw new Error('The workspace contains an invalid identity.');
      const key = id.toLowerCase();
      const tables = identities.get(key) ?? []; tables.push(table); identities.set(key, tables);
    }
  }
  return identities;
}
function sourceCatalog(db: Database.Database): WorkspaceSource[] {
  const sources = db.prepare('SELECT id,path AS filePath,fingerprint AS sha256 FROM sources ORDER BY rowid').all() as WorkspaceSource[];
  if (sources.some(source => typeof source.id !== 'string' || typeof source.filePath !== 'string' || (source.sha256 !== null && typeof source.sha256 !== 'string'))) {
    throw new Error('The workspace contains invalid source information.');
  }
  return sources;
}
function accountName(record: StoredBankImport, sectionId: string): string {
  return record.result.accountSections.find(section => section.sectionId === sectionId)!.accountReference?.value ?? record.result.adapter!.bankId;
}
function validateImports(db: Database.Database, imports: StoredBankImport[], owned: Set<string>) {
  const identities = entityIdentities(db); const hashes = new Set<string>();
  const sourceHashes = db.prepare('SELECT id,fingerprint FROM sources').all() as { id: string; fingerprint: string | null }[];
  const source = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?');
  const account = db.prepare('SELECT name,currency FROM accounts WHERE id=?');
  const statement = db.prepare('SELECT account_id,source_id FROM statements WHERE id=?');
  const transaction = db.prepare('SELECT statement_id,coefficient,currency,scale FROM transactions WHERE id=?');
  const sourceStatements = db.prepare('SELECT id FROM statements WHERE source_id=? ORDER BY id');
  const accountStatements = db.prepare('SELECT id FROM statements WHERE account_id=? ORDER BY id');
  const statementTransactions = db.prepare('SELECT id FROM transactions WHERE statement_id=? ORDER BY id');
  const matches = (query: Database.Statement, id: string, expected: Record<string, unknown>) => {
    const rows = query.all(id) as Record<string, unknown>[];
    if (rows.length !== 1 || Object.entries(expected).some(([key, value]) => rows[0][key] !== value)) throw new Error('The stored bank import does not match its workspace records.');
  };
  const matchesIds = (query: Database.Statement, id: string, expected: string[]) => {
    const ids = (query.all(id) as { id: string }[]).map(row => row.id);
    if (JSON.stringify(ids) !== JSON.stringify(expected.sort())) throw new Error('The stored bank import contains unexpected projected records.');
  };
  for (const record of imports) {
    const provenance = record.result.sourceProvenance!;
    for (const [id, table] of importIdentities(record)) {
      const key = id.toLowerCase(); const existing = identities.get(key);
      if (owned.has(key) || (table === null ? existing : !existing || existing.length !== 1 || !existing.includes(table)))
        throw new Error('Stored bank import identities conflict.');
      owned.add(key);
    }
    if (hashes.has(provenance.sha256) || sourceHashes.some(source => source.fingerprint === provenance.sha256 && source.id !== provenance.sourceId)) {
      throw new Error('The workspace contains duplicate bank statement content.');
    }
    hashes.add(provenance.sha256);
    matches(source, provenance.sourceId, { path: record.filePath, fingerprint: provenance.sha256 });
    const accounts = new Map(record.accounts.map(value => [value.sectionId, value]));
    const transactions = new Map(record.transactions.map(value => [value.rowId, value.transactionId]));
    matchesIds(sourceStatements, provenance.sourceId, record.accounts.map(value => value.statementId));
    for (const section of record.result.accountSections) {
      const mapped = accounts.get(section.sectionId)!;
      matches(account, mapped.accountId, { name: accountName(record, section.sectionId), currency: section.currency.value });
      matches(statement, mapped.statementId, { account_id: mapped.accountId, source_id: provenance.sourceId });
      matchesIds(accountStatements, mapped.accountId, [mapped.statementId]);
      matchesIds(statementTransactions, mapped.statementId, record.result.transactions.filter(row => row.accountSectionId === section.sectionId).map(row => transactions.get(row.rowId)!));
    }
    for (const row of record.result.transactions) {
      matches(transaction, transactions.get(row.rowId)!, {
        statement_id: accounts.get(row.accountSectionId)!.statementId,
        coefficient: row.accountAmount.value.coefficient, currency: row.accountAmount.value.currency, scale: BigInt(row.accountAmount.value.scale)
      });
    }
  }
}
function validateDocumentImports(db: Database.Database, imports: StoredDocumentImport[], owned: Set<string>) {
  const identities = entityIdentities(db); const sources = sourceCatalog(db);
  const documentSourceIds = new Set(imports.flatMap(record => record.files.flatMap(file => file.status === 'imported' ? [file.record.result.input!.source.sourceId] : [])));
  const available = new Map(sources.filter(source => !documentSourceIds.has(source.id)).map(source => [source.id, source.sha256]));
  const source = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?');
  const document = db.prepare('SELECT source_id FROM documents WHERE id=?');
  const sourceDocuments = db.prepare('SELECT id FROM documents WHERE source_id=? ORDER BY id');
  const sourceStatements = db.prepare('SELECT id FROM statements WHERE source_id=?');
  for (const record of imports) {
    for (const [id, table] of documentImportIdentities(record)) {
      const key = id.toLowerCase(); const existing = identities.get(key);
      if (owned.has(key) || (table === null ? existing : !existing || existing.length !== 1 || !existing.includes(table)))
        throw new Error('Stored document import identities conflict.');
      owned.add(key);
    }
    for (const file of record.files) {
      if (file.status === 'skipped') {
        if (available.get(file.existingSourceId) !== file.sha256) throw new Error('A skipped document does not match an existing source.');
      } else if (file.status === 'imported') {
        const documentRecord = file.record; const provenance = documentRecord.result.input!.source;
        const savedSource = source.get(provenance.sourceId) as { path: string; fingerprint: string } | undefined;
        const savedDocument = document.get(documentRecord.id) as { source_id: string } | undefined;
        if (!savedSource || savedSource.path !== documentRecord.filePath || savedSource.fingerprint !== provenance.sha256 || savedDocument?.source_id !== provenance.sourceId) {
          throw new Error('The stored document import does not match its workspace records.');
        }
        const projected = (sourceDocuments.all(provenance.sourceId) as { id: string }[]).map(row => row.id);
        if (projected.length !== 1 || projected[0] !== documentRecord.id || sourceStatements.all(provenance.sourceId).length) {
          throw new Error('The stored document import contains unexpected projected records.');
        }
        if (sources.some(source => source.id !== provenance.sourceId && source.sha256 === provenance.sha256)) throw new Error('The workspace contains duplicate document content.');
        available.set(provenance.sourceId, provenance.sha256);
      }
    }
  }
}
function validateAppend(
  db: Database.Database, previous: StoredBankImport[], requested: StoredBankImport[], previousDocuments: StoredDocumentImport[], requestedDocuments: StoredDocumentImport[]
) {
  if (requested.length < previous.length || previous.some((record, index) => JSON.stringify(record) !== JSON.stringify(requested[index]))) {
    throw new Error('Saved bank imports cannot be removed, reordered or rewritten.');
  }
  if (requestedDocuments.length < previousDocuments.length || previousDocuments.some((record, index) => JSON.stringify(record) !== JSON.stringify(requestedDocuments[index]))) {
    throw new Error('Saved document imports cannot be removed, reordered or rewritten.');
  }
  const identities = new Set(entityIdentities(db).keys());
  const sources = sourceCatalog(db); const hashes = new Set(sources.flatMap(source => source.sha256 === null ? [] : [source.sha256]));
  const available = new Map(sources.map(source => [source.id, source.sha256]));
  for (const record of previous) for (const [id] of importIdentities(record)) identities.add(id.toLowerCase());
  for (const record of previousDocuments) for (const [id] of documentImportIdentities(record)) identities.add(id.toLowerCase());
  const claim = (id: string) => {
    const key = id.toLowerCase();
    if (identities.has(key)) throw new Error('The new import reuses an existing workspace identity.');
    identities.add(key);
  };
  for (const record of requested.slice(previous.length)) {
    for (const [id] of importIdentities(record)) {
      claim(id);
    }
    const hash = record.result.sourceProvenance!.sha256;
    if (hashes.has(hash)) throw new Error('This bank statement content is already present in the workspace.');
    hashes.add(hash);
    available.set(record.result.sourceProvenance!.sourceId, hash);
  }
  for (const record of requestedDocuments.slice(previousDocuments.length)) {
    for (const [id] of documentImportIdentities(record)) claim(id);
    for (const file of record.files) {
      if (file.status === 'skipped') {
        if (available.get(file.existingSourceId) !== file.sha256) throw new Error('A skipped document does not match an existing source.');
      } else if (file.status === 'imported') {
        const provenance = file.record.result.input!.source;
        if (hashes.has(provenance.sha256)) throw new Error('This document content is already present in the workspace.');
        hashes.add(provenance.sha256); available.set(provenance.sourceId, provenance.sha256);
      }
    }
  }
}
function appendImports(db: Database.Database, imports: StoredBankImport[]) {
  const source = db.prepare('INSERT INTO sources(id,path,fingerprint) VALUES(?,?,?)');
  const account = db.prepare('INSERT INTO accounts(id,name,currency) VALUES(?,?,?)');
  const statement = db.prepare('INSERT INTO statements(id,account_id,source_id) VALUES(?,?,?)');
  const transaction = db.prepare('INSERT INTO transactions(id,statement_id,coefficient,currency,scale) VALUES(?,?,?,?,?)');
  const manifest = db.prepare('INSERT INTO bank_imports(id,source_id,record_json) VALUES(?,?,?)');
  for (const record of imports) {
    const sourceId = record.result.sourceProvenance!.sourceId;
    source.run(sourceId, record.filePath, record.result.sourceProvenance!.sha256);
    const accounts = new Map(record.accounts.map(value => [value.sectionId, value]));
    for (const section of record.result.accountSections) {
      const mapped = accounts.get(section.sectionId)!;
      account.run(mapped.accountId, accountName(record, section.sectionId), section.currency.value);
      statement.run(mapped.statementId, mapped.accountId, sourceId);
    }
    const transactions = new Map(record.transactions.map(value => [value.rowId, value.transactionId]));
    for (const row of record.result.transactions) {
      const amount = row.accountAmount.value;
      transaction.run(transactions.get(row.rowId)!, accounts.get(row.accountSectionId)!.statementId, amount.coefficient, amount.currency, amount.scale);
    }
    manifest.run(record.id, sourceId, JSON.stringify(record));
  }
}
function appendDocumentImports(db: Database.Database, imports: StoredDocumentImport[]) {
  const source = db.prepare('INSERT INTO sources(id,path,fingerprint) VALUES(?,?,?)');
  const document = db.prepare('INSERT INTO documents(id,source_id) VALUES(?,?)');
  const manifest = db.prepare('INSERT INTO document_imports(id,record_json) VALUES(?,?)');
  for (const record of imports) {
    for (const file of record.files) if (file.status === 'imported') {
      const provenance = file.record.result.input!.source;
      source.run(provenance.sourceId, file.record.filePath, provenance.sha256);
      document.run(file.record.id, provenance.sourceId);
    }
    manifest.run(record.id, JSON.stringify(record));
  }
}

function writeMatches(db: Database.Database, matches: TransactionMatch[]) {
  const write = db.prepare(`INSERT INTO match_results(transaction_id,record_json) VALUES(?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET record_json=excluded.record_json WHERE match_results.record_json<>excluded.record_json`);
  for (const match of matches) write.run(match.transactionId, JSON.stringify(match));
}

function readMatches(db: Database.Database, imports: StoredBankImport[], documentImports: StoredDocumentImport[]): TransactionMatch[] {
  const invalid = () => new Error('The saved match suggestions do not agree with the workspace imports.');
  const sameMoney = (stored: Money, original?: Omit<Money, 'currency'> & { currency: string | null }) => original !== undefined &&
    stored.currency === original.currency && stored.coefficient === original.coefficient && stored.scale === original.scale;
  const transactions = new Map<string, TransactionCandidate>();
  for (const record of imports) {
    const byRow = new Map(record.result.transactions.map(row => [row.rowId, row]));
    for (const { transactionId, rowId } of record.transactions) transactions.set(transactionId, byRow.get(rowId)!);
  }
  const documents = new Map(documentImports.flatMap(record => record.files.flatMap(file => file.status === 'imported'
    ? [[file.record.id, new Map(file.record.result.sections.map(section => [section.sectionId, section]))] as const] : [])));
  const matches: TransactionMatch[] = [];
  const rows = db.prepare('SELECT transaction_id,record_json FROM match_results ORDER BY transaction_id').iterate() as Iterable<{ transaction_id: string; record_json: string }>;
  for (const row of rows) {
    let input: unknown;
    try { input = JSON.parse(row.record_json); } catch { throw invalid(); }
    const parsed = transactionMatchSchema.safeParse(input);
    const transaction = transactions.get(row.transaction_id);
    if (!parsed.success || !transaction || parsed.data.transactionId !== row.transaction_id) throw invalid();
    transactions.delete(row.transaction_id);
    const candidateIds = new Set<string>();
    for (const candidate of parsed.data.candidates) {
      const section = documents.get(candidate.documentId)?.get(candidate.sectionId);
      const key = JSON.stringify([candidate.documentId, candidate.sectionId]);
      if (!section || candidateIds.has(key) || candidate.direction !== transaction.direction) throw invalid();
      candidateIds.add(key);
      for (const evidence of candidate.amounts) {
        const bankAmount = evidence.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount;
        if (!sameMoney(evidence.transactionAmount, bankAmount?.value) || !section.amounts.some(field => field.id === evidence.documentFieldId &&
          field.candidates.some(value => sameMoney(evidence.documentAmount, value)))) throw invalid();
      }
      for (const evidence of candidate.references) {
        if (!transaction.references.some(field => field.label === evidence.bankLabel && field.value === evidence.bankValue) ||
          !section.references.some(field => field.id === evidence.documentFieldId && field.candidates.includes(evidence.documentValue))) throw invalid();
      }
      const date = candidate.date;
      if (date && (date.bookingDate !== transaction.bookingDate.value || !section.dates.some(field => field.id === date.documentFieldId &&
        field.role === date.role && field.candidates.includes(date.documentDate)))) throw invalid();
    }
    matches.push(parsed.data);
  }
  if (transactions.size) throw invalid();
  return matches;
}

function configure(db: Database.Database) { db.pragma('foreign_keys = ON'); db.pragma('trusted_schema = OFF'); db.defaultSafeIntegers(true); }
function validateDatabase(db: Database.Database): Omit<SavedWorkspace, 'filePath' | 'fingerprint'> {
  if (db.pragma('application_id', { simple: true }) !== BigInt(APPLICATION_ID)) throw new Error('This file is not a ReceiptMatch workspace.');
  const version = db.pragma('user_version', { simple: true });
  if (typeof version !== 'bigint' || version < 1n || version > BigInt(SCHEMA_VERSION)) throw new Error('This workspace uses an unsupported format version.');
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const expected = [...expectedTables, ...(version >= 2n ? ['bank_imports'] : []), ...(version >= 3n ? ['document_imports'] : []), ...(version >= 4n ? ['match_results'] : [])].sort();
  if (JSON.stringify(tables) !== JSON.stringify(expected) || db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length) throw new Error('The workspace structure is not supported.');
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('The workspace is damaged.');
  const rows = db.prepare('SELECT id,name,created_at AS createdAt,saved_at AS savedAt FROM workspace').all();
  if (rows.length !== 1) throw new Error('The workspace information is damaged.');
  for (const transaction of db.prepare('SELECT coefficient,currency,scale FROM transactions').all() as { coefficient: string; currency: string; scale: bigint }[]) moneySchema.parse({ ...transaction, scale: Number(transaction.scale) });
  const imports = version === 1n ? [] : (db.prepare('SELECT id,source_id,record_json FROM bank_imports ORDER BY rowid').all() as { id: string; source_id: string; record_json: string }[]).map(row => {
    const record = storedBankImportSchema.parse(JSON.parse(row.record_json));
    if (record.id !== row.id || record.result.sourceProvenance!.sourceId !== row.source_id) throw new Error('The bank import manifest identity is damaged.');
    return record;
  });
  const documentImports = version < 3n ? [] : (db.prepare('SELECT id,record_json FROM document_imports ORDER BY rowid').all() as { id: string; record_json: string }[]).map(row => {
    const record = storedDocumentImportSchema.parse(JSON.parse(row.record_json));
    if (record.id !== row.id) throw new Error('The document import manifest identity is damaged.');
    return record;
  });
  const owned = new Set<string>();
  validateImports(db, imports, owned); validateDocumentImports(db, documentImports, owned);
  const matches = version >= 4n ? readMatches(db, imports, documentImports) : suggestWorkspaceMatches(imports, documentImports);
  return { metadata: metadataSchema.parse(rows[0]), schemaVersion: Number(version), imports, documentImports, sources: sourceCatalog(db), matches };
}

function checkHeader(filePath: string) {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Choose a regular workspace file, not a linked file.');
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(100);
    const bytesRead = readSync(descriptor, buffer, 0, 100, 0);
    if (bytesRead !== 100 || buffer.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || buffer.readUInt32BE(68) !== APPLICATION_ID) throw new Error('This file is not a ReceiptMatch workspace.');
    const version = buffer.readUInt32BE(60);
    if (version < 1 || version > SCHEMA_VERSION) throw new Error('This workspace uses an unsupported format version.');
    if (buffer[18] !== 1 || buffer[19] !== 1) throw new Error('This workspace journal format is not supported.');
  } finally { closeSync(descriptor); }
}

export async function loadWorkspace(filePath: string): Promise<SavedWorkspace> {
  checkHeader(filePath);
  const descriptor = openSync(filePath, 'r');
  let db: Database.Database | undefined;
  try {
    assertDescriptorPath(descriptor, filePath);
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    assertDescriptorPath(descriptor, filePath);
    configure(db);
    return db.transaction(() => {
      assertDescriptorPath(descriptor, filePath);
      return { ...validateDatabase(db!), filePath, fingerprint: fingerprintDescriptor(descriptor, filePath) };
    })();
  } finally { try { db?.close(); } finally { closeSync(descriptor); } }
}

export async function createWorkspace(
  filePath: string, metadata: WorkspaceMetadata, imports: StoredBankImport[] = [], documentImports: StoredDocumentImport[] = []
): Promise<SavedWorkspace> {
  if (path.extname(filePath).toLowerCase() !== '.receiptmatch') throw new Error('Use the .receiptmatch filename extension for a workspace.');
  const saved = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const retained = z.array(storedBankImportSchema).parse(imports);
  const retainedDocuments = z.array(storedDocumentImportSchema).parse(documentImports);
  const matches = suggestWorkspaceMatches(retained, retainedDocuments);
  const descriptor = openSync(filePath, 'wx+', 0o600);
  const owned = fstatSync(descriptor, { bigint: true });
  let db: Database.Database | undefined;
  let completed = false;
  try {
    assertDescriptorPath(descriptor, filePath);
    db = new Database(filePath, { fileMustExist: true });
    assertDescriptorPath(descriptor, filePath);
    configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = DELETE');
    db.transaction(() => {
      assertDescriptorPath(descriptor, filePath);
      db!.exec(schema);
      db!.exec(importSchema);
      db!.exec(documentImportSchema);
      db!.exec(matchSchema);
      db!.pragma(`application_id = ${APPLICATION_ID}`); db!.pragma(`user_version = ${SCHEMA_VERSION}`);
      db!.prepare('INSERT INTO workspace VALUES(?,?,?,?)').run(saved.id, saved.name, saved.createdAt, saved.savedAt);
      validateAppend(db!, [], retained, [], retainedDocuments); appendImports(db!, retained); appendDocumentImports(db!, retainedDocuments);
      writeMatches(db!, matches);
    }).exclusive();
    // SQLite EXCLUSIVE locking mode retains the committed-file lock until this connection closes.
    const committedFingerprint = fingerprintDescriptor(descriptor, filePath);
    completed = true;
    return { metadata: saved, filePath, fingerprint: committedFingerprint, schemaVersion: SCHEMA_VERSION, imports: retained,
      documentImports: retainedDocuments, sources: sourceCatalog(db), matches };
  } finally {
    try { db?.close(); }
    finally {
      closeSync(descriptor);
      if (!completed) { const current = lstatSync(filePath, { bigint: true }); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(filePath); }
    }
  }
}

export async function saveWorkspace(
  current: SavedWorkspace, metadata: WorkspaceMetadata, imports: StoredBankImport[] = current.imports, documentImports: StoredDocumentImport[] = current.documentImports
): Promise<SavedWorkspace> {
  const recognized = await loadWorkspace(current.filePath);
  if (recognized.metadata.id !== current.metadata.id || recognized.fingerprint !== current.fingerprint) throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
  const saved = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const retained = z.array(storedBankImportSchema).parse(imports);
  const retainedDocuments = z.array(storedDocumentImportSchema).parse(documentImports);
  const descriptor = openSync(current.filePath, 'r');
  let db: Database.Database | undefined;
  try {
    assertDescriptorPath(descriptor, current.filePath);
    db = new Database(current.filePath, { fileMustExist: true });
    assertDescriptorPath(descriptor, current.filePath);
    configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    const matches = db.transaction(() => {
      assertDescriptorPath(descriptor, current.filePath);
      const existing = validateDatabase(db!);
      const currentFingerprint = fingerprintDescriptor(descriptor, current.filePath);
      if (existing.metadata.id !== saved.id || currentFingerprint !== current.fingerprint) throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
      validateAppend(db!, existing.imports, retained, existing.documentImports, retainedDocuments);
      if (existing.schemaVersion === 1) db!.exec(importSchema);
      if (existing.schemaVersion < 3) db!.exec(documentImportSchema);
      if (existing.schemaVersion < 4) db!.exec(matchSchema);
      if (existing.schemaVersion < SCHEMA_VERSION) db!.pragma(`user_version = ${SCHEMA_VERSION}`);
      const newImports = retained.slice(existing.imports.length);
      const newDocumentImports = retainedDocuments.slice(existing.documentImports.length);
      appendImports(db!, newImports);
      appendDocumentImports(db!, newDocumentImports);
      const evidenceChanged = newImports.length || newDocumentImports.some(record => record.files.some(file => file.status === 'imported'));
      const updated = evidenceChanged ? suggestWorkspaceMatches(retained, retainedDocuments) : existing.matches;
      if (existing.schemaVersion < 4 || updated !== existing.matches) writeMatches(db!, updated);
      db!.prepare('UPDATE workspace SET name=?,saved_at=? WHERE id=?').run(saved.name, saved.savedAt, saved.id);
      return updated;
    }).exclusive();
    const committedFingerprint = fingerprintDescriptor(descriptor, current.filePath);
    return { metadata: saved, filePath: current.filePath, fingerprint: committedFingerprint, schemaVersion: SCHEMA_VERSION, imports: retained,
      documentImports: retainedDocuments, sources: sourceCatalog(db), matches };
  } finally { try { db?.close(); } finally { closeSync(descriptor); } }
}
