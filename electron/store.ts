import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { workspaceName } from '../src/shared/protocol.js';

export const APPLICATION_ID = 0x52434d54;
export const SCHEMA_VERSION = 1;
export const moneySchema = z.strictObject({ coefficient: z.string().regex(/^(0|-?[1-9]\d*)$/).max(128), currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().int().min(0).max(18) });
const metadataSchema = z.strictObject({ id: z.uuid(), name: workspaceName.refine(value => value.trim().length > 0), createdAt: z.iso.datetime(), savedAt: z.iso.datetime().nullable() });
export type WorkspaceMetadata = z.infer<typeof metadataSchema>;
export interface SavedWorkspace { metadata: WorkspaceMetadata; filePath: string; fingerprint: string; }

export function newMetadata(): WorkspaceMetadata { return { id: randomUUID(), name: 'Untitled workspace', createdAt: new Date().toISOString(), savedAt: null }; }
export async function fingerprint(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function fingerprintDescriptor(descriptor: number): string {
  // The descriptor stays open until SQLite closes; a separate POSIX close() can cancel SQLite locks.
  const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
  let position = 0;
  for (;;) {
    const count = readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) return hash.digest('hex');
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

function configure(db: Database.Database) { db.pragma('foreign_keys = ON'); db.pragma('trusted_schema = OFF'); db.defaultSafeIntegers(true); }
function validateDatabase(db: Database.Database): WorkspaceMetadata {
  if (db.pragma('application_id', { simple: true }) !== BigInt(APPLICATION_ID)) throw new Error('This file is not a ReceiptMatch workspace.');
  if (db.pragma('user_version', { simple: true }) !== BigInt(SCHEMA_VERSION)) throw new Error('This workspace uses an unsupported format version.');
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  if (JSON.stringify(tables) !== JSON.stringify(expectedTables) || db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length) throw new Error('The workspace structure is not supported.');
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('The workspace is damaged.');
  const rows = db.prepare('SELECT id,name,created_at AS createdAt,saved_at AS savedAt FROM workspace').all();
  if (rows.length !== 1) throw new Error('The workspace information is damaged.');
  for (const transaction of db.prepare('SELECT coefficient,currency,scale FROM transactions').all() as { coefficient: string; currency: string; scale: bigint }[]) moneySchema.parse({ ...transaction, scale: Number(transaction.scale) });
  return metadataSchema.parse(rows[0]);
}

function checkHeader(filePath: string) {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Choose a regular workspace file, not a linked file.');
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(100);
    const bytesRead = readSync(descriptor, buffer, 0, 100, 0);
    if (bytesRead !== 100 || buffer.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || buffer.readUInt32BE(68) !== APPLICATION_ID) throw new Error('This file is not a ReceiptMatch workspace.');
    if (buffer.readUInt32BE(60) !== SCHEMA_VERSION) throw new Error('This workspace uses an unsupported format version.');
    if (buffer[18] !== 1 || buffer[19] !== 1) throw new Error('This workspace journal format is not supported.');
  } finally { closeSync(descriptor); }
}

export async function loadWorkspace(filePath: string): Promise<SavedWorkspace> {
  checkHeader(filePath);
  const descriptor = openSync(filePath, 'r');
  let db: Database.Database | undefined;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    configure(db);
    return db.transaction(() => ({ metadata: validateDatabase(db!), filePath, fingerprint: fingerprintDescriptor(descriptor) }))();
  } finally { try { db?.close(); } finally { closeSync(descriptor); } }
}

export async function createWorkspace(filePath: string, metadata: WorkspaceMetadata): Promise<SavedWorkspace> {
  if (path.extname(filePath).toLowerCase() !== '.receiptmatch') throw new Error('Use the .receiptmatch filename extension for a workspace.');
  const saved = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const descriptor = openSync(filePath, 'wx+', 0o600);
  const owned = fstatSync(descriptor);
  let db: Database.Database | undefined;
  let completed = false;
  try {
    db = new Database(filePath, { fileMustExist: true }); configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = DELETE');
    db.transaction(() => {
      db!.exec(schema);
      db!.pragma(`application_id = ${APPLICATION_ID}`); db!.pragma(`user_version = ${SCHEMA_VERSION}`);
      db!.prepare('INSERT INTO workspace VALUES(?,?,?,?)').run(saved.id, saved.name, saved.createdAt, saved.savedAt);
    }).exclusive();
    // SQLite EXCLUSIVE locking mode retains the committed-file lock until this connection closes.
    const committedFingerprint = fingerprintDescriptor(descriptor);
    completed = true;
    return { metadata: saved, filePath, fingerprint: committedFingerprint };
  } finally {
    try { db?.close(); }
    finally {
      closeSync(descriptor);
      if (!completed) { const current = lstatSync(filePath); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(filePath); }
    }
  }
}

export async function saveWorkspace(current: SavedWorkspace, metadata: WorkspaceMetadata): Promise<SavedWorkspace> {
  const recognized = await loadWorkspace(current.filePath);
  if (recognized.metadata.id !== current.metadata.id || recognized.fingerprint !== current.fingerprint) throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
  const saved = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const descriptor = openSync(current.filePath, 'r');
  let db: Database.Database | undefined;
  try {
    db = new Database(current.filePath, { fileMustExist: true });
    configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    db.transaction(() => {
      const existing = validateDatabase(db!);
      const currentFingerprint = fingerprintDescriptor(descriptor);
      if (existing.id !== saved.id || currentFingerprint !== current.fingerprint) throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
      db!.prepare('UPDATE workspace SET name=?,saved_at=? WHERE id=?').run(saved.name, saved.savedAt, saved.id);
    }).exclusive();
    const committedFingerprint = fingerprintDescriptor(descriptor);
    return { metadata: saved, filePath: current.filePath, fingerprint: committedFingerprint };
  } finally { try { db?.close(); } finally { closeSync(descriptor); } }
}
