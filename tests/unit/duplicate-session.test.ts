import type { StoredBankImport } from "../../src/shared/workspace-import.js";
import type { StoredSupportingDocument } from "../../src/shared/workspace-documents.js";
import type { SourceEvidence, TransactionCandidate } from "../../src/shared/bank-import.js";
import type { MatchSummary } from "../../src/shared/workspace-matching.js";
import type { WorkspaceState } from "../../src/shared/protocol.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestContext } from 'vitest';
import { createWorkspace, loadWorkspace, newMetadata, SCHEMA_VERSION, type SavedWorkspace } from '../../electron/store.js';
import { WorkspaceSession } from '../../electron/workspace-session.js';
import { approvalSelectionFor } from '../../src/shared/match-approvals.js';
import type { WorkspaceCommand } from '../../src/shared/protocol.js';
import { documentRun, retainedBank, retainedDocument } from './document-fixtures.js';

async function fixture(context: TestContext): Promise<{ root: string; file: string; banks: StoredBankImport[]; firstId: string; secondId: string; thirdId: string; receipts: StoredSupportingDocument[]; session: WorkspaceSession; decide: (decision: Extract<WorkspaceCommand, { type: "set-duplicate-decision"; }>["decision"], transactionId?: string, otherTransactionId?: string, revision?: number) => Promise<WorkspaceState>; summaries: () => Map<string, MatchSummary>; }> {
	const root: string = await mkdtemp(path.join(tmpdir(), 'receiptmatch-duplicates-'));
	context.onTestFinished((): Promise<void> => rm(root, { recursive: true, force: true }));
	const file: string = path.join(root, 'test.receiptmatch');
	const banks: StoredBankImport[] = Array.from({ length: 3 }, (_: unknown, index: number): StoredBankImport => {
		const record: StoredBankImport = retainedBank(root);
		record.filePath = path.join(root, `statement-${index}.pdf`);
		record.transactions = record.transactions.slice(0, 1);
		record.result.transactions = record.result.transactions.slice(0, 1);
		return record;
	});
	const [firstId, secondId, thirdId]: string[] = banks.map((bank: StoredBankImport): string => bank.transactions[0].transactionId);
	const receipts: StoredSupportingDocument[] = [retainedDocument(root, 'first.pdf'), retainedDocument(root, 'second.pdf')];
	const session: WorkspaceSession = new WorkspaceSession({ open: async (): Promise<string> => Promise.resolve(file), save: async (): Promise<string> => Promise.resolve(file), unsaved: async (): Promise<"discard"> => Promise.resolve('discard') });
	const decide: (decision: Extract<WorkspaceCommand, { type: "set-duplicate-decision"; }>["decision"], transactionId?: string, otherTransactionId?: string, revision?: number) => Promise<WorkspaceState> = (decision: Extract<WorkspaceCommand, { type: 'set-duplicate-decision' }>['decision'],
		transactionId: string = firstId, otherTransactionId: string = secondId, revision: number = session.state().workspace!.matchRevision): Promise<WorkspaceState> =>
		session.dispatch({ type: 'set-duplicate-decision', revision, transactionId, otherTransactionId, decision });

	const summaries: () => Map<string, MatchSummary> = (): Map<string, MatchSummary> => new Map(session.matchSummaries(session.state().workspace!.matchRevision)!.map((row: MatchSummary): [string, MatchSummary] => [row.transactionId, row]));
	return { root, file, banks, firstId, secondId, thirdId, receipts, session, decide, summaries };
}

