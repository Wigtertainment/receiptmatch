import type { StoredSupportingDocument } from "../src/shared/workspace-documents.js";
import type { ImportIssue, SourceEvidence } from "../src/shared/bank-import.js";
import type { DocumentSection, SupportingDocument } from "../src/shared/supporting-document.js";
import Database from 'better-sqlite3';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync, type Stats, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { applyBankCorrections, bankCorrectionSchema, type BankCorrection } from '../src/shared/bank-corrections.js';
import { applyDocumentCorrections, documentCorrectionKey, documentCorrectionSchema, type DocumentCorrection } from '../src/shared/document-corrections.js';
import { advanceReviewRevision, documentRevisionIndex, reviewApprovalStateSchema, type ReviewApprovalState } from '../src/shared/match-approvals.js';
import { workspaceName } from '../src/shared/protocol.js';
import { moneySchema, type Money } from '../src/shared/money.js';
import { originalSourceExtensions } from '../src/shared/original-preview.js';
import { activeStatements, activeSupportingDocuments } from '../src/shared/source-replacements.js';
import { excludedDuplicateIds, validateDuplicateDecisions, type DuplicateDecision } from '../src/shared/transaction-duplicates.js';
import { storedBankImportSchema, type StoredBankImport } from '../src/shared/workspace-import.js';
import { storedDocumentImportSchema, type DocumentFormat, type StoredDocumentImport, type WorkspaceSource } from '../src/shared/workspace-documents.js';
import { transactionMatchSchema, type TransactionMatch } from '../src/shared/workspace-matching.js';
import type { TransactionCandidate } from '../src/shared/bank-import.js';
import { suggestWorkspaceMatches } from './matching.js';

export { moneySchema } from '../src/shared/money.js';

export const APPLICATION_ID: 1380142420 = 0x52434d54;
export const SCHEMA_VERSION: number = 12;
const metadataSchema: z.ZodObject<{ id: z.ZodUUID; name: z.ZodString; createdAt: z.ZodISODateTime; savedAt: z.ZodNullable<z.ZodISODateTime>; }, z.core.$strict> = z.strictObject({ id: z.uuid(), name: workspaceName.refine((value: string): boolean => value.trim().length > 0), createdAt: z.iso.datetime(), savedAt: z.iso.datetime().nullable() });
export type WorkspaceMetadata = z.infer<typeof metadataSchema>;
export interface SavedWorkspace {
  metadata: WorkspaceMetadata; filePath: string; fingerprint: string; schemaVersion: number;
  imports: StoredBankImport[]; documentImports: StoredDocumentImport[]; sources: WorkspaceSource[]; matches: TransactionMatch[];
  matchDecisions: Map<string, string | null>;
  bankCorrections: Map<string, BankCorrection>;
  documentCorrections: Map<string, DocumentCorrection>;
  reviewApprovals: Map<string, ReviewApprovalState>;
  duplicateDecisions: Map<string, DuplicateDecision>;
  sourceRelocations: Map<string, string>;
  sourceReplacements: Map<string, string>;
  archivedSourceReviews: Map<string, Map<string, string | null>>;
  ignoredTransactions: Set<string>;
}

export function newMetadata(): WorkspaceMetadata {
  return { id: randomUUID(), name: 'Untitled workspace', createdAt: new Date().toISOString(), savedAt: null };
}

export async function fingerprint(filePath: string): Promise<string> {
  const hash: Hash = createHash('sha256');
  const chunks: AsyncIterable<Buffer> = createReadStream(filePath);
  for await (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function assertDescriptorPath(descriptor: number, filePath: string): void {
  const descriptorInfo: BigIntStats = fstatSync(descriptor, { bigint: true }); const pathInfo: BigIntStats = lstatSync(filePath, { bigint: true });
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
  const hash: Hash = createHash('sha256'); const buffer: Buffer<ArrayBuffer> = Buffer.alloc(65536);
  let position: number = 0;
  for (;;) {
    const count: number = readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) {
      assertDescriptorPath(descriptor, filePath); return hash.digest('hex');
    }
    hash.update(buffer.subarray(0, count)); position += count;
  }
}

const schema: "\nCREATE TABLE workspace(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, saved_at TEXT NOT NULL);\nCREATE TABLE sources(id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT);\nCREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL);\nCREATE TABLE statements(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), source_id TEXT NOT NULL REFERENCES sources(id));\nCREATE TABLE transactions(id TEXT PRIMARY KEY, statement_id TEXT NOT NULL REFERENCES statements(id), coefficient TEXT NOT NULL, currency TEXT NOT NULL, scale INTEGER NOT NULL CHECK(scale BETWEEN 0 AND 18), revision INTEGER NOT NULL DEFAULT 1);\nCREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL DEFAULT 1);\nCREATE TABLE associations(id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id), document_id TEXT NOT NULL REFERENCES documents(id), confidence TEXT CHECK(confidence IN ('reliable','uncertain') OR confidence IS NULL), revision INTEGER NOT NULL DEFAULT 1, approved_revision TEXT, UNIQUE(transaction_id,document_id));\nCREATE INDEX statements_account ON statements(account_id);\nCREATE INDEX transactions_statement ON transactions(statement_id);\nCREATE INDEX associations_document ON associations(document_id);" = `
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
const expectedTables: string[] = ['accounts', 'associations', 'documents', 'sources', 'statements', 'transactions', 'workspace'];
const importSchema: "CREATE TABLE bank_imports(id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id), record_json TEXT NOT NULL);" = 'CREATE TABLE bank_imports(id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id), record_json TEXT NOT NULL);';
const documentImportSchema: "CREATE TABLE document_imports(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);" = 'CREATE TABLE document_imports(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);';
const matchSchema: "CREATE TABLE match_results(transaction_id TEXT PRIMARY KEY REFERENCES transactions(id), record_json TEXT NOT NULL);" = 'CREATE TABLE match_results(transaction_id TEXT PRIMARY KEY REFERENCES transactions(id), record_json TEXT NOT NULL);';
const ignoredTransactionsSchema: "CREATE TABLE ignored_transactions(transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id));" = 'CREATE TABLE ignored_transactions(transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id));';
// No row means open. A row without a document records an explicit completion.
const matchReviewSchema: "CREATE TABLE match_reviews(\n  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),\n  document_id TEXT UNIQUE REFERENCES documents(id)\n);" = `CREATE TABLE match_reviews(
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  document_id TEXT UNIQUE REFERENCES documents(id)
);`;
const bankCorrectionsSchema: "CREATE TABLE bank_corrections(row_id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);" = 'CREATE TABLE bank_corrections(row_id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);';
const documentCorrectionsSchema: "CREATE TABLE document_corrections(\n  correction_key TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), record_json TEXT NOT NULL\n);" = `CREATE TABLE document_corrections(
  correction_key TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), record_json TEXT NOT NULL
);`;
const matchApprovalSchema: "CREATE TABLE match_approval_state(\n  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),\n  document_id TEXT REFERENCES documents(id),\n  record_json TEXT NOT NULL\n);" = `CREATE TABLE match_approval_state(
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  document_id TEXT REFERENCES documents(id),
  record_json TEXT NOT NULL
);`;
const duplicateDecisionSchema: "CREATE TABLE duplicate_decisions(\n  first_id TEXT NOT NULL REFERENCES transactions(id),\n  second_id TEXT NOT NULL REFERENCES transactions(id),\n  record_json TEXT NOT NULL,\n  PRIMARY KEY(first_id,second_id)\n);" = `CREATE TABLE duplicate_decisions(
  first_id TEXT NOT NULL REFERENCES transactions(id),
  second_id TEXT NOT NULL REFERENCES transactions(id),
  record_json TEXT NOT NULL,
  PRIMARY KEY(first_id,second_id)
);`;
const sourceRelocationSchema: "CREATE TABLE source_relocations(\n  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),\n  file_path TEXT NOT NULL\n);" = `CREATE TABLE source_relocations(
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
  file_path TEXT NOT NULL
);`;
const sourceReplacementSchema: "CREATE TABLE source_replacements(\n  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),\n  replacement_id TEXT UNIQUE NOT NULL REFERENCES sources(id)\n);\nCREATE TABLE source_replacement_reviews(\n  source_id TEXT NOT NULL REFERENCES source_replacements(source_id),\n  transaction_id TEXT NOT NULL REFERENCES transactions(id),\n  document_id TEXT REFERENCES documents(id),\n  PRIMARY KEY(source_id,transaction_id)\n);" = `CREATE TABLE source_replacements(
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
  replacement_id TEXT UNIQUE NOT NULL REFERENCES sources(id)
);
CREATE TABLE source_replacement_reviews(
  source_id TEXT NOT NULL REFERENCES source_replacements(source_id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  document_id TEXT REFERENCES documents(id),
  PRIMARY KEY(source_id,transaction_id)
);`;

function importIdentities(record: StoredBankImport): [string, string | null][] {
  return [
    [record.id, null], [record.result.sourceProvenance!.sourceId, 'sources'],
    ...record.accounts.flatMap((value: { sectionId: string; accountId: string; statementId: string; }): [string, string][] => [[value.accountId, 'accounts'], [value.statementId, 'statements']] as [string, string][]),
    ...record.transactions.map((value: { rowId: string; transactionId: string; }): [string, string] => [value.transactionId, 'transactions'] as [string, string]),
    ...record.drafts.map((value: { rowId: string; draftId: string; }): [string, null] => [value.draftId, null] as [string, null])
  ];
}

function documentImportIdentities(record: StoredDocumentImport): [string, string | null][] {
  return [
    [record.id, null],
    ...record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [string, string | null][] => {
      if (file.status === 'imported') {
        return [[file.record.id, 'documents'], [file.record.result.input!.source.sourceId, 'sources']];
      }
      if (file.status === 'failed' && file.analysis?.input) {
        return [[file.analysis.input.source.sourceId, null]];
      }
      return [];
    })
  ];
}

function entityIdentities(db: Database.Database): Map<string, string[]> {
  const identities: Map<string, string[]> = new Map<string, string[]>();
  for (const table of expectedTables) {
    for (const { id } of db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]) {
      if (typeof id !== 'string') {
        throw new Error('The workspace contains an invalid identity.');
      }
      const key: string = id.toLowerCase();
      const tables: string[] = identities.get(key) ?? []; tables.push(table); identities.set(key, tables);
    }
  }
  return identities;
}

function sourceCatalog(db: Database.Database): WorkspaceSource[] {
  const sources: WorkspaceSource[] = db.prepare('SELECT id,path AS filePath,fingerprint AS sha256 FROM sources ORDER BY rowid').all() as WorkspaceSource[];
  if (sources.some((source: WorkspaceSource): boolean => typeof source.id !== 'string' || typeof source.filePath !== 'string' || (source.sha256 !== null && typeof source.sha256 !== 'string'))) {
    throw new Error('The workspace contains invalid source information.');
  }
  return sources;
}

export function isSourceRelocationPath(filePath: string, format: DocumentFormat): boolean {
  if (!filePath || filePath.length > 32768 || /\p{Cc}|[\\/]$/u.test(filePath)) {
    return false;
  }
  const windows: boolean = /^[a-z]:[\\/]|^[\\/]{2}/i.test(filePath);
  if (windows) {
    const normalized: string = filePath.replaceAll('\\', '/');
    if (!/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/).+$/i.test(normalized) || /[<>:"|?*]/u.test(normalized.replace(/^[a-z]:/i, '')) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(path.win32.basename(filePath)) || normalized.startsWith('//./')) {
        return false;
      }
  } else if (!path.posix.isAbsolute(filePath) || (process.platform === 'win32' && filePath.includes(':'))) {
    return false;
  }
  const extension: string = (windows ? path.win32 : path.posix).extname(filePath).toLowerCase();
  return originalSourceExtensions[format].some((allowed: ".pdf" | ".png" | ".jpg" | ".jpeg"): boolean => allowed === extension);
}

function validateSourceRelocations(
  entries: Iterable<readonly [string, string]>, imports: StoredBankImport[], documentImports: StoredDocumentImport[]
): Map<string, string> {
  const relocations: Map<string, string> = new Map<string, string>();
  const formats: Map<string, "png" | "jpeg" | "pdf"> = new Map<string, DocumentFormat>();
  for (const record of imports) {
    formats.set(record.result.sourceProvenance!.sourceId, 'pdf');
  }
  for (const record of documentImports) {
    for (const file of record.files) {
    if (file.status === 'imported') {
      formats.set(file.record.result.input!.source.sourceId, file.record.format);
    }
  }
  }
  for (const [sourceId, filePath] of entries) {
    const format: "png" | "jpeg" | "pdf" | undefined = formats.get(sourceId);
    if (!z.uuid().safeParse(sourceId).success || !format || relocations.has(sourceId)) {
      throw new Error('A source relocation must refer to an imported original.');
    }
    if (typeof filePath !== 'string' || !isSourceRelocationPath(filePath, format)) {
      throw new Error('A source relocation needs an absolute path with the original file type.');
    }
    relocations.set(sourceId, filePath);
  }
  return relocations;
}

function writeSourceRelocations(db: Database.Database, previous: ReadonlyMap<string, string>, relocations: ReadonlyMap<string, string>): void {
  const remove: Database.Statement<unknown[], unknown> = db.prepare('DELETE FROM source_relocations WHERE source_id=?');
  const write: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO source_relocations(source_id,file_path) VALUES(?,?)
    ON CONFLICT(source_id) DO UPDATE SET file_path=excluded.file_path WHERE source_relocations.file_path<>excluded.file_path`);
  for (const sourceId of previous.keys()) {
    if (!relocations.has(sourceId)) {
      remove.run(sourceId);
    }
  }
  for (const [sourceId, filePath] of relocations) {
    write.run(sourceId, filePath);
  }
}