test('archives an excluded review, revokes only its approval and restores the review after reopening and undo', async (context: TestContext & object): Promise<void> => {
	const { root, file, banks, firstId, secondId, receipts, session, decide, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const [firstDocument, secondDocument]: string[] = receipts.map((receipt: StoredSupportingDocument): string => receipt.id);
	const decisions: Map<string, string> = new Map([[firstId, firstDocument], [secondId, secondDocument]]);
	const approvals: Map<string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }> = new Map([...decisions].map(([id, doc]: [string, string]): [string, { associationRevision: number; approval: { batchId: `${string}-${string}-${string}-${string}-${string}`; approvedAt: string; transactionId: string; documentId: string; transactionRevision: number; documentRevision: number; associationRevision: number; }; }] => [id, {
		associationRevision: 1, approval: { ...approvalSelectionFor(id, doc), batchId: randomUUID(), approvedAt: '2032-06-01T12:00:00Z' },
	}]));
	await createWorkspace(file, newMetadata(), banks, [documentRun(root, receipts)], decisions, new Map(), new Map(), approvals);
	const bytes: NonSharedBuffer = await readFile(file);
	await session.dispatch({ type: 'open' });
	assert.equal(summaries().get(secondId)?.approvalStatus.status, 'approved');
	const separate: WorkspaceState = await decide('separate');
	assert.equal(separate.error, null);
	assert.equal(separate.workspace?.duplicateDecisions[0].primaryId, null);
	assert.equal(summaries().size, 3);
	assert.equal((await decide('clear')).error, null);
	const excluded: WorkspaceState = await decide('keep-first');
	assert.equal(excluded.error, null);
	assert.equal(excluded.workspace?.duplicateDecisions[0].primaryId, firstId);
	assert.deepEqual(excluded.workspace?.duplicateDecisions[0].archivedReview, { documentId: secondDocument });
	assert.equal(excluded.workspace?.approvedDocumentCount, 1);
	assert.equal(summaries().has(secondId), false);
	assert.equal(summaries().get(firstId)?.approvalStatus.status, 'approved');
	assert.equal(session.matchDetails(excluded.workspace.matchRevision, secondId), null);
	assert.deepEqual(session.bankImports(), banks);
	assert.deepEqual(await readFile(file), bytes);

	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.duplicateDecisions.size, 1);
	assert.equal(saved.matchDecisions.has(secondId), false);
	assert.equal(saved.reviewApprovals.get(secondId)?.approval?.documentId, secondDocument);
	assert.equal(saved.reviewApprovals.get(secondId)?.associationRevision, 2);
	await session.dispatch({ type: 'open' });
	assert.equal(summaries().has(secondId), false);
	assert.equal((await decide('clear', secondId, firstId)).error, null);
	assert.deepEqual(summaries().get(secondId)?.review, { status: 'assigned', documentId: secondDocument });
	assert.equal(summaries().get(secondId)?.approvalStatus.status, 'revoked');
	assert.equal(summaries().get(firstId)?.approvalStatus.status, 'approved');
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	assert.equal((await loadWorkspace(file)).duplicateDecisions.size, 0);
});

test('rejects stale and conflicting duplicate decisions and preserves explicitly separated bookings', async (context: TestContext & object): Promise<void> => {
	const { file, banks, firstId, secondId, thirdId, session, decide, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	const revision: number = session.state().workspace!.matchRevision;
	assert.equal((await decide('separate')).error, null);
	assert.match((await decide('keep-first', thirdId, firstId, revision)).error ?? '', /changed/);
	assert.equal((await decide('keep-first', thirdId, firstId)).error, null);
	const conflict: WorkspaceState = await decide('keep-first', thirdId, secondId);
	assert.match(conflict.error ?? '', /kept separate/);
	assert.equal(conflict.workspace?.duplicateDecisions.length, 2);
	assert.equal(summaries().has(secondId), true);
	assert.equal(summaries().has(firstId), false);
	assert.match((await decide('keep-first', secondId, thirdId)).error ?? '', /leading booking cannot also be excluded/);
	assert.match((await decide('keep-first', thirdId, randomUUID())).error ?? '', /no longer possible duplicates/);
});

test('requires resolving a reassigned document before restoring its archived review', async (context: TestContext & object): Promise<void> => {
	const { root, file, banks, firstId, secondId, receipts, session, decide, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const [receipt]: StoredSupportingDocument[] = receipts;
	await createWorkspace(file, newMetadata(), banks, [documentRun(root, [receipt])], new Map([[secondId, receipt.id]]));
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first')).error, null);
	const assign: WorkspaceState = await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision,
		transactionId: firstId, review: { status: 'assigned', documentId: receipt.id } });
	assert.equal(assign.error, null);
	const blocked: WorkspaceState = await decide('clear');
	assert.match(blocked.error ?? '', /archived document is now assigned/);
	assert.equal(blocked.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(secondId), false);
	await session.dispatch({ type: 'review-match', revision: session.state().workspace!.matchRevision, transactionId: firstId, review: { status: 'open' } });
	assert.equal((await decide('clear')).error, null);
	assert.deepEqual(summaries().get(secondId)?.review, { status: 'assigned', documentId: receipt.id });
});