export function validateSourceReplacements(
  entries: Iterable<readonly [string, string]>, imports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[]
): Map<string, string> {
  const kinds: Map<string, "document" | "statement"> = new Map<string, 'statement' | 'document'>();
  for (const record of imports) {
    kinds.set(record.result.sourceProvenance!.sourceId, 'statement');
  }
  for (const record of documentImports) {
    record.files.forEach((file: StoredDocumentImport['files'][number]): void => {
      if (file.status === 'imported') {
        kinds.set(file.record.result.input!.source.sourceId, 'document');
      }
    });
  }
  const replacements: Map<string, string> = new Map<string, string>();
  const targets: Set<string> = new Set<string>();
  for (const [sourceId, replacementId] of entries) {
    const kind: "document" | "statement" | undefined = kinds.get(sourceId);
    if (!kind || kind !== kinds.get(replacementId) || sourceId === replacementId || replacements.has(sourceId) || targets.has(replacementId)) {
      throw new Error('A source replacement must link distinct imported originals of the same kind.');
    }
    replacements.set(sourceId, replacementId);
    targets.add(replacementId);
  }
  // Each node has at most one predecessor. Walking from the heads visits every edge only if there is no cycle.
  let edges: number = 0;
  for (const sourceId of replacements.keys()) {
    if (targets.has(sourceId)) {
      continue;
    }
    for (let next: string | undefined = replacements.get(sourceId); next; next = replacements.get(next)) {
      edges++;
    }
  }
  if (edges !== replacements.size) {
    throw new Error('Source replacements cannot form a cycle.');
  }
  return replacements;
}

function writeSourceReplacements(db: Database.Database, previous: ReadonlyMap<string, string>, replacements: ReadonlyMap<string, string>): void {
  const insert: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO source_replacements(source_id,replacement_id) VALUES(?,?)');
  for (const [sourceId, replacementId] of previous) {
    if (replacements.get(sourceId) !== replacementId) {
      throw new Error('Saved source replacements cannot be removed or rewritten.');
    }
  }
  for (const [sourceId, replacementId] of replacements) {
    if (!previous.has(sourceId)) {
      insert.run(sourceId, replacementId);
    }
  }
}

type ArchivedSourceReviews = ReadonlyMap<string, ReadonlyMap<string, string | null>>;

function validateArchivedSourceReviews(
  entries: ArchivedSourceReviews, replacements: ReadonlyMap<string, string>, imports: readonly StoredBankImport[], documentImports: readonly StoredDocumentImport[]
): SavedWorkspace['archivedSourceReviews'] {
  const archive: SavedWorkspace['archivedSourceReviews'] = new Map();
  const transactions: Set<string> = new Set(imports.flatMap((record: StoredBankImport): string[] => record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId)));
  const documents: Set<string> = new Set(documentImports.flatMap((record: StoredDocumentImport): string[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.id] : [])));
  for (const [sourceId, reviews] of entries) {
    if (!replacements.has(sourceId)) {
      throw new Error('Archived reviews require an imported source replacement.');
    }
    const retained: Map<string, string | null> = new Map<string, string | null>();
    for (const [transactionId, documentId] of reviews) {
      if (!transactions.has(transactionId) || (documentId !== null && !documents.has(documentId))) {
        throw new Error('An archived source review refers to a booking or document outside the workspace imports.');
      }
      retained.set(transactionId, documentId);
    }
    if (retained.size) {
      archive.set(sourceId, retained);
    }
  }
  return archive;
}

function writeArchivedSourceReviews(db: Database.Database, previous: ArchivedSourceReviews, archive: ArchivedSourceReviews): void {
  const insert: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO source_replacement_reviews(source_id,transaction_id,document_id) VALUES(?,?,?)');
  for (const [sourceId, reviews] of previous) {
    for (const [transactionId, documentId] of reviews) {
    if (archive.get(sourceId)?.get(transactionId) !== documentId) {
      throw new Error('Saved source replacement reviews cannot be removed or rewritten.');
    }
  }
  }
  for (const [sourceId, reviews] of archive) {
    for (const [transactionId, documentId] of reviews) {
    if (!previous.get(sourceId)?.has(transactionId)) {
      insert.run(sourceId, transactionId, documentId);
    }
  }
  }
}

function accountName(record: StoredBankImport, sectionId: string): string {
  return record.result.accountSections.find((section: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; }): boolean => section.sectionId === sectionId)!.accountReference?.value ?? record.result.adapter!.bankId;
}

function claimStoredImportIdentities(entries: [string, string | null][], identities: Map<string, string[]>, owned: Set<string>, problem: string): void {
  for (const [id, table] of entries) {
    const key: string = id.toLowerCase(); const existing: string[] | undefined = identities.get(key);
    if (owned.has(key) || (table === null ? existing : existing?.length !== 1 || !existing.includes(table))) {
        throw new Error(problem);
      }
    owned.add(key);
  }
}

function validateImports(db: Database.Database, imports: StoredBankImport[], owned: Set<string>, corrections: ReadonlyMap<string, BankCorrection>): void {
  const identities: Map<string, string[]> = entityIdentities(db); const hashes: Set<string> = new Set<string>();
  const sourceHashes: { id: string; fingerprint: string | null; }[] = db.prepare('SELECT id,fingerprint FROM sources').all() as { id: string; fingerprint: string | null }[];
  const source: Database.Statement<unknown[], unknown> = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?');
  const account: Database.Statement<unknown[], unknown> = db.prepare('SELECT name,currency FROM accounts WHERE id=?');
  const statement: Database.Statement<unknown[], unknown> = db.prepare('SELECT account_id,source_id FROM statements WHERE id=?');
  const transaction: Database.Statement<unknown[], unknown> = db.prepare('SELECT statement_id,coefficient,currency,scale,revision FROM transactions WHERE id=?');
  const sourceStatements: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM statements WHERE source_id=? ORDER BY id');
  const accountStatements: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM statements WHERE account_id=? ORDER BY id');
  const statementTransactions: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM transactions WHERE statement_id=? ORDER BY id');
  const matches: (query: Database.Statement, id: string, expected: Record<string, unknown>) => void = (query: Database.Statement, id: string, expected: Record<string, unknown>): void => {
    const rows: Record<string, unknown>[] = query.all(id) as Record<string, unknown>[];
    if (rows.length !== 1 || Object.entries(expected).some(([key, value]: [string, unknown]): boolean => rows[0][key] !== value)) {
      throw new Error('The stored bank import does not match its workspace records.');
    }
  };

  const matchesIds: (query: Database.Statement, id: string, expected: string[]) => void = (query: Database.Statement, id: string, expected: string[]): void => {
    const ids: string[] = (query.all(id) as { id: string }[]).map((row: { id: string; }): string => row.id);
    if (JSON.stringify(ids) !== JSON.stringify(expected.sort())) {
      throw new Error('The stored bank import contains unexpected projected records.');
    }
  };
  for (const record of imports) {
    const provenance: { sourceId: string; sha256: string; extractionRunId: string; extractionVersion: string; pages: { pageId: string; pageNumber: number; width: number; height: number; }[]; } = record.result.sourceProvenance!;
    claimStoredImportIdentities(importIdentities(record), identities, owned, 'Stored bank import identities conflict.');
    if (hashes.has(provenance.sha256) || sourceHashes.some((source: { id: string; fingerprint: string | null; }): boolean => source.fingerprint === provenance.sha256 && source.id !== provenance.sourceId)) {
      throw new Error('The workspace contains duplicate bank statement content.');
    }
    hashes.add(provenance.sha256);
    matches(source, provenance.sourceId, { path: record.filePath, fingerprint: provenance.sha256 });
    const accounts: Map<string, { sectionId: string; accountId: string; statementId: string; }> = new Map(record.accounts.map((value: { sectionId: string; accountId: string; statementId: string; }): [string, { sectionId: string; accountId: string; statementId: string; }] => [value.sectionId, value]));
    const transactions: Map<string, string> = new Map(record.transactions.map((value: { rowId: string; transactionId: string; }): [string, string] => [value.rowId, value.transactionId]));
    matchesIds(sourceStatements, provenance.sourceId, record.accounts.map((value: { sectionId: string; accountId: string; statementId: string; }): string => value.statementId));
    for (const section of record.result.accountSections) {
      const mapped: { sectionId: string; accountId: string; statementId: string; } = accounts.get(section.sectionId)!;
      matches(account, mapped.accountId, { name: accountName(record, section.sectionId), currency: section.currency.value });
      matches(statement, mapped.statementId, { account_id: mapped.accountId, source_id: provenance.sourceId });
      matchesIds(accountStatements, mapped.accountId, [mapped.statementId]);
      matchesIds(statementTransactions, mapped.statementId, record.result.transactions.filter((row: TransactionCandidate): boolean => row.accountSectionId === section.sectionId).map((row: TransactionCandidate): string => transactions.get(row.rowId)!));
    }
    for (const row of record.result.transactions) {
      const id: string = transactions.get(row.rowId)!;
      const correction: BankCorrection | undefined = corrections.get(id);
      matches(transaction, id, {
        statement_id: accounts.get(row.accountSectionId)!.statementId,
        coefficient: row.accountAmount.value.coefficient, currency: row.accountAmount.value.currency, scale: BigInt(row.accountAmount.value.scale),
        ...(correction ? { revision: BigInt(correction.revision) } : {})
      });
    }
  }
}

function validateDocumentProjection(
  documentRecord: StoredSupportingDocument, source: Database.Statement, document: Database.Statement, sourceDocuments: Database.Statement,
  sourceStatements: Database.Statement, sources: WorkspaceSource[], revisions: ReadonlyMap<string, number>
): { sourceId: string; sha256: string } {
  const provenance: { sourceId: string; sha256: string; } = documentRecord.result.input!.source;
  const savedSource: { path: string; fingerprint: string; } | undefined = source.get(provenance.sourceId) as { path: string; fingerprint: string } | undefined;
  const savedDocument: { source_id: string; revision: bigint; } | undefined = document.get(documentRecord.id) as { source_id: string; revision: bigint } | undefined;
  const revision: number | undefined = revisions.get(documentRecord.id);
  if (savedSource?.path !== documentRecord.filePath || savedSource.fingerprint !== provenance.sha256 || savedDocument?.source_id !== provenance.sourceId ||
    (revision !== undefined && savedDocument.revision !== BigInt(revision))) {
    throw new Error('The stored document import does not match its workspace records.');
  }
  const projected: string[] = (sourceDocuments.all(provenance.sourceId) as { id: string }[]).map((row: { id: string; }): string => row.id);
  if (projected.length !== 1 || projected[0] !== documentRecord.id || sourceStatements.all(provenance.sourceId).length) {
    throw new Error('The stored document import contains unexpected projected records.');
  }
  if (sources.some((source: WorkspaceSource): boolean => source.id !== provenance.sourceId && source.sha256 === provenance.sha256)) {
    throw new Error('The workspace contains duplicate document content.');
  }
  return provenance;
}

function validateDocumentImports(db: Database.Database, imports: StoredDocumentImport[], owned: Set<string>, revisions: ReadonlyMap<string, number>): void {
  const identities: Map<string, string[]> = entityIdentities(db); const sources: WorkspaceSource[] = sourceCatalog(db);
  const documentSourceIds: Set<string> = new Set(imports.flatMap((record: StoredDocumentImport): string[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.result.input!.source.sourceId] : [])));
  const available: Map<string, string | null> = new Map(sources.filter((source: WorkspaceSource): boolean => !documentSourceIds.has(source.id)).map((source: WorkspaceSource): [string, string | null] => [source.id, source.sha256]));
  const source: Database.Statement<unknown[], unknown> = db.prepare('SELECT path,fingerprint FROM sources WHERE id=?');
  const document: Database.Statement<unknown[], unknown> = db.prepare('SELECT source_id,revision FROM documents WHERE id=?');
  const sourceDocuments: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM documents WHERE source_id=? ORDER BY id');
  const sourceStatements: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM statements WHERE source_id=?');
  for (const record of imports) {
    claimStoredImportIdentities(documentImportIdentities(record), identities, owned, 'Stored document import identities conflict.');
    for (const file of record.files) {
      if (file.status === 'skipped') {
        if (available.get(file.existingSourceId) !== file.sha256) {
          throw new Error('A skipped document does not match an existing source.');
        }
      } else if (file.status === 'imported') {
        const provenance: { sourceId: string; sha256: string; } = validateDocumentProjection(file.record, source, document, sourceDocuments, sourceStatements, sources, revisions);
        available.set(provenance.sourceId, provenance.sha256);
      }
    }
  }
}

function validateAppend(
  db: Database.Database, previous: StoredBankImport[], requested: StoredBankImport[], previousDocuments: StoredDocumentImport[], requestedDocuments: StoredDocumentImport[]
): void {
  if (requested.length < previous.length || previous.some((record: StoredBankImport, index: number): boolean => JSON.stringify(record) !== JSON.stringify(requested[index]))) {
    throw new Error('Saved bank imports cannot be removed, reordered or rewritten.');
  }
  if (requestedDocuments.length < previousDocuments.length || previousDocuments.some((record: StoredDocumentImport, index: number): boolean => JSON.stringify(record) !== JSON.stringify(requestedDocuments[index]))) {
    throw new Error('Saved document imports cannot be removed, reordered or rewritten.');
  }
  const identities: Set<string> = new Set(entityIdentities(db).keys());
  const sources: WorkspaceSource[] = sourceCatalog(db); const hashes: Set<string> = new Set(sources.flatMap((source: WorkspaceSource): string[] => source.sha256 === null ? [] : [source.sha256]));
  const available: Map<string, string | null> = new Map(sources.map((source: WorkspaceSource): [string, string | null] => [source.id, source.sha256]));
  for (const record of previous) {
    for (const [id] of importIdentities(record)) {
      identities.add(id.toLowerCase());
    }
  }
  for (const record of previousDocuments) {
    for (const [id] of documentImportIdentities(record)) {
      identities.add(id.toLowerCase());
    }
  }
  const claim: (id: string) => void = (id: string): void => {
    const key: string = id.toLowerCase();
    if (identities.has(key)) {
      throw new Error('The new import reuses an existing workspace identity.');
    }
    identities.add(key);
  };
  for (const record of requested.slice(previous.length)) {
    for (const [id] of importIdentities(record)) {
      claim(id);
    }
    const hash: string = record.result.sourceProvenance!.sha256;
    if (hashes.has(hash)) {
      throw new Error('This bank statement content is already present in the workspace.');
    }
    hashes.add(hash);
    available.set(record.result.sourceProvenance!.sourceId, hash);
  }
  validateAppendedDocuments(requestedDocuments.slice(previousDocuments.length), claim, available, hashes);
}