test('rejects excluding multiple bookings from one statement against a single leading booking', async (context: TestContext & object): Promise<void> => {
	const { file, banks, firstId, secondId, session, decide, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	const additionalId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(), additionalRow: TransactionCandidate = { ...banks[0].result.transactions[0], rowId: 'additional-booking' };
	banks[0].transactions.push({ rowId: additionalRow.rowId, transactionId: additionalId });
	banks[0].result.transactions.push(additionalRow);
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first', secondId, firstId)).error, null);
	const rejected: WorkspaceState = await decide('keep-first', secondId, additionalId);
	assert.match(rejected.error ?? '', /one booking per statement/);
	assert.equal(rejected.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(additionalId), true);
});

test.for(['account', 'reference'])('rejects bridging conflicting known %s identities through a leading booking with missing evidence', async (field: string, context: TestContext & object): Promise<void> => {
	const { file, banks, firstId, secondId, thirdId, session, decide, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	for (const [index, bank] of banks.entries()) {
		const account: { sectionId: string; currency: { value: string; evidence: SourceEvidence[]; }; accountReference: { label: string; value: string; evidence: SourceEvidence[]; } | null; evidence: SourceEvidence[]; } = bank.result.accountSections[0], row: TransactionCandidate = bank.result.transactions[0];
		account.accountReference = field === 'account' && index !== 0 ? { label: 'Account identifier', value: `ACCOUNT-${index}`, evidence: account.evidence } : null;
		row.references = field === 'reference' && index !== 0 ? [{ label: 'Transaction ID', value: `TRANSACTION-${index}`, evidence: row.evidence }] : [];
	}
	await createWorkspace(file, newMetadata(), banks);
	await session.dispatch({ type: 'open' });
	assert.equal((await decide('keep-first', firstId, secondId)).error, null);
	const rejected: WorkspaceState = await decide('keep-first', firstId, thirdId);
	assert.match(rejected.error ?? '', /conflicting bank, account or transaction identifiers/);
	assert.equal(rejected.workspace?.duplicateDecisions.length, 1);
	assert.equal(summaries().has(thirdId), true);
});

test('opens a version 8 workspace without writing and migrates it on explicit save', async (context: TestContext & object): Promise<void> => {
	const { file, banks, session, decide, secondId, summaries }: Awaited<ReturnType<typeof fixture>> = await fixture(context);
	await createWorkspace(file, newMetadata(), banks);
	const db: Database.Database = new Database(file);
	try {
		db.exec('DROP TABLE ignored_transactions; DROP TABLE source_replacement_reviews; DROP TABLE source_replacements; DROP TABLE source_relocations; DROP TABLE duplicate_decisions; PRAGMA user_version=8;');
	} finally {
		db.close();
	}
	const before: NonSharedBuffer = await readFile(file);
	assert.equal((await session.dispatch({ type: 'open' })).workspace?.dirty, false);
	assert.equal((await decide('keep-first')).error, null);
	assert.deepEqual(await readFile(file), before);
	assert.equal((await session.dispatch({ type: 'save' })).error, null);
	const saved: SavedWorkspace = await loadWorkspace(file);
	assert.equal(saved.schemaVersion, SCHEMA_VERSION);
	assert.equal(saved.duplicateDecisions.size, 1);
	assert.equal(summaries().has(secondId), false);
});