function validateAppendedDocuments(
  records: StoredDocumentImport[], claim: (id: string) => void, available: Map<string, string | null>, hashes: Set<string>
): void {
  for (const record of records) {
    for (const [id] of documentImportIdentities(record)) {
      claim(id);
    }
    record.files.forEach((file: StoredDocumentImport['files'][number]): void => {
      if (file.status === 'skipped') {
        if (available.get(file.existingSourceId) !== file.sha256) {
          throw new Error('A skipped document does not match an existing source.');
        }
      } else if (file.status === 'imported') {
        const provenance: { sourceId: string; sha256: string; } = file.record.result.input!.source;
        if (hashes.has(provenance.sha256)) {
          throw new Error('This document content is already present in the workspace.');
        }
        hashes.add(provenance.sha256); available.set(provenance.sourceId, provenance.sha256);
      }
    });
  }
}

function appendImports(db: Database.Database, imports: StoredBankImport[]): void {
  const source: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO sources(id,path,fingerprint) VALUES(?,?,?)');
  const account: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO accounts(id,name,currency) VALUES(?,?,?)');
  const statement: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO statements(id,account_id,source_id) VALUES(?,?,?)');
  const transaction: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO transactions(id,statement_id,coefficient,currency,scale) VALUES(?,?,?,?,?)');
  const manifest: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO bank_imports(id,source_id,record_json) VALUES(?,?,?)');
  for (const record of imports) {
    const sourceId: string = record.result.sourceProvenance!.sourceId;
    source.run(sourceId, record.filePath, record.result.sourceProvenance!.sha256);
    const accounts: Map<string, { sectionId: string; accountId: string; statementId: string; }> = new Map(record.accounts.map((value: { sectionId: string; accountId: string; statementId: string; }): [string, { sectionId: string; accountId: string; statementId: string; }] => [value.sectionId, value]));
    for (const section of record.result.accountSections) {
      const mapped: { sectionId: string; accountId: string; statementId: string; } = accounts.get(section.sectionId)!;
      account.run(mapped.accountId, accountName(record, section.sectionId), section.currency.value);
      statement.run(mapped.statementId, mapped.accountId, sourceId);
    }
    const transactions: Map<string, string> = new Map(record.transactions.map((value: { rowId: string; transactionId: string; }): [string, string] => [value.rowId, value.transactionId]));
    for (const row of record.result.transactions) {
      const amount: { coefficient: string; currency: string; scale: number; } = row.accountAmount.value;
      transaction.run(transactions.get(row.rowId)!, accounts.get(row.accountSectionId)!.statementId, amount.coefficient, amount.currency, amount.scale);
    }
    manifest.run(record.id, sourceId, JSON.stringify(record));
  }
}

function appendDocumentImports(db: Database.Database, imports: StoredDocumentImport[]): void {
  const source: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO sources(id,path,fingerprint) VALUES(?,?,?)');
  const document: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO documents(id,source_id) VALUES(?,?)');
  const manifest: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO document_imports(id,record_json) VALUES(?,?)');
  for (const record of imports) {
    for (const file of record.files) {
      if (file.status === 'imported') {
      const provenance: { sourceId: string; sha256: string; } = file.record.result.input!.source;
      source.run(provenance.sourceId, file.record.filePath, provenance.sha256);
      document.run(file.record.id, provenance.sourceId);
    }
    }
    manifest.run(record.id, JSON.stringify(record));
  }
}

function writeMatches(db: Database.Database, matches: TransactionMatch[]): void {
  const write: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO match_results(transaction_id,record_json) VALUES(?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET record_json=excluded.record_json WHERE match_results.record_json<>excluded.record_json`);
  for (const match of matches) {
    write.run(match.transactionId, JSON.stringify(match));
  }
}

function validateMatchDecisions(
  decisions: ReadonlyMap<string, string | null>, imports: StoredBankImport[], documentImports: StoredDocumentImport[], replacements: ReadonlyMap<string, string>
): void {
  const transactions: Set<string> = new Set(activeStatements(imports, replacements).flatMap((record: StoredBankImport): string[] => record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId)));
  const documents: Set<string> = new Set(activeSupportingDocuments(documentImports, replacements).flatMap((record: StoredDocumentImport): string[] =>
    record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.id] : [])));
  for (const [transactionId, documentId] of decisions) {
    if (!transactions.has(transactionId)) {
      throw new Error('A review decision refers to a transaction outside the workspace imports.');
    }
    if (documentId === null) {
      continue;
    }
    if (!documents.delete(documentId)) {
      throw new Error('A review decision uses an unavailable or already assigned document.');
    }
  }
}

function validateIgnoredTransactions(ids: Iterable<string>, imports: StoredBankImport[]): Set<string> {
  const ignored: Set<string> = new Set(ids);
  if (!ignored.size) {
    return ignored;
  }
  const transactions: Set<string> = new Set(imports.flatMap((record: StoredBankImport): string[] => record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId)));
  if ([...ignored].some((id: string): boolean => !transactions.has(id))) {
    throw new Error('An ignored transaction is not in the workspace imports.');
  }
  return ignored;
}

function writeIgnoredTransactions(db: Database.Database, previous: ReadonlySet<string>, ignored: ReadonlySet<string>): void {
  const remove: Database.Statement<unknown[], unknown> = db.prepare('DELETE FROM ignored_transactions WHERE transaction_id=?');
  const insert: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO ignored_transactions(transaction_id) VALUES(?)');
  for (const id of previous) {
    if (!ignored.has(id)) {
      remove.run(id);
    }
  }
  for (const id of ignored) {
    if (!previous.has(id)) {
      insert.run(id);
    }
  }
}

function writeMatchDecisions(db: Database.Database, previous: ReadonlyMap<string, string | null>, decisions: ReadonlyMap<string, string | null>): void {
  const remove: Database.Statement<unknown[], unknown> = db.prepare('DELETE FROM match_reviews WHERE transaction_id=?');
  const insert: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO match_reviews(transaction_id,document_id) VALUES(?,?)');
  for (const [transactionId, documentId] of previous) {
    if (decisions.get(transactionId) !== documentId) {
      remove.run(transactionId);
    }
  }
  for (const [transactionId, documentId] of decisions) {
    if (previous.get(transactionId) !== documentId) {
      insert.run(transactionId, documentId);
    }
  }
}

function validateDuplicateReviews(
  duplicates: ReadonlyMap<string, DuplicateDecision>, reviews: ReadonlyMap<string, string | null>, documentImports: StoredDocumentImport[]
): void {
  if (!duplicates.size) {
    return;
  }
  for (const id of excludedDuplicateIds(duplicates.values())) {
    if (reviews.has(id)) {
      throw new Error('An excluded duplicate has an active review decision.');
    }
  }
  const documents: Set<string> = new Set(documentImports.flatMap((record: StoredDocumentImport): string[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.id] : [])));
  for (const { archivedReview } of duplicates.values()) {
    if (archivedReview?.documentId && !documents.has(archivedReview.documentId)) {
      throw new Error('An archived duplicate review refers to a document outside the workspace imports.');
    }
  }
}

function writeDuplicateDecisions(db: Database.Database, previous: ReadonlyMap<string, DuplicateDecision>, decisions: ReadonlyMap<string, DuplicateDecision>): void {
  const remove: Database.Statement<unknown[], unknown> = db.prepare('DELETE FROM duplicate_decisions WHERE first_id=? AND second_id=?');
  const write: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO duplicate_decisions(first_id,second_id,record_json) VALUES(?,?,?)
    ON CONFLICT(first_id,second_id) DO UPDATE SET record_json=excluded.record_json WHERE duplicate_decisions.record_json<>excluded.record_json`);
  for (const [key, { firstId, secondId }] of previous) {
    if (!decisions.has(key)) {
      remove.run(firstId, secondId);
    }
  }
  for (const decision of decisions.values()) {
    write.run(decision.firstId, decision.secondId, JSON.stringify(decision));
  }
}

function parseReviewApprovals(entries: Iterable<readonly [string, unknown]>): Map<string, ReviewApprovalState> {
  const result: Map<string, ReviewApprovalState> = new Map<string, ReviewApprovalState>();
  for (const [id, value] of entries) {
    const state: ReviewApprovalState = reviewApprovalStateSchema.parse(value);
    if (result.has(id) || (state.approval !== null && state.approval.transactionId !== id)) {
      throw new Error('Stored match approval identities are damaged.');
    }
    result.set(id, state);
  }
  return result;
}

function validateReviewApprovals(
  approvals: ReadonlyMap<string, ReviewApprovalState>, decisions: ReadonlyMap<string, string | null>,
  imports: StoredBankImport[], documentImports: StoredDocumentImport[], bankCorrections: ReadonlyMap<string, BankCorrection>, documentRevisions: ReadonlyMap<string, number>
): void {
  if (!approvals.size) {
    return;
  }
  const transactions: Set<string> = new Set(imports.flatMap((record: StoredBankImport): string[] => record.transactions.map((row: { rowId: string; transactionId: string; }): string => row.transactionId)));
  const documents: Set<string> = new Set(documentImports.flatMap((record: StoredDocumentImport): string[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): string[] => file.status === 'imported' ? [file.record.id] : [])));
  for (const [id, { associationRevision, approval }] of approvals) {
    if (!transactions.has(id)) {
      throw new Error('A match approval state refers to a transaction outside the workspace imports.');
    }
    if (approval === null) {
      continue;
    }
    if (!documents.has(approval.documentId)) {
      throw new Error('A match approval refers to a document outside the workspace imports.');
    }
    if (approval.associationRevision > associationRevision || approval.transactionRevision > (bankCorrections.get(id)?.revision ?? 1) ||
      approval.documentRevision > (documentRevisions.get(approval.documentId) ?? 1) ||
      (approval.associationRevision === associationRevision && decisions.get(id) !== approval.documentId)) {
      throw new Error('Stored match approval revisions do not agree with the workspace.');
    }
  }
}

function changedDecisionIds(previous: ReadonlyMap<string, string | null>, decisions: ReadonlyMap<string, string | null>): string[] {
  return [...new Set([...previous.keys(), ...decisions.keys()])].filter((id: string): boolean => previous.get(id) !== decisions.get(id));
}

function writeReviewApprovals(
  db: Database.Database, previous: ReadonlyMap<string, ReviewApprovalState>, approvals: ReadonlyMap<string, ReviewApprovalState>, changed: string[]
): void {
  for (const [id, prior] of previous) {
    const current: ReviewApprovalState | undefined = approvals.get(id);
    if (!current || current.associationRevision < prior.associationRevision || (prior.approval !== null && current.approval === null)) {
      throw new Error('Saved match approval states cannot be removed or rolled back.');
    }
  }
  for (const id of changed) {
    if ((approvals.get(id)?.associationRevision ?? 1) <= (previous.get(id)?.associationRevision ?? 1)) {
      throw new Error('A changed review decision requires a new association revision.');
    }
  }
  const write: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO match_approval_state(transaction_id,document_id,record_json) VALUES(?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET document_id=excluded.document_id, record_json=excluded.record_json
    WHERE match_approval_state.record_json<>excluded.record_json`);
  for (const [id, state] of approvals) {
    write.run(id, state.approval?.documentId ?? null, JSON.stringify(state));
  }
}

function parseBankCorrections(entries: Iterable<readonly [string, unknown]>): Map<string, BankCorrection> {
  const result: Map<string, BankCorrection> = new Map<string, BankCorrection>();
  for (const [id, value] of entries) {
    const correction: BankCorrection = bankCorrectionSchema.parse(value);
    if (id !== correction.rowId || result.has(id)) {
      throw new Error('Stored bank correction identities are damaged.');
    }
    result.set(id, correction);
  }
  return result;
}

function projectBankCorrections(db: Database.Database, effective: StoredBankImport[], changed: ReadonlyMap<string, BankCorrection>): void {
  const existingTransaction: Database.Statement<unknown[], unknown> = db.prepare('SELECT id FROM transactions WHERE id=?');
  const project: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO transactions(id,statement_id,coefficient,currency,scale,revision) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET coefficient=excluded.coefficient, currency=excluded.currency, scale=excluded.scale, revision=excluded.revision`);
  for (const record of effective) {
    const ids: Map<string, string> = new Map(record.transactions.map((row: { rowId: string; transactionId: string; }): [string, string] => [row.rowId, row.transactionId]));
    const statements: Map<string, string> = new Map(record.accounts.map((account: { sectionId: string; accountId: string; statementId: string; }): [string, string] => [account.sectionId, account.statementId]));
    for (const row of record.result.transactions) {
      const id: string = ids.get(row.rowId)!;
      const correction: BankCorrection | undefined = changed.get(id);
      if (!correction) {
        continue;
      }
      const amount: { coefficient: string; currency: string; scale: number; } = row.accountAmount.value;
      project.run(id, statements.get(row.accountSectionId), amount.coefficient, amount.currency, amount.scale, correction.revision);
    }
    for (const row of record.drafts) {
      if (changed.has(row.draftId) && existingTransaction.get(row.draftId)) {
      throw new Error('A correction cannot return an existing transaction to an unresolved draft.');
    }
    }
  }
}

function writeBankCorrections(db: Database.Database, previous: ReadonlyMap<string, BankCorrection>, corrections: ReadonlyMap<string, BankCorrection>, effective: StoredBankImport[]): boolean {
  if ([...previous.keys()].some((id: string): boolean => !corrections.has(id))) {
    throw new Error('Saved bank corrections cannot be removed.');
  }
  const changed: Map<string, BankCorrection> = new Map([...corrections].filter(([id, value]: [string, BankCorrection]): boolean => JSON.stringify(previous.get(id)) !== JSON.stringify(value)));
  if (!changed.size) {
    return false;
  }
  const save: Database.Statement<unknown[], unknown> = db.prepare('INSERT INTO bank_corrections(row_id,record_json) VALUES(?,?) ON CONFLICT(row_id) DO UPDATE SET record_json=excluded.record_json');
  projectBankCorrections(db, effective, changed);
  for (const [id, correction] of changed) {
    if (correction.revision <= (previous.get(id)?.revision ?? 1)) {
      throw new Error('The bank correction revision must increase.');
    }
    save.run(id, JSON.stringify(correction));
  }
  return true;
}

function parseDocumentCorrections(entries: Iterable<readonly [string, unknown]>): Map<string, DocumentCorrection> {
  const result: Map<string, DocumentCorrection> = new Map<string, DocumentCorrection>();
  const revisions: Set<string> = new Set<string>();
  for (const [key, value] of entries) {
    const correction: DocumentCorrection = documentCorrectionSchema.parse(value);
    const revisionKey: string = `${correction.documentId}:${correction.revision}`;
    if (key !== documentCorrectionKey(correction, correction.change.kind) || result.has(key) || revisions.has(revisionKey)) {
      throw new Error('Stored document correction identities or revisions are damaged.');
    }
    revisions.add(revisionKey);
    result.set(key, correction);
  }
  return result;
}

function writeDocumentCorrections(db: Database.Database, previous: ReadonlyMap<string, DocumentCorrection>, corrections: ReadonlyMap<string, DocumentCorrection>): boolean {
  if ([...previous.keys()].some((key: string): boolean => !corrections.has(key))) {
    throw new Error('Saved document corrections cannot be removed.');
  }
  const changed: Map<string, DocumentCorrection> = new Map([...corrections].filter(([key, value]: [string, DocumentCorrection]): boolean => JSON.stringify(previous.get(key)) !== JSON.stringify(value)));
  if (!changed.size) {
    return false;
  }
  const revisions: Map<string, number> = documentRevisionIndex(previous.values());
  const save: Database.Statement<unknown[], unknown> = db.prepare(`INSERT INTO document_corrections(correction_key,document_id,record_json) VALUES(?,?,?)
    ON CONFLICT(correction_key) DO UPDATE SET record_json=excluded.record_json`);
  for (const [key, correction] of changed) {
    if (correction.revision <= (revisions.get(correction.documentId) ?? 1)) {
      throw new Error('The document correction revision must increase.');
    }
    save.run(key, correction.documentId, JSON.stringify(correction));
  }
  const update: Database.Statement<unknown[], unknown> = db.prepare('UPDATE documents SET revision=? WHERE id=?');
  for (const [id, revision] of documentRevisionIndex(changed.values())) {
    update.run(revision, id);
  }
  return true;
}

function invalidStoredMatches(): Error {
  return new Error('The saved match suggestions do not agree with the workspace imports.');
}

function sameStoredMoney(stored: Money, original?: Omit<Money, 'currency'> & { currency: string | null }): boolean {
  return stored.currency === original?.currency && stored.coefficient === original.coefficient && stored.scale === original.scale;
}

function validateStoredMatchEvidence(candidate: TransactionMatch['candidates'][number], transaction: TransactionCandidate, section: DocumentSection): void {
  for (const evidence of candidate.amounts) {
    const bankAmount: { value: { coefficient: string; currency: string; scale: number; }; evidence: SourceEvidence[]; } | null = evidence.basis === 'account-settlement' ? transaction.accountAmount : transaction.reportedOriginalAmount;
    if (!sameStoredMoney(evidence.transactionAmount, bankAmount?.value) || !section.amounts.some((field: { role: "unknown" | "billed-total" | "balance-due" | "payment" | "refund-payment" | "credit-note-component" | "informational-fx" | "tax" | "subtotal" | "line-item"; candidates: { coefficient: string; scale: number; currency: string | null; }[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === evidence.documentFieldId &&
      field.candidates.some((value: { coefficient: string; scale: number; currency: string | null; }): boolean => sameStoredMoney(evidence.documentAmount, value)))) {
        throw invalidStoredMatches();
      }
  }
  for (const evidence of candidate.references) {
    if (!transaction.references.some((field: { label: string; value: string; evidence: SourceEvidence[]; }): boolean => field.label === evidence.bankLabel && field.value === evidence.bankValue) ||
      !section.references.some((field: { role: "unknown" | "invoice" | "receipt" | "payment" | "order" | "customer" | "account" | "table" | "related-invoice"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === evidence.documentFieldId && field.candidates.includes(evidence.documentValue))) {
        throw invalidStoredMatches();
      }
  }
  const date: { documentFieldId: string; bookingDate: string; documentDate: string; role: "payment" | "issue"; daysApart: number; withinWindow: boolean; } | null = candidate.date;
  if (date && (date.bookingDate !== transaction.bookingDate.value || !section.dates.some((field: { role: "unknown" | "payment" | "issue" | "due" | "service-period" | "service-start" | "service-end"; candidates: string[]; id: string; label: string; evidence: SourceEvidence[]; }): boolean => field.id === date.documentFieldId &&
    field.role === date.role && field.candidates.includes(date.documentDate)))) {
      throw invalidStoredMatches();
    }
}

function readMatches(db: Database.Database, imports: StoredBankImport[], documentImports: StoredDocumentImport[]): TransactionMatch[] {
  const transactions: Map<string, TransactionCandidate> = new Map<string, TransactionCandidate>();
  for (const record of imports) {
    const byRow: Map<string, TransactionCandidate> = new Map(record.result.transactions.map((row: TransactionCandidate): [string, TransactionCandidate] => [row.rowId, row]));
    for (const { transactionId, rowId } of record.transactions) {
      transactions.set(transactionId, byRow.get(rowId)!);
    }
  }
  const documents: Map<string, Map<string, DocumentSection>> = new Map(documentImports.flatMap((record: StoredDocumentImport): (readonly [string, Map<string, DocumentSection>])[] => record.files.flatMap((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): [] | [readonly [string, Map<string, DocumentSection>]] => file.status === 'imported'
    ? [[file.record.id, new Map(file.record.result.sections.map((section: DocumentSection): [string, DocumentSection] => [section.sectionId, section]))] as const] : [])));
  const matches: TransactionMatch[] = [];
  const rows: Iterable<{ transaction_id: string; record_json: string; }> = db.prepare('SELECT transaction_id,record_json FROM match_results ORDER BY transaction_id').iterate() as Iterable<{ transaction_id: string; record_json: string }>;
  for (const row of rows) {
    let input: unknown;
    try {
      input = JSON.parse(row.record_json);
    } catch {
      throw invalidStoredMatches();
    }
    const parsed: z.ZodSafeParseResult<TransactionMatch> = transactionMatchSchema.safeParse(input);
    const transaction: TransactionCandidate | undefined = transactions.get(row.transaction_id);
    if (!parsed.success || !transaction || parsed.data.transactionId !== row.transaction_id) {
      throw invalidStoredMatches();
    }
    transactions.delete(row.transaction_id);
    const candidateIds: Set<string> = new Set<string>();
    for (const candidate of parsed.data.candidates) {
      const section: DocumentSection | undefined = documents.get(candidate.documentId)?.get(candidate.sectionId);
      const key: string = JSON.stringify([candidate.documentId, candidate.sectionId]);
      if (!section || candidateIds.has(key) || candidate.direction !== transaction.direction) {
        throw invalidStoredMatches();
      }
      candidateIds.add(key);
      validateStoredMatchEvidence(candidate, transaction, section);
    }
    matches.push(parsed.data);
  }
  if (transactions.size) {
    throw invalidStoredMatches();
  }
  return matches;
}

function configure(db: Database.Database): void {
  db.pragma('foreign_keys = ON'); db.pragma('trusted_schema = OFF'); db.defaultSafeIntegers(true);
}

function databaseTables(version: bigint): string[] {
  const expected: string[] = [...expectedTables];
  if (version >= 2n) {
    expected.push('bank_imports');
  }
  if (version >= 3n) {
    expected.push('document_imports');
  }
  if (version >= 4n) {
    expected.push('match_results');
  }
  if (version >= 5n) {
    expected.push('match_reviews');
  }
  if (version >= 6n) {
    expected.push('bank_corrections');
  }
  if (version >= 7n) {
    expected.push('document_corrections');
  }
  if (version >= 8n) {
    expected.push('match_approval_state');
  }
  if (version >= 9n) {
    expected.push('duplicate_decisions');
  }
  if (version >= 10n) {
    expected.push('source_relocations');
  }
  if (version >= 11n) {
    expected.push('source_replacements', 'source_replacement_reviews');
  }
  if (version >= 12n) {
    expected.push('ignored_transactions');
  }
  expected.sort();
  return expected;
}

function validateDatabaseStructure(db: Database.Database, version: bigint): void {
  const tables: string[] = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row: { name: string; }): string => row.name);
  const expected: string[] = databaseTables(version);
  if (JSON.stringify(tables) !== JSON.stringify(expected) || db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length) {
    throw new Error('The workspace structure is not supported.');
  }
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) {
    throw new Error('The workspace is damaged.');
  }
}

type SavedWorkspaceReviews = Pick<SavedWorkspace, 'matchDecisions' | 'duplicateDecisions' | 'reviewApprovals'>;

function readWorkspaceReviews(
  db: Database.Database, version: bigint, effective: StoredBankImport[], documentImports: StoredDocumentImport[],
  bankCorrections: ReadonlyMap<string, BankCorrection>, documentRevisions: ReadonlyMap<string, number>
): SavedWorkspaceReviews {
  const reviewRows: { transaction_id: string; document_id: string | null; }[] = version < 5n ? [] : db.prepare('SELECT transaction_id,document_id FROM match_reviews').all() as {
    transaction_id: string; document_id: string | null;
  }[];
  const matchDecisions: Map<string, string | null> = new Map(reviewRows.map((row: { transaction_id: string; document_id: string | null; }): [string, string | null] => [row.transaction_id, row.document_id]));
  if (matchDecisions.size !== reviewRows.length) {
    throw new Error('The workspace contains duplicate review decisions.');
  }
  const duplicateRows: { first_id: string; second_id: string; record_json: string; }[] = version < 9n ? [] : db.prepare('SELECT first_id,second_id,record_json FROM duplicate_decisions').all() as {
    first_id: string; second_id: string; record_json: string;
  }[];
  const duplicateDecisions: Map<string, DuplicateDecision> = validateDuplicateDecisions(duplicateRows.map((row: { first_id: string; second_id: string; record_json: string; }): DuplicateDecision => {
    const decision: DuplicateDecision | null = JSON.parse(row.record_json) as DuplicateDecision | null;
    if (decision?.firstId !== row.first_id || decision.secondId !== row.second_id) {
      throw new Error('Stored duplicate decisions do not agree with their transactions.');
    }
    return decision;
  }), effective);
  validateDuplicateReviews(duplicateDecisions, matchDecisions, documentImports);
  const approvalRows: { transaction_id: string; document_id: string | null; record_json: string; }[] = version < 8n ? [] : db.prepare('SELECT transaction_id,document_id,record_json FROM match_approval_state').all() as {
    transaction_id: string; document_id: string | null; record_json: string;
  }[];
  const reviewApprovals: Map<string, ReviewApprovalState> = parseReviewApprovals(approvalRows.map((row: { transaction_id: string; document_id: string | null; record_json: string; }): [string, unknown] => [row.transaction_id, JSON.parse(row.record_json) as unknown]));
  if (approvalRows.some((row: { transaction_id: string; document_id: string | null; record_json: string; }): boolean => (reviewApprovals.get(row.transaction_id)?.approval?.documentId ?? null) !== row.document_id)) {
    throw new Error('Stored match approvals do not agree with their documents.');
  }
  validateReviewApprovals(reviewApprovals, matchDecisions, effective, documentImports, bankCorrections, documentRevisions);
  return { matchDecisions, duplicateDecisions, reviewApprovals };
}

function readArchivedSourceReviews(db: Database.Database, version: bigint): SavedWorkspace['archivedSourceReviews'] {
  const archive: SavedWorkspace['archivedSourceReviews'] = new Map();
  if (version < 11n) {
    return archive;
  }
  interface ArchivedReview { source_id: string; transaction_id: string; document_id: string | null }
  const rows: ArchivedReview[] = db.prepare('SELECT source_id,transaction_id,document_id FROM source_replacement_reviews ORDER BY rowid').all() as ArchivedReview[];
  for (const { source_id, transaction_id, document_id } of rows) {
    const reviews: Map<string, string | null> = archive.get(source_id) ?? new Map<string, string | null>();
    if (reviews.has(transaction_id)) {
      throw new Error('The workspace contains duplicate archived source reviews.');
    }
    reviews.set(transaction_id, document_id);
    archive.set(source_id, reviews);
  }
  return archive;
}

function validateDatabase(db: Database.Database): Omit<SavedWorkspace, 'filePath' | 'fingerprint'> {
  if (db.pragma('application_id', { simple: true }) !== BigInt(APPLICATION_ID)) {
    throw new Error('This file is not a ReceiptMatch workspace.');
  }
  const version: unknown = db.pragma('user_version', { simple: true });
  if (typeof version !== 'bigint' || version < 1n || version > BigInt(SCHEMA_VERSION)) {
    throw new Error('This workspace uses an unsupported format version.');
  }
  validateDatabaseStructure(db, version);
  const rows: unknown[] = db.prepare('SELECT id,name,created_at AS createdAt,saved_at AS savedAt FROM workspace').all();
  if (rows.length !== 1) {
    throw new Error('The workspace information is damaged.');
  }
  for (const transaction of db.prepare('SELECT coefficient,currency,scale FROM transactions').all() as { coefficient: string; currency: string; scale: bigint }[]) {
    moneySchema.parse({ ...transaction, scale: Number(transaction.scale) });
  }
  const imports: StoredBankImport[] = version === 1n ? [] : (db.prepare('SELECT id,source_id,record_json FROM bank_imports ORDER BY rowid').all() as { id: string; source_id: string; record_json: string }[]).map((row: { id: string; source_id: string; record_json: string; }): StoredBankImport => {
    const record: StoredBankImport = storedBankImportSchema.parse(JSON.parse(row.record_json));
    if (record.id !== row.id || record.result.sourceProvenance!.sourceId !== row.source_id) {
      throw new Error('The bank import manifest identity is damaged.');
    }
    return record;
  });
  const documentImports: StoredDocumentImport[] = version < 3n ? [] : (db.prepare('SELECT id,record_json FROM document_imports ORDER BY rowid').all() as { id: string; record_json: string }[]).map((row: { id: string; record_json: string; }): StoredDocumentImport => {
    const record: StoredDocumentImport = storedDocumentImportSchema.parse(JSON.parse(row.record_json));
    if (record.id !== row.id) {
      throw new Error('The document import manifest identity is damaged.');
    }
    return record;
  });
  const owned: Set<string> = new Set<string>();
  const correctionRows: { row_id: string; record_json: string; }[] = version < 6n ? [] : db.prepare('SELECT row_id,record_json FROM bank_corrections').all() as { row_id: string; record_json: string }[];
  const bankCorrections: Map<string, BankCorrection> = parseBankCorrections(correctionRows.map((row: { row_id: string; record_json: string; }): [string, unknown] => [row.row_id, JSON.parse(row.record_json) as unknown]));
  const documentCorrectionRows: { correction_key: string; document_id: string; record_json: string; }[] = version < 7n ? [] : db.prepare('SELECT correction_key,document_id,record_json FROM document_corrections').all() as {
    correction_key: string; document_id: string; record_json: string;
  }[];
  const documentCorrections: Map<string, DocumentCorrection> = parseDocumentCorrections(documentCorrectionRows.map((row: { correction_key: string; document_id: string; record_json: string; }): [string, unknown] => [row.correction_key, JSON.parse(row.record_json) as unknown]));
  if (documentCorrectionRows.some((row: { correction_key: string; document_id: string; record_json: string; }): boolean => documentCorrections.get(row.correction_key)?.documentId !== row.document_id)) {
    throw new Error('Stored document corrections do not agree with their documents.');
  }
  const effective: StoredBankImport[] = applyBankCorrections(imports, bankCorrections);
  const effectiveDocuments: StoredDocumentImport[] = applyDocumentCorrections(documentImports, documentCorrections);
  const documentRevisions: Map<string, number> = documentRevisionIndex(documentCorrections.values());
  validateImports(db, effective, owned, bankCorrections); validateDocumentImports(db, documentImports, owned, documentRevisions);
  const matches: TransactionMatch[] = version >= 4n ? readMatches(db, effective, effectiveDocuments) : suggestWorkspaceMatches(effective, effectiveDocuments);
  const { matchDecisions, duplicateDecisions, reviewApprovals }: SavedWorkspaceReviews = readWorkspaceReviews(db, version, effective, documentImports, bankCorrections, documentRevisions);
  const relocationRows: { source_id: string; file_path: string; }[] = version < 10n ? [] : db.prepare('SELECT source_id,file_path FROM source_relocations ORDER BY rowid').all() as {
    source_id: string; file_path: string;
  }[];
  const sourceRelocations: Map<string, string> = validateSourceRelocations(relocationRows.map((row: { source_id: string; file_path: string; }): readonly [string, string] => [row.source_id, row.file_path] as const), imports, documentImports);
  const replacementRows: { source_id: string; replacement_id: string; }[] = version < 11n ? [] : db.prepare('SELECT source_id,replacement_id FROM source_replacements ORDER BY rowid').all() as {
    source_id: string; replacement_id: string;
  }[];
  const sourceReplacements: Map<string, string> = validateSourceReplacements(replacementRows.map((row: { source_id: string; replacement_id: string; }): readonly [string, string] => [row.source_id, row.replacement_id] as const), imports, documentImports);
  validateMatchDecisions(matchDecisions, effective, documentImports, sourceReplacements);
  const archivedSourceReviews: SavedWorkspace['archivedSourceReviews'] = validateArchivedSourceReviews(
    readArchivedSourceReviews(db, version), sourceReplacements, effective, documentImports
  );
  const ignoredRows: { transaction_id: string; }[] = version < 12n ? [] : db.prepare('SELECT transaction_id FROM ignored_transactions').all() as { transaction_id: string }[];
  const ignoredTransactions: Set<string> = validateIgnoredTransactions(ignoredRows.map((row: { transaction_id: string; }): string => row.transaction_id), effective);
  return { metadata: metadataSchema.parse(rows[0]), schemaVersion: Number(version), imports, documentImports, sources: sourceCatalog(db), matches, matchDecisions,
    bankCorrections, documentCorrections, reviewApprovals, duplicateDecisions, sourceRelocations, sourceReplacements, archivedSourceReviews, ignoredTransactions };
}

function checkHeader(filePath: string): void {
  const info: Stats = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error('Choose a regular workspace file, not a linked file.');
  }
  const descriptor: number = openSync(filePath, 'r');
  try {
    const buffer: Buffer<ArrayBuffer> = Buffer.alloc(100);
    const bytesRead: number = readSync(descriptor, buffer, 0, 100, 0);
    if (bytesRead !== 100 || buffer.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || buffer.readUInt32BE(68) !== APPLICATION_ID) {
      throw new Error('This file is not a ReceiptMatch workspace.');
    }
    const version: number = buffer.readUInt32BE(60);
    if (version < 1 || version > SCHEMA_VERSION) {
      throw new Error('This workspace uses an unsupported format version.');
    }
    if (buffer[18] !== 1 || buffer[19] !== 1) {
      throw new Error('This workspace journal format is not supported.');
    }
  } finally {
    closeSync(descriptor);
  }
}

export async function loadWorkspace(filePath: string): Promise<SavedWorkspace> {
  checkHeader(filePath);
  const descriptor: number = openSync(filePath, 'r');
  let db: Database.Database | undefined;
  try {
    assertDescriptorPath(descriptor, filePath);
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    assertDescriptorPath(descriptor, filePath);
    configure(db);
    return Promise.resolve(db.transaction((): SavedWorkspace => {
      assertDescriptorPath(descriptor, filePath);
      return { ...validateDatabase(db!), filePath, fingerprint: fingerprintDescriptor(descriptor, filePath) };
    })());
  } finally {
    try {
      db?.close();
    } finally {
      closeSync(descriptor);
    }
  }
}

export async function createWorkspace(
  filePath: string, metadata: WorkspaceMetadata, imports: StoredBankImport[] = [], documentImports: StoredDocumentImport[] = [],
  decisions: ReadonlyMap<string, string | null> = new Map(), corrections: ReadonlyMap<string, BankCorrection> = new Map(),
  documentEdits: ReadonlyMap<string, DocumentCorrection> = new Map(), approvalEdits: ReadonlyMap<string, ReviewApprovalState> = new Map(),
  duplicateEdits: ReadonlyMap<string, DuplicateDecision> = new Map(), relocationEdits: ReadonlyMap<string, string> = new Map(),
  replacementEdits: ReadonlyMap<string, string> = new Map(), archivedSourceReviewEdits: ArchivedSourceReviews = new Map(),
  ignoredEdits: ReadonlySet<string> = new Set()
): Promise<SavedWorkspace> {
  if (path.extname(filePath).toLowerCase() !== '.receiptmatch') {
    throw new Error('Use the .receiptmatch filename extension for a workspace.');
  }
  const saved: { id: string; name: string; createdAt: string; savedAt: string | null; } = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const retained: StoredBankImport[] = z.array(storedBankImportSchema).parse(imports);
  const retainedDocuments: StoredDocumentImport[] = z.array(storedDocumentImportSchema).parse(documentImports);
  const matchDecisions: Map<string, string | null> = new Map(decisions);
  const bankCorrections: Map<string, BankCorrection> = parseBankCorrections(corrections);
  const documentCorrections: Map<string, DocumentCorrection> = parseDocumentCorrections(documentEdits);
  const reviewApprovals: Map<string, ReviewApprovalState> = parseReviewApprovals(approvalEdits);
  const sourceRelocations: Map<string, string> = validateSourceRelocations(relocationEdits, retained, retainedDocuments);
  const sourceReplacements: Map<string, string> = validateSourceReplacements(replacementEdits, retained, retainedDocuments);
  const effective: StoredBankImport[] = applyBankCorrections(retained, bankCorrections);
  const archivedSourceReviews: Map<string, Map<string, string | null>> = validateArchivedSourceReviews(archivedSourceReviewEdits, sourceReplacements, effective, retainedDocuments);
  const ignoredTransactions: Set<string> = validateIgnoredTransactions(ignoredEdits, effective);
  const effectiveDocuments: StoredDocumentImport[] = applyDocumentCorrections(retainedDocuments, documentCorrections);
  validateMatchDecisions(matchDecisions, effective, retainedDocuments, sourceReplacements);
  const duplicateDecisions: Map<string, DuplicateDecision> = validateDuplicateDecisions(duplicateEdits.values(), effective);
  validateDuplicateReviews(duplicateDecisions, matchDecisions, retainedDocuments);
  validateReviewApprovals(reviewApprovals, matchDecisions, effective, retainedDocuments, bankCorrections, documentRevisionIndex(documentCorrections.values()));
  const matches: TransactionMatch[] = suggestWorkspaceMatches(effective, effectiveDocuments);
  const descriptor: number = openSync(filePath, 'wx+', 0o600);
  const owned: BigIntStats = fstatSync(descriptor, { bigint: true });
  let db: Database.Database | undefined;
  let completed: boolean = false;
  try {
    assertDescriptorPath(descriptor, filePath);
    db = new Database(filePath, { fileMustExist: true });
    assertDescriptorPath(descriptor, filePath);
    configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = DELETE');
    db.transaction((): void => {
      assertDescriptorPath(descriptor, filePath);
      db!.exec(schema);
      db!.exec(importSchema);
      db!.exec(documentImportSchema);
      db!.exec(matchSchema);
      db!.exec(matchReviewSchema);
      db!.exec(bankCorrectionsSchema);
      db!.exec(documentCorrectionsSchema);
      db!.exec(matchApprovalSchema);
      db!.exec(duplicateDecisionSchema);
      db!.exec(sourceRelocationSchema);
      db!.exec(sourceReplacementSchema);
      db!.exec(ignoredTransactionsSchema);
      db!.pragma(`application_id = ${APPLICATION_ID}`); db!.pragma(`user_version = ${SCHEMA_VERSION}`);
      db!.prepare('INSERT INTO workspace VALUES(?,?,?,?)').run(saved.id, saved.name, saved.createdAt, saved.savedAt);
      validateAppend(db!, [], retained, [], retainedDocuments); appendImports(db!, retained); appendDocumentImports(db!, retainedDocuments);
      writeBankCorrections(db!, new Map(), bankCorrections, effective);
      writeDocumentCorrections(db!, new Map(), documentCorrections);
      writeMatches(db!, matches);
      writeMatchDecisions(db!, new Map(), matchDecisions);
      writeIgnoredTransactions(db!, new Set(), ignoredTransactions);
      writeReviewApprovals(db!, new Map(), reviewApprovals, []);
      writeDuplicateDecisions(db!, new Map(), duplicateDecisions);
      writeSourceRelocations(db!, new Map(), sourceRelocations);
      writeSourceReplacements(db!, new Map(), sourceReplacements);
      writeArchivedSourceReviews(db!, new Map(), archivedSourceReviews);
    }).exclusive();
    // SQLite EXCLUSIVE locking mode retains the committed-file lock until this connection closes.
    const committedFingerprint: string = fingerprintDescriptor(descriptor, filePath);
    completed = true;
    return Promise.resolve({ metadata: saved, filePath, fingerprint: committedFingerprint, schemaVersion: SCHEMA_VERSION, imports: retained,
      documentImports: retainedDocuments, sources: sourceCatalog(db), matches, matchDecisions, bankCorrections, documentCorrections, reviewApprovals,
      duplicateDecisions, sourceRelocations, sourceReplacements, archivedSourceReviews, ignoredTransactions });
  } finally {
    try {
      db?.close();
    } finally {
      closeSync(descriptor);
      if (!completed) {
        const current: BigIntStats = lstatSync(filePath, { bigint: true }); if (current.dev === owned.dev && current.ino === owned.ino) {
          unlinkSync(filePath);
        }
      }
    }
  }
}

export async function saveWorkspace(
  current: SavedWorkspace, metadata: WorkspaceMetadata, imports: StoredBankImport[] = current.imports, documentImports: StoredDocumentImport[] = current.documentImports,
  decisions: ReadonlyMap<string, string | null> = current.matchDecisions, corrections: ReadonlyMap<string, BankCorrection> = current.bankCorrections,
  documentEdits: ReadonlyMap<string, DocumentCorrection> = current.documentCorrections, approvalEdits?: ReadonlyMap<string, ReviewApprovalState>,
  duplicateEdits: ReadonlyMap<string, DuplicateDecision> = current.duplicateDecisions, relocationEdits: ReadonlyMap<string, string> = current.sourceRelocations,
  replacementEdits: ReadonlyMap<string, string> = current.sourceReplacements, archivedSourceReviewEdits: ArchivedSourceReviews = current.archivedSourceReviews,
  ignoredEdits: ReadonlySet<string> = current.ignoredTransactions
): Promise<SavedWorkspace> {
  const matchDecisions: Map<string, string | null> = new Map(decisions);
  const bankCorrections: Map<string, BankCorrection> = parseBankCorrections(corrections);
  const documentCorrections: Map<string, DocumentCorrection> = parseDocumentCorrections(documentEdits);
  const recognized: SavedWorkspace = await loadWorkspace(current.filePath);
  if (recognized.metadata.id !== current.metadata.id || recognized.fingerprint !== current.fingerprint) {
    throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
  }
  const changed: string[] = changedDecisionIds(recognized.matchDecisions, matchDecisions);
  const reviewApprovals: Map<string, ReviewApprovalState> = parseReviewApprovals(approvalEdits ?? recognized.reviewApprovals);
  if (!approvalEdits) {
    for (const id of changed) {
      reviewApprovals.set(id, advanceReviewRevision(reviewApprovals.get(id)));
    }
  }
  const saved: { id: string; name: string; createdAt: string; savedAt: string | null; } = metadataSchema.parse({ ...metadata, savedAt: new Date().toISOString() });
  const retained: StoredBankImport[] = z.array(storedBankImportSchema).parse(imports);
  const retainedDocuments: StoredDocumentImport[] = z.array(storedDocumentImportSchema).parse(documentImports);
  const sourceRelocations: Map<string, string> = validateSourceRelocations(relocationEdits, retained, retainedDocuments);
  const sourceReplacements: Map<string, string> = validateSourceReplacements(replacementEdits, retained, retainedDocuments);
  const effective: StoredBankImport[] = applyBankCorrections(retained, bankCorrections);
  const archivedSourceReviews: Map<string, Map<string, string | null>> = validateArchivedSourceReviews(archivedSourceReviewEdits, sourceReplacements, effective, retainedDocuments);
  const ignoredTransactions: Set<string> = validateIgnoredTransactions(ignoredEdits, effective);
  const effectiveDocuments: StoredDocumentImport[] = applyDocumentCorrections(retainedDocuments, documentCorrections);
  validateMatchDecisions(matchDecisions, effective, retainedDocuments, sourceReplacements);
  const duplicateDecisions: Map<string, DuplicateDecision> = validateDuplicateDecisions(duplicateEdits.values(), effective);
  validateDuplicateReviews(duplicateDecisions, matchDecisions, retainedDocuments);
  validateReviewApprovals(reviewApprovals, matchDecisions, effective, retainedDocuments, bankCorrections, documentRevisionIndex(documentCorrections.values()));
  const descriptor: number = openSync(current.filePath, 'r');
  let db: Database.Database | undefined;
  try {
    assertDescriptorPath(descriptor, current.filePath);
    db = new Database(current.filePath, { fileMustExist: true });
    assertDescriptorPath(descriptor, current.filePath);
    configure(db);
    db.pragma('locking_mode = EXCLUSIVE');
    const matches: TransactionMatch[] = db.transaction((): TransactionMatch[] => {
      assertDescriptorPath(descriptor, current.filePath);
      const existing: Omit<SavedWorkspace, "filePath" | "fingerprint"> = validateDatabase(db!);
      const currentFingerprint: string = fingerprintDescriptor(descriptor, current.filePath);
      if (existing.metadata.id !== saved.id || currentFingerprint !== current.fingerprint) {
        throw new Error('The workspace file changed outside ReceiptMatch. Reopen it before saving.');
      }
      validateAppend(db!, existing.imports, retained, existing.documentImports, retainedDocuments);
      if (existing.schemaVersion === 1) {
        db!.exec(importSchema);
      }
      if (existing.schemaVersion < 3) {
        db!.exec(documentImportSchema);
      }
      if (existing.schemaVersion < 4) {
        db!.exec(matchSchema);
      }
      if (existing.schemaVersion < 5) {
        db!.exec(matchReviewSchema);
      }
      if (existing.schemaVersion < 6) {
        db!.exec(bankCorrectionsSchema);
      }
      if (existing.schemaVersion < 7) {
        db!.exec(documentCorrectionsSchema);
      }
      if (existing.schemaVersion < 8) {
        db!.exec(matchApprovalSchema);
      }
      if (existing.schemaVersion < 9) {
        db!.exec(duplicateDecisionSchema);
      }
      if (existing.schemaVersion < 10) {
        db!.exec(sourceRelocationSchema);
      }
      if (existing.schemaVersion < 11) {
        db!.exec(sourceReplacementSchema);
      }
      if (existing.schemaVersion < 12) {
        db!.exec(ignoredTransactionsSchema);
      }
      if (existing.schemaVersion < SCHEMA_VERSION) {
        db!.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
      const newImports: StoredBankImport[] = retained.slice(existing.imports.length);
      const newDocumentImports: StoredDocumentImport[] = retainedDocuments.slice(existing.documentImports.length);
      appendImports(db!, newImports);
      appendDocumentImports(db!, newDocumentImports);
      const bankCorrected: boolean = writeBankCorrections(db!, existing.bankCorrections, bankCorrections, effective);
      const documentCorrected: boolean = writeDocumentCorrections(db!, existing.documentCorrections, documentCorrections);
      const evidenceChanged: number | boolean = bankCorrected || documentCorrected || newImports.length || newDocumentImports.some((record: StoredDocumentImport): boolean => record.files.some((file: { status: "imported"; record: StoredSupportingDocument; } | { status: "skipped"; filePath: string; sha256: string; existingSourceId: string; } | { status: "unsupported"; filePath: string; issues: ImportIssue[]; } | { status: "failed"; filePath: string; format: "png" | "jpeg" | "pdf" | null; sha256: string | null; issues: ImportIssue[]; analysis: SupportingDocument | null; }): file is { status: "imported"; record: StoredSupportingDocument; } => file.status === 'imported'));
      const updated: TransactionMatch[] = evidenceChanged ? suggestWorkspaceMatches(effective, effectiveDocuments) : existing.matches;
      if (existing.schemaVersion < 4 || updated !== existing.matches) {
        writeMatches(db!, updated);
      }
      writeMatchDecisions(db!, existing.matchDecisions, matchDecisions);
      writeIgnoredTransactions(db!, existing.ignoredTransactions, ignoredTransactions);
      writeReviewApprovals(db!, existing.reviewApprovals, reviewApprovals, changed);
      writeDuplicateDecisions(db!, existing.duplicateDecisions, duplicateDecisions);
      writeSourceRelocations(db!, existing.sourceRelocations, sourceRelocations);
      writeSourceReplacements(db!, existing.sourceReplacements, sourceReplacements);
      writeArchivedSourceReviews(db!, existing.archivedSourceReviews, archivedSourceReviews);
      db!.prepare('UPDATE workspace SET name=?,saved_at=? WHERE id=?').run(saved.name, saved.savedAt, saved.id);
      return updated;
    }).exclusive();
    const committedFingerprint: string = fingerprintDescriptor(descriptor, current.filePath);
    return { metadata: saved, filePath: current.filePath, fingerprint: committedFingerprint, schemaVersion: SCHEMA_VERSION, imports: retained,
      documentImports: retainedDocuments, sources: sourceCatalog(db), matches, matchDecisions, bankCorrections, documentCorrections, reviewApprovals,
      duplicateDecisions, sourceRelocations, sourceReplacements, archivedSourceReviews, ignoredTransactions };
  } finally {
    try {
      db?.close();
    } finally {
      closeSync(descriptor);
    }
  }
}
